#!/usr/bin/env node
/**
 * 从官方语料重新生成 `src/akstage/local/editorForms.js` 内嵌的四张只读表：
 *
 *   OBSERVED_RANGES  数值参数的实测范围（滑杆用）
 *   NAMED_PRESETS     命名预设（参数取自真实语料行；保留 `文件:行` 溯源）
 *   CORPUS_ANCHORS    按"参数键集合"聚类后的高频写法
 *   COMMON_ASSETS     最常见的素材 key（background / character / bgm / sfx）
 *
 *   node scripts/fanfic/editorForms-data.mjs                 # 打印统计（不改文件）
 *   node scripts/fanfic/editorForms-data.mjs --write         # 写回 editorForms.js 的标记区
 *   node scripts/fanfic/editorForms-data.mjs --check         # 与文件内容比对（CI）
 *
 * 生成物只影响「滑杆范围 / 预设 / 素材候选」；**字段表始终从 CONTROLLERS
 * 派生**，所以改了 spec 不用重跑本脚本。语料可换：`--corpus <dir>`。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROLLERS, parseLine } from "../../src/akstage/local/editorModel.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORMS_PATH = resolve(HERE, "../../src/akstage/local/editorForms.js");
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const CORPUS = resolve(arg("--corpus", process.env.AKSTAGE_CORPUS_DIR || "/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story"));
const WRITE = argv.includes("--write");
const CHECK = argv.includes("--check");

const NUMERIC = new Set();
for (const spec of CONTROLLERS) {
  for (const meta of spec.required.concat(spec.optional)) {
    if (meta.type === "number" || meta.type === "int") NUMERIC.add(meta.name);
  }
}

/** 命名预设：`命令 → { 中文标签: 谓词(原始行) }`。全部取自真实语料（保留来源行号）。 */
const CURATED = {
  character: {
    "入场（淡入）": (v) => /fadetime=0?\.[1-9]/.test(v) && (v.match(/name="/g) ?? []).length === 1 && !/name2=|blackstart|#/.test(v) && v.length < 70,
    "差分切换": (v) => /name="[^"]*#\d/.test(v) && !/name2=|blackstart/.test(v) && v.length < 70,
    "双人同框": (v) => /name2="/.test(v) && !/blackstart/.test(v),
    "清槽": (v) => /name=""\s*\)/.test(v),
  },
  charslot: {
    "精确站位": (v) => /duration=/.test(v) && /slot\s*=\s*"/.test(v) && !/action=/.test(v) && v.length < 80,
    "聚焦": (v) => /focus=/.test(v) && !/action=/.test(v) && v.length < 70,
    "清槽": (v) => /name\s*=\s*""/.test(v) && /slot\s*=\s*"/.test(v),
  },
  blocker: {
    "全黑 0.5s": (v) => /a=1/.test(v) && /r=0/.test(v) && /fadetime=0\.5/.test(v),
    "全黑 2s": (v) => /a=1,?\s*r=0/.test(v) && /fadetime=2/.test(v),
    "白闪": (v) => /r=1/.test(v) && /g=1/.test(v) && /b=1/.test(v) && v.length < 100,
    "淡出": (v) => /a=0\b/.test(v) && !/from=/.test(v) && /block=/.test(v),
  },
  camerashake: {
    "重震": (v) => /randomness=(9\d|1\d\d)/.test(v) && /duration=/.test(v) && v.length < 100,
    "轻震": (v) => /randomness=([1-9]|10)\b/.test(v) && /duration=/.test(v) && !/fadetime/.test(v) && v.length < 110,
    "长镜头（3s）": (v) => /duration=3\b/.test(v) && v.length < 90,
  },
  cameraeffect: {
    "灰化（情绪冷下来）": (v) => /Grayscale/.test(v) && /amount=0?\.[1-9]/.test(v) && v.length < 70,
    "还原": (v) => /Grayscale/.test(v) && /amount=0\b/.test(v) && v.length < 70,
    "反色": (v) => /Colorinverse/.test(v),
  },
  background: {
    "换背景（铺满 + 阻塞）": (v) => /screenadapt="coverall"/.test(v) && /block=true/.test(v) && !/fadetime/.test(v),
    "淡入换景": (v) => /screenadapt="coverall"/.test(v) && /fadetime=1\b/.test(v),
    "清背景": (v) => /image=""\s*\)/.test(v),
  },
  image: {
    "整屏叠图（CG）": (v) => /screenadapt="coverall"/.test(v) && /fadetime=0\b/.test(v) && /xScale=1/.test(v),
    "叠图位移": (v) => /screenadapt="coverall"/.test(v) && /x=-100/.test(v) && v.length < 110,
  },
  delay: { "短停顿": (v) => /time=0?\.[1-9]/.test(v), "1 秒": (v) => /time=1\b/.test(v), "长停顿": (v) => /time=[2-9]\b/.test(v) },
  curtain: {
    "自左": (v) => /direction\s*=\s*0/.test(v) && /fadetime/.test(v) && v.length < 90,
    "自右": (v) => /direction\s*=\s*2/.test(v) && v.length < 90,
    "上下": (v) => /direction\s*=\s*[46]/.test(v) && v.length < 90,
  },
  playmusic: {
    "循环 BGM": (v) => !/intro=/.test(v) && !/delay=/.test(v) && /volume=/.test(v),
    "带前奏": (v) => /intro=/.test(v) && !/delay=/.test(v) && /volume=/.test(v),
  },
  subtitle: { "字幕（居中）": (v) => /alignment="center"/.test(v) && /size=24/.test(v) },
  decision: { "二选一": (v) => /values="1;2"/.test(v), "三选一": (v) => /values="1;2;3"/.test(v) },
  predicate: { "分支闸门": (v) => /references="[1-9]"/.test(v), "合流": (v) => /references="\d;/.test(v) },
  interlude: {
    "横向切入": (v) => /style\s*=\s*1\b/.test(v) && /maskid/.test(v),
    "淡入": (v) => /aduration/.test(v) && !/maskid/.test(v),
  },
  sticker: { "便签（正文内联）": (v) => /id="st\d"/.test(v) && /text="/.test(v) && v.length < 110 },
  focusout: { "景深": (v) => /duration=0\b/.test(v) },
  theater: { "开场": (v) => /mode=true/.test(v), "退场": (v) => /mode=false/.test(v) },
  skipnode: { "跳过首节点": (v) => /nofirstskip/.test(v), "跳过": (v) => /mode="skip"/.test(v) },
  charactercutin: { "切入角色": (v) => /name=/.test(v) && /widgetID/.test(v) },
  imagetween: { "缓推 15s": (v) => /duration=15\b/.test(v), "滑入": (v) => /xFrom=-100/.test(v) },
  backgroundtween: { "缓慢推近": (v) => /duration=1\d\b/.test(v) && /focusx|scale/.test(v) },
  characteraction: { "移动": (v) => /type\s*=\s*"move"/.test(v), "退场": (v) => /type\s*=\s*"exit"/.test(v) },
  header: { "标题 + 黑边": (v) => /fit_mode="BLACK_MASK"/.test(v) },
  gridbg: { "九宫格": (v) => /imagegroup/.test(v) },
};

const ASSET_BUCKETS = {
  backgrounds: new Set(["background", "image", "gridbg", "largebg", "verticalbg", "backgroundtween", "largebgtween"]),
  characters: new Set(["character", "charslot", "characteraction", "charactercutin", "interlude"]),
  music: new Set(["playmusic", "stopmusic", "musicvolume"]),
  sounds: new Set(["playsound", "stopsound", "soundvolume"]),
};
const ASSET_LIMIT = { backgrounds: 140, characters: 200, music: 140, sounds: 60 };

/** @param {string} dir @returns {string[]} */
function walkTxt(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walkTxt(path));
    else if (name.endsWith(".txt")) out.push(path);
  }
  return out;
}

/** @param {number} min @param {number} max */
function stepOf(min, max) {
  const span = max - min;
  if (span <= 0.5) return 0.01;
  if (span <= 3) return 0.05;
  if (span <= 12) return 0.1;
  if (span <= 60) return 1;
  if (span <= 400) return 5;
  return 10;
}

const files = walkTxt(CORPUS);
/** @type {Map<string, [number, number, number]>} */
const observed = new Map();
/** @type {Map<string, Map<string, {n: number, line: string, source: string}>>} */
const anchors = new Map();
/** @type {Map<string, Array<{raw: string, src: string}>>} */
const collected = new Map(Object.keys(CURATED).map((cmd) => [cmd, []]));
/** @type {Record<string, Map<string, number>>} */
const assetCount = { backgrounds: new Map(), characters: new Map(), music: new Map(), sounds: new Map() };

for (const file of files) {
  const rel = file.split(/gamedata[/\\]story[/\\]/)[1] ?? file;
  const lines = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (raw[0] !== "[" || raw.endsWith("\\") || raw.length > 130 || raw.includes("\t") || raw.includes("|")) continue;
    if (raw.slice(raw.lastIndexOf("]") + 1).trim() !== "" || /\]\]$/.test(raw)) continue;
    const result = parseLine(raw, i + 1);
    if (!result.spec || result.diagnostics.some((d) => d.severity === "error")) continue;
    const source = `${rel}:${i + 1}`;
    for (const param of result.params) {
      if (NUMERIC.has(param.name)) {
        const value = typeof param.value === "number" ? param.value : Number(param.value);
        if (Number.isFinite(value)) {
          for (const key of [`${result.controller}.${param.name}`, `*.${param.name}`]) {
            const cur = observed.get(key) ?? [Infinity, -Infinity, 0];
            observed.set(key, [Math.min(cur[0], value), Math.max(cur[1], value), cur[2] + 1]);
          }
        }
      }
      for (const [bucket, commands] of Object.entries(ASSET_BUCKETS)) {
        if (!commands.has(result.controller)) continue;
        if (!["image", "name", "key", "intro", "imagegroup", "char"].includes(param.name)) continue;
        const text = String(param.value ?? "");
        if (!text || !/^[A-Za-z0-9_$#@-]+$/.test(text)) continue;
        const key = result.controller === "character" || result.controller === "charslot" ? text.split(/[#$@]/)[0] : text;
        if (!key) continue;
        assetCount[bucket].set(key, (assetCount[bucket].get(key) ?? 0) + 1);
      }
    }
    // 只收"头就是本命令"的干净写法：`[Charname(...)]` / `[Charname]`，
    // 且整行只有一个 `[`（排除 `[blocker] [Blocker(...)]` 这类拼接）。
    const headToken = raw.slice(1, Math.min(raw.indexOf("(") === -1 ? raw.length : raw.indexOf("("), raw.lastIndexOf("]"))).trim();
    const clean = raw.slice(1).split("[").length === 1
      && headToken.toLowerCase() === result.controller
      && headToken.toLowerCase() === String(result.spec.canonical).toLowerCase();
    const list = collected.get(result.controller);
    if (clean && list && list.length < 4000) list.push({ raw, src: source });
    if (!clean) continue;
    const signature = result.params.map((p) => p.key).sort().join(",");
    const table = anchors.get(result.controller) ?? new Map();
    const prev = table.get(signature);
    if (!prev) table.set(signature, { n: 1, line: raw, source });
    else {
      prev.n += 1;
      if (raw.length < prev.line.length) { prev.line = raw; prev.source = source; }
    }
    anchors.set(result.controller, table);
  }
}

/** `[min,max,step,n]`，样本 <8 的丢弃（噪声）。 */
const ranges = {};
for (const [key, [lo, hi, n]] of [...observed.entries()].sort()) {
  if (n < 8) continue;
  ranges[key] = [lo, hi, stepOf(lo, hi), n];
}

const named = {};
for (const [command, defs] of Object.entries(CURATED)) {
  const list = collected.get(command) ?? [];
  /** @type {Array<{name: string, source: string, line: string}>} */
  const out = [];
  for (const [name, predicate] of Object.entries(defs)) {
    const hit = list.find((x) => predicate(x.raw) && !out.some((o) => o.line === x.raw));
    if (hit) out.push({ name, source: hit.src, line: hit.raw });
  }
  named[command] = out;
}

const KEY_LABELS = {
  a: "透明度", r: "红", g: "绿", b: "蓝", effect: "效果", duration: "时长", time: "秒数", key: "音频",
  image: "图片", name: "角色", text: "文本", fadetime: "淡入", block: "阻塞", id: "编号",
};
/** @param {string[]} keys @returns {string} */
function labelOf(keys) {
  const parts = keys.filter((k) => !["a", "r", "g", "b"].includes(k)).slice(0, 2).map((k) => KEY_LABELS[k] ?? k);
  return parts.length ? `常用（${parts.join("/")}）` : "常用";
}

const anchorOut = {};
for (const [command, table] of anchors) {
  const shapes = [...table.entries()].map(([signature, value]) => ({ keys: signature ? signature.split(",") : [], ...value }))
    .sort((a, b) => b.n - a.n || a.line.length - b.line.length);
  const minLen = shapes.reduce((min, shape) => Math.min(min, shape.keys.length), Infinity);
  /** @type {Array<{name: string, source: string, line: string, n: number}>} */
  const list = [];
  const add = (shape, name) => {
    if (!shape || list.length >= 4 || list.some((x) => x.line === shape.line)) return;
    list.push({ name, source: shape.source, line: shape.line, n: shape.n });
  };
  const base = shapes.find((shape) => shape.keys.length === minLen);
  add(base, base?.keys.length ? "最短写法" : "无参数");
  add(shapes[0], labelOf(shapes[0]?.keys ?? []));
  const second = shapes.find((shape) => !list.some((x) => x.line === shape.line));
  add(second, labelOf(second?.keys ?? []));
  const rich = shapes.slice().sort((a, b) => b.keys.length - a.keys.length || b.n - a.n)[0];
  add(rich, rich ? `全参数（${rich.keys.length} 项）` : "");
  anchorOut[command] = list.slice(0, 4);
}

const assets = {};
for (const [bucket, map] of Object.entries(assetCount)) {
  assets[bucket] = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, ASSET_LIMIT[bucket]).map(([key]) => key);
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
const out = [];
const chunk = (values, indent) => {
  for (let i = 0; i < values.length; i += 8) {
    out.push(`${indent}${values.slice(i, i + 8).map((v) => JSON.stringify(v)).join(", ")},`);
  }
};
out.push("/** 语料实测数值范围（`命令.参数` 或 `*.参数` → `[min, max, 滑杆步长, 样本数]`）。");
out.push(" *  由官方剧本 .txt 全量扫描得出；`*.` 前缀 = 该参数在各命令里的并集。 */");
out.push("export const OBSERVED_RANGES = {");
for (const [key, value] of Object.entries(ranges)) out.push(`  ${JSON.stringify(key)}: [${value.join(", ")}],`);
out.push("};");
out.push("");
out.push("/** 命名预设（参数取自真实语料行；`source` = `文件:行`，自检会回读核对）。 */");
out.push("export const NAMED_PRESETS = {");
for (const [command, list] of Object.entries(named)) {
  if (!list.length) continue;
  out.push(`  ${command}: [`);
  for (const item of list) out.push(`    { name: ${JSON.stringify(item.name)}, source: ${JSON.stringify(item.source)}, line: ${JSON.stringify(item.line)} },`);
  out.push("  ],");
}
out.push("};");
out.push("");
out.push("/** 语料高频写法（按参数键集合聚类后的代表行，`n` = 该形态的出现次数）。 */");
out.push("export const CORPUS_ANCHORS = {");
for (const [command, list] of Object.entries(anchorOut)) {
  out.push(`  ${command}: [`);
  for (const item of list) out.push(`    { name: ${JSON.stringify(item.name)}, source: ${JSON.stringify(item.source)}, line: ${JSON.stringify(item.line)}, n: ${item.n} },`);
  out.push("  ],");
}
out.push("};");
out.push("");
out.push("/** 语料里最常见的素材 key（离线可用；给了 `resolveUrl` 时优先用调用方的）。 */");
out.push("export const COMMON_ASSETS = {");
for (const [bucket, values] of Object.entries(assets)) {
  out.push(`  ${bucket}: [`);
  chunk(values, "    ");
  out.push("  ],");
}
out.push("};");
const block = `${out.join("\n")}\n`;

if (argv.includes("--print")) process.stdout.write(block);
const START = "/* @generated:data */";
const END = "/* @end:data */";
const current = readFileSync(FORMS_PATH, "utf8");
const from = current.indexOf(START);
const to = current.indexOf(END);
if (from === -1 || to === -1) {
  process.stderr.write(`editorForms.js 缺少 ${START} … ${END} 标记区\n`);
  process.exit(2);
}
const existing = current.slice(from + START.length, to).replace(/^\n/, "");
if (CHECK) {
  if (existing.trimEnd() !== block.trimEnd()) {
    process.stderr.write("内嵌语料表与语料不一致：跑 `node scripts/fanfic/editorForms-data.mjs --write`\n");
    process.exit(1);
  }
  process.stdout.write(`ok  内嵌语料表与语料一致（${Object.keys(ranges).length} 范围 / ${Object.keys(named).length} 命名预设 / ${Object.values(anchorOut).reduce((a, v) => a + v.length, 0)} 锚点）\n`);
} else if (WRITE) {
  writeFileSync(FORMS_PATH, current.slice(0, from + START.length) + `\n${block}` + current.slice(to));
  process.stdout.write(`已写回 ${FORMS_PATH}\n`);
} else {
  process.stdout.write(
    `语料：${CORPUS}\n文件：${files.length}\n`
    + `范围：${Object.keys(ranges).length}　命名预设：${Object.keys(named).filter((c) => named[c].length).length} 个命令 / ${Object.values(named).reduce((a, v) => a + v.length, 0)} 条\n`
    + `锚点：${Object.values(anchorOut).reduce((a, v) => a + v.length, 0)} 条　素材：${Object.entries(assets).map(([k, v]) => `${k}=${v.length}`).join(" ")}\n`
    + "（加 --write 写回 editorForms.js；--check 与文件比对；--print 打印生成块）\n",
  );
}
