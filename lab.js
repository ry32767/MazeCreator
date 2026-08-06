"use strict";

/**
 * lab.js — DFS-N × 偏在報酬 実験タブ
 *
 * 「探索優先順位を方位で偏らせた DFS（DFS-N）は、報酬が偏在する領域と方位が
 * 一致するとき BFS より少ない探索コストで報酬を回収する」という仮説を、
 * 再現・可視化・統計検証するためのモジュール。設計は dfsn_experiment_plan.md。
 *
 * app.js の迷路生成・探索基盤を再利用する。ブラウザではグローバル字句環境から、
 * Node（テスト）では require 経由で依存を受け取る。
 */

(function () {
  const IS_NODE = typeof module !== "undefined" && module.exports;

  // 依存の解決。ブラウザ側の分岐は app.js のトップレベル束縛（const/function）を
  // グローバル字句環境から拾う。app.js を先に読み込むこと。
  const A = IS_NODE
    ? require("./app.js")
    : {
        state,
        DIRECTIONS,
        clamp,
        posKey,
        posFromKey,
        keyFromXYZ,
        samePos,
        isOpen,
        getNeighbors,
        buildMaze,
        setSeed,
        makeRng,
        MinHeap,
        computeVisibleCells,
        parseSize,
      };

  const IS_BROWSER = !IS_NODE && typeof document !== "undefined";

  // ---------------------------------------------------------------------------
  // 1. 定数
  // ---------------------------------------------------------------------------

  const LAB_COLORS = {
    wall: "#1e293b",
    path: "#ffffff",
    region: "#f97316",
    reward: "#7c3aed",
    start: "#10b981",
    goal: "#f43f5e",
    trail: "#0ea5e9",
  };

  // 手法ごとの色。図とテーブルで一貫させる。
  const ALGO_STYLE = {
    bfs: { label: "BFS（対照）", color: "#2563eb" },
    dfs: { label: "DFS（等方・順序ランダム）", color: "#94a3b8" },
    dfsn: { label: "DFS-N（提案）", color: "#f97316" },
    greedy: { label: "Greedy-領域（参考）", color: "#10b981" },
  };

  const MM_STYLE = {
    plain: { label: "MM 無情報 (λ=0)", color: "#64748b" },
    guided: { label: "MM 領域誘導 (λ>0)", color: "#db2777" },
  };

  const ALGO_ORDER = ["bfs", "dfs", "dfsn", "greedy"];

  // ---------------------------------------------------------------------------
  // 2. 幾何 — 方位角と報酬領域
  // ---------------------------------------------------------------------------

  /**
   * 数学慣習の方位角（0°=右, 90°=上, 反時計回り）を、y が下向きのグリッド
   * ベクトルへ変換する。UI では人が読みやすい数学慣習で角度を出し、内部だけ
   * Canvas 座標に合わせる。
   */
  function biasVector(degrees) {
    const rad = (degrees * Math.PI) / 180;
    return { x: Math.cos(rad), y: -Math.sin(rad) };
  }

  /** グリッドベクトルから数学慣習の方位角（0..360）へ戻す。 */
  function vectorAngle(dx, dy) {
    const deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
    return (deg + 360) % 360;
  }

  /**
   * UI の百分率指定（cxPct/cyPct は迷路幅・高さに対する %、rPct は短辺に対する %）
   * を、セル座標の円 { cx, cy, r } に変換する。
   */
  function resolveRegion(width, height, cfg) {
    return {
      cx: ((width - 1) * cfg.cxPct) / 100,
      cy: ((height - 1) * cfg.cyPct) / 100,
      r: Math.max(1, (Math.min(width, height) * cfg.rPct) / 100),
    };
  }

  /** 領域中心から見たセルの距離。 */
  function distToCenter(x, y, region) {
    return Math.hypot(x - region.cx, y - region.cy);
  }

  /** 領域の外側にはみ出した分だけの距離（内側なら 0）。誘導ペナルティに使う。 */
  function outsideRegion(x, y, region) {
    return Math.max(0, distToCenter(x, y, region) - region.r);
  }

  /** スタートから見た報酬領域の方位角（H2 の「一致する角度」の正解値）。 */
  function regionBearing(start, region) {
    return vectorAngle(region.cx - start.x, region.cy - start.y);
  }

  /** 2 つの方位角の差を 0..180 に畳む。 */
  function angleGap(a, b) {
    const d = Math.abs(((a - b) % 360) + 360) % 360;
    return d > 180 ? 360 - d : d;
  }

  // ---------------------------------------------------------------------------
  // 3. 迷路スナップショット — 共有 state の退避と復元
  // ---------------------------------------------------------------------------

  // 探索関数群（isOpen / getNeighbors 等）はグローバル state を読むため、
  // ラボの計算は「state を差し替えて実行し、必ず元に戻す」形にする。
  const SNAPSHOT_KEYS = [
    "width",
    "height",
    "floorCount",
    "cellSize",
    "seed",
    "braid",
    "stairDensity",
    "generationAttempts",
    "layers",
    "stairsByKey",
    "start",
    "goal",
    "player",
  ];

  function snapshotState() {
    const snap = {};
    for (const key of SNAPSHOT_KEYS) snap[key] = A.state[key];
    return snap;
  }

  function applyState(snap) {
    for (const key of SNAPSHOT_KEYS) A.state[key] = snap[key];
  }

  /** ラボ迷路を state に載せて fn を実行し、必ず元の state に戻す。 */
  function withMaze(maze, fn) {
    const saved = snapshotState();
    applyState(maze);
    try {
      return fn();
    } finally {
      applyState(saved);
    }
  }

  /**
   * 実験用の 1 階層迷路を生成する。階段・多階層は使わない。
   * 生成試行は 1 回に固定（「最長経路の迷路を選ぶ」偏りを実験に持ち込まないため）。
   */
  function generateLabMaze(cfg) {
    const saved = snapshotState();
    try {
      A.setSeed(cfg.seed >>> 0);
      A.state.width = cfg.width;
      A.state.height = cfg.height;
      A.state.floorCount = 1;
      A.state.braid = A.clamp(cfg.braid || 0, 0, 1);
      A.state.stairDensity = 1;
      A.state.generationAttempts = 1;
      A.buildMaze();
      const maze = snapshotState();
      maze.labSeed = cfg.seed >>> 0;
      return maze;
    } finally {
      applyState(saved);
    }
  }

  /** 迷路内の通路セルを列挙する（z=0 固定）。 */
  function openCells(maze) {
    const cells = [];
    const layer = maze.layers[0];
    for (let y = 0; y < maze.height; y += 1) {
      for (let x = 0; x < maze.width; x += 1) {
        if (layer[y][x] === 0) cells.push({ x, y, z: 0 });
      }
    }
    return cells;
  }

  /**
   * 探索開始点を決める。方位バイアスの意味を明確にするため、既定は中央。
   * 指定座標が壁なら、最も近い通路セルへ寄せる。
   */
  function resolveStart(maze, mode) {
    if (mode === "auto") return { ...maze.start, z: 0 };
    const anchors = {
      center: [0.5, 0.5],
      bottomLeft: [0.06, 0.94],
      topLeft: [0.06, 0.06],
      bottomRight: [0.94, 0.94],
    };
    const [fx, fy] = anchors[mode] || anchors.center;
    const tx = Math.round((maze.width - 1) * fx);
    const ty = Math.round((maze.height - 1) * fy);
    let best = null;
    let bestD = Infinity;
    for (const cell of openCells(maze)) {
      const d = (cell.x - tx) ** 2 + (cell.y - ty) ** 2;
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
    return best || { ...maze.start, z: 0 };
  }

  // ---------------------------------------------------------------------------
  // 4. 報酬の配置
  // ---------------------------------------------------------------------------

  /** rng を使った非復元抽出。 */
  function sampleWithout(items, count, rand) {
    const pool = items.slice();
    const picked = [];
    const take = Math.min(count, pool.length);
    for (let i = 0; i < take; i += 1) {
      const j = i + Math.floor(rand() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      picked.push(pool[i]);
    }
    return picked;
  }

  /**
   * 報酬を配置する。集中率 concentration の割合を領域内に、残りを領域外へ
   * 一様に置く。concentration=0 は一様分布（対照条件）になる。
   * 領域内の通路が足りない場合は不足分を領域外から補う。
   */
  function placeRewards(maze, region, cfg, seed) {
    const rand = A.makeRng(seed >>> 0);
    const startKey = cfg.startKey || null;
    const inside = [];
    const outside = [];

    for (const cell of openCells(maze)) {
      const key = A.keyFromXYZ(cell.x, cell.y, 0);
      if (key === startKey) continue;
      if (distToCenter(cell.x, cell.y, region) <= region.r) inside.push(key);
      else outside.push(key);
    }

    const total = Math.max(1, Math.round(cfg.count));
    const wantInside = Math.round(total * A.clamp(cfg.concentration, 0, 1));
    const gotInside = sampleWithout(inside, wantInside, rand);
    const gotOutside = sampleWithout(outside, total - gotInside.length, rand);
    // 領域内が枯渇したら領域外から、領域外が枯渇したら領域内から補充する。
    const shortfall = total - gotInside.length - gotOutside.length;
    const extra =
      shortfall > 0
        ? sampleWithout(
            inside.filter((k) => !gotInside.includes(k)),
            shortfall,
            rand,
          )
        : [];

    return {
      keys: new Set([...gotInside, ...gotOutside, ...extra]),
      insideCount: gotInside.length + extra.length,
      availableInside: inside.length,
    };
  }

  // ---------------------------------------------------------------------------
  // 5. 展開順アルゴリズム（全知探索）
  //    いずれも「フロンティアから取り出した順」= 展開順の key 配列を返す。
  // ---------------------------------------------------------------------------

  function orderBfs(start) {
    const order = [];
    const seen = new Set([A.posKey(start)]);
    const queue = [start];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head];
      head += 1;
      order.push(A.posKey(cur));
      for (const nb of A.getNeighbors(cur)) {
        const key = A.posKey(nb);
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(nb);
        }
      }
    }
    return order;
  }

  /**
   * 優先順位付き DFS の共通実装。rank(from, to) が小さいほど優先。
   * rank 降順に push するため、最も優先度の高い近傍が最初に pop される。
   *
   * rank は近傍ごとに 1 回だけ評価してから並べ替える。比較関数の中で乱数を
   * 引くと sort の比較が非一貫になるため、乱数ランクもここで固定する。
   */
  function orderDfsRanked(start, rank) {
    const order = [];
    const done = new Set();
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop();
      const key = A.posKey(cur);
      if (done.has(key)) continue;
      done.add(key);
      order.push(key);

      const next = A.getNeighbors(cur)
        .filter((nb) => !done.has(A.posKey(nb)))
        .map((nb) => ({ nb, rank: rank(cur, nb) }));
      next.sort((a, b) => b.rank - a.rank);
      for (const item of next) stack.push(item.nb);
    }
    return order;
  }

  /**
   * 等方 DFS（対照条件）: 近傍の順序を毎回ランダムに引く。
   *
   * 「上→右→下→左」のような固定順の DFS は、それ自体が右上方向へのバイアスを
   * 持ってしまい、方位バイアスの効果を分離する対照にならない。DFS-N の優位が
   * 「深さ優先だから」なのか「方位が一致しているから」なのかを切り分けるため、
   * 対照には向きを持たない等方な深さ優先を使う。
   */
  function orderDfs(start, seed = 1) {
    const rand = A.makeRng(seed >>> 0);
    return orderDfsRanked(start, () => rand());
  }

  /**
   * DFS-N: 進行ベクトルとバイアス方位の内積で近傍の優先順位を決める。
   *
   *   rank(n) = −( d̂ · b(θ) ) + ε·U(0,1)
   *
   * ε 項は完全同点（θ が 45° の倍数のとき up/right などが厳密に並ぶ）の解消だけに
   * 効く。ここを固定順にすると 45°（＝「右上」）でだけ特定方向が必ず勝ってしまい、
   * 測りたい方位効果に系統的な偏りが混じるため、乱数で解く。
   */
  function orderDfsN(start, biasDegrees, seed = 1) {
    const bias = biasVector(biasDegrees);
    const rand = A.makeRng(seed >>> 0);
    return orderDfsRanked(start, (from, to) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const dot = (dx / len) * bias.x + (dy / len) * bias.y;
      return -dot + 1e-6 * rand();
    });
  }

  /**
   * Greedy-領域: 領域中心へのマンハッタン距離を優先度とする最良優先探索。
   * DFS-N と同じ事前情報を使い切った場合の参考線（提案手法を上回りうる）。
   */
  function orderGreedy(start, region) {
    const heap = new A.MinHeap();
    const seen = new Set([A.posKey(start)]);
    const score = (p) => Math.abs(p.x - region.cx) + Math.abs(p.y - region.cy);
    heap.push({ priority: score(start), pos: start });
    const order = [];

    while (heap.size > 0) {
      const cur = heap.pop().pos;
      order.push(A.posKey(cur));
      for (const nb of A.getNeighbors(cur)) {
        const key = A.posKey(nb);
        if (!seen.has(key)) {
          seen.add(key);
          heap.push({ priority: score(nb), pos: nb });
        }
      }
    }
    return order;
  }

  /** 名前でアルゴリズムを実行し、展開順を返す（maze は state に載っている前提）。 */
  function runOrder(name, start, ctx) {
    const seed = (ctx.seed || 1) >>> 0;
    if (name === "bfs") return orderBfs(start);
    if (name === "dfs") return orderDfs(start, seed);
    if (name === "dfsn") return orderDfsN(start, ctx.biasDegrees, seed);
    if (name === "greedy") return orderGreedy(start, ctx.region);
    throw new Error(`unknown algorithm: ${name}`);
  }

  // ---------------------------------------------------------------------------
  // 6. 評価指標
  // ---------------------------------------------------------------------------

  /**
   * 展開順（または実移動列）と報酬集合から回収曲線と指標を算出する。
   *
   *   c(n) = |W ∩ order[0..n)| / |W|
   *   nAUC = (1/H) Σ_{n=1..H} c(n)      … 大きいほど早く回収（主指標）
   *
   * horizon を与えると、その歩数まで曲線を伸ばす（短く終わった系列は最終値で
   * 埋める）。コスト単位の異なる系列を同じ分母で比べるために使う。
   *
   * order は重複を含みうる（マイクロマウスの実移動列は引き返しで同じセルを何度も
   * 通る）。報酬は 1 個につき 1 回しか回収できないので、回収済みを控えて二重に
   * 数えないようにする。
   */
  function evaluate(order, rewards, horizon) {
    const total = rewards.size || 1;
    const span = Math.max(1, horizon || order.length);
    const curve = new Float64Array(span + 1);
    const collectedKeys = new Set();
    let got = 0;
    let sum = 0;
    let costFirst = -1;
    let cost50 = -1;
    let cost90 = -1;

    for (let n = 1; n <= span; n += 1) {
      const key = n <= order.length ? order[n - 1] : null;
      if (key !== null && rewards.has(key) && !collectedKeys.has(key)) {
        collectedKeys.add(key);
        got += 1;
        if (costFirst < 0) costFirst = n;
      }
      curve[n] = got / total;
      sum += curve[n];
      if (cost50 < 0 && got >= total * 0.5) cost50 = n;
      if (cost90 < 0 && got >= total * 0.9) cost90 = n;
    }

    return {
      span,
      total,
      collected: got,
      nAUC: sum / span,
      costFirst,
      cost50,
      cost90,
      curve,
    };
  }

  /** 平均と標本標準偏差。 */
  function meanSd(values) {
    const n = values.length;
    if (n === 0) return { mean: 0, sd: 0, n: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / n;
    if (n < 2) return { mean, sd: 0, n };
    const varSum = values.reduce((a, b) => a + (b - mean) ** 2, 0);
    return { mean, sd: Math.sqrt(varSum / (n - 1)), n };
  }

  /** 中央値。歩数のように分布が右に長く尾を引く指標では平均より頑健。 */
  function median(values) {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ---------------------------------------------------------------------------
  // 7. 実験ドライバ（全知探索）
  // ---------------------------------------------------------------------------

  /** 1 つのシードについて、迷路生成・報酬配置・スタート決定までを行う。 */
  function prepareTrial(cfg, seed) {
    const maze = generateLabMaze({
      seed,
      width: cfg.width,
      height: cfg.height,
      braid: cfg.braid,
    });
    const region = resolveRegion(maze.width, maze.height, cfg.region);
    const start = resolveStart(maze, cfg.startMode);
    const rewards = placeRewards(maze, region, {
      count: cfg.rewardCount,
      concentration: cfg.concentration,
      startKey: A.posKey(start),
    }, seed ^ 0x9e3779b9);

    return { maze, region, start, rewards: rewards.keys, rewardMeta: rewards };
  }

  /** 単発実行: 指定した手法群を同一条件で走らせ、回収曲線と指標を返す。 */
  function runSingle(cfg, seed) {
    const trial = prepareTrial(cfg, seed);
    const names = cfg.algorithms || ALGO_ORDER;

    const results = withMaze(trial.maze, () => {
      const out = {};
      for (const name of names) {
        const order = runOrder(name, trial.start, {
          biasDegrees: cfg.biasDegrees,
          region: trial.region,
          seed,
        });
        out[name] = { order, metrics: evaluate(order, trial.rewards) };
      }
      return out;
    });

    return {
      seed,
      maze: trial.maze,
      region: trial.region,
      start: trial.start,
      rewards: trial.rewards,
      rewardMeta: trial.rewardMeta,
      bearing: regionBearing(trial.start, trial.region),
      results,
    };
  }

  /**
   * バイアス角スイープ（H2 の主実験）。
   * θ を等間隔に振り、各点で seeds 個の迷路にわたる DFS-N の nAUC を集計する。
   * 同じシード集合で BFS / DFS / Greedy も測り、等方な基準として重ねる。
   */
  function biasSweep(cfg, seeds, angles) {
    // 4 近傍格子では、近傍の並び順は 45° ごとにしか変わらない（内積の大小関係が
    // 切り替わるのが 45° の倍数）。22.5° 刻みで 16 点取ると、区間の内側と境界の
    // 両方を拾えて階段状の構造がそのまま見える。
    const angleList = angles || Array.from({ length: 16 }, (_, i) => i * 22.5);
    const perAngle = angleList.map(() => []);
    const baselines = { bfs: [], dfs: [], greedy: [] };
    const bearings = [];

    for (const seed of seeds) {
      const trial = prepareTrial(cfg, seed);
      bearings.push(regionBearing(trial.start, trial.region));

      withMaze(trial.maze, () => {
        for (const name of Object.keys(baselines)) {
          const order = runOrder(name, trial.start, {
            biasDegrees: 0,
            region: trial.region,
            seed,
          });
          baselines[name].push(evaluate(order, trial.rewards).nAUC);
        }
        angleList.forEach((deg, i) => {
          const order = orderDfsN(trial.start, deg, seed);
          perAngle[i].push(evaluate(order, trial.rewards).nAUC);
        });
      });
    }

    const bearingStats = meanSd(bearings);
    return {
      angles: angleList,
      points: angleList.map((deg, i) => ({
        deg,
        gap: angleGap(deg, bearingStats.mean),
        ...meanSd(perAngle[i]),
      })),
      baselines: Object.fromEntries(
        Object.entries(baselines).map(([k, v]) => [k, meanSd(v)]),
      ),
      bearing: bearingStats.mean,
      seeds: seeds.slice(),
    };
  }

  // ---------------------------------------------------------------------------
  // 8. マイクロマウス型（未知環境・実移動歩数）
  // ---------------------------------------------------------------------------

  /**
   * 視界計算（直進 LOS ＋廊下の左右）。app.js の computeVisibleCells と同じ
   * モデルを、id ベースで高速に解いたもの。等価性は test/lab.test.js で検証する。
   */
  function senseIds(layer, W, H, px, py, out) {
    out.length = 0;
    out.push(py * W + px);
    for (const dir of A.DIRECTIONS) {
      const perpX = dir.y;
      const perpY = dir.x;
      let x = px;
      let y = py;
      while (true) {
        const nx = x + dir.x;
        const ny = y + dir.y;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) break;
        if (layer[ny][nx] === 1) {
          out.push(ny * W + nx);
          break;
        }
        out.push(ny * W + nx);
        const ax = nx + perpX;
        const ay = ny + perpY;
        const bx = nx - perpX;
        const by = ny - perpY;
        if (ax >= 0 && ax < W && ay >= 0 && ay < H) out.push(ay * W + ax);
        if (bx >= 0 && bx < W && by >= 0 && by < H) out.push(by * W + bx);
        x = nx;
        y = ny;
      }
    }
    return out;
  }

  /**
   * マイクロマウス型のフロンティア探索。未知セルは通行可能と楽観視する
   * （標準的なフラッドフィル法と同じ）。
   *
   * 次に向かうフロンティアの評価:
   *   score(cell) = dist(pos → cell) + λ · max(0, |cell − center| − r)
   *
   * λ=0 なら最近傍フロンティア探索（従来手法）、λ>0 なら「ゴールは領域 R の
   * あたり」という事前情報を距離場に埋め込んだ領域誘導になる。
   *
   * mode によって「次の目標」の定義が変わる。
   *   "reward" — 被覆課題。報酬は<strong>踏んだセル</strong>でしか回収できないので、
   *              まだ踏んでいないセルを目標にし、到達可能な全通路を踏んだら終了する。
   *   "goal"   — 探索課題。ゴール位置は未知なので、まだ<strong>見ていない</strong>セルを
   *              目標にし、ゴールが視界に入った時点でそこへ向かう。
   *
   * opts:
   *   mode      "reward"（全域被覆して報酬回収）| "goal"（ゴール到達で終了）
   *   lambda    領域外ペナルティ係数
   *   region    { cx, cy, r }
   *   rewards   Set<key>
   *   goal      { x, y } — mode="goal" のとき必須
   *   maxSteps  歩数の上限
   */
  function microMouseRun(maze, start, opts) {
    const W = maze.width;
    const H = maze.height;
    const N = W * H;
    const layer = maze.layers[0];
    const lambda = opts.lambda || 0;
    const region = opts.region;
    const maxSteps = opts.maxSteps || N * 8;

    const coverage = opts.mode === "reward";
    const known = new Uint8Array(N);
    const wall = new Uint8Array(N);
    const visited = new Uint8Array(N); // 実際に踏んだセル
    const dist = new Int32Array(N);
    const from = new Int32Array(N);
    const stamp = new Int32Array(N);
    const queue = new Int32Array(N);
    let ver = 0;

    // 領域外ペナルティを事前計算しておく（毎回の hypot を避ける）。
    const penalty = new Float64Array(N);
    if (lambda !== 0) {
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          penalty[y * W + x] = lambda * outsideRegion(x, y, region);
        }
      }
    }

    const passable = (id) => known[id] === 0 || wall[id] === 0;

    // 現在地から、未知セルを通行可能とみなした距離場を張る。
    const floodFrom = (originId) => {
      ver += 1;
      stamp[originId] = ver;
      dist[originId] = 0;
      from[originId] = -1;
      queue[0] = originId;
      let head = 0;
      let tail = 1;
      while (head < tail) {
        const c = queue[head];
        head += 1;
        const y = (c / W) | 0;
        const x = c - y * W;
        const nd = dist[c] + 1;
        for (let d = 0; d < 4; d += 1) {
          const dir = A.DIRECTIONS[d];
          const nx = x + dir.x;
          const ny = y + dir.y;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const nid = ny * W + nx;
          if (stamp[nid] === ver || !passable(nid)) continue;
          stamp[nid] = ver;
          dist[nid] = nd;
          from[nid] = c;
          queue[tail] = nid;
          tail += 1;
        }
      }
      return tail;
    };

    // 距離場から目標セルまでの経路（現在地の次のセルから順）を取り出す。
    const pathTo = (targetId) => {
      const out = [];
      let cur = targetId;
      while (cur !== -1 && stamp[cur] === ver) {
        out.push(cur);
        cur = from[cur];
      }
      out.pop(); // 現在地そのものは含めない
      out.reverse();
      return out;
    };

    const startId = start.y * W + start.x;
    const goalId = opts.goal ? opts.goal.y * W + opts.goal.x : -1;

    let pos = startId;
    const trail = [pos];
    const sensed = [];
    let plan = [];
    let target = -1;
    let steps = 0;
    let reachedGoal = false;

    const sense = (id) => {
      const y = (id / W) | 0;
      const x = id - y * W;
      senseIds(layer, W, H, x, y, sensed);
      let changed = false;
      for (const cid of sensed) {
        if (known[cid]) continue;
        known[cid] = 1;
        const cy = (cid / W) | 0;
        const cx = cid - cy * W;
        wall[cid] = layer[cy][cx] === 1 ? 1 : 0;
        changed = true;
      }
      return changed;
    };

    visited[pos] = 1;
    sense(pos);
    if (goalId >= 0 && pos === goalId) reachedGoal = true;

    // 目標候補か。被覆課題は「まだ踏んでいない通路（未知なら通路と楽観視）」、
    // 探索課題は「まだ見ていないセル」。
    const isCandidate = (id) =>
      coverage
        ? visited[id] === 0 && (known[id] === 0 || wall[id] === 0)
        : known[id] === 0;

    // 目標が用済みになったか。
    const targetStale = () => {
      if (target < 0) return true;
      if (target === goalId) return false;
      return !isCandidate(target);
    };

    while (!reachedGoal && steps < maxSteps) {
      // --- 目標の決定（計画が尽きたか、事情が変わったとき） ---
      const goalVisible = goalId >= 0 && known[goalId] === 1 && wall[goalId] === 0;
      const needReplan =
        plan.length === 0 ||
        targetStale() ||
        (goalVisible && target !== goalId) ||
        (plan.length > 0 && known[plan[0]] === 1 && wall[plan[0]] === 1);

      if (needReplan) {
        floodFrom(pos);
        if (goalVisible) {
          target = goalId;
        } else {
          // 候補のうち score 最小のものを次の目標にする。
          let best = -1;
          let bestScore = Infinity;
          for (let id = 0; id < N; id += 1) {
            if (stamp[id] !== ver || !isCandidate(id)) continue;
            const score = dist[id] + (lambda !== 0 ? penalty[id] : 0);
            if (score < bestScore) {
              bestScore = score;
              best = id;
            }
          }
          target = best;
        }
        if (target < 0 || stamp[target] !== ver) break; // 探索完了 or 到達不能
        plan = pathTo(target);
        if (plan.length === 0) break;
      }

      // --- 1 歩進む ---
      const next = plan.shift();
      const ny = (next / W) | 0;
      const nx = next - ny * W;
      if (layer[ny][nx] === 1) {
        // 楽観視が外れた。壁として記録して再計画。
        known[next] = 1;
        wall[next] = 1;
        plan = [];
        continue;
      }
      pos = next;
      steps += 1;
      visited[pos] = 1;
      trail.push(pos);
      sense(pos);
      if (goalId >= 0 && pos === goalId) reachedGoal = true;
    }

    // 実移動列を key 配列にして返す（評価関数と単位を揃える）。
    const trailKeys = trail.map((id) => {
      const y = (id / W) | 0;
      return A.keyFromXYZ(id - y * W, y, 0);
    });

    let coveredCount = 0;
    for (let id = 0; id < N; id += 1) coveredCount += visited[id];

    return {
      steps,
      trail: trailKeys,
      reachedGoal,
      coveredCount,
      exhausted: steps >= maxSteps,
    };
  }

  /**
   * H3 の検証。同じシード集合で「無情報 (λ=0)」と「領域誘導 (λ>0)」を比較する。
   *
   * - 報酬回収: 実移動歩数を横軸にした nAUC / cost@50% / cost@90%
   * - ゴール到達: 真のゴール位置は未知。事前情報は領域 R のみ。到達歩数を比較。
   *
   * ゴールは既定で領域内に置く。goalPlacement="outside" にすると領域外に置き、
   * 事前情報が誤っている場合のコスト（誘導が裏目に出る）を測れる。
   */
  function microMouseStudy(cfg, seeds) {
    const rows = [];

    for (const seed of seeds) {
      const trial = prepareTrial(cfg, seed);
      const maze = trial.maze;
      const region = trial.region;
      const startKey = A.posKey(trial.start);

      // --- ゴールの配置 ---
      const rand = A.makeRng((seed ^ 0x85ebca6b) >>> 0);
      const inside = [];
      const outside = [];
      for (const cell of openCells(maze)) {
        if (A.posKey(cell) === startKey) continue;
        (distToCenter(cell.x, cell.y, region) <= region.r ? inside : outside).push(cell);
      }
      const wantOutside = cfg.goalPlacement === "outside";
      const pool = wantOutside ? outside : inside;
      const fallback = wantOutside ? inside : outside;
      const source = pool.length > 0 ? pool : fallback;
      const goal = source[Math.floor(rand() * source.length)];

      const run = (lambda, mode) =>
        withMaze(maze, () =>
          microMouseRun(maze, trial.start, {
            mode,
            lambda,
            region,
            goal: mode === "goal" ? goal : null,
            maxSteps: maze.width * maze.height * 6,
          }),
        );

      const rewardPlain = run(0, "reward");
      const rewardGuided = run(cfg.lambda, "reward");
      const goalPlain = run(0, "goal");
      const goalGuided = run(cfg.lambda, "goal");

      // 回収曲線は同じ地平（両者の最大歩数）で正規化しないと比較できない。
      const horizon = Math.max(rewardPlain.trail.length, rewardGuided.trail.length);
      rows.push({
        seed,
        goal,
        reward: {
          plain: evaluate(rewardPlain.trail, trial.rewards, horizon),
          guided: evaluate(rewardGuided.trail, trial.rewards, horizon),
          horizon,
        },
        goalReach: {
          plain: goalPlain,
          guided: goalGuided,
        },
      });
    }

    return { rows, summary: summariseMm(rows) };
  }

  /**
   * マイクロマウス試行の集計。歩数の分布は右に長く尾を引くため、平均±sd だけでなく
   * 中央値と「シードごとの勝率」も出す。平均だけ見ると少数の大勝ちで印象が変わる。
   */
  function summariseMm(rows) {
    const stat = (fn, better) => {
      const plain = rows.map((r) => fn(r, "plain"));
      const guided = rows.map((r) => fn(r, "guided"));
      const wins = rows.filter((_, i) =>
        better === "high" ? guided[i] > plain[i] : guided[i] < plain[i],
      ).length;
      return {
        plain: { ...meanSd(plain), median: median(plain) },
        guided: { ...meanSd(guided), median: median(guided) },
        guidedWins: wins,
        n: rows.length,
        better,
      };
    };

    return {
      rewardAuc: stat((r, w) => r.reward[w].nAUC, "high"),
      rewardCost50: stat((r, w) => r.reward[w].cost50, "low"),
      rewardCost90: stat((r, w) => r.reward[w].cost90, "low"),
      goalSteps: stat((r, w) => r.goalReach[w].steps, "low"),
      goalSuccess: {
        plain: rows.filter((r) => r.goalReach.plain.reachedGoal).length,
        guided: rows.filter((r) => r.goalReach.guided.reachedGoal).length,
        n: rows.length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 9. エクスポート用の整形
  // ---------------------------------------------------------------------------

  function sweepToCsv(sweep) {
    const lines = ["angle_deg,gap_to_region_deg,mean_nauc,sd_nauc,n"];
    for (const p of sweep.points) {
      lines.push(
        [p.deg, p.gap.toFixed(2), p.mean.toFixed(6), p.sd.toFixed(6), p.n].join(","),
      );
    }
    for (const [name, stat] of Object.entries(sweep.baselines)) {
      lines.push(`baseline_${name},,${stat.mean.toFixed(6)},${stat.sd.toFixed(6)},${stat.n}`);
    }
    return lines.join("\n");
  }

  function mmToCsv(study) {
    const lines = [
      "seed,reward_nauc_plain,reward_nauc_guided,reward_cost50_plain,reward_cost50_guided,goal_steps_plain,goal_steps_guided,goal_reached_plain,goal_reached_guided",
    ];
    for (const r of study.rows) {
      lines.push(
        [
          r.seed,
          r.reward.plain.nAUC.toFixed(6),
          r.reward.guided.nAUC.toFixed(6),
          r.reward.plain.cost50,
          r.reward.guided.cost50,
          r.goalReach.plain.steps,
          r.goalReach.guided.steps,
          r.goalReach.plain.reachedGoal ? 1 : 0,
          r.goalReach.guided.reachedGoal ? 1 : 0,
        ].join(","),
      );
    }
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // 10. 公開 API
  // ---------------------------------------------------------------------------

  const Lab = {
    LAB_COLORS,
    ALGO_STYLE,
    ALGO_ORDER,
    MM_STYLE,
    biasVector,
    vectorAngle,
    angleGap,
    resolveRegion,
    distToCenter,
    outsideRegion,
    regionBearing,
    generateLabMaze,
    openCells,
    resolveStart,
    withMaze,
    placeRewards,
    orderBfs,
    orderDfs,
    orderDfsN,
    orderGreedy,
    runOrder,
    evaluate,
    meanSd,
    median,
    summariseMm,
    prepareTrial,
    runSingle,
    biasSweep,
    microMouseRun,
    microMouseStudy,
    senseIds,
    sweepToCsv,
    mmToCsv,
  };

  if (IS_NODE) {
    module.exports = Lab;
  } else {
    window.MazeLab = Lab;
  }

  if (!IS_BROWSER) return;

  // ===========================================================================
  // ここから下はブラウザ UI（描画・イベント）
  // ===========================================================================

  const el = (id) => document.getElementById(id);

  // --- タブ切り替え（ページ全体） --------------------------------------------

  function bindTabs() {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    if (tabs.length === 0) return;

    const activate = (tab) => {
      for (const other of tabs) {
        const selected = other === tab;
        other.setAttribute("aria-selected", String(selected));
        other.tabIndex = selected ? 0 : -1;
        const panel = el(other.getAttribute("aria-controls"));
        if (panel) panel.hidden = !selected;
      }
      tab.focus();
      window.dispatchEvent(new CustomEvent(`${tab.id === "tabLab" ? "lab" : "viz"}:activate`));
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => activate(tab));
      tab.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        activate(tabs[(i + step + tabs.length) % tabs.length]);
      });
    });
  }

  bindTabs();

  const ui = {
    status: el("labStatus"),
    canvas: el("labCanvas"),
    curve: el("labCurveCanvas"),
    polar: el("labPolarCanvas"),
    mm: el("labMmCanvas"),
    table: el("labTable"),
    sweepNote: el("labSweepNote"),
    mmTable: el("labMmTable"),
    size: el("labSize"),
    braid: el("labBraid"),
    braidOut: el("labBraidValue"),
    seed: el("labSeed"),
    startMode: el("labStartMode"),
    rewardCount: el("labRewardCount"),
    concentration: el("labConcentration"),
    concentrationOut: el("labConcentrationValue"),
    cx: el("labRegionX"),
    cxOut: el("labRegionXValue"),
    cy: el("labRegionY"),
    cyOut: el("labRegionYValue"),
    radius: el("labRegionR"),
    radiusOut: el("labRegionRValue"),
    bias: el("labBias"),
    biasOut: el("labBiasValue"),
    matchButton: el("labMatchButton"),
    heatSelect: el("labHeatSelect"),
    runButton: el("labRunButton"),
    sweepSeeds: el("labSweepSeeds"),
    sweepButton: el("labSweepButton"),
    mmLambda: el("labMmLambda"),
    mmLambdaOut: el("labMmLambdaValue"),
    goalPlacement: el("labGoalPlacement"),
    mmSeeds: el("labMmSeeds"),
    mmButton: el("labMmButton"),
    stopButton: el("labStopButton"),
    progress: el("labProgress"),
    progressBar: el("labProgressBar"),
    csvSweep: el("labSweepCsv"),
    csvMm: el("labMmCsv"),
    presets: document.querySelectorAll("[data-region-preset]"),
  };

  if (!ui.canvas) return; // ラボ用 DOM が無いページでは何もしない

  /** 試行数（シード数）の上限。これ以上は 1 回の実行が長くなりすぎる。 */
  const MAX_SEEDS = 200;

  const labState = {
    single: null,
    sweep: null,
    mm: null,
    busy: false,
    cancel: false,
  };

  function setLabStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function readConfig() {
    const { width, height } = A.parseSize(ui.size.value);
    const rawSeed = ui.seed.value.trim();
    const seed =
      rawSeed === "" || Number.isNaN(Number(rawSeed))
        ? Math.floor(Math.random() * 0xffffffff) >>> 0
        : Number(rawSeed) >>> 0;
    ui.seed.value = String(seed);

    return {
      width,
      height,
      braid: Number(ui.braid.value) / 100,
      seed,
      startMode: ui.startMode.value,
      rewardCount: Number(ui.rewardCount.value),
      concentration: Number(ui.concentration.value) / 100,
      region: {
        cxPct: Number(ui.cx.value),
        cyPct: Number(ui.cy.value),
        rPct: Number(ui.radius.value),
      },
      biasDegrees: Number(ui.bias.value),
      lambda: Number(ui.mmLambda.value),
      goalPlacement: ui.goalPlacement.value,
      algorithms: ALGO_ORDER,
    };
  }

  // --- Canvas 共通 -----------------------------------------------------------

  /**
   * devicePixelRatio を考慮して論理サイズ cssW×cssH の描画コンテキストを用意する。
   *
   * 高さは px 直指定ではなく aspect-ratio で与える。インラインの height が付くと
   * CSS 側の `max-width: 100%` で横幅だけ縮んだときに高さが追従できず、狭い画面で
   * 図が縦に潰れてしまうため。
   */
  function prepareCanvas(canvas, cssW, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = "auto";
    canvas.style.aspectRatio = `${cssW} / ${cssH}`;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, cssW, cssH);
    return g;
  }

  function heatColor(t) {
    return `hsl(${210 - A.clamp(t, 0, 1) * 210}, 85%, 62%)`;
  }

  // --- 迷路の描画 ------------------------------------------------------------

  const MAZE_TARGET_PX = 520;

  function labCellSize(maze) {
    return Math.max(3, Math.floor(MAZE_TARGET_PX / Math.max(maze.width, maze.height)));
  }

  function drawLabMaze() {
    const single = labState.single;
    if (!single) return;
    const { maze, region, start, rewards } = single;
    const cs = labCellSize(maze);
    const g = prepareCanvas(ui.canvas, maze.width * cs, maze.height * cs);
    const layer = maze.layers[0];

    // 探索順ヒートマップ（選択中の手法）
    const heatName = ui.heatSelect ? ui.heatSelect.value : "dfsn";
    const heatOrder = heatName !== "none" && single.results[heatName]
      ? single.results[heatName].order
      : null;
    const rank = new Map();
    if (heatOrder) heatOrder.forEach((key, i) => rank.set(key, i));
    const totalRank = Math.max(1, heatOrder ? heatOrder.length : 1);

    for (let y = 0; y < maze.height; y += 1) {
      for (let x = 0; x < maze.width; x += 1) {
        let color = LAB_COLORS.path;
        if (layer[y][x] === 1) {
          color = LAB_COLORS.wall;
        } else if (heatOrder) {
          const r = rank.get(A.keyFromXYZ(x, y, 0));
          color = r === undefined ? "#e2e8f0" : heatColor(r / totalRank);
        }
        g.fillStyle = color;
        g.fillRect(x * cs, y * cs, cs, cs);
      }
    }

    // マイクロマウスの実走行経路（あれば）
    if (labState.mmTrail && labState.mmTrail.length > 1) {
      g.strokeStyle = LAB_COLORS.trail;
      g.lineWidth = Math.max(1.5, cs * 0.35);
      g.lineJoin = "round";
      g.lineCap = "round";
      g.globalAlpha = 0.75;
      g.beginPath();
      labState.mmTrail.forEach((key, i) => {
        const p = A.posFromKey(key);
        const px = p.x * cs + cs / 2;
        const py = p.y * cs + cs / 2;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.stroke();
      g.globalAlpha = 1;
    }

    // 報酬領域（破線円）
    g.strokeStyle = LAB_COLORS.region;
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    g.beginPath();
    g.arc((region.cx + 0.5) * cs, (region.cy + 0.5) * cs, region.r * cs, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);

    // 報酬（小さな菱形）
    const rr = Math.max(2, cs * 0.42);
    g.fillStyle = LAB_COLORS.reward;
    g.strokeStyle = "#ffffff";
    g.lineWidth = 1;
    for (const key of rewards) {
      const p = A.posFromKey(key);
      const px = p.x * cs + cs / 2;
      const py = p.y * cs + cs / 2;
      g.beginPath();
      g.moveTo(px, py - rr);
      g.lineTo(px + rr, py);
      g.lineTo(px, py + rr);
      g.lineTo(px - rr, py);
      g.closePath();
      g.fill();
      g.stroke();
    }

    // 探索開始点
    const sx = start.x * cs + cs / 2;
    const sy = start.y * cs + cs / 2;
    const sr = Math.max(4, cs * 0.9);
    g.beginPath();
    g.arc(sx, sy, sr, 0, Math.PI * 2);
    g.fillStyle = LAB_COLORS.start;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = "#ffffff";
    g.stroke();

    // バイアス方位の矢印（スタートから）
    const bias = biasVector(Number(ui.bias.value));
    const arrowLen = Math.max(28, sr * 6);
    const ex = sx + bias.x * arrowLen;
    const ey = sy + bias.y * arrowLen;
    g.strokeStyle = ALGO_STYLE.dfsn.color;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(ex, ey);
    g.stroke();
    const head = 7;
    const ang = Math.atan2(bias.y, bias.x);
    g.fillStyle = ALGO_STYLE.dfsn.color;
    g.beginPath();
    g.moveTo(ex, ey);
    g.lineTo(ex - head * Math.cos(ang - 0.4), ey - head * Math.sin(ang - 0.4));
    g.lineTo(ex - head * Math.cos(ang + 0.4), ey - head * Math.sin(ang + 0.4));
    g.closePath();
    g.fill();
  }

  // --- 図1: 回収曲線 ---------------------------------------------------------

  function drawAxes(g, box, opts) {
    g.strokeStyle = "#cbd5e1";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(box.l, box.t);
    g.lineTo(box.l, box.t + box.h);
    g.lineTo(box.l + box.w, box.t + box.h);
    g.stroke();

    g.font = "11px system-ui, sans-serif";
    g.fillStyle = "#475569";

    g.textAlign = "right";
    g.textBaseline = "middle";
    for (let i = 0; i <= opts.yTicks; i += 1) {
      const v = (opts.yMax * i) / opts.yTicks;
      const y = box.t + box.h * (1 - i / opts.yTicks);
      g.strokeStyle = "#f1f5f9";
      g.beginPath();
      g.moveTo(box.l, y);
      g.lineTo(box.l + box.w, y);
      g.stroke();
      g.fillText(opts.yFormat(v), box.l - 6, y);
    }

    g.textAlign = "center";
    g.textBaseline = "top";
    for (let i = 0; i <= opts.xTicks; i += 1) {
      const v = (opts.xMax * i) / opts.xTicks;
      const x = box.l + (box.w * i) / opts.xTicks;
      g.fillText(opts.xFormat(v), x, box.t + box.h + 6);
    }

    g.fillStyle = "#334155";
    g.font = "11px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(opts.xLabel, box.l + box.w / 2, box.t + box.h + 24);
    g.save();
    g.translate(12, box.t + box.h / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(opts.yLabel, 0, 0);
    g.restore();
  }

  function drawCurveChart() {
    const single = labState.single;
    if (!single || !ui.curve) return;
    const W = 460;
    const H = 300;
    const g = prepareCanvas(ui.curve, W, H);
    const box = { l: 52, t: 14, w: W - 52 - 14, h: H - 14 - 46 };

    drawAxes(g, box, {
      xMax: 100,
      yMax: 100,
      xTicks: 5,
      yTicks: 5,
      xFormat: (v) => `${Math.round(v)}%`,
      yFormat: (v) => `${Math.round(v)}%`,
      xLabel: "探索コスト（展開セル数 / 全通路セル数）",
      yLabel: "報酬回収率",
    });

    for (const name of ALGO_ORDER) {
      const res = single.results[name];
      if (!res) continue;
      const { curve, span } = res.metrics;
      g.strokeStyle = ALGO_STYLE[name].color;
      g.lineWidth = name === "dfsn" ? 2.6 : 1.8;
      g.beginPath();
      const samples = 240;
      for (let i = 0; i <= samples; i += 1) {
        const n = Math.round((span * i) / samples);
        const x = box.l + (box.w * i) / samples;
        const y = box.t + box.h * (1 - curve[n]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }

    // 凡例
    g.font = "11px system-ui, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    let ly = box.t + box.h - 12;
    for (const name of [...ALGO_ORDER].reverse()) {
      if (!single.results[name]) continue;
      const style = ALGO_STYLE[name];
      g.strokeStyle = style.color;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(box.l + box.w - 150, ly);
      g.lineTo(box.l + box.w - 130, ly);
      g.stroke();
      g.fillStyle = "#334155";
      g.fillText(style.label, box.l + box.w - 125, ly);
      ly -= 16;
    }
  }

  // --- 図2: バイアス角スイープ（極座標） -------------------------------------

  function drawPolarChart() {
    const sweep = labState.sweep;
    if (!sweep || !ui.polar) return;
    const W = 460;
    const H = 380;
    const g = prepareCanvas(ui.polar, W, H);
    const cx = W / 2;
    const cy = H / 2 + 6;
    const rMax = Math.min(W, H) / 2 - 52;

    const values = sweep.points.map((p) => p.mean);
    const bfs = sweep.baselines.bfs.mean;
    const lo = Math.min(...values, bfs);
    const hi = Math.max(...values, bfs);
    // 差が小さいので原点は 0 にしない。内側リングの値を必ずラベルする。
    const pad = Math.max(0.01, (hi - lo) * 0.35);
    const vMin = Math.max(0, lo - pad);
    const vMax = hi + pad * 0.5;
    const radial = (v) => (rMax * (v - vMin)) / (vMax - vMin || 1);

    // 同心リング
    g.font = "10px system-ui, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    for (let i = 1; i <= 4; i += 1) {
      const v = vMin + ((vMax - vMin) * i) / 4;
      g.strokeStyle = i === 4 ? "#cbd5e1" : "#eef2f7";
      g.beginPath();
      g.arc(cx, cy, radial(v), 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = "#94a3b8";
      g.fillText(v.toFixed(3), cx + 3, cy - radial(v));
    }

    // 方位の目盛
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (let deg = 0; deg < 360; deg += 45) {
      const b = biasVector(deg);
      g.strokeStyle = "#eef2f7";
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + b.x * rMax, cy + b.y * rMax);
      g.stroke();
      g.fillStyle = "#64748b";
      g.fillText(`${deg}°`, cx + b.x * (rMax + 16), cy + b.y * (rMax + 16));
    }

    // BFS の等方基準円
    g.strokeStyle = ALGO_STYLE.bfs.color;
    g.setLineDash([5, 4]);
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, radial(bfs), 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);

    // 報酬領域の方位
    const bear = biasVector(sweep.bearing);
    g.strokeStyle = LAB_COLORS.region;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + bear.x * rMax, cy + bear.y * rMax);
    g.stroke();

    // DFS-N の nAUC（±sd をリボンで）
    const at = (deg, v) => {
      const b = biasVector(deg);
      return [cx + b.x * radial(v), cy + b.y * radial(v)];
    };
    g.fillStyle = "rgba(249, 115, 22, 0.18)";
    g.beginPath();
    sweep.points.forEach((p, i) => {
      const [x, y] = at(p.deg, A.clamp(p.mean + p.sd, vMin, vMax));
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    for (let i = sweep.points.length - 1; i >= 0; i -= 1) {
      const p = sweep.points[i];
      const [x, y] = at(p.deg, A.clamp(p.mean - p.sd, vMin, vMax));
      g.lineTo(x, y);
    }
    g.closePath();
    g.fill();

    g.strokeStyle = ALGO_STYLE.dfsn.color;
    g.lineWidth = 2.6;
    g.beginPath();
    sweep.points.forEach((p, i) => {
      const [x, y] = at(p.deg, p.mean);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.closePath();
    g.stroke();

    g.fillStyle = ALGO_STYLE.dfsn.color;
    for (const p of sweep.points) {
      const [x, y] = at(p.deg, p.mean);
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }

    // 凡例
    g.font = "11px system-ui, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    const legend = [
      [ALGO_STYLE.dfsn.color, "DFS-N の nAUC（±sd）"],
      [ALGO_STYLE.bfs.color, "BFS ベースライン（等方）"],
      [LAB_COLORS.region, `報酬領域の方位 ${sweep.bearing.toFixed(0)}°`],
    ];
    legend.forEach(([color, text], i) => {
      const y = 14 + i * 15;
      g.strokeStyle = color;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(10, y);
      g.lineTo(28, y);
      g.stroke();
      g.fillStyle = "#334155";
      g.fillText(text, 33, y);
    });
  }

  // --- 図3: マイクロマウス比較（棒グラフ） -----------------------------------

  function drawMmChart() {
    const study = labState.mm;
    if (!study || !ui.mm) return;
    const W = 460;
    const H = 300;
    const g = prepareCanvas(ui.mm, W, H);
    const box = { l: 56, t: 16, w: W - 56 - 16, h: H - 16 - 58 };

    const s = study.summary;
    const groups = [
      {
        label: "報酬 nAUC\n(大きいほど良)",
        plain: s.rewardAuc.plain,
        guided: s.rewardAuc.guided,
        norm: Math.max(s.rewardAuc.plain.mean, s.rewardAuc.guided.mean),
        fmt: (v) => v.toFixed(3),
      },
      {
        label: "50%回収歩数\n(小さいほど良)",
        plain: s.rewardCost50.plain,
        guided: s.rewardCost50.guided,
        norm: Math.max(s.rewardCost50.plain.mean, s.rewardCost50.guided.mean),
        fmt: (v) => Math.round(v).toLocaleString("ja-JP"),
      },
      {
        label: "ゴール到達歩数\n(小さいほど良)",
        plain: s.goalSteps.plain,
        guided: s.goalSteps.guided,
        norm: Math.max(s.goalSteps.plain.mean, s.goalSteps.guided.mean),
        fmt: (v) => Math.round(v).toLocaleString("ja-JP"),
      },
    ];

    // 指標ごとに単位が違うため、各群内で最大値=1 に正規化して並べる。
    g.strokeStyle = "#cbd5e1";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(box.l, box.t);
    g.lineTo(box.l, box.t + box.h);
    g.lineTo(box.l + box.w, box.t + box.h);
    g.stroke();

    const gw = box.w / groups.length;
    const bw = Math.min(38, gw / 3.4);
    g.font = "10px system-ui, sans-serif";

    groups.forEach((grp, gi) => {
      const base = box.l + gw * gi + gw / 2;
      [
        ["plain", -1],
        ["guided", 1],
      ].forEach(([which, side]) => {
        const stat = grp[which];
        const ratio = grp.norm > 0 ? stat.mean / grp.norm : 0;
        const h = box.h * ratio * 0.92;
        const x = base + side * (bw / 2 + 3) - bw / 2;
        const y = box.t + box.h - h;
        g.fillStyle = MM_STYLE[which].color;
        g.fillRect(x, y, bw, h);

        // 誤差棒（±sd）
        if (stat.sd > 0 && grp.norm > 0) {
          const eh = (box.h * (stat.sd / grp.norm)) * 0.92;
          g.strokeStyle = "#0f172a";
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x + bw / 2, y - eh);
          g.lineTo(x + bw / 2, Math.min(box.t + box.h, y + eh));
          g.moveTo(x + bw / 2 - 4, y - eh);
          g.lineTo(x + bw / 2 + 4, y - eh);
          g.stroke();
        }

        g.fillStyle = "#334155";
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillText(grp.fmt(stat.mean), x + bw / 2, y - 4);
      });

      g.fillStyle = "#475569";
      g.textAlign = "center";
      g.textBaseline = "top";
      grp.label.split("\n").forEach((line, li) => {
        g.fillText(line, base, box.t + box.h + 6 + li * 13);
      });
    });

    g.textAlign = "left";
    g.textBaseline = "middle";
    Object.entries(MM_STYLE).forEach(([key, style], i) => {
      const y = 16 + i * 15;
      g.fillStyle = style.color;
      g.fillRect(box.l + box.w - 150, y - 5, 12, 10);
      g.fillStyle = "#334155";
      g.fillText(style.label, box.l + box.w - 134, y);
    });

    g.fillStyle = "#94a3b8";
    g.textAlign = "left";
    g.fillText("※ 群ごとに単位が異なるため群内最大値で正規化", box.l, H - 10);
  }

  // --- テーブル --------------------------------------------------------------

  function fmtPct(v) {
    return `${(v * 100).toFixed(1)}%`;
  }

  function renderSingleTable() {
    const single = labState.single;
    if (!single || !ui.table) return;
    const span = single.results.bfs
      ? single.results.bfs.metrics.span
      : Object.values(single.results)[0].metrics.span;

    const rows = ALGO_ORDER.filter((n) => single.results[n]).map((name) => {
      const m = single.results[name].metrics;
      const rel = single.results.bfs
        ? m.nAUC / single.results.bfs.metrics.nAUC - 1
        : 0;
      return `<tr>
        <th scope="row"><span class="swatch" style="background:${ALGO_STYLE[name].color}"></span>${ALGO_STYLE[name].label}</th>
        <td class="num">${m.nAUC.toFixed(4)}</td>
        <td class="num ${rel > 0 ? "good" : rel < 0 ? "bad" : ""}">${single.results.bfs ? `${rel >= 0 ? "+" : ""}${(rel * 100).toFixed(1)}%` : "—"}</td>
        <td class="num">${fmtPct(m.costFirst / span)}</td>
        <td class="num">${fmtPct(m.cost50 / span)}</td>
        <td class="num">${fmtPct(m.cost90 / span)}</td>
      </tr>`;
    });

    ui.table.innerHTML = `
      <table class="lab-table">
        <caption>表1: 単発試行の指標（シード ${single.seed}／通路セル ${span.toLocaleString("ja-JP")}／報酬 ${single.rewards.size} 個、うち領域内 ${single.rewardMeta.insideCount} 個）</caption>
        <thead><tr>
          <th scope="col">手法</th>
          <th scope="col">nAUC</th>
          <th scope="col">BFS比</th>
          <th scope="col">初回収</th>
          <th scope="col">50%回収</th>
          <th scope="col">90%回収</th>
        </tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
      <p class="field-help">nAUC は回収曲線の下面積（0〜1、大きいほど早く回収）。回収コストは全通路セル数に対する割合。
      報酬領域の方位は探索開始点から見て ${single.bearing.toFixed(0)}°、現在のバイアスは ${ui.bias.value}°（ずれ ${angleGap(Number(ui.bias.value), single.bearing).toFixed(0)}°）。</p>`;
  }

  function renderMmTable() {
    const study = labState.mm;
    if (!study || !ui.mmTable) return;
    const s = study.summary;
    const line = (label, stat, fmt) => {
      const p = stat.plain;
      const gd = stat.guided;
      const diff = stat.better === "high" ? gd.mean - p.mean : p.mean - gd.mean;
      const rel = p.mean !== 0 ? (diff / Math.abs(p.mean)) * 100 : 0;
      const winPct = (stat.guidedWins / stat.n) * 100;
      return `<tr>
        <th scope="row">${label}</th>
        <td class="num">${fmt(p.mean)} <span class="sd">±${fmt(p.sd)}</span><br><span class="sd">中央値 ${fmt(p.median)}</span></td>
        <td class="num">${fmt(gd.mean)} <span class="sd">±${fmt(gd.sd)}</span><br><span class="sd">中央値 ${fmt(gd.median)}</span></td>
        <td class="num ${rel > 0 ? "good" : rel < 0 ? "bad" : ""}">${rel >= 0 ? "+" : ""}${rel.toFixed(1)}%</td>
        <td class="num ${winPct > 50 ? "good" : winPct < 50 ? "bad" : ""}">${stat.guidedWins}/${stat.n}<br><span class="sd">${winPct.toFixed(0)}%</span></td>
      </tr>`;
    };
    const int = (v) => Math.round(v).toLocaleString("ja-JP");
    const f3 = (v) => v.toFixed(3);

    ui.mmTable.innerHTML = `
      <table class="lab-table">
        <caption>表2: マイクロマウス型の比較（${study.rows.length} 試行 / シード、単位は<strong>実移動歩数</strong>）</caption>
        <thead><tr>
          <th scope="col">指標</th>
          <th scope="col">無情報 λ=0</th>
          <th scope="col">領域誘導 λ&gt;0</th>
          <th scope="col">平均改善</th>
          <th scope="col">誘導の勝率</th>
        </tr></thead>
        <tbody>
          ${line("報酬 nAUC（大きいほど良）", s.rewardAuc, f3)}
          ${line("50% 回収歩数（小さいほど良）", s.rewardCost50, int)}
          ${line("90% 回収歩数（小さいほど良）", s.rewardCost90, int)}
          ${line("ゴール到達歩数（小さいほど良）", s.goalSteps, int)}
        </tbody>
      </table>
      <p class="field-help">ゴール到達成功: 無情報 ${s.goalSuccess.plain}/${s.goalSuccess.n}、領域誘導 ${s.goalSuccess.guided}/${s.goalSuccess.n}。
      ゴール配置は「${ui.goalPlacement.value === "outside" ? "領域外（事前情報が誤り）" : "領域内（事前情報が正しい）"}」。
      歩数の分布は右に長く尾を引くため、平均だけでなく中央値と勝率も併記しています。
      平均改善が大きくても勝率が 50% 前後なら、少数のシードでの大勝ちが効いているだけかもしれません。</p>`;
  }

  // --- 進捗と非同期チャンク --------------------------------------------------

  function showProgress(done, total) {
    if (!ui.progress) return;
    ui.progress.hidden = false;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    ui.progress.setAttribute("aria-valuenow", String(pct));
    ui.progressBar.style.width = `${pct}%`;
  }

  function hideProgress() {
    if (!ui.progress) return;
    ui.progress.hidden = true;
    ui.progressBar.style.width = "0%";
  }

  /**
   * UI を固まらせないよう、重い反復を時間予算で区切って回す。
   * 中止された場合はそこで打ち切り、完了した反復数を返す（部分集計に使う）。
   */
  async function chunked(count, step, onProgress) {
    let i = 0;
    while (i < count && !labState.cancel) {
      const deadline = performance.now() + 24;
      while (i < count && !labState.cancel && performance.now() < deadline) {
        step(i);
        i += 1;
      }
      if (onProgress) onProgress(i, count);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return i;
  }

  function setBusy(busy) {
    labState.busy = busy;
    if (busy) labState.cancel = false;
    [ui.runButton, ui.sweepButton, ui.mmButton].forEach((b) => {
      if (b) b.disabled = busy;
    });
    if (ui.stopButton) {
      ui.stopButton.hidden = !busy;
      ui.stopButton.disabled = !busy;
    }
  }

  function seedList(baseSeed, count) {
    const rand = A.makeRng(baseSeed >>> 0);
    return Array.from({ length: count }, () => Math.floor(rand() * 0xffffffff) >>> 0);
  }

  /**
   * 試行数の読み取り。空欄や不正値は既定値に落とし、1〜MAX_SEEDS に丸めて
   * 入力欄へ書き戻す（丸めた結果が UI と食い違わないように）。
   */
  function readSeedCount(input, fallback) {
    if (!input) return fallback;
    const text = String(input.value).trim();
    const raw = Number(text);
    const count = text !== "" && Number.isFinite(raw) ? Math.round(raw) : fallback;
    const clamped = A.clamp(count, 1, MAX_SEEDS);
    input.value = String(clamped);
    return clamped;
  }

  // --- アクション ------------------------------------------------------------

  function runSingleTrial() {
    if (labState.busy) return;
    const cfg = readConfig();
    setLabStatus("単発試行を実行中...");
    const single = runSingle(cfg, cfg.seed);
    labState.single = single;
    labState.mmTrail = null;
    drawLabMaze();
    drawCurveChart();
    renderSingleTable();
    const gap = angleGap(cfg.biasDegrees, single.bearing);
    const rel = single.results.dfsn.metrics.nAUC / single.results.bfs.metrics.nAUC - 1;
    setLabStatus(
      `単発完了: DFS-N は BFS 比 ${rel >= 0 ? "+" : ""}${(rel * 100).toFixed(1)}%（方位ずれ ${gap.toFixed(0)}°）`,
    );
  }

  async function runSweepAction() {
    if (labState.busy) return;
    setBusy(true);
    const cfg = readConfig();
    const seedCount = readSeedCount(ui.sweepSeeds, 8);
    const seeds = seedList(cfg.seed, seedCount);
    const angles = Array.from({ length: 16 }, (_, i) => i * 22.5);
    setLabStatus(`バイアス角スイープ: ${seeds.length} 試行 × ${angles.length} 方位...`);

    // シードごとにチャンク実行して進捗を出す。
    const perAngle = angles.map(() => []);
    const baselines = { bfs: [], dfs: [], greedy: [] };
    const bearings = [];

    try {
      const done = await chunked(
        seeds.length,
        (i) => {
          const partial = biasSweep(cfg, [seeds[i]], angles);
          partial.points.forEach((p, ai) => perAngle[ai].push(p.mean));
          for (const name of Object.keys(baselines)) {
            baselines[name].push(partial.baselines[name].mean);
          }
          bearings.push(partial.bearing);
        },
        (finished, total) => {
          showProgress(finished, total);
          setLabStatus(`バイアス角スイープ: ${finished} / ${total} 試行`);
        },
      );

      if (done === 0) {
        setLabStatus("バイアス角スイープを中止しました（結果なし）");
        return;
      }

      const bearingStats = meanSd(bearings);
      labState.sweep = {
        angles,
        points: angles.map((deg, i) => ({
          deg,
          gap: angleGap(deg, bearingStats.mean),
          ...meanSd(perAngle[i]),
        })),
        baselines: Object.fromEntries(
          Object.entries(baselines).map(([k, v]) => [k, meanSd(v)]),
        ),
        bearing: bearingStats.mean,
        seeds: seeds.slice(0, done),
      };
      drawPolarChart();
      renderSweepNote();
      const best = labState.sweep.points.reduce((a, b) => (b.mean > a.mean ? b : a));
      const head = done < seeds.length ? `スイープ中止（${done}/${seeds.length} 試行）: ` : "スイープ完了: ";
      setLabStatus(
        `${head}最良バイアス ${best.deg}°（領域方位 ${bearingStats.mean.toFixed(0)}° とのずれ ${best.gap.toFixed(0)}°）`,
      );
    } finally {
      hideProgress();
      setBusy(false);
      if (ui.csvSweep) ui.csvSweep.disabled = !labState.sweep;
    }
  }

  function renderSweepNote() {
    const sweep = labState.sweep;
    if (!sweep || !ui.sweepNote) return;
    const best = sweep.points.reduce((a, b) => (b.mean > a.mean ? b : a));
    const worst = sweep.points.reduce((a, b) => (b.mean < a.mean ? b : a));
    const bfs = sweep.baselines.bfs;
    const dfs = sweep.baselines.dfs;
    const winsBfs = sweep.points.filter((p) => p.mean > bfs.mean).length;
    const winsDfs = sweep.points.filter((p) => p.mean > dfs.mean).length;
    const rel = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

    ui.sweepNote.innerHTML = `
      <table class="lab-table">
        <caption>表3: バイアス角スイープの要約（${sweep.seeds.length} 試行 / シード）</caption>
        <thead><tr><th scope="col">条件</th><th scope="col">nAUC 平均</th><th scope="col">±sd</th><th scope="col">BFS比</th><th scope="col">等方DFS比</th></tr></thead>
        <tbody>
          <tr><th scope="row">DFS-N 最良 ${best.deg}°（ずれ ${best.gap.toFixed(0)}°）</th><td class="num">${best.mean.toFixed(4)}</td><td class="num">${best.sd.toFixed(4)}</td><td class="num good">${rel(best.mean / bfs.mean - 1)}</td><td class="num ${best.mean > dfs.mean ? "good" : "bad"}">${rel(best.mean / dfs.mean - 1)}</td></tr>
          <tr><th scope="row">DFS-N 最悪 ${worst.deg}°（ずれ ${worst.gap.toFixed(0)}°）</th><td class="num">${worst.mean.toFixed(4)}</td><td class="num">${worst.sd.toFixed(4)}</td><td class="num ${worst.mean < bfs.mean ? "bad" : ""}">${rel(worst.mean / bfs.mean - 1)}</td><td class="num ${worst.mean < dfs.mean ? "bad" : ""}">${rel(worst.mean / dfs.mean - 1)}</td></tr>
          <tr><th scope="row">BFS（幅優先の対照）</th><td class="num">${bfs.mean.toFixed(4)}</td><td class="num">${bfs.sd.toFixed(4)}</td><td class="num">—</td><td class="num">${rel(bfs.mean / dfs.mean - 1)}</td></tr>
          <tr><th scope="row">DFS（等方・順序ランダム）</th><td class="num">${dfs.mean.toFixed(4)}</td><td class="num">${dfs.sd.toFixed(4)}</td><td class="num">${rel(dfs.mean / bfs.mean - 1)}</td><td class="num">—</td></tr>
          <tr><th scope="row">Greedy-領域（参考上限）</th><td class="num">${sweep.baselines.greedy.mean.toFixed(4)}</td><td class="num">${sweep.baselines.greedy.sd.toFixed(4)}</td><td class="num">${rel(sweep.baselines.greedy.mean / bfs.mean - 1)}</td><td class="num">${rel(sweep.baselines.greedy.mean / dfs.mean - 1)}</td></tr>
        </tbody>
      </table>
      <p class="field-help"><strong>効果の切り分け</strong>: ${sweep.points.length} 方位のうち ${winsBfs} 方位が BFS を、${winsDfs} 方位が等方 DFS を上回りました。
      BFS との差には「深さ優先だから速い」分が混ざっています。<strong>方位バイアスそのものの効果</strong>は
      「等方DFS比」の列、および最良方位と最悪方位の差（${rel(best.mean / worst.mean - 1)}）で読んでください。
      なお 4 近傍格子では近傍の並び順が 45° ごとにしか変わらないため、曲線は階段状になります。
      DFS-N は最短経路を保証しません。本実験が問うのは「報酬回収の早さ」だけです。</p>`;
  }

  async function runMmAction() {
    if (labState.busy) return;
    setBusy(true);
    const cfg = readConfig();
    const seedCount = readSeedCount(ui.mmSeeds || ui.sweepSeeds, 8);
    const seeds = seedList(cfg.seed ^ 0x1234567, seedCount);
    setLabStatus(`マイクロマウス検証: ${seeds.length} 試行...`);

    const rows = [];
    try {
      const done = await chunked(
        seeds.length,
        (i) => {
          const part = microMouseStudy(cfg, [seeds[i]]);
          rows.push(...part.rows);
        },
        (finished, total) => {
          showProgress(finished, total);
          setLabStatus(`マイクロマウス検証: ${finished} / ${total} 試行`);
        },
      );

      if (rows.length === 0) {
        setLabStatus("マイクロマウス検証を中止しました（結果なし）");
        return;
      }

      labState.mm = {
        rows,
        summary: summariseMm(rows),
        cancelled: done < seeds.length,
        requested: seeds.length,
      };
      drawMmChart();
      renderMmTable();

      // 代表 1 本の走行経路を迷路に重ねる（領域誘導のゴール到達）。
      if (labState.single) {
        const trial = prepareTrial(cfg, labState.single.seed);
        const goalPool = openCells(trial.maze).filter(
          (c) => distToCenter(c.x, c.y, trial.region) <= trial.region.r,
        );
        if (goalPool.length > 0) {
          const run = withMaze(trial.maze, () =>
            microMouseRun(trial.maze, trial.start, {
              mode: "goal",
              lambda: cfg.lambda,
              region: trial.region,
              goal: goalPool[Math.floor(goalPool.length / 2)],
              maxSteps: trial.maze.width * trial.maze.height * 6,
            }),
          );
          labState.mmTrail = run.trail;
          drawLabMaze();
        }
      }

      const s = labState.mm.summary.goalSteps;
      const rel = s.plain.mean !== 0 ? (1 - s.guided.mean / s.plain.mean) * 100 : 0;
      const head = labState.mm.cancelled
        ? `マイクロマウス中止（${s.n}/${labState.mm.requested} 試行）: `
        : "マイクロマウス完了: ";
      setLabStatus(
        `${head}領域誘導のゴール到達歩数は無情報より ` +
          `${Math.abs(rel).toFixed(1)}% ${rel >= 0 ? "少ない" : "多い"}` +
          `（勝率 ${s.guidedWins}/${s.n}）`,
      );
    } finally {
      hideProgress();
      setBusy(false);
      if (ui.csvMm) ui.csvMm.disabled = !labState.mm;
    }
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // --- イベント --------------------------------------------------------------

  function syncOutput(input, out, format) {
    if (!input || !out) return;
    const update = () => {
      out.textContent = format(input.value);
    };
    input.addEventListener("input", update);
    update();
  }

  function bindLabEvents() {
    syncOutput(ui.braid, ui.braidOut, (v) => `${v}%`);
    syncOutput(ui.concentration, ui.concentrationOut, (v) => `${v}%`);
    syncOutput(ui.cx, ui.cxOut, (v) => `${v}%`);
    syncOutput(ui.cy, ui.cyOut, (v) => `${v}%`);
    syncOutput(ui.radius, ui.radiusOut, (v) => `${v}%`);
    syncOutput(ui.bias, ui.biasOut, (v) => `${v}°`);
    syncOutput(ui.mmLambda, ui.mmLambdaOut, (v) => Number(v).toFixed(1));

    ui.runButton.addEventListener("click", runSingleTrial);
    ui.sweepButton.addEventListener("click", runSweepAction);
    ui.mmButton.addEventListener("click", runMmAction);

    if (ui.stopButton) {
      ui.stopButton.addEventListener("click", () => {
        if (!labState.busy) return;
        labState.cancel = true;
        ui.stopButton.disabled = true;
        setLabStatus("中止しています（ここまでの試行で集計します）...");
      });
    }

    if (ui.heatSelect) ui.heatSelect.addEventListener("change", drawLabMaze);

    // ドラッグ中（input）は迷路の重ね描きだけを更新して軽く追従させ、
    // 手を離した時点（change）で試行そのものをやり直して図表を揃える。
    // 報酬の配置は領域に依存するため、プレビューのまま放置すると表示が食い違う。
    if (ui.bias) {
      ui.bias.addEventListener("input", drawLabMaze);
      ui.bias.addEventListener("change", runSingleTrial);
    }
    [ui.cx, ui.cy, ui.radius].forEach((input) => {
      if (!input) return;
      input.addEventListener("input", () => {
        if (!labState.single) return;
        labState.single.region = resolveRegion(
          labState.single.maze.width,
          labState.single.maze.height,
          readRegionOnly(),
        );
        drawLabMaze();
      });
      input.addEventListener("change", runSingleTrial);
    });
    [ui.size, ui.braid, ui.seed, ui.startMode, ui.rewardCount, ui.concentration].forEach(
      (input) => {
        if (input) input.addEventListener("change", runSingleTrial);
      },
    );

    // 領域プリセット（右上・右下など）
    ui.presets.forEach((button) => {
      button.addEventListener("click", () => {
        const [cx, cy] = button.dataset.regionPreset.split(",").map(Number);
        ui.cx.value = String(cx);
        ui.cy.value = String(cy);
        ui.cx.dispatchEvent(new Event("input"));
        ui.cy.dispatchEvent(new Event("input"));
        runSingleTrial();
      });
    });

    // 「バイアスを領域方位に合わせる」
    if (ui.matchButton) {
      ui.matchButton.addEventListener("click", () => {
        if (!labState.single) runSingleTrial();
        const bearing = labState.single.bearing;
        ui.bias.value = String(Math.round(bearing / 15) * 15);
        ui.bias.dispatchEvent(new Event("input"));
        runSingleTrial();
      });
    }

    // 迷路をクリックして領域中心を置く
    ui.canvas.addEventListener("click", (event) => {
      if (!labState.single) return;
      const rect = ui.canvas.getBoundingClientRect();
      const cs = labCellSize(labState.single.maze);
      const x = ((event.clientX - rect.left) / rect.width) * (labState.single.maze.width * cs);
      const y = ((event.clientY - rect.top) / rect.height) * (labState.single.maze.height * cs);
      ui.cx.value = String(
        Math.round(A.clamp((x / cs / (labState.single.maze.width - 1)) * 100, 0, 100)),
      );
      ui.cy.value = String(
        Math.round(A.clamp((y / cs / (labState.single.maze.height - 1)) * 100, 0, 100)),
      );
      ui.cx.dispatchEvent(new Event("input"));
      ui.cy.dispatchEvent(new Event("input"));
      runSingleTrial();
    });

    if (ui.csvSweep) {
      ui.csvSweep.addEventListener("click", () => {
        if (labState.sweep) download("dfsn_bias_sweep.csv", sweepToCsv(labState.sweep));
      });
    }
    if (ui.csvMm) {
      ui.csvMm.addEventListener("click", () => {
        if (labState.mm) download("micromouse_study.csv", mmToCsv(labState.mm));
      });
    }
  }

  function readRegionOnly() {
    return {
      cxPct: Number(ui.cx.value),
      cyPct: Number(ui.cy.value),
      rPct: Number(ui.radius.value),
    };
  }

  bindLabEvents();

  // ラボタブが最初に開かれたときに初期試行を走らせる。
  let initialised = false;
  window.addEventListener("lab:activate", () => {
    if (initialised) return;
    initialised = true;
    runSingleTrial();
  });
})();
