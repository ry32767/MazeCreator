"use strict";

const COLORS = {
  wall: "#1e293b",
  path: "#ffffff",
  start: "#10b981",
  goal: "#f43f5e",
  player: "#f59e0b",
  candidate: "#fb923c",
  tempBlock: "#dc2626",
  flood: "#7dd3fc",
  rejected: "#94a3b8",
  confirmed: "#059669",
  solution: "#fde047",
  stairUp: "#2563eb",
  stairDown: "#7c3aed",
  stairBoth: "#0891b2",
  fog: "#000000", // マイクロマウス視点で未踏・未視認のセル
  backtrack: "#ea580c", // 一度通った道を戻った（再走した）セル
};

const DIRECTIONS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const SPEEDS = {
  slow: { flood: 26, step: 170 },
  normal: { flood: 7, step: 60 },
  fast: { flood: 0, step: 12 },
};

// SPEEDS の値は「基準サイズの迷路」を対象に調律されている。迷路が大きいほど
// 探索ステップ数が増えるため、同じ速度設定でも単純に適用すると総再生時間が
// サイズに比例して延びてしまう。そこで基準サイズに対するセル数比を使い、
// 迷路サイズによらず総再生時間がほぼ一定になるようにペース配分する。
// 選択可能な最小の迷路(81x61x1)を基準にする。これより小さい迷路は存在しないため
// すべての迷路で基準比 >= 1 となり、バッチ化（描画回数の削減）が全サイズで効く。
// 最小の迷路を「最も遅い基準」とし、大きい迷路ほど総再生時間が基準に揃うよう速める。
const ANIMATION_REFERENCE_CELLS = 81 * 61 * 1;

// 現在の迷路セル数の基準比。基準より大きい迷路では 1 を超える。
function animationSizeRatio(
  width = state.width,
  height = state.height,
  floorCount = state.floorCount,
) {
  const cells = width * height * floorCount;
  if (!cells) return 1;
  return cells / ANIMATION_REFERENCE_CELLS;
}

// 迷路サイズに応じたアニメーションのペース配分を求める。
// - batchSize: 1 回の描画で進めるアルゴリズムのステップ数（大きい迷路ほど増える）
// - sleepFactor: 1 回の描画あたりの待機時間に掛ける倍率（小さい迷路ほど増える）
// 描画回数 ≒ ステップ数 / batchSize、総待機時間 ≒ 描画回数 × 基準待機 となり、
// ステップ数が概ねセル数に比例することから、総再生時間が一定に近づく。
function animationPacing(ratio = animationSizeRatio()) {
  const safeRatio = ratio > 0 ? ratio : 1;
  const batchSize = Math.max(1, Math.round(safeRatio));
  const sleepFactor = batchSize / safeRatio;
  return { batchSize, sleepFactor };
}

const TAU = Math.PI * 2;
const FLOOR_GAP = 18; // 全階表示時の階ブロック間の余白(px)
const FLOOR_LABEL_H = 18; // 全階表示時の階ラベル領域の高さ(px)

// 階段の移動コストは 1 ステップ。階層差 1 につき最低 1 ステップ必要なので、
// 係数を 1 にすることでヒューリスティックが実コストを超えず（許容的）、A* が最短経路を保証する。
const FLOOR_HEURISTIC_COST = 1;

// ブラウザでは DOM を参照して UI を構築するが、Node（テスト）からは
// DOM 非依存のアルゴリズム関数だけを利用する。両環境で読み込めるよう分岐する。
const IS_BROWSER = typeof document !== "undefined";

const dom = IS_BROWSER
  ? {
      canvas: document.querySelector("#mazeCanvas"),
      status: document.querySelector("#statusText"),
      size: document.querySelector("#sizeSelect"),
      floorCount: document.querySelector("#floorCountSelect"),
      floorLabel: document.querySelector("#floorLabel"),
      floorDown: document.querySelector("#floorDownButton"),
      floorUp: document.querySelector("#floorUpButton"),
      viewMode: document.querySelector("#viewModeSelect"),
      speed: document.querySelector("#speedSelect"),
      animate: document.querySelector("#animateToggle"),
      generate: document.querySelector("#generateButton"),
      reset: document.querySelector("#resetButton"),
      stop: document.querySelector("#stopButton"),
      visitedMetric: document.querySelector("#visitedMetric"),
      pathMetric: document.querySelector("#pathMetric"),
      timeMetric: document.querySelector("#timeMetric"),
      seed: document.querySelector("#seedInput"),
      randomSeed: document.querySelector("#randomSeedButton"),
      braid: document.querySelector("#braidRange"),
      braidValue: document.querySelector("#braidValue"),
      stairDensity: document.querySelector("#stairDensityRange"),
      stairDensityValue: document.querySelector("#stairDensityValue"),
      attempts: document.querySelector("#attemptsRange"),
      attemptsValue: document.querySelector("#attemptsValue"),
      compare: document.querySelector("#compareButton"),
      compareOutput: document.querySelector("#compareOutput"),
      heatmap: document.querySelector("#heatmapToggle"),
      heatmapLegend: document.querySelector("#heatmapLegend"),
      fogToggle: document.querySelector("#fogToggle"),
      batchRuns: document.querySelector("#batchRuns"),
      batch: document.querySelector("#batchButton"),
      batchOutput: document.querySelector("#batchOutput"),
      batchProgress: document.querySelector("#batchProgress"),
      batchProgressBar: document.querySelector("#batchProgressBar"),
      batchCsv: document.querySelector("#batchCsvButton"),
      batchJson: document.querySelector("#batchJsonButton"),
      sweepParam: document.querySelector("#sweepParam"),
      sweepPoints: document.querySelector("#sweepPoints"),
      sweepRuns: document.querySelector("#sweepRuns"),
      sweep: document.querySelector("#sweepButton"),
      sweepCanvas: document.querySelector("#sweepCanvas"),
      sweepLegend: document.querySelector("#sweepLegend"),
      sweepProgress: document.querySelector("#sweepProgress"),
      sweepProgressBar: document.querySelector("#sweepProgressBar"),
      sweepCsv: document.querySelector("#sweepCsvButton"),
      sweepJson: document.querySelector("#sweepJsonButton"),
      announce: document.querySelector("#announce"),
    }
  : {};

const ctx = IS_BROWSER ? dom.canvas.getContext("2d", { alpha: false }) : null;

const state = {
  width: 121,
  height: 91,
  floorCount: 3,
  visibleFloor: 0,
  viewMode: "stack", // "single"=1階ずつ / "stack"=全階平面縦並び / "iso"=全階3D俯瞰
  cellSize: 5,
  seed: 0,
  braid: 0, // ループ率 0..1（行き止まりを開放して別解を生む）
  stairDensity: 3, // 階のつなぎ目あたりの階段ペア数
  generationAttempts: 3, // 最長経路を選ぶための生成試行回数
  layers: [],
  stairsByKey: new Map(),
  start: { x: 1, y: 1, z: 0 },
  goal: { x: 1, y: 1, z: 0 },
  player: { x: 1, y: 1, z: 0 },
  visited: new Set(),
  rejected: new Set(),
  path: [],
  pathKeys: new Set(),
  currentKey: null,
  candidateKey: null,
  tempBlock: null,
  finalPathMode: false,
  heat: null, // { order: Map<key,index>, total } 探索順ヒートマップ用
  lastBatch: null, // 直近のバッチ検証結果（エクスポート用）
  lastSweep: null, // 直近のパラメータ掃引結果（エクスポート用）
  running: false,
  runToken: 0,
  replaying: false, // ルート再生（最短経路のなぞり）中か
  skipReplay: false, // ルート再生のスキップ要求
  fog: false, // マイクロマウス視点（霧）モード
  revealed: new Set(), // 霧モードで判明済みのセル（key の集合）
  backtrack: new Set(), // マイクロマウスが再走（引き返し）したセル
};

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  get size() {
    return this.items.length;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  bubbleDown(index) {
    const length = this.items.length;
    while (true) {
      let smallest = index;
      const left = index * 2 + 1;
      const right = left + 1;

      if (left < length && this.items[left].priority < this.items[smallest].priority) {
        smallest = left;
      }

      if (right < length && this.items[right].priority < this.items[smallest].priority) {
        smallest = right;
      }

      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }
}

function keyFromXYZ(x, y, z) {
  return `${x},${y},${z}`;
}

function posKey(pos) {
  return keyFromXYZ(pos.x, pos.y, pos.z);
}

function posFromKey(value) {
  const [x, y, z] = value.split(",").map(Number);
  return { x, y, z };
}

function samePos(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function edgeKey(a, b) {
  const ka = posKey(a);
  const kb = posKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

// 再現可能な擬似乱数（mulberry32）。シードを与えると同じ迷路を再生成でき、
// 同一迷路上での解法アルゴリズム比較（研究用途）が可能になる。
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 既定はブラウザ標準の乱数。generateGame() でシードが指定されると差し替わる。
let rng = Math.random;

function setSeed(seed) {
  state.seed = seed >>> 0;
  rng = makeRng(state.seed);
  return state.seed;
}

function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

function randomOdd(limit) {
  const count = Math.floor((limit - 1) / 2);
  return 1 + Math.floor(rng() * count) * 2;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseSize(value) {
  const [rawWidth, rawHeight] = value.split("x").map(Number);
  const width = rawWidth % 2 === 1 ? rawWidth : rawWidth - 1;
  const height = rawHeight % 2 === 1 ? rawHeight : rawHeight - 1;
  return { width, height };
}

function cellSizeFor(width) {
  if (width >= 190) return 4;
  if (width >= 145) return 5;
  if (width >= 110) return 6;
  return 8;
}

function setStatus(text) {
  if (dom.status) dom.status.textContent = text;
}

// スクリーンリーダー向けの詳細アナウンス（aria-live 領域へ全文を流し込む）。
function announce(text) {
  if (dom.announce) dom.announce.textContent = text;
}

function setMetrics(visitedCount = 0, pathCount = 0, duration = 0) {
  if (!dom.visitedMetric) return;
  dom.visitedMetric.textContent = visitedCount.toLocaleString("ja-JP");
  dom.pathMetric.textContent = pathCount.toLocaleString("ja-JP");
  dom.timeMetric.textContent = `${duration.toFixed(duration < 10 ? 2 : 1)} ms`;
}

function floorName(index) {
  return `Floor ${index + 1}`;
}

// 実際に使う表示モード。1 階しかなければ常に single。
function effectiveViewMode() {
  if (state.floorCount <= 1) return "single";
  return state.viewMode;
}

function updateFloorUi() {
  if (!dom.floorLabel) return;
  const mode = effectiveViewMode();
  const showAll = mode !== "single";
  dom.floorLabel.textContent = showAll
    ? `全 ${state.floorCount} 階表示`
    : `${floorName(state.visibleFloor)} / ${state.floorCount}`;
  dom.floorDown.disabled = state.running || showAll || state.visibleFloor === 0;
  dom.floorUp.disabled = state.running || showAll || state.visibleFloor === state.floorCount - 1;
}

function setVisibleFloor(floor, redraw = true) {
  state.visibleFloor = clamp(floor, 0, state.floorCount - 1);
  updateFloorUi();
  if (redraw) drawMaze();
}

function setPath(path) {
  state.path = path || [];
  state.pathKeys = new Set(state.path.map(posKey));
}

// OS の「視差効果を減らす / 動きを減らす」設定を尊重する。
// 有効時は装飾的な演出（ワープ・ルートなぞり再生）を省き、即座に結果を見せる。
function prefersReducedMotion() {
  return (
    IS_BROWSER &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// 探索ヒートマップの凡例（青=早い → 赤=遅い）の表示/非表示を切り替える。
function updateHeatmapLegend() {
  if (!dom.heatmapLegend) return;
  const show = Boolean(dom.heatmap && dom.heatmap.checked && state.heat);
  dom.heatmapLegend.hidden = !show;
  dom.heatmapLegend.setAttribute("aria-hidden", show ? "false" : "true");
}

function clearVisualization() {
  state.visited = new Set();
  state.rejected = new Set();
  setPath([]);
  state.currentKey = null;
  state.candidateKey = null;
  state.tempBlock = null;
  state.finalPathMode = false;
  state.heat = null;
  state.backtrack = new Set();
  updateHeatmapLegend();
  setMetrics();
}

// 経路の中で2回以上通過したセル（＝引き返した道）の集合を返す。
function computeBacktrackSet(path) {
  const seen = new Set();
  const back = new Set();
  for (const cell of path || []) {
    const key = posKey(cell);
    if (seen.has(key)) back.add(key);
    else seen.add(key);
  }
  return back;
}

function resetPlayerAndView() {
  state.player = { ...state.start };
  setVisibleFloor(state.player.z, false);
  clearVisualization();
  if (state.fog) {
    state.revealed = new Set();
    revealFrom(state.player);
  }
  drawMaze();
  setStatus(state.fog ? "マイクロマウス視点: 矢印/WASDで移動してゴールを探そう" : "手動操作モード");
  dom.canvas.focus({ preventScroll: true });
}

function setControlsRunning(isRunning) {
  state.running = isRunning;
  dom.stop.disabled = !isRunning;
  dom.generate.disabled = isRunning;
  dom.reset.disabled = isRunning;
  dom.size.disabled = isRunning;
  dom.floorCount.disabled = isRunning;
  if (dom.randomSeed) dom.randomSeed.disabled = isRunning;

  document.querySelectorAll("[data-move]").forEach((button) => {
    button.disabled = isRunning;
  });
  updateSolverButtons();
  updateFloorUi();
}

// 解法・解析ボタンの活性状態を更新する。
// 実行中は全て無効。霧（マイクロマウス視点）モード中はマイクロマウス以外の
// 解法と、他解法を回す解析機能（比較・バッチ・掃引）を選択不可にする。
function updateSolverButtons() {
  const running = state.running;
  document.querySelectorAll("[data-solver]").forEach((button) => {
    const isMicromouse = button.dataset.solver === "micromouse";
    button.disabled = running || (state.fog && !isMicromouse);
  });
  const analysisDisabled = running || state.fog;
  if (dom.compare) dom.compare.disabled = analysisDisabled;
  if (dom.batch) dom.batch.disabled = analysisDisabled;
  if (dom.sweep) dom.sweep.disabled = analysisDisabled;
}

function isOpen(x, y, z) {
  return (
    z >= 0 &&
    z < state.floorCount &&
    y >= 0 &&
    y < state.height &&
    x >= 0 &&
    x < state.width &&
    state.layers[z][y][x] === 0
  );
}

function planarNeighbors(pos) {
  const result = [];
  for (const dir of DIRECTIONS) {
    const nx = pos.x + dir.x;
    const ny = pos.y + dir.y;
    if (isOpen(nx, ny, pos.z)) {
      result.push({ x: nx, y: ny, z: pos.z });
    }
  }
  return result;
}

function getStairsFrom(pos) {
  return state.stairsByKey.get(posKey(pos)) || [];
}

function getNeighbors(pos) {
  return planarNeighbors(pos).concat(getStairsFrom(pos).map((next) => ({ ...next })));
}

function heuristic(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + FLOOR_HEURISTIC_COST * Math.abs(a.z - b.z);
}

function inBoundsXY(x, y) {
  return x >= 0 && x < state.width && y >= 0 && y < state.height;
}

// マイクロマウス視点の可視セルを計算する（直進LOS＋廊下の壁）。
// 現在地から4方向に直進し、壁に当たるまでの通路セルと、その廊下の左右の壁を
// 明らかにする。曲がり角の先や壁の向こうは見えない。
function computeVisibleCells(pos) {
  const cells = new Set();
  const z = pos.z;
  const layer = state.layers[z];
  const mark = (x, y) => {
    if (inBoundsXY(x, y)) cells.add(keyFromXYZ(x, y, z));
  };

  mark(pos.x, pos.y);
  for (const dir of DIRECTIONS) {
    const perp = { x: dir.y, y: dir.x }; // 進行方向に垂直
    let x = pos.x;
    let y = pos.y;
    while (true) {
      const nx = x + dir.x;
      const ny = y + dir.y;
      if (!inBoundsXY(nx, ny)) break;
      if (layer[ny][nx] === 1) {
        mark(nx, ny); // 壁面は見える。そこで視線が止まる
        break;
      }
      mark(nx, ny); // 通路
      mark(nx + perp.x, ny + perp.y); // 廊下の左右（壁または開口）
      mark(nx - perp.x, ny - perp.y);
      x = nx;
      y = ny;
    }
  }
  return cells;
}

// 指定位置から見えるセルを判明済み集合に追加する。
function revealFrom(pos) {
  if (!state.revealed) state.revealed = new Set();
  for (const key of computeVisibleCells(pos)) state.revealed.add(key);
}

// 霧（マイクロマウス視点）モードの ON/OFF を切り替える。
// ON にすると判明済みを現在地の視界だけにリセットし、1階表示へ。
function setFog(on) {
  state.fog = Boolean(on);
  if (dom.fogToggle) dom.fogToggle.checked = state.fog;
  if (state.fog) {
    state.revealed = new Set();
    revealFrom(state.player);
    setVisibleFloor(state.player.z, false);
  }
  updateSolverButtons();
  updateFloorUi();
  drawMaze();
}

function createFilledMaze(width, height) {
  return Array.from({ length: height }, () => Array(width).fill(1));
}

function generateDfsMaze(width, height) {
  const maze = createFilledMaze(width, height);
  const start = { x: randomOdd(width), y: randomOdd(height) };
  const stack = [start];
  maze[start.y][start.x] = 0;

  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const dirs = shuffle([
      { x: 0, y: 2 },
      { x: 2, y: 0 },
      { x: 0, y: -2 },
      { x: -2, y: 0 },
    ]);

    let carved = false;
    for (const dir of dirs) {
      const nx = current.x + dir.x;
      const ny = current.y + dir.y;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && maze[ny][nx] === 1) {
        maze[current.y + dir.y / 2][current.x + dir.x / 2] = 0;
        maze[ny][nx] = 0;
        stack.push({ x: nx, y: ny });
        carved = true;
        break;
      }
    }

    if (!carved) stack.pop();
  }

  return maze;
}

// 完全迷路（木）の行き止まりを一定割合で開放し、ループ（別解）を作る。
// factor は 0..1。0 なら唯一解、値を上げるほど別解が増え、壁伝い法が解けず
// BFS/A* との差が際立つため、アルゴリズム比較の題材として面白くなる。
function braidMaze(maze, width, height, factor) {
  if (factor <= 0) return maze;

  const step = [
    { x: 0, y: -2 },
    { x: 2, y: 0 },
    { x: 0, y: 2 },
    { x: -2, y: 0 },
  ];

  const deadEnds = [];
  for (let y = 1; y < height; y += 2) {
    for (let x = 1; x < width; x += 2) {
      if (maze[y][x] !== 0) continue;
      let openLinks = 0;
      for (const d of step) {
        const wx = x + d.x / 2;
        const wy = y + d.y / 2;
        if (wx >= 0 && wx < width && wy >= 0 && wy < height && maze[wy][wx] === 0) {
          openLinks += 1;
        }
      }
      if (openLinks === 1) deadEnds.push({ x, y });
    }
  }

  shuffle(deadEnds);
  for (const cell of deadEnds) {
    if (rng() >= factor) continue;
    // まだ壁で隔てられている隣接セルへの通路を 1 つ開ける。
    const closed = [];
    for (const d of step) {
      const nx = cell.x + d.x;
      const ny = cell.y + d.y;
      const wx = cell.x + d.x / 2;
      const wy = cell.y + d.y / 2;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && maze[ny][nx] === 0 && maze[wy][wx] === 1) {
        closed.push({ wx, wy });
      }
    }
    if (closed.length > 0) {
      const pick = closed[Math.floor(rng() * closed.length)];
      maze[pick.wy][pick.wx] = 0;
    }
  }

  return maze;
}

function getOpenCells(layer, z) {
  const cells = [];
  for (let y = 1; y < state.height; y += 2) {
    for (let x = 1; x < state.width; x += 2) {
      if (layer[y][x] === 0) cells.push({ x, y, z });
    }
  }
  return cells;
}

function pickOpenCell(layer, z, avoidStairs = true) {
  const cells = shuffle(getOpenCells(layer, z).slice());
  return cells.find((cell) => !avoidStairs || getStairsFrom(cell).length === 0) || cells[0];
}

function addStair(stairsByKey, a, b) {
  const aKey = posKey(a);
  const bKey = posKey(b);
  if (!stairsByKey.has(aKey)) stairsByKey.set(aKey, []);
  if (!stairsByKey.has(bKey)) stairsByKey.set(bKey, []);
  stairsByKey.get(aKey).push({ ...b });
  stairsByKey.get(bKey).push({ ...a });
}

function buildStairs(layers, width, height, floorCount) {
  const stairsByKey = new Map();
  const usedByFloor = Array.from({ length: floorCount }, () => new Set());
  const stairPairsPerJoin = state.stairDensity;

  for (let z = 0; z < floorCount - 1; z += 1) {
    const candidates = [];
    for (let y = 1; y < height; y += 2) {
      for (let x = 1; x < width; x += 2) {
        if (layers[z][y][x] === 0 && layers[z + 1][y][x] === 0) {
          candidates.push({ x, y });
        }
      }
    }

    shuffle(candidates);
    let made = 0;
    for (const candidate of candidates) {
      const localKey = `${candidate.x},${candidate.y}`;
      if (usedByFloor[z].has(localKey) || usedByFloor[z + 1].has(localKey)) continue;

      const lower = { x: candidate.x, y: candidate.y, z };
      const upper = { x: candidate.x, y: candidate.y, z: z + 1 };
      addStair(stairsByKey, lower, upper);
      usedByFloor[z].add(localKey);
      usedByFloor[z + 1].add(localKey);
      made += 1;

      if (made >= stairPairsPerJoin) break;
    }
  }

  return stairsByKey;
}

function bfsDistances(start) {
  const queue = [start];
  let cursor = 0;
  const distances = new Map([[posKey(start), 0]]);

  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    const currentDistance = distances.get(posKey(current));

    for (const neighbor of getNeighbors(current)) {
      const key = posKey(neighbor);
      if (!distances.has(key)) {
        distances.set(key, currentDistance + 1);
        queue.push(neighbor);
      }
    }
  }

  return distances;
}

function farthestInFloor(distances, floor, avoidStairs = true) {
  let best = null;
  let bestDistance = -1;

  for (const [key, distance] of distances.entries()) {
    const pos = posFromKey(key);
    if (pos.z !== floor) continue;
    if (avoidStairs && getStairsFrom(pos).length > 0) continue;
    if (distance > bestDistance) {
      best = pos;
      bestDistance = distance;
    }
  }

  if (best) return { pos: best, distance: bestDistance };
  if (avoidStairs) return farthestInFloor(distances, floor, false);
  return null;
}

function chooseStartAndGoal() {
  const bottomFloor = 0;
  const topFloor = state.floorCount - 1;
  const seed = pickOpenCell(state.layers[bottomFloor], bottomFloor);
  const firstSweep = bfsDistances(seed);
  const roughGoal = farthestInFloor(firstSweep, topFloor).pos;
  const secondSweep = bfsDistances(roughGoal);
  const start = farthestInFloor(secondSweep, bottomFloor).pos;
  const finalSweep = bfsDistances(start);
  const goalInfo = farthestInFloor(finalSweep, topFloor);
  return {
    start,
    goal: goalInfo.pos,
    length: goalInfo.distance,
  };
}

function reconstructPath(parentMap, goal) {
  const path = [];
  let current = posKey(goal);

  while (current) {
    path.push(posFromKey(current));
    current = parentMap.get(current);
  }

  return path.reverse();
}

function shortestPathBetween(start, goal) {
  const queue = [start];
  let cursor = 0;
  const visited = new Set([posKey(start)]);
  const parent = new Map([[posKey(start), null]]);

  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (samePos(current, goal)) {
      return { path: reconstructPath(parent, goal), visited };
    }

    for (const neighbor of getNeighbors(current)) {
      const key = posKey(neighbor);
      if (!visited.has(key)) {
        visited.add(key);
        parent.set(key, posKey(current));
        queue.push(neighbor);
      }
    }
  }

  return { path: null, visited };
}

function solveBfsInstant() {
  return shortestPathBetween(state.start, state.goal);
}

function ensureGoalIsDeadEnd() {
  const result = solveBfsInstant();
  if (!result.path || result.path.length < 2) return;

  const entrance = result.path[result.path.length - 2];
  for (const neighbor of planarNeighbors(state.goal)) {
    if (!samePos(neighbor, entrance)) {
      state.layers[neighbor.z][neighbor.y][neighbor.x] = 1;
    }
  }
}

// DOM の生成オプションを state に取り込む。空欄シードはランダムに割り当て、
// 使用したシードを入力欄へ反映して再現できるようにする。
function readGenerationConfig() {
  if (dom.braid) state.braid = clamp(Number(dom.braid.value) / 100, 0, 1);
  if (dom.stairDensity) state.stairDensity = clamp(Number(dom.stairDensity.value), 1, 8);
  if (dom.attempts) state.generationAttempts = clamp(Number(dom.attempts.value), 1, 10);

  const raw = dom.seed ? dom.seed.value.trim() : "";
  const seed = raw === "" || Number.isNaN(Number(raw)) ? randomSeed() : Number(raw) >>> 0;
  setSeed(seed);
  if (dom.seed) dom.seed.value = String(seed);
}

// DOM に依存せず、現在の state 設定（width/height/floorCount/braid/
// stairDensity/generationAttempts/seed）から迷路を構築して state に反映する。
// 試行回数分の生成のうち最長経路のものを採用する。バッチ検証から再利用する。
function buildMaze() {
  const { width, height, floorCount } = state;
  let best = null;
  const attempts = Math.max(1, state.generationAttempts);

  for (let i = 0; i < attempts; i += 1) {
    const layers = Array.from({ length: floorCount }, () => {
      const layer = generateDfsMaze(width, height);
      return braidMaze(layer, width, height, state.braid);
    });
    const stairsByKey = buildStairs(layers, width, height, floorCount);

    state.layers = layers;
    state.stairsByKey = stairsByKey;
    const endpoints = chooseStartAndGoal();

    if (!best || endpoints.length > best.length) {
      best = { layers, stairsByKey, ...endpoints };
    }
  }

  state.layers = best.layers;
  state.stairsByKey = best.stairsByKey;
  state.start = best.start;
  state.goal = best.goal;
  state.player = { ...state.start };
  ensureGoalIsDeadEnd();
  return best;
}

function generateGame() {
  if (IS_BROWSER) readGenerationConfig();

  const { width, height } = parseSize(dom.size ? dom.size.value : `${state.width}x${state.height}`);
  const floorCount = dom.floorCount ? Number(dom.floorCount.value) : state.floorCount;
  state.width = width;
  state.height = height;
  state.floorCount = floorCount;
  state.cellSize = cellSizeFor(width);
  setControlsRunning(true);
  setStatus("階層迷路を生成中...");

  const best = buildMaze();
  state.visibleFloor = state.start.z;
  clearVisualization();
  clearComparison();
  if (state.fog) {
    state.revealed = new Set();
    revealFrom(state.player);
  }
  setControlsRunning(false);
  updateFloorUi();
  drawMaze();
  setStatus(`生成完了: ${width} x ${height} x ${floorCount}階`);
  announce(
    `迷路を生成しました。サイズ ${width}×${height}、${floorCount}階、` +
      `シード ${state.seed}、ループ率 ${Math.round(state.braid * 100)}%。` +
      `最短経路長 ${best.length} ステップ。スタートは ${floorName(state.start.z)}、ゴールは ${floorName(state.goal.z)} です。`,
  );
}

function stairRoleAt(pos) {
  const stairs = getStairsFrom(pos);
  if (stairs.length === 0) return null;
  const hasUp = stairs.some((next) => next.z > pos.z);
  const hasDown = stairs.some((next) => next.z < pos.z);
  if (hasUp && hasDown) return "both";
  return hasUp ? "up" : "down";
}

function colorForStairRole(role) {
  if (role === "up") return COLORS.stairUp;
  if (role === "down") return COLORS.stairDown;
  if (role === "both") return COLORS.stairBoth;
  return COLORS.path;
}

// 表示する階のリストとレイアウト寸法を決める。
// 全階表示は縦積み（各階は横幅いっぱい、縦スクロールで全階を確認）にして可読性を保つ。
function floorLayout() {
  const { width, height, cellSize } = state;
  const showAll = effectiveViewMode() === "stack";
  const floors = showAll ? Array.from({ length: state.floorCount }, (unused, i) => i) : [state.visibleFloor];
  const labelH = showAll ? FLOOR_LABEL_H : 0;
  const blockW = width * cellSize;
  const blockH = height * cellSize;
  const stepY = labelH + blockH + FLOOR_GAP;
  const canvasWidth = blockW;
  const canvasHeight = floors.length * (labelH + blockH) + Math.max(0, floors.length - 1) * FLOOR_GAP;
  return { showAll, floors, labelH, blockW, blockH, stepY, canvasWidth, canvasHeight };
}

// 正解ルートの線を、与えられた stroke(color, width) で重ね描きする。
// 通常は「濃い縁取り + 本来色」の 2 層。ヒートマップ表示中は虹色の背景に
// 埋もれて見えづらいため、濃い縁取り + 白の下地 + 本来色 の 3 層にして
// コントラストを上げ、最短経路をはっきり視認できるようにする。
function drawPathStrokes(stroke, cs) {
  const core = state.finalPathMode ? COLORS.solution : COLORS.confirmed;
  if (state.heat) {
    stroke("rgba(2, 6, 23, 0.95)", Math.max(4, cs * 1.6));
    stroke("#ffffff", Math.max(3, cs * 1.05));
    stroke(core, Math.max(2, cs * 0.6));
  } else {
    stroke("rgba(15, 23, 42, 0.55)", Math.max(3, cs * 1.15));
    stroke(core, Math.max(2, cs * 0.7));
  }
}

// 大きく目立つ円形マーカー（スタート/ゴール/プレイヤー/階段）。セルが小さくても視認できる。
function drawMarker(cx, cy, radius, fill, ring, label) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, radius * 0.32);
  ctx.strokeStyle = ring;
  ctx.stroke();
  if (label) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(radius * 1.25)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy + radius * 0.05);
  }
}

// 1 つの階を (ox, oy) を原点として描画する。
function drawFloorBlock(floor, ox, oy, layout) {
  const { width, height, cellSize: cs } = state;
  const layer = state.layers[floor];

  // 階ラベル + 枠
  if (layout.showAll) {
    const goalKnown = !state.fog || state.revealed.has(posKey(state.goal));
    ctx.fillStyle = floor === state.start.z || (floor === state.goal.z && goalKnown) ? "#0f172a" : "#475569";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const tags = [];
    if (floor === state.start.z) tags.push("S");
    if (floor === state.goal.z && goalKnown) tags.push("G");
    const suffix = tags.length ? `  [${tags.join("/")}]` : "";
    ctx.fillText(`${floorName(floor)}${suffix}`, ox + 2, oy - 5);
  }

  // セル背景（探索状態・経路・階段の下地）
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = keyFromXYZ(x, y, floor);
      let color = COLORS.path;
      if (layer[y][x] === 1) {
        color = COLORS.wall;
      } else {
        const stairRole = stairRoleAt({ x, y, z: floor });
        if (stairRole) color = colorForStairRole(stairRole);
        if (state.rejected.has(key)) color = COLORS.rejected;
        if (state.visited.has(key)) color = COLORS.flood;
        if (state.heat && state.heat.order.has(key)) {
          color = heatColor(state.heat.order.get(key) / state.heat.total);
        }
        if (state.pathKeys.has(key)) color = state.finalPathMode ? COLORS.solution : COLORS.confirmed;
        if (state.backtrack.has(key)) color = COLORS.backtrack; // 引き返した道
        if (key === state.candidateKey) color = COLORS.candidate;
        if (key === state.currentKey) color = COLORS.player;
      }
      // 霧モード: 未判明のセルは黒で塗りつぶす
      if (state.fog && !state.revealed.has(key)) color = COLORS.fog;
      ctx.fillStyle = color;
      ctx.fillRect(ox + x * cs, oy + y * cs, cs, cs);
    }
  }

  // 階ブロックの枠線
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, layout.blockW - 1, layout.blockH - 1);

  // テスト中の仮ブロック線（Paintbrush）
  if (state.tempBlock) {
    const [a, b] = state.tempBlock;
    if (a.z === floor && b.z === floor) {
      ctx.strokeStyle = COLORS.tempBlock;
      ctx.lineWidth = Math.max(2, Math.floor(cs * 0.75));
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(ox + a.x * cs + cs / 2, oy + a.y * cs + cs / 2);
      ctx.lineTo(ox + b.x * cs + cs / 2, oy + b.y * cs + cs / 2);
      ctx.stroke();
    }
  }

  // 正解ルートを連続した太線で描く（暗い縁取り + 明色）。階をまたぐ箇所で線を切る。
  // 霧モード（マイクロマウス）では太線でセル色が隠れないよう線は描かず、
  // セルの塗り分け（往路=緑 / 引き返し=橙）で経路を表す。
  if (state.path.length > 1 && !state.fog) {
    const stroke = (color, w) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      let pen = false;
      for (const p of state.path) {
        // 霧モードでは未判明セルの経路は描かない
        if (p.z !== floor || (state.fog && !state.revealed.has(posKey(p)))) {
          pen = false;
          continue;
        }
        const cx = ox + p.x * cs + cs / 2;
        const cy = oy + p.y * cs + cs / 2;
        if (!pen) {
          ctx.moveTo(cx, cy);
          pen = true;
        } else {
          ctx.lineTo(cx, cy);
        }
      }
      ctx.stroke();
    };
    drawPathStrokes(stroke, cs);
  }

  // 階段マーカー（上り▲/下り▼/両方↕）
  const stairR = Math.max(cs * 1.3, 5);
  for (const keyStr of state.stairsByKey.keys()) {
    const pos = posFromKey(keyStr);
    if (pos.z !== floor) continue;
    if (state.fog && !state.revealed.has(keyStr)) continue; // 未発見の階段は隠す
    const role = stairRoleAt(pos);
    const glyph = role === "up" ? "▲" : role === "down" ? "▼" : "↕";
    const cx = ox + pos.x * cs + cs / 2;
    const cy = oy + pos.y * cs + cs / 2;
    drawMarker(cx, cy, stairR, colorForStairRole(role), "#ffffff", glyph);
  }

  // スタート / ゴール / プレイヤーマーカー（最前面）
  const markerR = Math.max(cs * 1.9, 7);
  if (state.start.z === floor) {
    drawMarker(ox + state.start.x * cs + cs / 2, oy + state.start.y * cs + cs / 2, markerR, COLORS.start, "#064e3b", "S");
  }
  // 霧モードではゴールは発見するまで隠す
  const goalVisible = !state.fog || state.revealed.has(posKey(state.goal));
  if (state.goal.z === floor && goalVisible) {
    drawMarker(ox + state.goal.x * cs + cs / 2, oy + state.goal.y * cs + cs / 2, markerR, COLORS.goal, "#7f1d1d", "G");
  }
  if (state.player.z === floor && !samePos(state.player, state.start) && !samePos(state.player, state.goal)) {
    drawMarker(ox + state.player.x * cs + cs / 2, oy + state.player.y * cs + cs / 2, markerR * 0.85, COLORS.player, "#7c2d12", null);
  }
}

// 3D 俯瞰（オブリーク投影）パラメータ
const ISO_SKEW_X = 0.5; // 奥行き(y)に応じた横ずらし量
const ISO_SCALE_Y = 0.62; // 奥行き(y)方向の圧縮（俯瞰の傾き）
const ISO_PAD = 14;

function isoFloorLift() {
  // 各階の縦方向の占有量 + 階間の余白。下の階ほど画面下に描く。
  return state.height * state.cellSize * ISO_SCALE_Y + 26;
}

// 3D 俯瞰のスクリーン座標へ投影する。
function isoProject(x, y, z, originX, originY) {
  const cs = state.cellSize;
  const lift = isoFloorLift();
  const sx = originX + x * cs + y * cs * ISO_SKEW_X;
  const sy = originY + (state.floorCount - 1 - z) * lift + y * cs * ISO_SCALE_Y;
  return { sx, sy };
}

function drawMaze3D() {
  const { width, height, cellSize: cs, floorCount } = state;
  const lift = isoFloorLift();
  const planW = width * cs;
  const planH = height * cs;
  const originX = ISO_PAD;
  const originY = ISO_PAD + FLOOR_LABEL_H;

  const canvasWidth = Math.ceil(ISO_PAD * 2 + planW + planH * ISO_SKEW_X);
  const canvasHeight = Math.ceil(originY + (floorCount - 1) * lift + planH * ISO_SCALE_Y + ISO_PAD);

  if (dom.canvas.width !== canvasWidth || dom.canvas.height !== canvasHeight) {
    dom.canvas.width = canvasWidth;
    dom.canvas.height = canvasHeight;
    dom.canvas.style.setProperty("--canvas-width", `${canvasWidth}px`);
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // 階段の縦の柱（下階セルと上階の同座標をつなぐ）を先に描いて立体感を出す。
  ctx.strokeStyle = "rgba(8, 145, 178, 0.45)";
  ctx.lineWidth = Math.max(1.5, cs * 0.6);
  ctx.lineCap = "round";
  for (const keyStr of state.stairsByKey.keys()) {
    const pos = posFromKey(keyStr);
    if (pos.z >= floorCount - 1) continue;
    if (state.fog && !state.revealed.has(keyStr)) continue; // 未発見の階段の柱は隠す
    const a = isoProject(pos.x + 0.5, pos.y + 0.5, pos.z, originX, originY);
    const b = isoProject(pos.x + 0.5, pos.y + 0.5, pos.z + 1, originX, originY);
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.stroke();
  }

  // 下の階から順に描く（手前=下に重なる）。
  for (let z = 0; z < floorCount; z += 1) {
    drawFloorIso(z, originX, originY);
  }
}

// 1 つの階を 3D 俯瞰で描く。セルは平行四辺形になるよう ctx 変換を使い、
// マーカーと文字は変換を戻して直立で描く。
function drawFloorIso(floor, originX, originY) {
  const { width, height, cellSize: cs, floorCount } = state;
  const layer = state.layers[floor];
  const lift = isoFloorLift();
  const floorOffsetY = (floorCount - 1 - floor) * lift;

  ctx.save();
  // local (lx, ly) -> screen: sx = originX + lx + ly*skew, sy = originY + floorOffsetY + ly*scaleY
  ctx.setTransform(1, 0, ISO_SKEW_X, ISO_SCALE_Y, originX, originY + floorOffsetY);

  // 階の床（通路全体）の下地
  ctx.fillStyle = "#f1f5f9";
  ctx.fillRect(0, 0, width * cs, height * cs);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = keyFromXYZ(x, y, floor);
      let color = null;
      if (layer[y][x] === 1) {
        color = COLORS.wall;
      } else {
        const stairRole = stairRoleAt({ x, y, z: floor });
        if (stairRole) color = colorForStairRole(stairRole);
        if (state.rejected.has(key)) color = COLORS.rejected;
        if (state.visited.has(key)) color = COLORS.flood;
        if (state.heat && state.heat.order.has(key)) {
          color = heatColor(state.heat.order.get(key) / state.heat.total);
        }
        if (state.pathKeys.has(key)) color = state.finalPathMode ? COLORS.solution : COLORS.confirmed;
        if (state.backtrack.has(key)) color = COLORS.backtrack; // 引き返した道
        if (key === state.candidateKey) color = COLORS.candidate;
        if (key === state.currentKey) color = COLORS.player;
      }
      // 霧モード: 未判明のセルは黒で塗りつぶす（通路の下地も隠す）
      if (state.fog && !state.revealed.has(key)) color = COLORS.fog;
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(x * cs, y * cs, cs, cs);
      }
    }
  }

  // 正解ルート（変換下でそのまま描くと立体的な線になる）
  // 霧モードでは線を描かず、セルの塗り分けで往路/引き返しを表す。
  if (state.path.length > 1 && !state.fog) {
    const stroke = (color, w) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      let pen = false;
      for (const p of state.path) {
        if (p.z !== floor || (state.fog && !state.revealed.has(posKey(p)))) {
          pen = false;
          continue;
        }
        if (!pen) {
          ctx.moveTo(p.x * cs + cs / 2, p.y * cs + cs / 2);
          pen = true;
        } else {
          ctx.lineTo(p.x * cs + cs / 2, p.y * cs + cs / 2);
        }
      }
      ctx.stroke();
    };
    drawPathStrokes(stroke, cs);
  }

  ctx.restore();

  // ここからはスクリーン座標（直立）でマーカー・文字を描く
  ctx.fillStyle = floor === state.start.z || floor === state.goal.z ? "#0f172a" : "#475569";
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const goalVisible = !state.fog || state.revealed.has(posKey(state.goal));
  const tags = [];
  if (floor === state.start.z) tags.push("S");
  if (floor === state.goal.z && goalVisible) tags.push("G");
  const labelPt = isoProject(0, 0, floor, originX, originY);
  ctx.fillText(`${floorName(floor)}${tags.length ? `  [${tags.join("/")}]` : ""}`, labelPt.sx, labelPt.sy - 4);

  const stairR = Math.max(cs * 1.2, 5);
  for (const keyStr of state.stairsByKey.keys()) {
    const pos = posFromKey(keyStr);
    if (pos.z !== floor) continue;
    if (state.fog && !state.revealed.has(keyStr)) continue; // 未発見の階段は隠す
    const role = stairRoleAt(pos);
    const glyph = role === "up" ? "▲" : role === "down" ? "▼" : "↕";
    const c = isoProject(pos.x + 0.5, pos.y + 0.5, floor, originX, originY);
    drawMarker(c.sx, c.sy, stairR, colorForStairRole(role), "#ffffff", glyph);
  }

  const markerR = Math.max(cs * 1.7, 7);
  if (state.start.z === floor) {
    const c = isoProject(state.start.x + 0.5, state.start.y + 0.5, floor, originX, originY);
    drawMarker(c.sx, c.sy, markerR, COLORS.start, "#064e3b", "S");
  }
  if (state.goal.z === floor && goalVisible) {
    const c = isoProject(state.goal.x + 0.5, state.goal.y + 0.5, floor, originX, originY);
    drawMarker(c.sx, c.sy, markerR, COLORS.goal, "#7f1d1d", "G");
  }
  if (state.player.z === floor && !samePos(state.player, state.start) && !samePos(state.player, state.goal)) {
    const c = isoProject(state.player.x + 0.5, state.player.y + 0.5, floor, originX, originY);
    drawMarker(c.sx, c.sy, markerR * 0.85, COLORS.player, "#7c2d12", null);
  }
}

function drawMaze() {
  if (!ctx) return;

  if (effectiveViewMode() === "iso") {
    drawMaze3D();
    return;
  }

  const layout = floorLayout();

  if (dom.canvas.width !== layout.canvasWidth || dom.canvas.height !== layout.canvasHeight) {
    dom.canvas.width = layout.canvasWidth;
    dom.canvas.height = layout.canvasHeight;
    dom.canvas.style.setProperty("--canvas-width", `${layout.canvasWidth}px`);
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);

  layout.floors.forEach((floor, idx) => {
    const oy = idx * layout.stepY + layout.labelH;
    drawFloorBlock(floor, 0, oy, layout);
  });
}

function* bfsAnimated() {
  const start = state.start;
  const goal = state.goal;
  const queue = [start];
  let cursor = 0;
  const visited = new Set([posKey(start)]);
  const parent = new Map([[posKey(start), null]]);
  yield [start];

  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (samePos(current, goal)) {
      return { path: reconstructPath(parent, goal), visited };
    }

    for (const neighbor of getNeighbors(current)) {
      const key = posKey(neighbor);
      if (!visited.has(key)) {
        visited.add(key);
        parent.set(key, posKey(current));
        queue.push(neighbor);
        yield [neighbor];
      }
    }
  }

  return { path: null, visited };
}

function solveDfsInstant() {
  // アニメーション版と同じ経路定義（スタックに経路を持たせる）になるよう、
  // ジェネレータを最後まで回して結果を取得する。
  return runGeneratorToEnd(dfsAnimated());
}

function* dfsAnimated() {
  const start = state.start;
  const goal = state.goal;
  const stack = [{ pos: start, path: [start] }];
  const visited = new Set();

  while (stack.length > 0) {
    const { pos, path } = stack.pop();
    const key = posKey(pos);
    if (visited.has(key)) continue;
    visited.add(key);
    yield [pos];

    if (samePos(pos, goal)) {
      return { path, visited };
    }

    for (const neighbor of getNeighbors(pos)) {
      if (!visited.has(posKey(neighbor))) {
        stack.push({ pos: neighbor, path: path.concat(neighbor) });
      }
    }
  }

  return { path: null, visited };
}

function solveAstarInstant() {
  const start = state.start;
  const goal = state.goal;
  const heap = new MinHeap();
  const startKey = posKey(start);
  const visited = new Set([startKey]);
  const parent = new Map([[startKey, null]]);
  const cost = new Map([[startKey, 0]]);

  heap.push({ priority: 0, pos: start });

  while (heap.size > 0) {
    const current = heap.pop().pos;
    if (samePos(current, goal)) {
      return { path: reconstructPath(parent, goal), visited };
    }

    for (const neighbor of getNeighbors(current)) {
      const neighborKey = posKey(neighbor);
      const newCost = cost.get(posKey(current)) + 1;
      if (!cost.has(neighborKey) || newCost < cost.get(neighborKey)) {
        cost.set(neighborKey, newCost);
        parent.set(neighborKey, posKey(current));
        visited.add(neighborKey);
        heap.push({ priority: newCost + heuristic(neighbor, goal), pos: neighbor });
      }
    }
  }

  return { path: null, visited };
}

function* astarAnimated() {
  const start = state.start;
  const goal = state.goal;
  const heap = new MinHeap();
  const startKey = posKey(start);
  const visited = new Set([startKey]);
  const cost = new Map([[startKey, 0]]);

  heap.push({ priority: 0, pos: start, path: [start] });
  yield [start];

  while (heap.size > 0) {
    const current = heap.pop();
    yield [current.pos];

    if (samePos(current.pos, goal)) {
      return { path: current.path, visited };
    }

    for (const neighbor of getNeighbors(current.pos)) {
      const neighborKey = posKey(neighbor);
      const newCost = cost.get(posKey(current.pos)) + 1;
      if (!cost.has(neighborKey) || newCost < cost.get(neighborKey)) {
        cost.set(neighborKey, newCost);
        visited.add(neighborKey);
        heap.push({
          priority: newCost + heuristic(neighbor, goal),
          pos: neighbor,
          path: current.path.concat(neighbor),
        });
        yield [neighbor];
      }
    }
  }

  return { path: null, visited };
}

function* wallFollowerAnimated(leftHand = false) {
  const goal = state.goal;
  let pos = { ...state.start };
  let directionIndex = 2;
  let previousKey = null;
  const path = [pos];
  const visited = new Set([posKey(pos)]);
  const maxSteps = Math.min(state.width * state.height * state.floorCount, 12000);
  yield [pos];

  for (let step = 0; step < maxSteps && !samePos(pos, goal); step += 1) {
    const stairOptions = getStairsFrom(pos).filter((next) => posKey(next) !== previousKey);
    if (stairOptions.length > 0) {
      const next = stairOptions.find((candidate) => !visited.has(posKey(candidate))) || stairOptions[0];
      previousKey = posKey(pos);
      pos = { ...next };
      path.push(pos);
      visited.add(posKey(pos));
      yield [pos];
      continue;
    }

    const order = leftHand ? [-1, 0, 1, 2] : [1, 0, -1, 2];
    let moved = false;

    for (const turn of order) {
      const nextDirection = (directionIndex + turn + 4) % 4;
      const dir = DIRECTIONS[nextDirection];
      const next = { x: pos.x + dir.x, y: pos.y + dir.y, z: pos.z };
      if (isOpen(next.x, next.y, next.z)) {
        previousKey = posKey(pos);
        directionIndex = nextDirection;
        pos = next;
        path.push(pos);
        visited.add(posKey(pos));
        yield [pos];
        moved = true;
        break;
      }
    }

    if (!moved) break;
  }

  if (!samePos(pos, goal)) {
    const fallback = shortestPathBetween(pos, goal);
    for (const key of fallback.visited) visited.add(key);
    if (fallback.path) {
      for (const next of fallback.path.slice(1)) {
        pos = next;
        path.push(pos);
        visited.add(posKey(pos));
        yield [pos];
      }
    }
  }

  return { path: samePos(pos, goal) ? path : null, visited };
}

function runGeneratorToEnd(generator) {
  const visited = new Set();
  while (true) {
    const step = generator.next();
    if (step.done) {
      for (const key of step.value.visited) visited.add(key);
      return { ...step.value, visited };
    }

    for (const pos of step.value) visited.add(posKey(pos));
  }
}

function solveWallFollowerInstant(leftHand = false) {
  return runGeneratorToEnd(wallFollowerAnimated(leftHand));
}

// マイクロマウス探索（フラッドフィル法）。
// エージェントは訪問セル周囲の壁だけを既知とし、未知は通行可と仮定して
// ゴールからの距離場を作り、距離が小さくなる隣へ進む。視界(sensed)を毎ステップ
// yield して霧を晴らす。距離場の再計算は「行き詰まり（局所最小）」のときだけに
// 限定し、整数IDと TypedArray を使って高速化している（古典的な flood-fill 法）。
function* micromouseAnimated() {
  const W = state.width;
  const H = state.height;
  const F = state.floorCount;
  const N = W * H * F;
  const idOf = (x, y, z) => (z * H + y) * W + x;

  const start = state.start;
  const goal = state.goal;
  const goalId = idOf(goal.x, goal.y, goal.z);

  // 階段の隣接（id -> [id,...]）を事前構築。大半のセルは階段が無いので、
  // フラッドフィルの内側ループでの Map 参照を避けるためフラグも持つ。
  const stairIds = new Map();
  const hasStair = new Uint8Array(N);
  for (const [key, targets] of state.stairsByKey.entries()) {
    const p = posFromKey(key);
    const id = idOf(p.x, p.y, p.z);
    stairIds.set(id, targets.map((t) => idOf(t.x, t.y, t.z)));
    hasStair[id] = 1;
  }

  const wall = new Uint8Array(N); // 1 = 既知の壁
  const known = new Uint8Array(N); // 1 = センス済み
  const dist = new Int32Array(N);
  const distVer = new Int32Array(N); // dist[i] が有効なのは distVer[i]===ver のとき
  const queue = new Int32Array(N); // BFS キュー（毎回再利用）
  let ver = 0;
  const visited = new Set(); // 判明済み（霧を晴らす対象）

  // ゴールからの距離場（既知壁のみ遮断、未知は通行可）を BFS で再計算する。
  const flood = () => {
    ver += 1;
    dist[goalId] = 0;
    distVer[goalId] = ver;
    queue[0] = goalId;
    let head = 0;
    let tail = 1;
    while (head < tail) {
      const c = queue[head];
      head += 1;
      const nd = dist[c] + 1;
      const z = (c / (W * H)) | 0;
      const rem = c - z * W * H;
      const y = (rem / W) | 0;
      const x = rem - y * W;
      let nid;
      if (y > 0 && wall[(nid = c - W)] !== 1 && distVer[nid] !== ver) {
        distVer[nid] = ver; dist[nid] = nd; queue[tail++] = nid;
      }
      if (y < H - 1 && wall[(nid = c + W)] !== 1 && distVer[nid] !== ver) {
        distVer[nid] = ver; dist[nid] = nd; queue[tail++] = nid;
      }
      if (x > 0 && wall[(nid = c - 1)] !== 1 && distVer[nid] !== ver) {
        distVer[nid] = ver; dist[nid] = nd; queue[tail++] = nid;
      }
      if (x < W - 1 && wall[(nid = c + 1)] !== 1 && distVer[nid] !== ver) {
        distVer[nid] = ver; dist[nid] = nd; queue[tail++] = nid;
      }
      if (hasStair[c]) {
        for (const sid of stairIds.get(c)) {
          if (wall[sid] !== 1 && distVer[sid] !== ver) {
            distVer[sid] = ver; dist[sid] = nd; queue[tail++] = sid;
          }
        }
      }
    }
  };
  const distOf = (id) => (distVer[id] === ver ? dist[id] : Infinity);

  // pos 周囲をセンスして known / wall / visited を更新。
  const sense = (p) => {
    const sensed = computeVisibleCells(p);
    for (const key of sensed) {
      visited.add(key);
      const c = posFromKey(key);
      const id = idOf(c.x, c.y, c.z);
      if (!known[id]) {
        known[id] = 1;
        wall[id] = isOpen(c.x, c.y, c.z) ? 0 : 1;
      }
    }
    return sensed;
  };

  // 現在地から実際に移動できる隣（実迷路で開いている平面隣＋階段）。
  const realMoves = (p) => {
    const res = [];
    for (const dir of DIRECTIONS) {
      const nx = p.x + dir.x;
      const ny = p.y + dir.y;
      if (isOpen(nx, ny, p.z)) res.push({ x: nx, y: ny, z: p.z });
    }
    for (const s of getStairsFrom(p)) res.push({ ...s });
    return res;
  };

  let pos = { ...start };
  const path = [pos];
  const cap = N * 4 + 100;
  flood();

  let steps = 0;
  while (steps < cap) {
    steps += 1;
    const sensed = sense(pos);
    yield { pos: { ...pos }, sensed };
    if (samePos(pos, goal)) return { path, visited };

    const here = idOf(pos.x, pos.y, pos.z);
    const moves = realMoves(pos);
    const prevId =
      path.length > 1
        ? idOf(path[path.length - 2].x, path[path.length - 2].y, path[path.length - 2].z)
        : -1;
    const pick = () => {
      let best = null;
      let bestD = Infinity;
      let bestId = -1;
      for (const m of moves) {
        const id = idOf(m.x, m.y, m.z);
        const d = distOf(id);
        if (d < bestD || (d === bestD && bestId === prevId && id !== prevId)) {
          bestD = d;
          best = m;
          bestId = id;
        }
      }
      return { best, bestD };
    };

    let { best, bestD } = pick();
    // 局所最小（下り坂の隣がない）なら、判明した壁で距離場を再計算する。
    if (!best || bestD >= distOf(here)) {
      flood();
      ({ best, bestD } = pick());
    }
    if (!best || bestD === Infinity) break; // 到達不能
    pos = { ...best };
    path.push(pos);
  }

  // 安全網: 上限到達/行き詰まりは既知の最短経路で補完する。
  const fallback = shortestPathBetween(pos, goal);
  for (const key of fallback.visited || []) visited.add(key);
  if (fallback.path) {
    for (const next of fallback.path.slice(1)) path.push(next);
  }
  return { path: samePos(path[path.length - 1], goal) ? path : null, visited };
}

function solveMicromouseInstant() {
  const gen = micromouseAnimated();
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

function appendFallbackPath(path, pathKeys, visited, current, goal) {
  const fallback = shortestPathBetween(current, goal);
  for (const key of fallback.visited) visited.add(key);
  if (!fallback.path) return false;

  for (const next of fallback.path.slice(1)) {
    path.push(next);
    pathKeys.add(posKey(next));
    visited.add(posKey(next));
  }
  return true;
}

function floodFillReachable(start, goal, blockedEdgeKey = null) {
  const queue = [start];
  let cursor = 0;
  const visited = new Set([posKey(start)]);

  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (samePos(current, goal)) {
      return { reachable: true, visited };
    }

    for (const neighbor of getNeighbors(current)) {
      if (blockedEdgeKey && edgeKey(current, neighbor) === blockedEdgeKey) continue;
      const key = posKey(neighbor);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push(neighbor);
      }
    }
  }

  return { reachable: false, visited };
}

function solvePaintbrushInstant() {
  const start = state.start;
  const goal = state.goal;
  const initial = floodFillReachable(start, goal);
  if (!initial.reachable) {
    return { path: null, visited: new Set(), rejected: new Set() };
  }

  let current = start;
  const path = [current];
  const pathKeys = new Set([posKey(current)]);
  const rejected = new Set();
  const visitedOverall = new Set([posKey(current)]);
  const maxSteps = state.width * state.height * state.floorCount;

  for (let step = 0; step < maxSteps && !samePos(current, goal); step += 1) {
    const neighbors = getNeighbors(current)
      .filter((neighbor) => !pathKeys.has(posKey(neighbor)))
      .sort((a, b) => heuristic(a, goal) - heuristic(b, goal));

    if (neighbors.length === 0) {
      const completed = appendFallbackPath(path, pathKeys, visitedOverall, current, goal);
      return { path: completed ? path : null, visited: visitedOverall, rejected };
    }

    let chosen = null;
    for (const candidate of neighbors) {
      const blocked = edgeKey(current, candidate);
      const result = floodFillReachable(current, goal, blocked);
      for (const key of result.visited) visitedOverall.add(key);

      if (result.reachable) {
        rejected.add(posKey(candidate));
      } else {
        chosen = candidate;
        break;
      }
    }

    if (!chosen) chosen = neighbors[0];
    current = chosen;
    path.push(current);
    pathKeys.add(posKey(current));
    visitedOverall.add(posKey(current));
  }

  if (!samePos(current, goal)) {
    const completed = appendFallbackPath(path, pathKeys, visitedOverall, current, goal);
    return { path: completed ? path : null, visited: visitedOverall, rejected };
  }

  return { path, visited: visitedOverall, rejected };
}

function* paintbrushFallbackEvents(path, pathKeys, visitedOverall, current, goal) {
  const fallback = shortestPathBetween(current, goal);
  for (const key of fallback.visited) visitedOverall.add(key);
  if (!fallback.path) return false;

  for (const next of fallback.path.slice(1)) {
    path.push(next);
    pathKeys.add(posKey(next));
    visitedOverall.add(posKey(next));
    yield { type: "step", current: next, path: path.slice() };
  }

  return true;
}

function* paintbrushAnimated() {
  const start = state.start;
  const goal = state.goal;
  const initial = floodFillReachable(start, goal);
  if (!initial.reachable) {
    return { path: null, visited: new Set(), rejected: new Set() };
  }

  let current = start;
  const path = [current];
  const pathKeys = new Set([posKey(current)]);
  const rejected = new Set();
  const visitedOverall = new Set([posKey(current)]);
  const maxSteps = state.width * state.height * state.floorCount;

  for (let step = 0; step < maxSteps && !samePos(current, goal); step += 1) {
    yield { type: "step", current, path: path.slice() };

    const neighbors = getNeighbors(current)
      .filter((neighbor) => !pathKeys.has(posKey(neighbor)))
      .sort((a, b) => heuristic(a, goal) - heuristic(b, goal));

    if (neighbors.length === 0) {
      const completed = yield* paintbrushFallbackEvents(path, pathKeys, visitedOverall, current, goal);
      return { path: completed ? path : null, visited: visitedOverall, rejected };
    }

    let chosen = null;
    for (const candidate of neighbors) {
      const blocked = edgeKey(current, candidate);
      yield { type: "test", candidate, tempBlock: [current, candidate] };

      const result = floodFillReachable(current, goal, blocked);
      for (const key of result.visited) visitedOverall.add(key);
      yield { type: "flood", cells: result.visited };

      if (result.reachable) {
        rejected.add(posKey(candidate));
        yield { type: "reject", branch: candidate };
      } else {
        chosen = candidate;
        yield { type: "accept", branch: candidate };
        break;
      }
    }

    if (!chosen) chosen = neighbors[0];
    current = chosen;
    path.push(current);
    pathKeys.add(posKey(current));
    visitedOverall.add(posKey(current));
  }

  if (!samePos(current, goal)) {
    const completed = yield* paintbrushFallbackEvents(path, pathKeys, visitedOverall, current, goal);
    return { path: completed ? path : null, visited: visitedOverall, rejected };
  }

  return { path, visited: visitedOverall, rejected };
}

function sleep(ms) {
  return new Promise((resolve) => {
    if (ms <= 0) {
      requestAnimationFrame(() => resolve());
    } else {
      window.setTimeout(resolve, ms);
    }
  });
}

async function animateGeneric(generator, label, startedAt, token) {
  const speed = SPEEDS[dom.speed.value] || SPEEDS.normal;
  const { batchSize, sleepFactor } = animationPacing();

  while (state.running && token === state.runToken) {
    // 大きい迷路では 1 描画あたり複数ステップ進めて描画回数を抑える。
    let done = null;
    for (let i = 0; i < batchSize; i += 1) {
      const step = generator.next();
      if (step.done) {
        done = step.value;
        break;
      }
      const last = step.value[step.value.length - 1];
      if (last) setVisibleFloor(last.z, false);
      for (const pos of step.value) state.visited.add(posKey(pos));
    }

    if (done) {
      const result = done;
      state.visited = result.visited;
      setPath(result.path || []);
      state.rejected = result.rejected || new Set();
      state.currentKey = null;
      state.candidateKey = null;
      state.tempBlock = null;
      state.finalPathMode = Boolean(result.path);
      if (result.path) setVisibleFloor(result.path[result.path.length - 1].z, false);
      drawMaze();
      return result;
    }

    setMetrics(state.visited.size, state.path.length, performance.now() - startedAt);
    setStatus(`${label}: 探索中 (${floorName(state.visibleFloor)})`);
    drawMaze();
    await sleep(speed.flood * sleepFactor);
  }

  return null;
}

async function animatePaintbrush(startedAt, token) {
  const speed = SPEEDS[dom.speed.value] || SPEEDS.normal;
  const generator = paintbrushAnimated();
  const { batchSize, sleepFactor } = animationPacing();

  while (state.running && token === state.runToken) {
    // 大きい迷路では複数イベントをまとめて適用し、描画回数を抑える。
    let done = null;
    let lastType = null;
    for (let i = 0; i < batchSize; i += 1) {
      const step = generator.next();
      if (step.done) {
        done = step.value;
        break;
      }

      const event = step.value;
      lastType = event.type;
      if (event.type === "step") {
        setVisibleFloor(event.current.z, false);
        state.currentKey = posKey(event.current);
        state.candidateKey = null;
        state.tempBlock = null;
        setPath(event.path);
      }

      if (event.type === "test") {
        setVisibleFloor(event.tempBlock[0].z, false);
        state.candidateKey = posKey(event.candidate);
        state.tempBlock = event.tempBlock;
      }

      if (event.type === "flood") {
        for (const key of event.cells) state.visited.add(key);
      }

      if (event.type === "reject") {
        state.rejected.add(posKey(event.branch));
      }
    }

    if (done) {
      const result = done;
      state.visited = result.visited;
      state.rejected = result.rejected;
      setPath(result.path || []);
      state.currentKey = null;
      state.candidateKey = null;
      state.tempBlock = null;
      state.finalPathMode = Boolean(result.path);
      if (result.path) setVisibleFloor(result.path[result.path.length - 1].z, false);
      drawMaze();
      return result;
    }

    setMetrics(state.visited.size, state.path.length, performance.now() - startedAt);
    setStatus(`Paintbrush: ${lastType} (${floorName(state.visibleFloor)})`);
    drawMaze();
    await sleep((lastType === "flood" ? speed.flood : speed.step) * sleepFactor);
  }

  return null;
}

// マイクロマウス探索のアニメーション。エージェントを1歩ずつ進めながら
// 視界(sensed)を判明済みに加えて霧を晴らしていく。
async function animateMicromouse(startedAt, token) {
  const speed = SPEEDS[dom.speed.value] || SPEEDS.normal;
  const { batchSize, sleepFactor } = animationPacing();
  const generator = micromouseAnimated();
  const trail = [];
  const walked = new Set(); // 一度でも通ったセル
  state.finalPathMode = false;
  state.backtrack = new Set();

  while (state.running && token === state.runToken) {
    let done = null;
    let last = null;
    for (let i = 0; i < batchSize; i += 1) {
      const step = generator.next();
      if (step.done) {
        done = step.value;
        break;
      }
      const event = step.value;
      last = event;
      state.player = event.pos;
      trail.push(event.pos);
      // すでに通ったセルに再び入った＝引き返し。色分け用に記録する。
      const pkey = posKey(event.pos);
      if (walked.has(pkey)) state.backtrack.add(pkey);
      else walked.add(pkey);
      for (const key of event.sensed) {
        state.revealed.add(key);
        state.visited.add(key);
      }
    }

    if (done) {
      const result = done;
      state.visited = result.visited;
      for (const key of result.visited) state.revealed.add(key);
      setPath(result.path || []);
      if (result.path) state.player = result.path[result.path.length - 1];
      state.currentKey = null;
      state.finalPathMode = Boolean(result.path);
      if (result.path) setVisibleFloor(result.path[result.path.length - 1].z, false);
      drawMaze();
      return result;
    }

    if (last) {
      state.currentKey = posKey(last.pos);
      setVisibleFloor(last.pos.z, false);
      setPath(trail.slice()); // 走行跡
      setMetrics(state.visited.size, trail.length, performance.now() - startedAt);
      setStatus(`マイクロマウス: 探索中 (${floorName(state.visibleFloor)})`);
      drawMaze();
      await sleep(speed.step * sleepFactor);
    }
  }

  return null;
}

// 各解法の表示名・即時実行関数・アニメーション・最短保証フラグ。
// runSolver と比較機能（solverComparison）で共有する。
const SOLVER_CONFIGS = {
  paintbrush: {
    label: "Paintbrush",
    instant: solvePaintbrushInstant,
    animated: () => paintbrushAnimated(),
    optimal: false,
  },
  right: {
    label: "右手法",
    instant: () => solveWallFollowerInstant(false),
    animated: () => wallFollowerAnimated(false),
    optimal: false,
  },
  left: {
    label: "左手法",
    instant: () => solveWallFollowerInstant(true),
    animated: () => wallFollowerAnimated(true),
    optimal: false,
  },
  bfs: { label: "BFS", instant: solveBfsInstant, animated: bfsAnimated, optimal: true },
  dfs: { label: "DFS", instant: solveDfsInstant, animated: dfsAnimated, optimal: false },
  astar: { label: "A*", instant: solveAstarInstant, animated: astarAnimated, optimal: true },
  micromouse: {
    label: "マイクロマウス",
    instant: solveMicromouseInstant,
    animated: () => micromouseAnimated(),
    optimal: false,
  },
};

// 比較・バッチ・掃引で回す解法群（マイクロマウスは霧専用のため含めない）。
const SOLVER_ORDER = ["bfs", "astar", "dfs", "paintbrush", "right", "left"];

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// 現在の迷路上で全解法を即時実行し、経路長・探索セル数・所要時間・最短一致を集計する。
// DOM に依存しないため、研究用途のベンチマークやテストからも利用できる。
function solverComparison() {
  const optimal = bfsDistances(state.start).get(posKey(state.goal));
  const rows = SOLVER_ORDER.map((name) => {
    const config = SOLVER_CONFIGS[name];
    const startedAt = nowMs();
    const result = config.instant();
    const duration = nowMs() - startedAt;
    const solved = Boolean(result.path);
    const pathLength = solved ? result.path.length - 1 : null;
    return {
      name,
      label: config.label,
      solved,
      pathLength,
      isShortest: solved && pathLength === optimal,
      visited: result.visited ? result.visited.size : 0,
      duration,
    };
  });
  return { optimal, rows };
}

// バッチ集計用のアキュムレータ。1 迷路ずつ加算できるため、非同期チャンク処理に使える。
function createBatchAccumulator() {
  const agg = {};
  for (const name of SOLVER_ORDER) {
    agg[name] = { label: SOLVER_CONFIGS[name].label, solved: 0, shortest: 0, pathSum: 0, visitedSum: 0, timeSum: 0 };
  }
  return { agg, optimalSum: 0, count: 0 };
}

// 指定シードで迷路を作り直し、全解法を実行してアキュムレータへ加算する。
// state の width/height/floorCount/braid 等の現在設定を用いる（state を書き換える）。
function batchAccumulateOne(acc, seed) {
  setSeed(seed);
  buildMaze();
  const stats = solverComparison();
  acc.optimalSum += stats.optimal;
  acc.count += 1;
  for (const row of stats.rows) {
    const a = acc.agg[row.name];
    a.visitedSum += row.visited;
    a.timeSum += row.duration;
    if (row.solved) {
      a.solved += 1;
      a.pathSum += row.pathLength;
    }
    if (row.isShortest) a.shortest += 1;
  }
  return acc;
}

function finalizeBatch(acc) {
  const n = acc.count || 1;
  const rows = SOLVER_ORDER.map((name) => {
    const a = acc.agg[name];
    return {
      name,
      label: a.label,
      solveRate: a.solved / n,
      shortestRate: a.shortest / n,
      avgPath: a.solved ? a.pathSum / a.solved : null,
      avgVisited: a.visitedSum / n,
      avgTime: a.timeSum / n,
    };
  });
  return { runs: acc.count, avgOptimal: acc.optimalSum / n, rows };
}

// 複数のシードで迷路を作り直し、全解法を実行して平均値を集計する（研究用バッチ検証）。
// 呼び出し側で表示用の迷路を復元すること。
function batchBenchmark(seeds) {
  const acc = createBatchAccumulator();
  for (const seed of seeds) batchAccumulateOne(acc, seed);
  return finalizeBatch(acc);
}

// パラメータ掃引: 指定パラメータ（"braid" / "stairDensity"）を values で振りながら、
// 各値で runsPerPoint 回のバッチを集計する。横軸=パラメータ値の比較データを返す。
function parameterSweep(param, values, runsPerPoint, seedFor) {
  const prev = state[param];
  const points = values.map((value, vi) => {
    state[param] = value;
    const acc = createBatchAccumulator();
    for (let r = 0; r < runsPerPoint; r += 1) {
      const seed = seedFor ? seedFor(vi, r) : randomSeed();
      batchAccumulateOne(acc, seed);
    }
    return { value, batch: finalizeBatch(acc) };
  });
  state[param] = prev;
  return { param, points };
}

// --- 結果のエクスポート（CSV / JSON） ----------------------------------------

// エクスポートに添える生成設定（再現用メタデータ）。
function exportSettings() {
  return {
    width: state.width,
    height: state.height,
    floorCount: state.floorCount,
    braid: state.braid,
    stairDensity: state.stairDensity,
    generationAttempts: state.generationAttempts,
  };
}

function batchToCsv(stats) {
  const header = "solver,solveRate,shortestRate,avgPath,avgVisited,avgTime";
  const lines = stats.rows.map((r) =>
    [
      r.label,
      r.solveRate.toFixed(4),
      r.shortestRate.toFixed(4),
      r.avgPath == null ? "" : r.avgPath.toFixed(3),
      r.avgVisited.toFixed(3),
      r.avgTime.toFixed(4),
    ].join(","),
  );
  return [`# runs=${stats.runs} avgOptimal=${stats.avgOptimal.toFixed(3)}`, header, ...lines].join("\n");
}

function sweepToCsv(sweep) {
  const header = `${sweep.param},solver,solveRate,shortestRate,avgPath,avgVisited,avgTime`;
  const lines = [];
  for (const point of sweep.points) {
    for (const r of point.batch.rows) {
      lines.push(
        [
          point.value,
          r.label,
          r.solveRate.toFixed(4),
          r.shortestRate.toFixed(4),
          r.avgPath == null ? "" : r.avgPath.toFixed(3),
          r.avgVisited.toFixed(3),
          r.avgTime.toFixed(4),
        ].join(","),
      );
    }
  }
  return [header, ...lines].join("\n");
}

// 指定解法の「探索順」を取得する。アニメーション用ジェネレータを最後まで回し、
// 各セルが最初に訪問された順番を記録する（ヒートマップ描画に使う）。
function solverVisitOrder(name) {
  const gen = SOLVER_CONFIGS[name].animated();
  const order = new Map();
  let idx = 0;
  const add = (key) => {
    if (!order.has(key)) {
      order.set(key, idx);
      idx += 1;
    }
  };

  while (true) {
    const step = gen.next();
    if (step.done) {
      const result = step.value;
      if (result && result.visited) {
        for (const key of result.visited) add(key);
      }
      return { order, total: Math.max(1, idx), result };
    }

    const value = step.value;
    if (Array.isArray(value)) {
      for (const pos of value) add(posKey(pos));
    } else if (value && value.cells) {
      for (const key of value.cells) add(key);
    } else if (value && value.current) {
      add(posKey(value.current));
    } else if (value && value.candidate) {
      add(posKey(value.candidate));
    }
  }
}

// アニメーションの再生に要する時間を見積もる（DOM 非依存・検証用）。
// animateGeneric / animatePaintbrush と同じバッチ・待機ルールでジェネレータを
// 走査し、累積待機時間(totalSleep)と描画回数(draws)を返す。
// applyPacing=false で従来挙動（迷路サイズに依らず等倍）を再現でき、
// ペース配分の効果を比較検証できる。
function estimateAnimationDuration(name, speedName = "normal", applyPacing = true) {
  const speed = SPEEDS[speedName] || SPEEDS.normal;
  const { batchSize, sleepFactor } = applyPacing
    ? animationPacing()
    : { batchSize: 1, sleepFactor: 1 };
  const isPaintbrush = name === "paintbrush";
  const gen = SOLVER_CONFIGS[name].animated();

  let totalSleep = 0;
  let draws = 0;
  let pending = 0;
  let lastType = null;

  const flush = () => {
    draws += 1;
    const base = isPaintbrush && lastType !== "flood" ? speed.step : speed.flood;
    totalSleep += base * sleepFactor;
    pending = 0;
  };

  while (true) {
    const step = gen.next();
    // done はそのバッチを描画せず終了する（アニメーターの挙動に合わせる）。
    if (step.done) break;
    pending += 1;
    if (isPaintbrush) lastType = step.value.type;
    if (pending >= batchSize) flush();
  }

  return { totalSleep, draws };
}

// 探索順 t(0..1) を寒色→暖色のグラデーションに変換する。
function heatColor(t) {
  const hue = 210 - clamp(t, 0, 1) * 210; // 青(210) → 赤(0)
  return `hsl(${hue}, 85%, 60%)`;
}

function finishSolver(label, result, startedAt) {
  const duration = performance.now() - startedAt;
  state.visited = result.visited || new Set();
  state.rejected = result.rejected || new Set();
  setPath(result.path || []);
  state.currentKey = null;
  state.candidateKey = null;
  state.tempBlock = null;
  state.finalPathMode = Boolean(result.path);
  if (result.path) setVisibleFloor(result.path[result.path.length - 1].z, false);
  drawMaze();
  setMetrics(state.visited.size, state.path.length, duration);
  setStatus(result.path ? `${label}: 完了 (${floorName(state.visibleFloor)})` : `${label}: 解なし`);

  if (result.path) {
    const optimalLen = bfsDistances(state.start).get(posKey(state.goal));
    const len = result.path.length - 1;
    const note = len === optimalLen ? "（最短）" : `（最短は ${optimalLen} ステップ）`;
    announce(
      `${label} が完了しました。経路長 ${len} ステップ${note}、` +
        `探索セル数 ${state.visited.size}、所要時間 ${duration.toFixed(1)} ミリ秒。`,
    );
  } else {
    announce(`${label}: 経路が見つかりませんでした。`);
  }
}

// 指定セルの画面座標（中心）を現在のレイアウトで求める。平面表示（1階ずつ/
// 全階縦積み）のみ対応し、表示外の階や 3D 俯瞰では null を返す（呼び出し側で
// 画面中央にフォールバックする）。
function cellScreenPos(pos) {
  if (effectiveViewMode() === "iso") return null;
  const layout = floorLayout();
  const idx = layout.floors.indexOf(pos.z);
  if (idx === -1) return null;
  const cs = state.cellSize;
  const oy = idx * layout.stepY + layout.labelH;
  return { sx: pos.x * cs + cs / 2, sy: oy + pos.y * cs + cs / 2 };
}

// 階をまたぐ「ワープ」演出を 1 セル位置に描く。t は 0→1 の進捗。
// 前半(出発)はリングが中心へ収束しオーブが吸い込まれる、後半(到着)は中心から
// リングが拡散しオーブが現れる。上り(up)は青系・▲・上方向、下りは紫系・▼・下方向。
function drawWarpOverlay(t, up, tint, fromCell, toCell) {
  const arriving = t >= 0.5;
  const cell = arriving ? toCell : fromCell;
  const pos =
    cellScreenPos(cell) || { sx: dom.canvas.width / 2, sy: dom.canvas.height / 2 };
  const local = arriving ? (t - 0.5) / 0.5 : t / 0.5; // 各フェーズ内 0→1
  const cs = state.cellSize;
  const baseR = Math.max(14, cs * 7);
  const dir = up ? -1 : 1;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // 縦方向の光の柱（垂直移動を示唆）
  ctx.globalAlpha = 0.22 * Math.sin(clamp(t, 0, 1) * Math.PI);
  ctx.fillStyle = tint;
  ctx.fillRect(pos.sx - cs * 1.2, 0, cs * 2.4, dom.canvas.height);

  // 同心リング（出発=外→中心へ収束 / 到着=中心→外へ拡散）
  ctx.lineWidth = Math.max(2, cs * 0.7);
  ctx.strokeStyle = tint;
  for (let k = 0; k < 4; k += 1) {
    const phase = (local + k * 0.25) % 1;
    const rr = arriving ? phase * baseR : (1 - phase) * baseR;
    ctx.globalAlpha = (1 - phase) * 0.75;
    ctx.beginPath();
    ctx.arc(pos.sx, pos.sy, Math.max(1, rr), 0, TAU);
    ctx.stroke();
  }

  // 中心のオーブ（出発で縮小・到着で拡大）
  const orbR = (arriving ? local : 1 - local) * baseR * 0.5;
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = tint;
  ctx.beginPath();
  ctx.arc(pos.sx, pos.sy, Math.max(2, orbR), 0, TAU);
  ctx.fill();
  ctx.lineWidth = Math.max(2, cs * 0.5);
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  // 進行方向へ流れる矢印
  const glyph = up ? "▲" : "▼";
  const flow = t % 1;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.round(baseR * 0.55)}px system-ui, sans-serif`;
  for (let o = 0; o < 3; o += 1) {
    const f = (o * 0.4 + flow) % 1;
    ctx.globalAlpha = (1 - Math.abs(f - 0.5) * 1.6) * 0.9;
    ctx.fillText(glyph, pos.sx, pos.sy + dir * (f - 0.5) * baseR * 2.4);
  }

  // ラベル（上り/下り）
  ctx.globalAlpha = Math.sin(clamp(t, 0, 1) * Math.PI);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(baseR * 0.3)}px system-ui, sans-serif`;
  ctx.fillText(up ? "上り" : "下り", pos.sx, pos.sy + baseR * 1.5);

  ctx.restore();
}

// 現在地(fromCell)から上下階の同一地点(toCell)へワープする演出を再生する。
// 前半は出発階を、中間で表示階を切り替え、後半は到着階を背景に描く。
// 停止/再実行されたら false を返す。
async function playFloorWarp(fromCell, toCell, direction, token) {
  // 動きを減らす設定 or スキップ要求時は、演出せず即座に階を切り替える。
  if (prefersReducedMotion() || state.skipReplay) {
    setVisibleFloor(toCell.z, false);
    drawMaze();
    return state.running && token === state.runToken;
  }

  const up = direction === "up";
  const tint = up ? COLORS.stairUp : COLORS.stairDown;
  const { sleepFactor } = animationPacing();
  const duration = clamp(720 * sleepFactor, 480, 1300);
  const start = performance.now();
  let switched = false;

  while (state.running && token === state.runToken && !state.skipReplay) {
    const t = (performance.now() - start) / duration;
    if (t >= 1) break;
    if (t >= 0.5 && !switched) {
      setVisibleFloor(toCell.z, false); // 中間で到着階へ切り替え
      switched = true;
    } else if (t < 0.5) {
      setVisibleFloor(fromCell.z, false);
    }
    drawMaze();
    drawWarpOverlay(t, up, tint, fromCell, toCell);
    await sleep(16);
  }

  if (!state.running || token !== state.runToken) return false;
  setVisibleFloor(toCell.z, false);
  drawMaze();
  return true;
}

// 解答ルートが階層をまたぐか（階段を通るか）を判定する。
function pathCrossesFloors(path) {
  if (!path) return false;
  for (let i = 1; i < path.length; i += 1) {
    if (path[i].z !== path[i - 1].z) return true;
  }
  return false;
}

// 解答ルートを始点から終点までなぞり、階段で上り/下りの遷移演出を入れる。
// 探索が終わった「正解の道のり」を再生する位置づけ。サイズによらず再生時間が
// 一定になるよう、なぞるテンポをパスの長さに応じて間引く。
async function animateSolutionTraversal(path, token, label) {
  if (!path || path.length < 2) return true;

  // 操作用プレイヤーは始点へ戻し、表示は終点の階に合わせて締める共通処理。
  const finalize = () => {
    state.finalPathMode = true;
    state.player = { ...path[0] };
    state.currentKey = null;
    setVisibleFloor(path[path.length - 1].z, false);
    drawMaze();
  };

  // 動きを減らす設定では、なぞり再生を行わず結果だけを表示する。
  if (prefersReducedMotion()) {
    finalize();
    return true;
  }

  const speed = SPEEDS[dom.speed.value] || SPEEDS.normal;
  // パス長によらず描画回数を概ね一定(~TARGET)に保つ。再生はゆっくり見せたいので
  // 描画回数を多めに取り、1 セルあたりの待機も探索より長めにする。
  const TARGET = 160;
  const batchSize = Math.max(1, Math.ceil((path.length - 1) / TARGET));
  const stepMs = Math.min(speed.step * 1.2, 110); // 遅すぎ防止に上限を設ける

  state.replaying = true;
  state.skipReplay = false;
  state.finalPathMode = true;
  state.player = { ...path[0] };
  setVisibleFloor(state.player.z, false);
  drawMaze();

  try {
    let pending = 0;
    for (let i = 1; i < path.length; i += 1) {
      if (!state.running || token !== state.runToken) return false;
      if (state.skipReplay) break; // クリック/キーで最終結果へスキップ
      const cell = path[i];

      if (cell.z !== state.player.z) {
        // 直前のセル（階段の足元）まで進めてから、その地点でワープ演出に入る。
        const fromCell = { ...path[i - 1] };
        state.player = fromCell;
        state.currentKey = posKey(state.player);
        const direction = cell.z > fromCell.z ? "up" : "down";
        setStatus(`${label}: ${direction === "up" ? "上り" : "下り"}ワープ`);
        const ok = await playFloorWarp(fromCell, cell, direction, token);
        if (!ok && !state.skipReplay) return false;
        pending = 0;
      }

      state.player = { ...cell };
      pending += 1;

      if (pending >= batchSize || i === path.length - 1) {
        state.currentKey = posKey(state.player);
        setVisibleFloor(state.player.z, false);
        drawMaze();
        setStatus(`${label}: ルート再生（クリックでスキップ） (${floorName(state.visibleFloor)})`);
        await sleep(stepMs);
        pending = 0;
      }
    }
  } finally {
    state.replaying = false;
  }

  if (!state.running || token !== state.runToken) return false;
  finalize();
  return true;
}

function clearComparison() {
  if (dom.compareOutput) dom.compareOutput.innerHTML = "";
}

function renderComparison(stats) {
  if (!dom.compareOutput) return;
  const rowsHtml = stats.rows
    .map((row) => {
      const path = row.solved ? row.pathLength : "—";
      const best = row.isShortest ? ' <span class="badge">最短</span>' : "";
      const cls = row.solved ? "" : ' class="cmp-fail"';
      return `<tr${cls}><th scope="row">${row.label}${best}</th><td>${path}</td><td>${row.visited.toLocaleString("ja-JP")}</td><td>${row.duration.toFixed(2)}</td></tr>`;
    })
    .join("");

  dom.compareOutput.innerHTML =
    `<table class="cmp-table"><caption>最短経路長: ${stats.optimal} ステップ</caption>` +
    "<thead><tr><th scope=\"col\">解法</th><th scope=\"col\">経路長</th><th scope=\"col\">探索</th><th scope=\"col\">時間(ms)</th></tr></thead>" +
    `<tbody>${rowsHtml}</tbody></table>`;
}

function runComparison() {
  if (state.running) return;
  clearVisualization();
  setVisibleFloor(state.start.z, false);
  drawMaze();
  setStatus("比較: 全アルゴリズムを実行中...");

  const stats = solverComparison();
  renderComparison(stats);
  setStatus("比較: 完了");

  const shortestSolvers = stats.rows.filter((r) => r.isShortest).map((r) => r.label);
  const failed = stats.rows.filter((r) => !r.solved).map((r) => r.label);
  announce(
    `全${stats.rows.length}解法を比較しました。最短経路長は ${stats.optimal} ステップ。` +
      `最短を達成したのは ${shortestSolvers.join("、") || "なし"}。` +
      (failed.length ? `経路を見つけられなかったのは ${failed.join("、")}。` : "全解法がゴールに到達しました。"),
  );
}

function renderBatch(stats) {
  if (!dom.batchOutput) return;
  const rowsHtml = stats.rows
    .map((r) => {
      const path = r.avgPath == null ? "—" : r.avgPath.toFixed(1);
      return `<tr><th scope="row">${r.label}</th><td>${path}</td><td>${Math.round(r.avgVisited).toLocaleString("ja-JP")}</td><td>${Math.round(r.shortestRate * 100)}%</td><td>${r.avgTime.toFixed(2)}</td></tr>`;
    })
    .join("");

  dom.batchOutput.innerHTML =
    `<table class="cmp-table"><caption>${stats.runs} 迷路の平均 / 平均最短長 ${stats.avgOptimal.toFixed(1)}</caption>` +
    "<thead><tr><th scope=\"col\">解法</th><th scope=\"col\">平均経路</th><th scope=\"col\">平均探索</th><th scope=\"col\">最短率</th><th scope=\"col\">平均ms</th></tr></thead>" +
    `<tbody>${rowsHtml}</tbody></table>`;
}

// 重い処理を時間予算(budgetMs)ごとに分割実行し、合間にUIへ制御を返す（フリーズ防止）。
// runToken が変化したら（停止/再生成）中断して false を返す。
async function runChunked(count, step, options) {
  const { token, onProgress, budgetMs = 24 } = options || {};
  let last = nowMs();
  for (let i = 0; i < count; i += 1) {
    if (token != null && token !== state.runToken) return false;
    step(i);
    if (nowMs() - last >= budgetMs) {
      if (onProgress) onProgress(i + 1, count);
      await sleep(0);
      last = nowMs();
    }
  }
  if (onProgress) onProgress(count, count);
  return true;
}

function setProgress(container, bar, done, total) {
  if (!container || !bar) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  container.hidden = false;
  if (container.setAttribute) container.setAttribute("aria-valuenow", String(pct));
  bar.style.width = `${pct}%`;
  bar.textContent = `${pct}%`;
}

function hideProgress(container) {
  if (container) container.hidden = true;
}

function updateExportButtons() {
  if (dom.batchCsv) dom.batchCsv.disabled = !state.lastBatch;
  if (dom.batchJson) dom.batchJson.disabled = !state.lastBatch;
  if (dom.sweepCsv) dom.sweepCsv.disabled = !state.lastSweep;
  if (dom.sweepJson) dom.sweepJson.disabled = !state.lastSweep;
}

function downloadFile(filename, text, mime) {
  if (!IS_BROWSER || typeof Blob === "undefined" || !document.createElement) return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// 表示用の迷路（元のシード・設定）を復元する。
function restoreDisplayMaze(displaySeed) {
  setSeed(displaySeed);
  buildMaze();
  state.visibleFloor = state.start.z;
  clearVisualization();
}

async function runBatch() {
  if (state.running) return;
  const runs = clamp(dom.batchRuns ? Number(dom.batchRuns.value) : 20, 1, 200);
  const displaySeed = state.seed;
  const seeds = Array.from({ length: runs }, () => randomSeed());
  const token = (state.runToken += 1);

  setControlsRunning(true);
  setProgress(dom.batchProgress, dom.batchProgressBar, 0, runs);
  setStatus(`バッチ検証: 0 / ${runs}`);

  const acc = createBatchAccumulator();
  const ok = await runChunked(runs, (i) => batchAccumulateOne(acc, seeds[i]), {
    token,
    onProgress: (done, total) => {
      setProgress(dom.batchProgress, dom.batchProgressBar, done, total);
      setStatus(`バッチ検証: ${done} / ${total}`);
    },
  });

  restoreDisplayMaze(displaySeed);

  if (ok) {
    const stats = finalizeBatch(acc);
    state.lastBatch = stats;
    renderBatch(stats);
    updateExportButtons();
    setStatus("バッチ検証: 完了");
    const mostEfficient = stats.rows
      .filter((r) => r.shortestRate > 0)
      .sort((a, b) => a.avgVisited - b.avgVisited)[0];
    announce(
      `${stats.runs} 個の迷路でバッチ検証しました。平均最短経路長は ${stats.avgOptimal.toFixed(1)} ステップ。` +
        (mostEfficient
          ? `最短を出した中で最も探索が少なかったのは ${mostEfficient.label}（平均 ${Math.round(mostEfficient.avgVisited)} セル）です。`
          : ""),
    );
  } else {
    setStatus("バッチ検証: 停止");
  }

  hideProgress(dom.batchProgress);
  setControlsRunning(false);
  updateFloorUi();
  drawMaze();
}

function paramLabel(param) {
  return param === "stairDensity" ? "階段密度" : "ループ率";
}

// 掃引する横軸の値の配列。braid は 0〜0.6 を等分、stairDensity は 1..n の整数。
function sweepValues(param, points) {
  if (param === "stairDensity") {
    const n = clamp(points, 2, 6);
    return Array.from({ length: n }, (unused, i) => i + 1);
  }
  const n = clamp(points, 2, 9);
  const max = 0.6;
  return Array.from({ length: n }, (unused, i) => Math.round(((max * i) / (n - 1)) * 100) / 100);
}

async function runSweep() {
  if (state.running) return;
  const param = dom.sweepParam ? dom.sweepParam.value : "braid";
  const points = clamp(dom.sweepPoints ? Number(dom.sweepPoints.value) : 5, 2, 9);
  const runsPerPoint = clamp(dom.sweepRuns ? Number(dom.sweepRuns.value) : 8, 1, 50);
  const values = sweepValues(param, points);
  const prevParam = state[param];
  const displaySeed = state.seed;
  const token = (state.runToken += 1);

  const accs = values.map(() => createBatchAccumulator());
  const work = [];
  for (let vi = 0; vi < values.length; vi += 1) {
    for (let r = 0; r < runsPerPoint; r += 1) work.push({ vi, seed: randomSeed() });
  }

  setControlsRunning(true);
  setProgress(dom.sweepProgress, dom.sweepProgressBar, 0, work.length);
  setStatus(`掃引(${paramLabel(param)}): 0 / ${work.length}`);

  const ok = await runChunked(
    work.length,
    (i) => {
      const w = work[i];
      state[param] = values[w.vi];
      batchAccumulateOne(accs[w.vi], w.seed);
    },
    {
      token,
      onProgress: (done, total) => {
        setProgress(dom.sweepProgress, dom.sweepProgressBar, done, total);
        setStatus(`掃引(${paramLabel(param)}): ${done} / ${total}`);
      },
    },
  );

  state[param] = prevParam;
  restoreDisplayMaze(displaySeed);

  if (ok) {
    const sweep = {
      param,
      runsPerPoint,
      points: values.map((value, i) => ({ value, batch: finalizeBatch(accs[i]) })),
    };
    state.lastSweep = sweep;
    drawSweepChart(sweep);
    updateExportButtons();
    setStatus("パラメータ掃引: 完了");
    announce(
      `${paramLabel(param)}のパラメータ掃引が完了しました。${values.length} 点 × 各 ${runsPerPoint} 回。` +
        "グラフは横軸がパラメータ値、縦軸が平均探索セル数です。",
    );
  } else {
    setStatus("パラメータ掃引: 停止");
  }

  hideProgress(dom.sweepProgress);
  setControlsRunning(false);
  updateFloorUi();
  drawMaze();
}

const SWEEP_COLORS = {
  bfs: "#2563eb",
  astar: "#059669",
  dfs: "#9333ea",
  paintbrush: "#ea580c",
  right: "#dc2626",
  left: "#0891b2",
};

// パラメータ掃引の結果を折れ線グラフ（横軸=パラメータ値, 縦軸=平均探索セル数）で描く。
function drawSweepChart(sweep) {
  const canvas = dom.sweepCanvas;
  if (!canvas || !canvas.getContext) return;
  const W = 320;
  const H = 220;
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) return;

  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);

  const padL = 46;
  const padR = 10;
  const padT = 12;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const pts = sweep.points;

  let maxY = 0;
  for (const p of pts) {
    for (const r of p.batch.rows) maxY = Math.max(maxY, r.avgVisited);
  }
  maxY = maxY || 1;

  const xAt = (i) => (pts.length > 1 ? padL + (plotW * i) / (pts.length - 1) : padL + plotW / 2);
  const yAt = (v) => padT + plotH * (1 - v / maxY);

  // グリッド + Y軸目盛
  g.font = "10px system-ui, sans-serif";
  g.textBaseline = "middle";
  g.textAlign = "right";
  for (let t = 0; t <= 4; t += 1) {
    const v = (maxY * t) / 4;
    const y = yAt(v);
    g.strokeStyle = "#eef2f7";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(padL + plotW, y);
    g.stroke();
    g.fillStyle = "#64748b";
    g.fillText(String(Math.round(v)), padL - 4, y);
  }

  // 軸
  g.strokeStyle = "#cbd5e1";
  g.beginPath();
  g.moveTo(padL, padT);
  g.lineTo(padL, padT + plotH);
  g.lineTo(padL + plotW, padT + plotH);
  g.stroke();

  // X軸ラベル
  g.fillStyle = "#64748b";
  g.textAlign = "center";
  g.textBaseline = "top";
  pts.forEach((p, i) => {
    const label = sweep.param === "braid" ? `${Math.round(p.value * 100)}%` : String(p.value);
    g.fillText(label, xAt(i), padT + plotH + 5);
  });

  // 解法ごとの折れ線
  for (const name of SOLVER_ORDER) {
    g.strokeStyle = SWEEP_COLORS[name];
    g.fillStyle = SWEEP_COLORS[name];
    g.lineWidth = 2;
    g.beginPath();
    pts.forEach((p, i) => {
      const row = p.batch.rows.find((r) => r.name === name);
      const y = yAt(row.avgVisited);
      if (i === 0) g.moveTo(xAt(i), y);
      else g.lineTo(xAt(i), y);
    });
    g.stroke();
    pts.forEach((p, i) => {
      const row = p.batch.rows.find((r) => r.name === name);
      g.beginPath();
      g.arc(xAt(i), yAt(row.avgVisited), 2.5, 0, Math.PI * 2);
      g.fill();
    });
  }

  // 凡例（HTML）
  if (dom.sweepLegend) {
    dom.sweepLegend.innerHTML = SOLVER_ORDER.map(
      (name) =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${SWEEP_COLORS[name]}"></span>${SOLVER_CONFIGS[name].label}</span>`,
    ).join("");
  }
}

async function runSolver(name) {
  if (state.running) return;

  const config = SOLVER_CONFIGS[name];
  if (!config) return;

  const isMicromouse = name === "micromouse";
  // マイクロマウスのみ霧ON、他の解法は全体像を見せるため霧OFFにする。
  state.player = { ...state.start };
  setFog(isMicromouse);

  clearVisualization();
  setVisibleFloor(state.start.z, false);
  drawMaze();
  const token = state.runToken + 1;
  state.runToken = token;
  setControlsRunning(true);
  setStatus(`${config.label}: 開始`);
  const startedAt = performance.now();

  try {
    let result;
    if (dom.animate.checked) {
      if (name === "paintbrush") {
        result = await animatePaintbrush(startedAt, token);
      } else if (isMicromouse) {
        result = await animateMicromouse(startedAt, token);
      } else {
        result = await animateGeneric(config.animated(), config.label, startedAt, token);
      }
    } else {
      result = config.instant();
      if (isMicromouse && result) {
        // 即時実行でも探索済みセルを判明済みにして霧を晴らす。
        for (const key of result.visited) state.revealed.add(key);
        // 引き返した道を色分けできるよう記録する。
        state.backtrack = computeBacktrackSet(result.path);
      }
    }

    if (result && token === state.runToken) {
      finishSolver(config.label, result, startedAt);
      // ヒートマップ表示が有効なら、探索順のグラデーションで塗り直す（霧中は無効）。
      if (dom.heatmap && dom.heatmap.checked && result.path && !state.fog) {
        const visit = solverVisitOrder(name);
        state.heat = { order: visit.order, total: visit.total };
        updateHeatmapLegend();
        drawMaze();
      }
      // アニメーション有効かつ解答が階をまたぐ場合は、ルートをなぞりながら
      // 上り/下りの階層遷移演出を再生する（マイクロマウスは探索自体が演出なので除外）。
      if (dom.animate.checked && !isMicromouse && pathCrossesFloors(result.path)) {
        const done = await animateSolutionTraversal(result.path, token, config.label);
        if (done && token === state.runToken) {
          setStatus(`${config.label}: 完了 (${floorName(state.visibleFloor)})`);
        }
      }
    } else if (token === state.runToken) {
      setStatus(`${config.label}: 停止`);
    }
  } finally {
    if (token === state.runToken) {
      setControlsRunning(false);
      dom.canvas.focus({ preventScroll: true });
    }
  }
}

function applyStairTransition() {
  const options = getStairsFrom(state.player);
  if (options.length !== 1) return false;
  state.player = { ...options[0] };
  setVisibleFloor(state.player.z, false);
  return true;
}

function movePlayer(dx, dy) {
  if (state.running) return;
  const next = { x: state.player.x + dx, y: state.player.y + dy, z: state.player.z };
  if (!isOpen(next.x, next.y, next.z)) return;

  clearVisualization();
  state.player = next;
  const changedFloor = applyStairTransition();
  if (state.fog) revealFrom(state.player);
  setVisibleFloor(state.player.z, false);
  drawMaze();
  if (samePos(state.player, state.goal)) {
    setStatus("ゴール");
  } else if (changedFloor) {
    setStatus(`階段移動: ${floorName(state.player.z)}`);
  } else {
    setStatus(`手動操作モード (${floorName(state.player.z)})`);
  }
}

function handleKeydown(event) {
  // ルート再生中は Enter / Space で最終結果へスキップ。
  if (state.replaying && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    state.skipReplay = true;
    return;
  }

  const keyMap = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    w: [0, -1],
    s: [0, 1],
    a: [-1, 0],
    d: [1, 0],
  };

  if (event.key === "PageUp") {
    event.preventDefault();
    setVisibleFloor(state.visibleFloor + 1);
    return;
  }

  if (event.key === "PageDown") {
    event.preventDefault();
    setVisibleFloor(state.visibleFloor - 1);
    return;
  }

  const move = keyMap[event.key];
  if (!move) return;
  event.preventDefault();
  movePlayer(move[0], move[1]);
}

// レンジ入力の現在値を隣接ラベルに反映する。
function syncRangeLabel(input, label, format) {
  if (!input || !label) return;
  label.textContent = format(input.value);
}

function bindEvents() {
  dom.generate.addEventListener("click", generateGame);
  dom.reset.addEventListener("click", resetPlayerAndView);
  dom.floorDown.addEventListener("click", () => setVisibleFloor(state.visibleFloor - 1));
  dom.floorUp.addEventListener("click", () => setVisibleFloor(state.visibleFloor + 1));
  if (dom.viewMode) {
    dom.viewMode.addEventListener("change", () => {
      state.viewMode = dom.viewMode.value;
      updateFloorUi();
      drawMaze();
    });
  }
  dom.stop.addEventListener("click", () => {
    state.runToken += 1;
    setControlsRunning(false);
    setStatus("停止しました");
  });

  if (dom.randomSeed) {
    dom.randomSeed.addEventListener("click", () => {
      if (dom.seed) dom.seed.value = String(randomSeed());
      generateGame();
    });
  }
  if (dom.compare) {
    dom.compare.addEventListener("click", runComparison);
  }
  if (dom.batch) {
    dom.batch.addEventListener("click", runBatch);
  }
  if (dom.sweep) {
    dom.sweep.addEventListener("click", runSweep);
  }

  const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (dom.batchCsv) {
    dom.batchCsv.addEventListener("click", () => {
      if (state.lastBatch) downloadFile(`maze-batch-${timestamp()}.csv`, batchToCsv(state.lastBatch), "text/csv");
    });
  }
  if (dom.batchJson) {
    dom.batchJson.addEventListener("click", () => {
      if (state.lastBatch) {
        const payload = { type: "batch", settings: exportSettings(), ...state.lastBatch };
        downloadFile(`maze-batch-${timestamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
      }
    });
  }
  if (dom.sweepCsv) {
    dom.sweepCsv.addEventListener("click", () => {
      if (state.lastSweep) downloadFile(`maze-sweep-${timestamp()}.csv`, sweepToCsv(state.lastSweep), "text/csv");
    });
  }
  if (dom.sweepJson) {
    dom.sweepJson.addEventListener("click", () => {
      if (state.lastSweep) {
        const payload = { type: "sweep", settings: exportSettings(), ...state.lastSweep };
        downloadFile(`maze-sweep-${timestamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
      }
    });
  }
  updateExportButtons();
  if (dom.heatmap) {
    dom.heatmap.addEventListener("change", () => {
      if (dom.heatmap.checked && state.fog) {
        setFog(false); // 霧とヒートマップは併用しない
      }
      if (!dom.heatmap.checked) {
        state.heat = null;
        drawMaze();
      }
      updateHeatmapLegend();
    });
  }
  if (dom.fogToggle) {
    dom.fogToggle.addEventListener("change", () => {
      if (dom.fogToggle.checked && dom.heatmap && dom.heatmap.checked) {
        // 霧とヒートマップは併用しない
        dom.heatmap.checked = false;
        state.heat = null;
        updateHeatmapLegend();
      }
      setFog(dom.fogToggle.checked);
      setStatus(
        dom.fogToggle.checked
          ? "マイクロマウス視点: 矢印/WASDで移動してゴールを探そう"
          : "通常表示に戻りました",
      );
    });
  }

  syncRangeLabel(dom.braid, dom.braidValue, (v) => `${v}%`);
  syncRangeLabel(dom.stairDensity, dom.stairDensityValue, (v) => v);
  syncRangeLabel(dom.attempts, dom.attemptsValue, (v) => v);
  if (dom.braid) {
    dom.braid.addEventListener("input", () =>
      syncRangeLabel(dom.braid, dom.braidValue, (v) => `${v}%`),
    );
  }
  if (dom.stairDensity) {
    dom.stairDensity.addEventListener("input", () =>
      syncRangeLabel(dom.stairDensity, dom.stairDensityValue, (v) => v),
    );
  }
  if (dom.attempts) {
    dom.attempts.addEventListener("input", () =>
      syncRangeLabel(dom.attempts, dom.attemptsValue, (v) => v),
    );
  }
  document.querySelectorAll("[data-solver]").forEach((button) => {
    button.addEventListener("click", () => runSolver(button.dataset.solver));
  });
  document.querySelectorAll("[data-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const moves = {
        up: [0, -1],
        down: [0, 1],
        left: [-1, 0],
        right: [1, 0],
      };
      const move = moves[button.dataset.move];
      movePlayer(move[0], move[1]);
    });
  });
  window.addEventListener("keydown", handleKeydown);
  // ルート再生中はキャンバスクリックで最終結果へスキップ。
  dom.canvas.addEventListener("click", () => {
    if (state.replaying) state.skipReplay = true;
  });
}

if (IS_BROWSER) {
  bindEvents();
  generateGame();
}

// Node（テスト）向けに、DOM に依存しない迷路生成・解法ロジックを公開する。
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    state,
    MinHeap,
    DIRECTIONS,
    clamp,
    keyFromXYZ,
    posKey,
    posFromKey,
    samePos,
    parseSize,
    makeRng,
    setSeed,
    generateDfsMaze,
    braidMaze,
    buildStairs,
    buildMaze,
    solverComparison,
    createBatchAccumulator,
    batchAccumulateOne,
    finalizeBatch,
    batchBenchmark,
    parameterSweep,
    sweepValues,
    batchToCsv,
    sweepToCsv,
    solverVisitOrder,
    pathCrossesFloors,
    animationSizeRatio,
    animationPacing,
    estimateAnimationDuration,
    isOpen,
    getNeighbors,
    heuristic,
    bfsDistances,
    chooseStartAndGoal,
    shortestPathBetween,
    solveBfsInstant,
    solveDfsInstant,
    solveAstarInstant,
    solvePaintbrushInstant,
    solveWallFollowerInstant,
    solveMicromouseInstant,
    computeVisibleCells,
    revealFrom,
    floodFillReachable,
  };
}
