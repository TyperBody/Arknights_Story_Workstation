#!/usr/bin/env node
/**
 * 舞台坐标自检（offline, zero-dependency）——「立绘乱飘」的回归。
 *
 *   node scripts/fanfic/stage-selftest.mjs [--corpus <dir>] [--allow-missing-corpus]
 *
 * 断言（都对着真实数据，不造数）：
 *   (a) `resolvePlan` 移植 == `src/akstage/local/library.js::resolvePlan`：50 个
 *       语料角色（含 sizes/render/百分号三种截图尺寸）逐字段相等；
 *   (b) `layoutOf` 对**语料用量前 15** 的角色 + 3 个真实背景产出可用矩形
 *       （w/h > 0、中心落在 1.25× 画布带内、与画布相交），且槽位基准
 *       l/m/r 严格相差 ±200；
 *   (c) `parseStage` 走内置样例（seed 的那份）到 Decision 行 → **恰好 1 个立绘、
 *       在 m 槽**；再逐步走完整篇，断言与"逐行重放"的影子状态一致；
 *   (d) `movePatch` 的每一份产物（含 `extra.line` 的 character / characteraction /
 *       charslot 三种形态）`lintDocument` **0 error**，数值与引擎语义一致
 *       （`xpos = -dx`、`ypos = +dy`、`enter` 方向、`CharacterAction` 的
 *       `xpos = dx`/`ypos = -dy`），并可被 `enterOffset` 还原成 (-dx, -dy)；
 *   (e) 清槽/聚焦规则：`[Character(name=…)]` 清 l/r、`name`+`name2` 清 m、
 *       `char_empty` 清单槽、`focus` 变暗判定与 runtime 的位运算一致。
 *
 * 退出码：0 = 全过；1 = 有断言失败；2 = 用法/环境错误。
 * 契约见 `frontend/src/components/editor/stageModel.ts` 顶部的引擎对照。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SLOT_BASE_X,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  backgroundRuleOf,
  enterOffset,
  genPosition,
  layoutOf,
  movePatch,
  nativeBackgroundRect,
  parseEnter,
  parseStage,
  parseSlot,
  planOf,
  resolveCharacterFocus,
  resolveExpression,
  resolveFocusList,
  rulesFromModel,
  ruleShift,
  viewportSize,
} from "../../frontend/src/components/editor/stageModel.ts";
import { lintDocument } from "../../src/akstage/local/editorModel.js";
import { resolvePlan } from "../../src/akstage/local/library.js";
import { arg, parseScript } from "../../src/akstage/local/storyPack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/** 与 editor-selftest.mjs 同一套候选路径。 */
const CORPUS_CANDIDATES = [
  process.env.AKSTAGE_CORPUS_DIR,
  "/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story",
  join(process.env.HOME ?? "", ".akresearch/akgd/zh_CN/gamedata/story"),
].filter(Boolean);
const TABLE_CANDIDATES = [
  process.env.AKSTAGE_CHARACTER_TABLE,
  "/home/typer/桌面/.akresearch/tables/character.json",
  join(process.env.HOME ?? "", ".akresearch/tables/character.json"),
].filter(Boolean);
const UPSTREAM_CANDIDATES = ["build/fanfic/upstream.json", "example/fanfic/demo/build/runtime.json"];
const SAMPLE_CANDIDATES = [
  join(REPO_ROOT, "src-tauri/resources/library/sample-fanfic/script.txt"),
  join(REPO_ROOT, "example/library/fanfic-demo/script.txt"),
  join(REPO_ROOT, "example/fanfic/demo/script.txt"),
];

const CHARACTER_URL = "https://torappu.prts.wiki/assets/avg/character.json";
const BACKGROUND_URL = "https://torappu.prts.wiki/assets/avg/background.json";

// ── 极简断言框架（与 editor-selftest 同风格） ─────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
let groupName = "";

function group(name) {
  groupName = name;
  process.stdout.write(`\n## ${name}\n`);
}

const show = (value) => {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 220 ? `${text.slice(0, 217)}…` : text;
};

function ok(name, value, detail = "") {
  if (value) {
    passed += 1;
    process.stdout.write(`  ✓ ${name}${detail ? ` — ${detail}` : ""}\n`);
    return;
  }
  failed += 1;
  failures.push({ group: groupName, name, detail });
  process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, a === b ? "" : `expected ${show(expected)}, got ${show(actual)}`);
}

function skip(name) {
  skipped += 1;
  process.stdout.write(`  · skip ${name}\n`);
}

// ── 参数 ────────────────────────────────────────────────────────────────

function parseArgv() {
  const argv = process.argv.slice(2);
  const options = { corpus: null, allowMissingCorpus: false, top: 15, parity: 50, branchSamples: 24 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--corpus") options.corpus = argv[++i] ?? null;
    else if (arg === "--top") options.top = Math.max(1, Number(argv[++i] ?? 15) || 15);
    else if (arg === "--parity") options.parity = Math.max(1, Number(argv[++i] ?? 50) || 50);
    else if (arg === "--branch-samples") options.branchSamples = Math.max(1, Number(argv[++i] ?? 24) || 24);
    else if (arg === "--allow-missing-corpus") options.allowMissingCorpus = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "用法：node scripts/fanfic/stage-selftest.mjs [--corpus <dir>] [--top 15] [--parity 50] [--allow-missing-corpus]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`未知参数：${arg}（-h 看帮助）\n`);
      process.exit(2);
    }
  }
  return options;
}

// ── 数据加载 ────────────────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 角色表：优先本机 `.akresearch` 快照，其次仓库里的上游 bundle 快照。 */
function loadCharacterTable() {
  for (const path of TABLE_CANDIDATES) {
    if (!existsSync(path)) continue;
    const table = readJson(path);
    if (table && typeof table === "object" && !Array.isArray(table) && Object.keys(table).length > 100) {
      return { table, path, origin: CHARACTER_URL };
    }
  }
  for (const rel of UPSTREAM_CANDIDATES) {
    const path = join(REPO_ROOT, rel);
    if (!existsSync(path)) continue;
    const json = readJson(path);
    const table = json?.bundle?.data?.[CHARACTER_URL] ?? json?.data?.[CHARACTER_URL];
    if (table && Object.keys(table).length > 100) return { table, path, origin: CHARACTER_URL };
  }
  return null;
}

function loadBackgroundTable() {
  const has = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 100;
  for (const rel of UPSTREAM_CANDIDATES) {
    const path = join(REPO_ROOT, rel);
    if (!existsSync(path)) continue;
    const json = readJson(path);
    const table = json?.bundle?.data?.[BACKGROUND_URL] ?? json?.data?.[BACKGROUND_URL];
    if (has(table)) return { table, path };
  }
  for (const path of [resolve(REPO_ROOT, "build/fanfic/background.json")]) {
    const table = existsSync(path) ? readJson(path) : null;
    if (has(table)) return { table, path };
  }
  return null;
}

/** 递归收集 .txt（与 editor-selftest 一致）。 */
function walkTxt(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkTxt(path, out);
    else if (entry.name.endsWith(".txt")) out.push(path);
  }
  return out;
}

/**
 * 语料扫描：`[character]`/`[charslot]` 的 base 用量排行（顺序稳定）。
 * 只扫一遍全语料（5735 文件，约 4s）。
 */
function scanCharacterUsage(corpusRoot) {
  const counts = new Map();
  let files = 0;
  for (const file of walkTxt(corpusRoot)) {
    files += 1;
    for (const line of parseScript(readFileSync(file, "utf8"))) {
      if (line.kind !== "command") continue;
      if (line.command !== "character" && line.command !== "charslot") continue;
      for (const key of ["name", "name2"]) {
        const raw = line.args[key];
        if (typeof raw !== "string" || !raw.trim()) continue;
        const base = String(raw).trim().split(/[#$@]/)[0].toLowerCase();
        if (!base) continue;
        counts.set(base, (counts.get(base) ?? 0) + 1);
      }
    }
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([base, uses]) => ({ base, uses }));
  return { files, ranked };
}

/** 把上游条目折成 `resolvePlan` 的 `characters` 形状（image 取 array[0]）。 */
function planCharacters(table) {
  const out = {};
  for (const [base, entry] of Object.entries(table)) {
    const first = Array.isArray(entry?.array) ? entry.array[0] : null;
    const image = first && typeof first.image === "string" ? first.image : undefined;
    out[base] = image ? { image } : {};
  }
  return out;
}

/** 1.25× 画布带（以画布中心放大 25%）。 */
const BAND = {
  minX: -0.125 * STAGE_WIDTH,
  maxX: 1.125 * STAGE_WIDTH,
  minY: -0.125 * STAGE_HEIGHT,
  maxY: 1.125 * STAGE_HEIGHT,
};

const centerInBand = (rect) => {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return cx >= BAND.minX && cx <= BAND.maxX && cy >= BAND.minY && cy <= BAND.maxY;
};

const overlapsCanvas = (rect) =>
  rect.x < STAGE_WIDTH && rect.x + rect.w > 0 && rect.y < STAGE_HEIGHT && rect.y + rect.h > 0;

const round2 = (value) => Math.round(value * 100) / 100;

function main() {
  const options = parseArgv();
  const started = Date.now();
  process.stdout.write("stage-selftest：舞台坐标模型（task-10）\n");

  const loaded = loadCharacterTable();
  if (!loaded) {
    process.stderr.write(
      `找不到角色表（试过：${TABLE_CANDIDATES.join(" / ")}；或仓库里的 ${UPSTREAM_CANDIDATES.join(" / ")}）\n` +
        "先跑 `node scripts/fanfic/fetch-upstream.mjs build/fanfic/upstream.json W2G/BEG`。\n",
    );
    process.exit(2);
  }
  const { table } = loaded;
  const backgrounds = loadBackgroundTable();
  process.stdout.write(`角色表：${relative(REPO_ROOT, loaded.path) || loaded.path}（${Object.keys(table).length} 条）\n`);

  const corpusRoot = options.corpus ?? CORPUS_CANDIDATES.find((path) => existsSync(path) && statSync(path).isDirectory()) ?? null;
  let ranked = null;
  if (corpusRoot) {
    const scan = scanCharacterUsage(corpusRoot);
    ranked = scan.ranked;
    process.stdout.write(`语料：${corpusRoot}（${scan.files} 文件 / ${ranked.length} 个不同 base）\n`);
  } else if (!options.allowMissingCorpus) {
    process.stderr.write(
      `语料目录不存在（试过：${CORPUS_CANDIDATES.join(" / ")}）；用 --corpus <dir> 指定，或用 --allow-missing-corpus 跳过。\n`,
    );
    process.exit(2);
  }

  // ── (a) resolvePlan 移植逐字段对拍 ────────────────────────────────
  group(`(a) resolvePlan 移植 vs library.resolvePlan（${options.parity} 个语料角色）`);
  const parityBases = (ranked ?? []).map((row) => row.base).filter((base) => table[base]).slice(0, options.parity);
  // 语料里用量最高的 base 不一定都有表条目（`char_empty` 也有）；不足时用表里的键补齐。
  if (parityBases.length < options.parity) {
    for (const base of Object.keys(table)) {
      if (parityBases.length >= options.parity) break;
      if (!parityBases.includes(base)) parityBases.push(base);
    }
  }
  ok(`拿到 ${options.parity} 个角色`, parityBases.length === options.parity, `实际 ${parityBases.length}`);
  const characters = planCharacters(table);
  let mismatch = 0;
  let zoomed = 0;
  let percent = 0;
  parityBases.forEach((base, index) => {
    const entry = table[base];
    // 三种截图尺寸形态都要覆盖：真实 size / ÷render 缩放 / 百分号。
    const variant = index % 3;
    const size = variant === 0
      ? [entry.size?.x ?? 1024, entry.size?.y ?? 1024]
      : variant === 1
        ? [entry.size?.x ?? 1024, 1.35]
        : ["125%", "125%"];
    if (variant === 1) zoomed += 1;
    if (variant === 2) percent += 1;
    const input = {
      assets: {},
      bases: { [base]: { render: variant === 1 ? 1.35 : 1, size } },
      characters,
      upstream: { [base]: { image: characters[base]?.image, pos: entry.pos, size: entry.size } },
    };
    const viewport = { width: STAGE_WIDTH, height: STAGE_HEIGHT };
    const mine = planOf(input, base, viewport);
    const theirs = resolvePlan(input, base, viewport);
    const same =
      JSON.stringify(mine.url) === JSON.stringify(theirs.url) &&
      mine.base === theirs.base &&
      JSON.stringify(mine.rect) === JSON.stringify(theirs.rect) &&
      JSON.stringify(mine.anchor) === JSON.stringify(theirs.anchor) &&
      JSON.stringify(mine.canvas) === JSON.stringify(theirs.canvas) &&
      JSON.stringify(mine.upstreamPlan) === JSON.stringify(theirs.upstreamPlan);
    if (!same) {
      mismatch += 1;
      if (mismatch <= 3) {
        process.stdout.write(
          `      ${base}: mine=${show({ url: mine.url, rect: mine.rect, anchor: mine.anchor })} ` +
            `theirs=${show({ url: theirs.url, rect: theirs.rect, anchor: theirs.anchor })}\n`,
        );
      }
    }
  });
  ok("50 个角色的 url/rect/anchor/canvas/upstreamPlan 全部相等", mismatch === 0, `${parityBases.length - mismatch}/${parityBases.length}`);
  ok("覆盖 ÷render 缩放", zoomed > 0, `${zoomed} 例`);
  ok("覆盖百分号截图尺寸", percent > 0, `${percent} 例`);
  eq("viewportSize(缺省) = 1024×1024", viewportSize(null, "whatever"), { x: 1024, y: 1024 });
  eq("viewportSize(125%) = 1600×1600", viewportSize({ x: { size: ["125%", "125%"] } }, "x"), { x: 1600, y: 1600 });

  // ── (b) layoutOf 的矩形可用性 + 槽位基准 ───────────────────────
  group(`(b) layoutOf：语料用量前 ${options.top} 的角色 × 3 背景`);
  const top = (ranked ?? Object.keys(table).map((base) => ({ base, uses: 0 })))
    .filter((row) => resolveExpression(table, row.base))
    .slice(0, options.top);
  ok(`取到 ${options.top} 个用语料角色`, top.length === options.top, `实际 ${top.length}`);
  const info = [];
  let badBox = 0;
  let badEngineRect = 0;
  let notInBand = 0;
  for (const row of top) {
    const engine = resolveExpression(table, row.base);
    const base = row.base;
    // 只用 base（无 `#$`）= 引擎的 `_LoadImage` 取 `sprites[0]`；带 `#N$G` 的写法
    // 由 (e) 的组/差分断言单独覆盖（不是每个条目的 array[0] 都叫 `xxx$1`）。
    const snapshot = layoutOf(
      { characters: { [engine.base]: table[engine.base] }, upstream: table },
      { chars: [{ name: base, slot: "m" }], background: "bg_black", viewport: { width: STAGE_WIDTH, height: STAGE_HEIGHT } },
    );
    const layout = snapshot.chars[0];
    const size = `${Math.round(layout.rect.w)}×${Math.round(layout.rect.h)}`;
    info.push(`${String(row.uses).padStart(5)} 次 ${base} → ${size} @ (${Math.round(layout.rect.x)},${Math.round(layout.rect.y)}) anchor(${layout.anchor.x},${layout.anchor.y})`);
    if (!(layout.rect.w > 0 && layout.rect.h > 0)) badBox += 1;
    if (!centerInBand(layout.rect)) notInBand += 1;
    if (!overlapsCanvas(layout.rect)) notInBand += 1;
    // 几何与引擎公式逐字一致（`PixiStoryRenderer::setCharacter`）。
    const entry = table[engine.base];
    const w = entry.size?.x ?? 0;
    const h = entry.size?.y ?? 0;
    const px = entry.pos?.x ?? 0;
    const py = entry.pos?.y ?? 0;
    const expected = { x: SLOT_BASE_X.m - w / 2 + px, y: STAGE_HEIGHT - h / 2 - py };
    if (Math.abs(layout.rect.x - expected.x) > 1e-6 || Math.abs(layout.rect.y - expected.y) > 1e-6) badEngineRect += 1;
  }
  process.stdout.write(`      ${info.join("\n      ")}\n`);
  ok("全部 w>0 且 h>0", badBox === 0, `${top.length - badBox}/${top.length}`);
  ok("中心在 1.25× 画布带内、且与画布相交", notInBand === 0, `${top.length - notInBand}/${top.length}`);
  ok("矩形 == 引擎公式 slotBaseX − size/2 + pos（y: 720 − size/2 − pos）", badEngineRect === 0, `${top.length - badEngineRect}/${top.length}`);

  // 差分 / 表情组（`#N$G`）：贴图取 `groups[G].base`（face_overlay）。
  const groupedBase = Object.entries(table).find(([, entry]) =>
    Array.isArray(entry.groups) && entry.groups.some((group) => group?.mode === "face_overlay") &&
    Array.isArray(entry.array) && entry.array.some((item) => Number(item.group) >= 0 && typeof item.face === "string"),
  )?.[0];
  if (groupedBase) {
    const item = table[groupedBase].array.find((candidate) => Number(candidate.group) >= 0 && typeof candidate.face === "string");
    const groupIndex = Number(item.group);
    const ref = `${groupedBase}@${String(item.alias ?? "")}` || `${groupedBase}`;
    const byAlias = resolveExpression(table, `${groupedBase}#1$${groupIndex + 1}`);
    eq(`\`#1$${groupIndex + 1}\` 命中差分`, byAlias?.item?.name, item.name);
    const withFace = resolveExpression(table, `${groupedBase}#${table[groupedBase].array.indexOf(item) + 1}$${groupIndex + 1}`);
    const layout = layoutOf({ upstream: table }, { chars: [{ name: withFace ? `${groupedBase}#${table[groupedBase].array.indexOf(item) + 1}$${groupIndex + 1}` : groupedBase, slot: "m" }] }).chars[0];
    eq("face_overlay 的贴图 = groups[G].base", layout.image, table[groupedBase].groups[groupIndex].base);
    ok("face_overlay 不是 missing", layout.missing === false);
    void ref;
  } else {
    skip("face_overlay 差分断言（表里没有可用的组条目）");
  }

  // 槽位基准：同一角色 l/m/r 严格相差 ±200，y 完全相同（引擎 slotBaseX 只改 x）。
  const probeBase = top[0]?.base;
  if (probeBase) {
    const snap = (slot) => layoutOf({ upstream: table }, { chars: [{ name: probeBase, slot }] }).chars[0].rect;
    const l = snap("l");
    const m = snap("m");
    const r = snap("r");
    eq("l 与 r 相差 400px", round2(r.x - l.x), 400);
    eq("m 与 l 相差 200px", round2(m.x - l.x), 200);
    eq("三个槽 y 相同", [round2(l.y), round2(r.y)], [round2(m.y), round2(m.y)]);
    eq("SLOT_BASE_X = 440/640/840", SLOT_BASE_X, { l: 440, m: 640, r: 840 });
  } else {
    skip("槽位基准（没有可用的语料角色）");
  }

  // 3 个背景：URL 与键校验。
  const bgKeys = ["bg_black", "bg_corridor", "bg_forest"];
  const withBackground = bgKeys.map((key) =>
    layoutOf({ upstream: table }, { chars: [], background: key }).background,
  );
  eq("3 个背景的 URL", withBackground.map((bg) => bg?.url), bgKeys.map((key) => `https://torappu.prts.wiki/assets/avg/background/${key}.png`));
  if (backgrounds) {
    const known = bgKeys.filter((key) => key in backgrounds.table);
    ok("3 个背景键都在 background.json 里", known.length === 3, known.join(","));
  } else {
    skip("background.json 快照不存在，跳过背景键校验");
  }
  ok("空 chars 也能渲染（空舞台）", layoutOf({ upstream: table }, { chars: [], background: null }).chars.length === 0);

  // 背景**自身**的原生矩形（`nativeBackgroundRect`）：ppu 决定背景，不动立绘。
  const bgRules = backgrounds ? rulesFromModel({ resolutionRules: backgrounds.table }) : {};
  if (backgrounds) {
    const ppuValues = new Set(Object.values(backgrounds.table).filter((value) => typeof value === "number"));
    eq("background.json 的值都是 ppu（数字）", ppuValues.size > 1, true);
    eq("bg_black 的 ppu", backgroundRuleOf(bgRules, "bg_black")?.ppu, backgrounds.table.bg_black);
    const native = nativeBackgroundRect("bg_black", { width: 1024, height: 576 }, bgRules);
    // 1024×576、ppu 68.2464… → 原生 1500.44×844（17% 居中过扫），和引擎注释一致。
    ok("nativeBackgroundRect = 贴图 / ppu * 100", Math.abs(native.x - (1024 / backgrounds.table.bg_black) * 100) < 1e-6 && Math.abs(native.y - (576 / backgrounds.table.bg_black) * 100) < 1e-6, `${round2(native.x)}×${round2(native.y)}`);
    eq("16:9 且无 ppu → 正好铺满 1280×720", nativeBackgroundRect("no_such_bg", { width: 1280, height: 720 }, bgRules), { x: 1280, y: 720 });
    eq("非 16:9 且无 ppu → 保持贴图尺寸", nativeBackgroundRect("no_such_bg", { width: 1024, height: 384 }, bgRules), { x: 1024, y: 384 });
  } else {
    skip("nativeBackgroundRect 的 ppu 断言（缺少 background.json 快照）");
  }

  // 「换个背景立绘就飘」= 包在 `patch/resolutionRules.json` 里给了站位 → 必须算出来。
  const anchorBase = top[0]?.base;
  if (anchorBase) {
    const rule = { pos: { x: 40, y: -25 } };
    const sameKey = (rules) =>
      layoutOf({ upstream: table, resolutionRules: rules }, { chars: [{ name: anchorBase, slot: "m" }], background: "bg_black" }).chars[0];
    const plain = sameKey({});
    const moved = sameKey({ bg_black: rule });
    const shifted = ruleShift({ bg_black: rule }, "bg_black");
    eq("规则的 pos 增量 = (40, -25)（character.json 的 pos 语义）", shifted, rule.pos);
    ok("同一角色在不同背景（带规则）上 anchor 必须不同", plain.anchor.x !== moved.anchor.x || plain.anchor.y !== moved.anchor.y, `plain=${show(plain.anchor)} ruled=${show(moved.anchor)}`);
    eq("anchor = 原 anchor + 规则的 pos", moved.anchor, { x: plain.anchor.x + 40, y: plain.anchor.y - 25 });
    eq("规则同时平移矩形（x +40、屏幕 y -(-25) = +25）", [round2(moved.rect.x - plain.rect.x), round2(moved.rect.y - plain.rect.y)], [40, 25]);
    eq("没有规则的同名背景不受影响", layoutOf({ upstream: table, resolutionRules: { bg_black: rule } }, { chars: [{ name: anchorBase, slot: "m" }], background: "bg_black" }).chars[0].anchor, moved.anchor);
    const untouched = layoutOf({ upstream: table, resolutionRules: { bg_black: rule } }, { chars: [{ name: anchorBase, slot: "m" }], background: "bg_forest" }).chars[0];
    eq("规则是按背景键命中的（bg_forest 不变）", [untouched.anchor, untouched.rect.x], [plain.anchor, plain.rect.x]);
    // 上游本身（background.json 只给 ppu）**不动立绘**：background.json 的值是
    // ppu，只决定背景自己的原生矩形。所以"乱飘"只可能来自包的 resolutionRules。
    if (backgrounds) {
      const upstreamRules = rulesFromModel({ resolutionRules: backgrounds.table });
      eq("上游 background.json 只有 ppu（没有 pos/size/render）", upstreamRules.bg_black?.pos ?? null, null);
      const byBg = bgKeys.map((key) =>
        layoutOf({ upstream: table, resolutionRules: upstreamRules }, { chars: [{ name: anchorBase, slot: "m" }], background: key }).chars[0],
      );
      eq(
        "只用上游表时，换背景不改 anchor（与引擎一致）",
        [...new Set(byBg.map((char) => `${round2(char.anchor.x)},${round2(char.anchor.y)}`))],
        [`${round2(byBg[0].anchor.x)},${round2(byBg[0].anchor.y)}`],
      );
      eq(
        "只用上游表时，换背景不改矩形",
        [...new Set(byBg.map((char) => `${round2(char.rect.x)},${round2(char.rect.y)}`))].length,
        1,
      );
    }
    // `size` + `render` 也要走 `resolvePlan` 的口径
    const resized = layoutOf({ upstream: table, resolutionRules: { bg_black: { size: { x: 1200, y: 1200 }, render: 1.5 } } }, { chars: [{ name: anchorBase, slot: "m" }], background: "bg_black" }).chars[0];
    eq("规则的 size/render 覆盖立绘尺寸（1200 / 1.5 = 800）", [round2(resized.rect.w), round2(resized.rect.h)], [800, 800]);
  } else {
    skip("背景规则断言（没有可用的语料角色）");
  }

  // 未知角色 → 占位框。
  const unknown = layoutOf({ upstream: table }, { chars: [{ name: "no_such_character#1$1", slot: "m" }] });
  eq("未知角色 1 个占位框", unknown.chars.length, 1);
  ok("未知角色 missing=true", unknown.chars[0]?.missing === true);
  ok("未知角色走 1024² 兜底矩形", unknown.chars[0]?.rect.w === 1024 && unknown.chars[0]?.rect.h === 1024);
  eq("未知角色 anchor=repairScenarioLinks 的 {0,160}", unknown.chars[0]?.anchor, { x: 0, y: 160 });
  ok("未知角色有告警", unknown.warnings.length === 1, unknown.warnings[0]);

  // ── (c) parseStage：内置样例 ─────────────────────────────────
  group("(c) parseStage：内置样例");
  const samplePath = SAMPLE_CANDIDATES.find((path) => existsSync(path));
  if (!samplePath) {
    skip("内置样例不存在");
  } else {
    const sample = readFileSync(samplePath, "utf8");
    process.stdout.write(`      样例：${relative(REPO_ROOT, samplePath)}\n`);
    const lines = parseScript(sample);
    const decision = lines.find((line) => line.command === "decision");
    ok("样例里有 Decision 行", Boolean(decision), decision ? `第 ${decision.lineNumber} 行` : "");
    if (decision) {
      const atDecision = parseStage(sample, decision.lineNumber, { table });
      const inM = atDecision.chars.filter((char) => char.slot === "m");
      const others = atDecision.chars.filter((char) => char.slot !== "m");
      eq("走到 Decision 行 → 恰好 1 个 m 槽立绘", inM.length, 1);
      eq("走到 Decision 行 → l/r 为空", others.length, 0);
      ok("这 1 个立绘命中 character.json", inM[0]?.missing === false, inM[0] ? `${inM[0].name} → ${inM[0].url}` : "");
      ok("带上了背景（样例先 [Background]）", Boolean(atDecision.background), atDecision.background?.key ?? "");
      ok("解析行号 = Decision 行", atDecision.line === decision.lineNumber, `${atDecision.line}`);
    }
    // 逐行重放：每一步都与"影子状态"（独立重写的最小模型）一致。
    let replayMismatch = null;
    const shadow = new Map();
    let shadowFocus = ["l", "m", "r"];
    const sorted = [...lines].sort((a, b) => a.lineNumber - b.lineNumber);
    for (const line of sorted) {
      const mine = parseStage(sample, line.lineNumber, { table });
      // 影子：只看 character / charslot 的槽位归属与 focus。
      if (line.kind === "command" && line.command === "character") {
        const name = typeof line.args.name === "string" ? line.args.name : "";
        const name2 = typeof line.args.name2 === "string" ? line.args.name2 : "";
        const focus = Number(line.args.focus ?? 0) || 0;
        shadowFocus = resolveCharacterFocus(focus);
        const next = new Map([
          ["m", name && !name2 ? name : null],
          ["l", name2 ? name : null],
          ["r", name2 || null],
        ]);
        for (const [slot, ref] of next) {
          if (ref) shadow.set(slot, ref);
          else shadow.delete(slot);
        }
      } else if (line.kind === "command" && line.command === "charslot") {
        const rawSlot = String(line.args.slot ?? "").trim();
        const name = String(line.args.name ?? "");
        if (!rawSlot) shadow.clear();
        else {
          const slot = parseSlot(rawSlot);
          if (slot) {
            if (name === "char_empty") shadow.delete(slot);
            else if (name) shadow.set(slot, name);
          }
        }
      }
      const expected = ["m", "l", "r"].filter((slot) => shadow.has(slot)).map((slot) => `${slot}:${shadow.get(slot)}`);
      const actual = ["m", "l", "r"].filter((slot) => mine.chars.some((char) => char.slot === slot))
        .map((slot) => `${slot}:${mine.chars.find((char) => char.slot === slot)?.name}`);
      if (JSON.stringify(expected) !== JSON.stringify(actual) && !replayMismatch) {
        replayMismatch = `第 ${line.lineNumber} 行 expected ${show(expected)} got ${show(actual)}`;
      }
      // focus 也要跟着走
      const expectedFocus = line.kind === "command" && line.command === "character"
        ? resolveCharacterFocus(Number(line.args.focus ?? 0) || 0)
        : mine.focusSlots;
      if (line.kind === "command" && line.command === "charslot") {
        const focusRaw = String(line.args.focus ?? "all").trim().toLowerCase();
        const want = !focusRaw || focusRaw === "all" ? ["l", "m", "r"] : resolveFocusList(focusRaw);
        if (JSON.stringify(mine.focusSlots) !== JSON.stringify(want) && !replayMismatch) {
          replayMismatch = `第 ${line.lineNumber} 行 charslot focus expected ${show(want)} got ${show(mine.focusSlots)}`;
        }
      } else if (JSON.stringify(mine.focusSlots) !== JSON.stringify(expectedFocus) && !replayMismatch) {
        replayMismatch = `第 ${line.lineNumber} 行 focus expected ${show(expectedFocus)} got ${show(mine.focusSlots)}`;
      }
    }
    ok("逐行重放与影子状态一致（槽位 + focus）", replayMismatch === null, replayMismatch ?? `${sorted.length} 行`);
    // 结尾：合流后回到 m 槽
    const end = parseStage(sample, Number.MAX_SAFE_INTEGER, { table });
    eq("走完整篇 → 只有 m 槽 1 个立绘", end.chars.map((char) => `${char.slot}:${char.name}`), [`m:${end.chars[0]?.name ?? ""}`]);
    // 只看某一行之前（不含）→ lineIndex=1 时应当空舞台
    eq("lineIndex=1（第一行前）→ 空舞台", parseStage(sample, 1, { table }).chars.length, 0);
  }

  // ── (c2) 分支闸门：合流前后 ────────────────────────────────
  group("(c2) Decision/Predicate 闸门");
  const branchScript = [
    '[Decision(options="A;B", values="1;2")]',
    '[Predicate(references="1")]',
    '[Character(name="avg_npc_012", fadetime=0.3)]',
    '[Predicate(references="2")]',
    '[Character(name="avg_npc_053", fadetime=0.3)]',
    '[Predicate(references="1;2")]',
    '[Character(name="avg_npc_061", fadetime=0.3)]',
  ].join("\n");
  eq("无选择记录 = 全放行（合流后最后一个立绘）", parseStage(branchScript, 7, { table }).chars.map((char) => char.name), ["avg_npc_061"]);
  eq("选 1 时只走分支 1", parseStage(branchScript, 3, { table, selections: { 1: 1 } }).chars.map((char) => char.name), ["avg_npc_012"]);
  eq("选 2 时分支 2 放行、分支 1 被挡", parseStage(branchScript, 5, { table, selections: { 1: 2 } }).chars.map((char) => char.name), ["avg_npc_053"]);
  const gated = parseStage(branchScript, 4, { table, selections: { 1: 2 } });
  eq("选 2 时第 4 行仍在分支 1 内（闸门挡住）", gated.chars.length, 0);

  // ── (c3) 未穿过 Decision 的预览必须与"穿过并选中某分支"一致 ──────────
  // 编辑器把光标放在 Decision 之前时不知道玩家会选什么（闸门全放行）；光标放到
  // Decision 之后时才知道。**同一行**在两处的立绘必须一致，否则拖滑杆会跳。
  group(`(c3) 未穿过 Decision vs 选中分支（语料抽查 ${options.branchSamples} 个 Decision）`);
  if (!corpusRoot) {
    skip("语料抽样（没有 corpus）");
  } else {
    const picks = [];
    for (const file of walkTxt(corpusRoot)) {
      if (picks.length >= options.branchSamples) break;
      const text = readFileSync(file, "utf8");
      const lines = parseScript(text);
      const decision = lines.find((line) => line.kind === "command" && line.command === "decision");
      if (!decision) continue;
      const values = String(arg(decision.args, "values") ?? "")
        .split(";")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value));
      if (values.length < 2) continue;
      picks.push({ file, text, decision, values, lines });
    }
    ok(`抽到 ${options.branchSamples} 个多选项 Decision`, picks.length >= Math.min(2, options.branchSamples), `实际 ${picks.length}`);
    const shapeOf = (snapshot) => JSON.stringify(snapshot.chars.map((char) => [char.slot, char.key, char.missing, Math.round(char.rect.x), Math.round(char.rect.y)]));
    let mismatches = 0;
    let probes = 0;
    const details = [];
    for (const pick of picks) {
      // 预览锚点：Decision 本行（未穿过）与它之后的第一条指令行（已穿过）。
      const after = pick.lines.find((line) => line.lineNumber > pick.decision.lineNumber && line.kind === "command")?.lineNumber ?? pick.decision.lineNumber;
      const positions = new Set([pick.decision.lineNumber, after]);
      for (let n = 1; n <= pick.decision.lineNumber; n += Math.max(1, Math.floor(pick.decision.lineNumber / 6))) positions.add(n);
      for (const lineIndex of positions) {
        for (const value of pick.values) {
          probes += 1;
          const blind = parseStage(pick.text, lineIndex, { model: { characters: table }, selections: {} });
          const chosen = parseStage(pick.text, lineIndex, { model: { characters: table }, selections: { [pick.decision.lineNumber]: value } });
          if (shapeOf(blind) !== shapeOf(chosen)) {
            mismatches += 1;
            if (details.length < 3) {
              details.push(`${relative(corpusRoot, pick.file)}:${lineIndex} value=${value} 全放行=${shapeOf(blind)} 选中=${shapeOf(chosen)}`);
            }
          }
        }
      }
    }
    ok(
      "逐预览位置 × 逐分支值：立绘完全一致（不跳动）",
      mismatches === 0,
      `${probes} 组对照 / ${mismatches} 处不一致${details.length ? `：${details.join(" ; ")}` : ""}`,
    );
  }

  // ── (d) movePatch ────────────────────────────────────────
  group("(d) movePatch：lint 0 error + 引擎语义");
  const cases = [
    { extra: undefined, label: "无当前行" },
    { extra: { line: '[Character(name="avg_npc_012", fadetime=0.3)]' }, label: "Character(name only)" },
    { extra: { line: '[Character(name="avg_npc_012", name2="avg_npc_053", fadetime=0.3)]' }, label: "Character(name+name2)" },
    { extra: { line: '[charslot(slot="m", name="avg_npc_012", duration=0.3)]' }, label: "charslot" },
    { extra: { line: '[CharacterAction(name="middle", type="move", fadetime=0.5)]' }, label: "CharacterAction" },
    { extra: { line: '[Character(name="avg_npc_012", enter="left", xpos1=-40, ypos1=12, fadetime=0.3)]' }, label: "已有 xpos/ypos" },
  ];
  const drags = [
    { dx: 80, dy: -40 },
    { dx: -80, dy: 0 },
    { dx: 0, dy: 120 },
    { dx: -30, dy: -160 },
  ];
  let lintErrors = 0;
  let semanticErrors = 0;
  let roundTripErrors = 0;
  for (const slot of ["l", "m", "r"]) {
    for (const drag of drags) {
      for (const item of cases) {
        const patch = movePatch(slot, drag.dx, drag.dy, item.extra);
        // 数值语义
        const expectEnter = Math.abs(drag.dx) >= Math.abs(drag.dy)
          ? (drag.dx >= 0 ? "left" : "right")
          : (drag.dy >= 0 ? "up" : "down");
        if (patch.dx !== drag.dx || patch.dy !== drag.dy) semanticErrors += 1;
        if (JSON.stringify(patch.absolute) !== JSON.stringify({ x: drag.dx, y: -drag.dy })) semanticErrors += 1;
        if (patch.slide.enter !== expectEnter) semanticErrors += 1;
        // `Character` 的滑入参数按槽选键：ypos = +dy（Unity y-up），xpos = -dx。
        // 但当前行是 `[charslot]` / `[CharacterAction]` / 已有的 `Character` 时，
        // `patch` 是**那条命令**的键（setpos / xpos,ypos / enter+滑入），要分开断言。
        const lineKind = item.extra?.line
          ? (item.extra.line.match(/^\[\s*([A-Za-z_]\w*)/)?.[1] ?? "").toLowerCase()
          : "";
        if (lineKind === "charslot") {
          if (patch.patch.action !== "setpos" || patch.patch.posto !== `${drag.dx},${-drag.dy}`) semanticErrors += 1;
        } else if (lineKind === "characteraction") {
          if (patch.patch.xpos !== drag.dx || patch.patch.ypos !== -drag.dy) semanticErrors += 1;
        } else {
          // 用 `movePatch` 自己给出的键（它按「这一行怎么写的 / 槽位」选了
          // `enter/xpos1/ypos1` 还是 `enter2/xpos2/ypos2`）。
          const { x: xKey, y: yKey, enter: enterKey } = patch.keys;
          if (patch.patch[enterKey] !== expectEnter) semanticErrors += 1;
          if (patch.patch[xKey] !== -drag.dx || patch.patch[yKey] !== drag.dy) semanticErrors += 1;
          // 引擎还原：enterOffset(dir, {xpos, ypos}) = (-dx, -dy)（屏幕方向）
          const restored = enterOffset(slot, parseEnter(patch.patch[enterKey]), {
            x: Number(patch.patch[xKey]),
            y: Number(patch.patch[yKey]),
          });
          if (restored.x !== -drag.dx || restored.y !== -drag.dy) roundTripErrors += 1;
        }
        // 文本产物 lint
        for (const [kind, text] of [
          ["line", patch.line],
          ["slideLine", patch.slideLine],
          ["moveLine", patch.moveLine],
        ]) {
          if (!text) continue;
          const report = lintDocument(text);
          if (report.stats.errors > 0) {
            lintErrors += 1;
            if (lintErrors <= 5) {
              process.stdout.write(`      lint ${slot} ${JSON.stringify(drag)} ${item.label} ${kind}: ${show(report.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}:${d.message}`))}\n`);
            }
          }
        }
      }
    }
  }
  ok("全部 movePatch 产物 lintDocument 0 error", lintErrors === 0, `${3 * drags.length * cases.length * 3} 份文本`);
  ok("滑入数值 = (-dx, +dy) / enter 方向正确", semanticErrors === 0, `${semanticErrors} 处`);
  ok("enterOffset 可还原成屏幕 (-dx, -dy)", roundTripErrors === 0, `${roundTripErrors} 处`);

  // 编辑器实际用法：改完的整行接回样例，整篇 lint 仍 0 error。
  if (samplePath) {
    const sample = readFileSync(samplePath, "utf8");
    const target = parseScript(sample).find((line) => line.command === "character");
    if (target) {
      const patched = movePatch("m", 64, -24, { line: target.raw });
      const nextLine = patched.line ?? patched.slideLine;
      const next = sample.split("\n").map((raw, index) => (index + 1 === target.lineNumber ? nextLine : raw)).join("\n");
      const report = lintDocument(next);
      eq("样例里真的改一行 → lintDocument 0 error", report.stats.errors, 0);
      process.stdout.write(`      ${target.raw}\n   →  ${nextLine}\n`);
      // charslot 形态的整行
      const charslotLine = `[charslot(slot="m", name="${target.args.name}", duration=0.3)]`;
      const charslotPatched = movePatch("m", 64, -24, { line: charslotLine });
      eq("charslot 形态 → setpos", charslotPatched.patch, { action: "setpos", posfrom: "0,0", posto: "64,24" });
      eq("charslot 形态 lint 0 error", lintDocument(charslotPatched.line ?? "").stats.errors, 0);
    }
  }
  eq("enter 缺失（middle）→ parseEnter undefined", parseEnter("middle"), undefined);
  eq("enter 合法（left）→ parseEnter left", parseEnter("left"), "left");
  eq("fallback 入场起点（l/left）= +200-1152", genPosition("l", "left"), { x: -952, y: 0 });
  eq("fallback 入场起点（r/up）", genPosition("r", "up"), { x: 0, y: -1072 });

  // ── (e) 清槽 / focus 规则 ──────────────────────────────
  group("(e) 清槽与 focus（runtime 的 updates 数组）");
  const clearScript = [
    '[Character(name="avg_npc_012", fadetime=0.2)]',
    '[charslot(slot="l", name="avg_npc_053", duration=0.2)]',
    '[charslot(slot="r", name="avg_npc_061", duration=0.2)]',
    '[Character(name="avg_npc_242", fadetime=0.2)]',
  ].join("\n");
  eq("Character(name) 清掉 l/r，只剩 m", parseStage(clearScript, 4, { table }).chars.map((char) => char.slot), ["m"]);
  const pairScript = [
    '[charslot(slot="m", name="avg_npc_242", duration=0.2)]',
    '[Character(name="avg_npc_012", name2="avg_npc_053", fadetime=0.2)]',
  ].join("\n");
  eq("name+name2 → l/r，m 被清", parseStage(pairScript, 2, { table }).chars.map((char) => `${char.slot}:${char.name}`), ["l:avg_npc_012", "r:avg_npc_053"]);
  const emptyScript = [
    '[Character(name="avg_npc_012", fadetime=0.2)]',
    '[charslot(slot="m", name="char_empty", duration=0.2)]',
  ].join("\n");
  eq("char_empty 只清该槽", parseStage(emptyScript, 2, { table }).chars.length, 0);
  const keepScript = [
    '[Character(name="avg_npc_012", fadetime=0.2)]',
    '[charslot(slot="m", duration=0.2)]',
  ].join("\n");
  eq("charslot 空 name + 有 slot = 该槽不动", parseStage(keepScript, 2, { table }).chars.map((char) => char.slot), ["m"]);
  const clearAllScript = [
    '[Character(name="avg_npc_012", fadetime=0.2)]',
    '[charslot(slot="", name="", duration=0.2)]',
  ].join("\n");
  eq("charslot 空 slot = 清三个内置槽", parseStage(clearAllScript, 2, { table }).chars.length, 0);
  eq("Character(name=\"\") 清全槽", parseStage('[Character(name="", fadetime=0.2)]', 1, { table }).chars.length, 0);
  // focus
  const focusScript = (focus) => `[Character(name="avg_npc_012", name2="avg_npc_053", focus=${focus}, fadetime=0.2)]`;
  eq("focus=0 → 全亮", parseStage(focusScript(0), 1, { table }).focusSlots, ["l", "m", "r"]);
  eq("focus=1 → l/m 亮、r 暗", resolveCharacterFocus(1), ["l", "m"]);
  eq("focus=2 → 只有 r 亮（runtime: `(focus & 0xFFFFFFFD) == 0` 不含 r）", resolveCharacterFocus(2), ["r"]);
  const focusTwo = parseStage(focusScript(2), 1, { table });
  eq("focus=2 时 r 亮、l 暗", focusTwo.chars.map((char) => `${char.slot}:${char.dimmed}`), ["l:true", "r:false"]);
  const focusOne = parseStage(focusScript(1), 1, { table });
  eq("focus=1 时 l 亮、r 暗", focusOne.chars.map((char) => `${char.slot}:${char.dimmed}`), ["l:false", "r:true"]);
  eq("charslot focus=\"l\" → 只亮 l", resolveFocusList("l"), ["l"]);
  eq("charslot focus=all → 全亮", resolveFocusList("all"), ["l", "m", "r"]);
  eq("charslot focus 未知值 → 全暗", resolveFocusList("n"), []);
  // 槽位词表
  eq("parseSlot(char_right) = r", parseSlot("char_right"), "r");
  eq("parseSlot(CENTER) = m", parseSlot("CENTER"), "m");
  eq("parseSlot(custom) = undefined", parseSlot("custom"), undefined);

  // ── 证据落盘 ───────────────────────────────────────────
  const report = {
    ok: failed === 0,
    passed,
    failed,
    skipped,
    ms: Date.now() - started,
    table: relative(REPO_ROOT, loaded.path) || loaded.path,
    corpus: corpusRoot,
    topUsage: (ranked ?? []).slice(0, options.top),
    rects: info,
    failures,
  };
  try {
    mkdirSync(join(REPO_ROOT, "build", "fanfic"), { recursive: true });
    writeFileSync(join(REPO_ROOT, "build", "fanfic", "stage-selftest.json"), `${JSON.stringify(report, null, 1)}\n`);
  } catch {
    // 报告写不出来不影响结论
  }

  process.stdout.write(
    `\n${failed === 0 ? "STAGE-SELFTEST PASS" : "STAGE-SELFTEST FAIL"} — ${passed} 通过` +
      `${failed ? ` / ${failed} 失败` : ""}${skipped ? ` / ${skipped} 跳过` : ""}（${report.ms}ms）\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
