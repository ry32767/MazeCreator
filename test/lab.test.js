"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("../app.js");
const lab = require("../lab.js");

// --- ヘルパー ----------------------------------------------------------------

/** 壁のない開けた盤面のスナップショット（優先順位そのものを検証するため）。 */
function openField(size) {
  const layer = Array.from({ length: size }, () => Array(size).fill(0));
  return {
    width: size,
    height: size,
    floorCount: 1,
    cellSize: 6,
    seed: 1,
    braid: 0,
    stairDensity: 1,
    generationAttempts: 1,
    layers: [layer],
    stairsByKey: new Map(),
    start: { x: 1, y: 1, z: 0 },
    goal: { x: size - 2, y: size - 2, z: 0 },
    player: { x: 1, y: 1, z: 0 },
  };
}

/** 実験設定の既定値。テストごとに上書きして使う。 */
function baseConfig(overrides) {
  return {
    width: 33,
    height: 33,
    braid: 0,
    startMode: "center",
    rewardCount: 30,
    concentration: 0.9,
    region: { cxPct: 80, cyPct: 20, rPct: 22 },
    biasDegrees: 45,
    lambda: 2,
    goalPlacement: "inside",
    algorithms: ["bfs", "dfsn"],
    ...overrides,
  };
}

function seeds(count, base = 12345) {
  const rand = app.makeRng(base);
  return Array.from({ length: count }, () => Math.floor(rand() * 0xffffffff) >>> 0);
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// --- 1. 幾何 -----------------------------------------------------------------

test("方位角は数学慣習（0°=右, 90°=上）で、y 下向きグリッドへ正しく変換される", () => {
  const right = lab.biasVector(0);
  assert.ok(Math.abs(right.x - 1) < 1e-9);
  assert.ok(Math.abs(right.y) < 1e-9);

  const up = lab.biasVector(90);
  assert.ok(Math.abs(up.x) < 1e-9);
  assert.ok(Math.abs(up.y + 1) < 1e-9, "90° は y が負（画面上方向）になる");

  const upRight = lab.biasVector(45);
  assert.ok(upRight.x > 0 && upRight.y < 0, "45° は右上");

  // vectorAngle は biasVector の逆変換
  for (const deg of [0, 30, 90, 135, 200, 315]) {
    const v = lab.biasVector(deg);
    assert.ok(Math.abs(lab.vectorAngle(v.x, v.y) - deg) < 1e-6);
  }
});

test("angleGap は 0..180 に畳まれる", () => {
  assert.equal(lab.angleGap(10, 350), 20);
  assert.equal(lab.angleGap(0, 180), 180);
  assert.equal(lab.angleGap(90, 90), 0);
  assert.equal(lab.angleGap(350, 10), 20);
});

test("resolveRegion は百分率をセル座標の円に変換する", () => {
  const region = lab.resolveRegion(101, 51, { cxPct: 50, cyPct: 0, rPct: 20 });
  assert.equal(region.cx, 50);
  assert.equal(region.cy, 0);
  assert.ok(Math.abs(region.r - 51 * 0.2) < 1e-9, "半径は短辺基準");
});

// --- 2. state の退避と復元 ---------------------------------------------------

test("withMaze は共有 state を必ず元に戻す", () => {
  const before = {
    width: app.state.width,
    height: app.state.height,
    floorCount: app.state.floorCount,
    layers: app.state.layers,
  };
  const field = openField(9);

  const inside = lab.withMaze(field, () => app.state.width);
  assert.equal(inside, 9, "実行中はラボ迷路が載っている");

  assert.equal(app.state.width, before.width);
  assert.equal(app.state.height, before.height);
  assert.equal(app.state.floorCount, before.floorCount);
  assert.equal(app.state.layers, before.layers);

  // 例外が飛んでも復元される
  assert.throws(() => {
    lab.withMaze(field, () => {
      throw new Error("boom");
    });
  }, /boom/);
  assert.equal(app.state.width, before.width);
  assert.equal(app.state.layers, before.layers);
});

test("generateLabMaze は 1 階層の迷路を作り、同じシードで再現する", () => {
  const a = lab.generateLabMaze({ seed: 777, width: 21, height: 21, braid: 0 });
  const b = lab.generateLabMaze({ seed: 777, width: 21, height: 21, braid: 0 });
  assert.equal(a.floorCount, 1);
  assert.equal(a.stairsByKey.size, 0, "1 階層なら階段は存在しない");
  assert.deepEqual(a.layers[0], b.layers[0], "同じシードなら同じ迷路");

  const c = lab.generateLabMaze({ seed: 778, width: 21, height: 21, braid: 0 });
  assert.notDeepEqual(a.layers[0], c.layers[0], "違うシードなら違う迷路");
});

// --- 3. DFS-N の探索優先順位 -------------------------------------------------

test("DFS-N はバイアス方位の近傍を先に展開する（開けた盤面での決定的な順序）", () => {
  const field = openField(9);
  const start = { x: 4, y: 4, z: 0 };

  // 20°: 右が単独最優先（同点なし）。右端まで伸びる。
  const right = lab.withMaze(field, () => lab.orderDfsN(start, 20));
  assert.deepEqual(right.slice(0, 5), ["4,4,0", "5,4,0", "6,4,0", "7,4,0", "8,4,0"]);

  // 70°: 上が単独最優先。上端まで登ってから、2 位の右へ抜ける。
  const up = lab.withMaze(field, () => lab.orderDfsN(start, 70));
  assert.deepEqual(
    up.slice(0, 9),
    ["4,4,0", "4,3,0", "4,2,0", "4,1,0", "4,0,0", "5,0,0", "6,0,0", "7,0,0", "8,0,0"],
    "上バイアスは上→（2位の）右の順に伸びる",
  );

  // 200°: 左が単独最優先。
  const left = lab.withMaze(field, () => lab.orderDfsN(start, 200));
  assert.deepEqual(left.slice(0, 5), ["4,4,0", "3,4,0", "2,4,0", "1,4,0", "0,4,0"]);

  // 290°: 下が単独最優先。
  const down = lab.withMaze(field, () => lab.orderDfsN(start, 290));
  assert.deepEqual(down.slice(0, 5), ["4,4,0", "4,5,0", "4,6,0", "4,7,0", "4,8,0"]);
});

test("DFS-N の同点解消は乱数で、45° の倍数でも特定方向に固定されない", () => {
  const field = openField(21);
  const start = { x: 10, y: 10, z: 0 };

  // 45° では上と右が厳密に同点。シードを変えれば最初の一歩も変わりうる。
  const firstMoves = new Set();
  for (let seed = 1; seed <= 30; seed += 1) {
    const order = lab.withMaze(field, () => lab.orderDfsN(start, 45, seed));
    firstMoves.add(order[1]);
  }
  assert.deepEqual(
    [...firstMoves].sort(),
    ["10,9,0", "11,10,0"],
    "同点の上と右の両方が出る（片方に固定されない）",
  );
});

test("対照の DFS は等方（向きを持たない）で、シードを固定すれば再現する", () => {
  const field = openField(21);
  const start = { x: 10, y: 10, z: 0 };

  const a = lab.withMaze(field, () => lab.orderDfs(start, 7));
  const b = lab.withMaze(field, () => lab.orderDfs(start, 7));
  assert.deepEqual(a, b, "同じシードなら同じ探索順");

  // 最初の一歩が 4 方向すべてに散る = 固定順のような方向の偏りがない。
  const firstMoves = new Set();
  for (let seed = 1; seed <= 60; seed += 1) {
    firstMoves.add(lab.withMaze(field, () => lab.orderDfs(start, seed))[1]);
  }
  assert.equal(firstMoves.size, 4, "上下左右すべてが最初の一歩になりうる");
});

test("BFS の展開順はスタートからの距離について単調", () => {
  const field = openField(9);
  const start = { x: 4, y: 4, z: 0 };
  const order = lab.withMaze(field, () => lab.orderBfs(start));
  assert.equal(order.length, 81, "全セルを展開する");

  let previous = -1;
  for (const key of order) {
    const p = app.posFromKey(key);
    const d = Math.abs(p.x - 4) + Math.abs(p.y - 4);
    assert.ok(d >= previous, "距離が減ることはない");
    previous = d;
  }
});

test("全ての手法が到達可能な通路セルを漏れなく 1 回ずつ展開する", () => {
  const maze = lab.generateLabMaze({ seed: 42, width: 21, height: 21, braid: 0 });
  const region = lab.resolveRegion(21, 21, { cxPct: 80, cyPct: 20, rPct: 22 });
  const start = lab.resolveStart(maze, "center");
  const expected = lab.openCells(maze).length;

  lab.withMaze(maze, () => {
    for (const name of lab.ALGO_ORDER) {
      const order = lab.runOrder(name, start, { biasDegrees: 45, region });
      assert.equal(new Set(order).size, order.length, `${name}: 重複展開がない`);
      assert.equal(order.length, expected, `${name}: 全通路セルを展開する`);
      assert.equal(order[0], app.posKey(start), `${name}: 開始点から始まる`);
    }
  });
});

// --- 4. 評価指標 -------------------------------------------------------------

test("evaluate は nAUC と回収コストを定義どおりに計算する", () => {
  const order = ["a", "b", "c", "d"];
  const rewards = new Set(["b", "d"]);
  const m = lab.evaluate(order, rewards);

  // c(n) = 0, 0.5, 0.5, 1.0  →  nAUC = 2.0 / 4 = 0.5
  assert.equal(m.span, 4);
  assert.equal(m.total, 2);
  assert.equal(m.collected, 2);
  assert.ok(Math.abs(m.nAUC - 0.5) < 1e-12);
  assert.equal(m.costFirst, 2);
  assert.equal(m.cost50, 2);
  assert.equal(m.cost90, 4);
  assert.deepEqual(Array.from(m.curve), [0, 0, 0.5, 0.5, 1]);
});

test("evaluate の horizon は短い系列を最終値で埋める", () => {
  const m = lab.evaluate(["a", "b", "c", "d"], new Set(["b", "d"]), 8);
  // c(n) = 0, .5, .5, 1, 1, 1, 1, 1  →  6.0 / 8 = 0.75
  assert.equal(m.span, 8);
  assert.ok(Math.abs(m.nAUC - 0.75) < 1e-12);
});

test("同じセルを何度も通っても報酬は 1 回しか回収されない（引き返しの二重計上を防ぐ）", () => {
  const rewards = new Set(["a", "b"]);
  // 実移動列は引き返しで同じセルを何度も踏む
  const trail = ["a", "x", "a", "x", "a", "b", "a", "b"];
  const m = lab.evaluate(trail, rewards);
  assert.equal(m.collected, 2, "報酬は 2 個までしか回収できない");
  assert.ok(m.nAUC <= 1, "nAUC は 1 を超えない");
  assert.equal(m.costFirst, 1);
  assert.equal(m.cost90, 6, "2 個目を初めて踏んだ歩数");
  for (const v of m.curve) assert.ok(v <= 1);
});

test("早く回収するほど nAUC が大きい", () => {
  const rewards = new Set(["a", "b"]);
  const early = lab.evaluate(["a", "b", "c", "d"], rewards).nAUC;
  const late = lab.evaluate(["c", "d", "a", "b"], rewards).nAUC;
  assert.ok(early > late);
  assert.ok(early <= 1 && late >= 0);
});

test("meanSd は標本標準偏差を返す", () => {
  const s = lab.meanSd([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.mean, 5);
  assert.equal(s.n, 8);
  assert.ok(Math.abs(s.sd - 2.13809) < 1e-4);
  assert.equal(lab.meanSd([3]).sd, 0);
});

// --- 5. 報酬配置 -------------------------------------------------------------

test("placeRewards は集中率に従って報酬を領域内へ寄せる", () => {
  const maze = lab.generateLabMaze({ seed: 9, width: 41, height: 41, braid: 0 });
  const region = lab.resolveRegion(41, 41, { cxPct: 80, cyPct: 20, rPct: 25 });

  const concentrated = lab.placeRewards(maze, region, { count: 40, concentration: 1 }, 5);
  assert.equal(concentrated.keys.size, 40);
  for (const key of concentrated.keys) {
    const p = app.posFromKey(key);
    assert.ok(lab.distToCenter(p.x, p.y, region) <= region.r, "集中率 100% なら全て領域内");
  }

  const uniform = lab.placeRewards(maze, region, { count: 40, concentration: 0 }, 5);
  assert.equal(uniform.insideCount, 0, "集中率 0% なら領域内には置かない（対照条件）");

  // 同じシードなら同じ配置
  const again = lab.placeRewards(maze, region, { count: 40, concentration: 1 }, 5);
  assert.deepEqual([...again.keys].sort(), [...concentrated.keys].sort());
});

// --- 6. 中核仮説（H1 / H2） --------------------------------------------------

test("H1: 報酬が偏在するとき、方位が一致した DFS-N は BFS より早く回収する", () => {
  const cfg = baseConfig({ algorithms: ["bfs", "dfs", "dfsn"] });
  const trials = seeds(10).map((seed) => lab.runSingle(cfg, seed));

  // バイアス 45°（右上）は報酬領域（右上・中央スタート）の方位とほぼ一致する。
  for (const t of trials) {
    assert.ok(lab.angleGap(cfg.biasDegrees, t.bearing) < 30, "設定上、方位はおおむね一致している");
  }

  const dfsn = mean(trials.map((t) => t.results.dfsn.metrics.nAUC));
  const bfs = mean(trials.map((t) => t.results.bfs.metrics.nAUC));
  assert.ok(dfsn > bfs, `一致した DFS-N (${dfsn.toFixed(4)}) が BFS (${bfs.toFixed(4)}) を上回る`);
});

test("H2: バイアスが報酬領域と逆を向くと DFS-N の優位は消える", () => {
  const matched = baseConfig({ biasDegrees: 45, algorithms: ["bfs", "dfs", "dfsn"] });
  const opposed = baseConfig({ biasDegrees: 225, algorithms: ["bfs", "dfs", "dfsn"] });
  const seedList = seeds(12);

  const matchedRows = seedList.map((s) => lab.runSingle(matched, s));
  const opposedRows = seedList.map((s) => lab.runSingle(opposed, s));

  const matchedAuc = mean(matchedRows.map((t) => t.results.dfsn.metrics.nAUC));
  const opposedAuc = mean(opposedRows.map((t) => t.results.dfsn.metrics.nAUC));
  const isotropicDfs = mean(matchedRows.map((t) => t.results.dfs.metrics.nAUC));

  assert.ok(
    matchedAuc > opposedAuc,
    `一致 (${matchedAuc.toFixed(4)}) が不一致 (${opposedAuc.toFixed(4)}) を上回る`,
  );

  // 方位バイアスそのものの効果は、等方な深さ優先を対照にして初めて分離できる。
  // BFS との差には「深さ優先だから速い」分が混ざっている。
  assert.ok(
    matchedAuc > isotropicDfs,
    `一致 (${matchedAuc.toFixed(4)}) が等方 DFS (${isotropicDfs.toFixed(4)}) を上回る`,
  );
  assert.ok(
    opposedAuc < isotropicDfs,
    `不一致 (${opposedAuc.toFixed(4)}) は等方 DFS (${isotropicDfs.toFixed(4)}) を下回る`,
  );
});

test("対照条件: 報酬が一様分布なら DFS-N の BFS に対する優位が縮む", () => {
  const seedList = seeds(10);
  const advantage = (concentration) => {
    const cfg = baseConfig({ concentration, algorithms: ["bfs", "dfsn"] });
    const rows = seedList.map((s) => lab.runSingle(cfg, s));
    return (
      mean(rows.map((t) => t.results.dfsn.metrics.nAUC)) /
      mean(rows.map((t) => t.results.bfs.metrics.nAUC))
    );
  };

  const biased = advantage(0.9);
  const uniform = advantage(0);
  assert.ok(
    biased > uniform,
    `偏在時の優位 (${biased.toFixed(4)}) が一様時 (${uniform.toFixed(4)}) より大きい`,
  );
});

test("biasSweep は各方位の統計を返し、領域方位に近い側ほど nAUC が高い", () => {
  const cfg = baseConfig();
  const sweep = lab.biasSweep(cfg, seeds(8));

  assert.equal(sweep.points.length, 16, "既定は 22.5° 刻みの 16 点");
  for (const p of sweep.points) {
    assert.equal(p.n, 8);
    assert.ok(p.mean > 0 && p.mean < 1);
    assert.ok(p.sd >= 0);
  }
  assert.ok(sweep.baselines.bfs.mean > 0);
  assert.ok(sweep.baselines.dfs.mean > 0);

  // 個々の最良方位は 45° 量子化と分散でぶれるので、方位の「一致度」で束ねて比べる。
  // 4 近傍格子では近傍の並び順が 45° ごとにしか変わらないため、単点の argmax は
  // 安定しない。
  const aligned = sweep.points.filter((p) => p.gap <= 45).map((p) => p.mean);
  const opposed = sweep.points.filter((p) => p.gap >= 135).map((p) => p.mean);
  assert.ok(aligned.length > 0 && opposed.length > 0);
  assert.ok(
    mean(aligned) > mean(opposed),
    `一致側 ${mean(aligned).toFixed(4)} > 逆側 ${mean(opposed).toFixed(4)}`,
  );
  assert.ok(
    mean(aligned) > sweep.baselines.dfs.mean,
    "一致側は等方 DFS を上回る（方位バイアスそのものの効果）",
  );
});

// --- 7. マイクロマウス（H3） -------------------------------------------------

test("senseIds は app.js の computeVisibleCells と同じ視界を返す", () => {
  const maze = lab.generateLabMaze({ seed: 31, width: 21, height: 21, braid: 0 });
  const layer = maze.layers[0];
  const out = [];

  lab.withMaze(maze, () => {
    for (const cell of lab.openCells(maze)) {
      const expected = app.computeVisibleCells(cell);
      lab.senseIds(layer, maze.width, maze.height, cell.x, cell.y, out);
      const actual = new Set(
        out.map((id) => {
          const y = Math.floor(id / maze.width);
          return app.keyFromXYZ(id - y * maze.width, y, 0);
        }),
      );
      assert.deepEqual(
        [...actual].sort(),
        [...expected].sort(),
        `(${cell.x},${cell.y}) の視界が一致する`,
      );
    }
  });
});

test("マイクロマウスは壁を通り抜けず、被覆課題で到達可能な全通路を踏む", () => {
  const maze = lab.generateLabMaze({ seed: 55, width: 21, height: 21, braid: 0 });
  const region = lab.resolveRegion(21, 21, { cxPct: 80, cyPct: 20, rPct: 22 });
  const start = lab.resolveStart(maze, "center");

  const run = lab.withMaze(maze, () =>
    lab.microMouseRun(maze, start, {
      mode: "reward",
      lambda: 0,
      region,
      maxSteps: 21 * 21 * 6,
    }),
  );

  assert.ok(!run.exhausted, "歩数上限に達せず探索を完了する");
  assert.equal(run.coveredCount, lab.openCells(maze).length, "到達可能な全通路を踏む");

  for (const key of run.trail) {
    const p = app.posFromKey(key);
    assert.equal(maze.layers[0][p.y][p.x], 0, "壁の上には乗らない");
  }
  // 移動は 1 歩ずつ隣接セルへ
  for (let i = 1; i < run.trail.length; i += 1) {
    const a = app.posFromKey(run.trail[i - 1]);
    const b = app.posFromKey(run.trail[i]);
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, "隣接セルへの移動のみ");
  }
});

test("H3: 領域誘導したマイクロマウスは報酬を早く回収し、ゴールへ早く着く", () => {
  const study = lab.microMouseStudy(baseConfig(), seeds(20, 2468));
  const s = study.summary;

  assert.equal(s.goalSuccess.plain, study.rows.length, "無情報でも必ずゴールへ到達する");
  assert.equal(s.goalSuccess.guided, study.rows.length, "領域誘導でも必ずゴールへ到達する");

  for (const r of study.rows) {
    for (const which of ["plain", "guided"]) {
      assert.ok(r.reward[which].nAUC <= 1, "実移動列でも nAUC は 1 を超えない");
      assert.equal(r.reward[which].collected, r.reward[which].total, "最終的に全報酬を回収する");
      assert.ok(r.reward[which].cost90 > 0, "90% 回収歩数が定義される");
    }
  }

  assert.ok(
    s.rewardAuc.guided.mean > s.rewardAuc.plain.mean,
    `報酬 nAUC: 誘導 ${s.rewardAuc.guided.mean.toFixed(4)} > 無情報 ${s.rewardAuc.plain.mean.toFixed(4)}`,
  );
  assert.ok(
    s.goalSteps.guided.mean < s.goalSteps.plain.mean,
    `ゴール到達歩数: 誘導 ${s.goalSteps.guided.mean.toFixed(1)} < 無情報 ${s.goalSteps.plain.mean.toFixed(1)}`,
  );
});

test("事前情報が誤っている（ゴールが領域外）と領域誘導は裏目に出る", () => {
  // 歩数は分散が大きく尾を引くため、この比較にはシードを多めに取る。
  const seedList = seeds(20, 13579);
  const correct = lab.microMouseStudy(baseConfig({ goalPlacement: "inside" }), seedList);
  const wrong = lab.microMouseStudy(baseConfig({ goalPlacement: "outside" }), seedList);

  const gain = (study) =>
    1 - study.summary.goalSteps.guided.mean / study.summary.goalSteps.plain.mean;

  assert.ok(
    gain(correct) > gain(wrong),
    `事前情報が正しいときの短縮率 ${(gain(correct) * 100).toFixed(1)}% が、` +
      `誤っているとき ${(gain(wrong) * 100).toFixed(1)}% を上回る`,
  );
});

// --- 8. エクスポート ---------------------------------------------------------

test("CSV 出力はヘッダと行数が整合する", () => {
  const cfg = baseConfig();
  const sweep = lab.biasSweep(cfg, seeds(2), [0, 90, 180, 270]);
  const csv = lab.sweepToCsv(sweep).split("\n");
  assert.equal(csv[0], "angle_deg,gap_to_region_deg,mean_nauc,sd_nauc,n");
  assert.equal(csv.length, 1 + 4 + 3, "4 方位 + 3 ベースライン");

  const study = lab.microMouseStudy(cfg, seeds(2));
  const mmCsv = lab.mmToCsv(study).split("\n");
  assert.ok(mmCsv[0].startsWith("seed,"));
  assert.equal(mmCsv.length, 1 + 2);
  assert.equal(mmCsv[1].split(",").length, mmCsv[0].split(",").length);
});
