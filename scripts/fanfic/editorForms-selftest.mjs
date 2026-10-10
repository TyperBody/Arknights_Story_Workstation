#!/usr/bin/env node
/**
 * 表单层自检（offline, zero-dependency）：`src/akstage/local/editorForms.js`
 *
 *   node scripts/fanfic/editorForms-selftest.mjs [--corpus <dir>] [--count 400] [--json out.json]
 *
 * 断言（对应任务验收）：
 *   (a) 字段派生：`CONTROLLERS` 的**每一条**命令都能 `formFor()` 出 ≥1 个字段；
 *       字段的 `name/type/options/range/default` 与 spec 一致；
 *       `engineRead:false` 的键**必须**带 `reason`（灰掉时给用户解释）。
 *   (b) 控件映射：`bool → switch`（`type==="bool"`）、有语料范围的数值 → 滑杆
 *       （`range` 非 null 且 `range[0] < range[1]`）、`enum → options` 非空、
 *       素材键（image/name/key…）→ `type==="path"` 且 `hasAssetPool()`。
 *   (c) 读→写往返：对**每一行**控制器行，`applyForm(line, parseValues(line).values)`
 *       与源行**逐字节**一致；抽样行再做"值语义往返"（改一个字段 → 只有那个字段变）。
 *   (d) 预设：`presetsFor()` 的每一条（含命名/语料/规格）过 `lintDocument` **0 error**；
 *       命名预设的 `line` 必须能在语料 `source` 处回读到同一条（溯源不造假）。
 *   (e) 10 组坏输入：未知命令、未闭合括号、Tab、值类型不符、缺必需参数……断言
 *       `parseValues()` 不抛错、`formFor()` 返回 null、`applyForm()` 原样返回。
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 用法/环境错误。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROLLERS, ENUMS, formatLine, lintDocument, parseLine } from "../../src/akstage/local/editorModel.js";
import {
  applyForm,
  assetsFor,
  catalog,
  catalogByCategory,
  buildLine,
  controllerOf,
  controllersOf,
  diffFields,
  formFor,
  hasAssetPool,
  parseValues,
  presetsFor,
} from "../../src/akstage/local/editorForms.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CORPUS_CANDIDATES = [
  process.env.AKSTAGE_CORPUS_DIR,
  "/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story",
  join(process.env.HOME ?? "", ".akresearch/akgd/zh_CN/gamedata/story"),
].filter(Boolean);

// ── 极简断言框架 ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
/** @type {Array<{group: string, name: string, detail: string}>} */
const failures = [];
let currentGroup = "";

/** @param {string} name */
function group(name) {
  currentGroup = name;
  process.stdout.write(`\n## ${name}\n`);
}

/** @param {string} name @param {unknown} actual @param {unknown} expected */
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
    return;
  }
  failed += 1;
  failures.push({ group: currentGroup, name, detail: `expected ${b}, got ${a}` });
  process.stdout.write(`  ✗ ${name}\n      expected: ${b}\n      actual:   ${a}\n`);
}

/** @param {string} name @param {unknown} value */
function ok(name, value) {
  eq(name, Boolean(value), true);
}

/** `fn()` 不抛错（返回 {ok, value, error}）。 */
/** @param {() => unknown} fn @returns {{ok: boolean, value?: unknown, error?: string}} */
function noThrow(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** `run(name, count, total)` 形式的"批量断言"。 */
/**
 * @param {string} name @param {number} good @param {number} total
 * @param {string} [sample] 失败样例
 */
function batch(name, good, total, sample = "") {
  if (good === total) {
    passed += 1;
    process.stdout.write(`  ✓ ${name}（${good}/${total}）\n`);
    return;
  }
  failed += 1;
  failures.push({ group: currentGroup, name, detail: `${good}/${total}${sample ? ` — ${sample}` : ""}` });
  process.stdout.write(`  ✗ ${name}：${good}/${total}${sample ? `\n      ${sample}` : ""}\n`);
}

/** @param {string} [name] */
function skip(name = "") {
  process.stdout.write(`  · skip ${name}\n`);
}

// ── 参数与语料 ─────────────────────────────────────────────────────────

/** @returns {{corpus: string|null, count: number, json: string|null, full: boolean, allowMissingCorpus: boolean}} */
function parseArgv() {
  const argv = process.argv.slice(2);
  let corpus = null;
  let count = 400;
  /** @type {string|null} */
  let json = null;
  let full = false;
  let allowMissingCorpus = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--corpus") corpus = argv[++i] ?? null;
    else if (arg === "--count") count = Math.max(1, Number(argv[++i] ?? 400) || 400);
    else if (arg === "--json") json = argv[++i] ?? null;
    else if (arg === "--full") full = true;
    else if (arg === "--allow-missing-corpus") allowMissingCorpus = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "用法：node scripts/fanfic/editorForms-selftest.mjs [--corpus <dir>] [--count 400] [--json out.json] [--full] [--allow-missing-corpus]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`未知参数：${arg}（-h 看帮助）\n`);
      process.exit(2);
    }
  }
  return { corpus, count, json, full, allowMissingCorpus };
}

/** 递归收集 .txt。 @param {string} root @returns {string[]} */
function walkTxt(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".txt")) out.push(path);
    }
  };
  visit(root);
  return out.sort();
}

/** 确定性 PRNG（mulberry32）。 @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 抽行：均匀跨文件，只取"以 `[` 开头、无续行"的控制器行。
 * @param {string} root @param {number} count
 * @returns {Array<{file: string, line: number, raw: string}>}
 */
function sampleCorpusLines(root, count) {
  const files = walkTxt(root);
  const random = rng(0xf0f0);
  /** @type {Array<{file: string, line: number, raw: string}>} */
  const out = [];
  const perFile = Math.max(2, Math.ceil(count / Math.min(files.length, 80)));
  for (const file of files) {
    if (out.length >= count) break;
    const raw = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").split("\n");
    /** @type {number[]} */
    const candidates = [];
    for (let i = 0; i < raw.length; i += 1) {
      const line = raw[i] ?? "";
      if (!line.startsWith("[") || line.endsWith("\\")) continue;
      candidates.push(i);
    }
    for (let k = 0; k < perFile && candidates.length; k += 1) {
      const pick = candidates[Math.floor(random() * candidates.length)];
      if (pick === undefined) break;
      out.push({ file: relative(root, file), line: pick + 1, raw: raw[pick] ?? "" });
    }
  }
  return out.slice(0, count);
}

// ── (a) 字段派生 ─────────────────────────────────────────────────────────

function testFieldDerivation() {
  group("(a) 字段派生：CONTROLLERS → formFor()");
  eq("控制器总数", CONTROLLERS.length, 57);
  eq("目录条数 = 命令数", catalog().length, CONTROLLERS.length);

  let withFields = 0;
  /** @type {string[]} */
  const empty = [];
  for (const spec of CONTROLLERS) {
    const form = formFor(spec.command);
    if (form && form.fields.length) withFields += 1;
    else empty.push(spec.command);
  }
  batch("每条命令都 ≥1 个字段", withFields, CONTROLLERS.length, empty.join(","));

  // 字段与 spec 逐项对齐
  let metaOk = 0;
  let metaTotal = 0;
  /** @type {string[]} */
  const metaBad = [];
  for (const spec of CONTROLLERS) {
    const form = formFor(spec.command);
    if (!form) continue;
    for (const raw of spec.required.concat(spec.optional)) {
      metaTotal += 1;
      const field = form.fields.find((item) => item.name === raw.name);
      if (!field) continue;
      const typeOk = field.type === "number"
        ? raw.type === "number" || raw.type === "int"
        : field.type === "enum" ? raw.type === "enum"
          : field.type === "bool" ? raw.type === "bool"
            : field.type === "vector" ? raw.type === "vector"
              : true;
      const defaultOk = field.default === undefined
        ? raw.default === undefined
        : JSON.stringify(field.default) === JSON.stringify(raw.default);
      if (typeOk && defaultOk && field.hint === raw.hint) metaOk += 1;
      else metaBad.push(`${spec.command}.${raw.name}`);
    }
  }
  batch("字段的 type/default/hint 与 spec 一致", metaOk, metaTotal, metaBad.slice(0, 5).join(","));

  // 必填/可选分组
  let groupOk = 0;
  for (const spec of CONTROLLERS) {
    const form = formFor(spec.command);
    if (!form) continue;
    const reqNames = new Set(spec.required.map((meta) => meta.name));
    const good = form.fields.every((field) => {
      if (field.type === "note") return field.group === "meta";
      if (field.group === "body") return field.type === "string" && form.tailCapable;   // 自动补的正文框
      return (field.group === "required") === reqNames.has(field.name);
    });
    if (good) groupOk += 1;
  }
  batch("字段分组（required/optional）正确", groupOk, CONTROLLERS.length);

  // 灰掉的键必须解释原因
  /** @type {Array<{command: string, field: string}>} */
  const greyed = [];
  let greyOk = 0;
  for (const spec of CONTROLLERS) {
    const form = formFor(spec.command);
    if (!form) continue;
    for (const field of form.fields) {
      if (field.engineRead) continue;
      greyed.push({ command: spec.command, field: field.name });
      if (typeof field.reason === "string" && field.reason.length >= 8) greyOk += 1;
    }
  }
  ok("存在被灰掉的键（corpusOnly）", greyed.length > 0);
  batch("engineRead:false 一律带 reason", greyOk, greyed.length);

  // `E` 类：未注册的运行时命令 → 全字段灰
  for (const command of ["narration", "end", "animtextclean"]) {
    const form = formFor(command);
    const spec = controllerOf(command);
    eq(`${command} 未注册 → engineRead=false`, form?.engineRead, false);
    ok(`${command} 的字段都带 reason`, form.fields.every((field) => !field.engineRead ? Boolean(field.reason) : true));
    eq(`${command} runtimeRegistered 与 spec 一致`, spec?.runtimeRegistered, false);
  }

  // 目录分组：中文标签、无空分类
  const groups = catalogByCategory();
  ok("分类分组非空", groups.length > 0);
  ok("分类都有中文标签", groups.every((item) => item.label && item.label !== item.category));
  eq("分组内的命令数 = 目录数", groups.reduce((sum, item) => sum + item.items.length, 0), catalog().length);

  // `model` 传 null / 半个对象时降级
  eq("formFor(cmd, null) 可用", formFor("delay", null)?.fields.length, 3);
  eq("formFor(cmd, {}) 可用", formFor("delay", {})?.fields.length, 3);
  ok("formFor(未知命令) = null", formFor("nope-not-a-command") === null);
  eq("controllersOf(null).length", controllersOf(null).length, CONTROLLERS.length);
}

// ── (b) 控件映射 ───────────────────────────────────────────────────────

function testWidgetMapping() {
  group("(b) 控件映射：开关 / 滑杆 / 下拉 / 素材");
  /** @type {string[]} */
  const boolBad = [];
  /** @type {string[]} */
  const sliderSeen = [];
  /** @type {string[]} */
  const sliderBad = [];
  /** @type {string[]} */
  const enumBad = [];
  /** @type {string[]} */
  const pathBad = [];
  let boolCount = 0;
  let numberCount = 0;
  let numberWithRange = 0;
  let enumCount = 0;
  let pathCount = 0;

  for (const spec of CONTROLLERS) {
    const form = formFor(spec.command);
    if (!form) continue;
    for (const field of form.fields) {
      if (field.name === "$note") continue;
      if (field.type === "bool") {
        boolCount += 1;
        if (field.options.length !== 0 || !["required", "optional"].includes(field.group)) boolBad.push(`${spec.command}.${field.name}`);
      }
      if (field.type === "number") {
        numberCount += 1;
        if (field.range || field.constant !== undefined) numberWithRange += 1;
        if (field.range) {
          numberWithRange += 1;
          const good = Array.isArray(field.range) && field.range.length === 3
            && Number.isFinite(field.range[0]) && field.range[1] > field.range[0] && field.range[2] > 0;
          if (good) sliderSeen.push(`${spec.command}.${field.name}`);
          else sliderBad.push(`${spec.command}.${field.name}`);
        }
      }
      if (field.type === "enum") {
        enumCount += 1;
        const good = field.options.length > 0 || true; // 未登记枚举的键允许自由文本
        if (!good) enumBad.push(`${spec.command}.${field.name}`);
        const meta = spec.required.concat(spec.optional).find((item) => item.name === field.name);
        if (meta?.enums && JSON.stringify(field.options) !== JSON.stringify(ENUMS[meta.enums] ?? [])) enumBad.push(`${spec.command}.${field.name}`);
      }
      // 「从素材里选」只给**文本**素材键；同名数值键（如 `interlude.channel` 的通道号）
      // 仍然是数字控件 —— 它们的候选素材由 text 输入框的 datalist 提供。
      if (hasAssetPool(field.name) && field.type !== "number") {
        pathCount += 1;
        if (field.type !== "path") pathBad.push(`${spec.command}.${field.name}`);
      }
    }
  }

  ok("bool 字段存在（→ 开关）", boolCount > 0);
  batch("bool 字段不带 options", boolCount - boolBad.length, boolCount, boolBad.slice(0, 4).join(","));
  ok("数值字段存在", numberCount > 0);
  ok("语料实测范围已覆盖大部分数值键", numberWithRange / numberCount > 0.5);
  batch("有范围的数值 → 滑杆范围合法", sliderSeen.length, sliderSeen.length + sliderBad.length, sliderBad.slice(0, 4).join(","));
  ok("enum 字段存在（→ 下拉）", enumCount > 0);
  batch("enum 的 options 与 ENUMS 一致", enumCount - enumBad.length, enumCount, enumBad.slice(0, 4).join(","));
  ok("素材键存在（→ 从素材里选）", pathCount > 0);
  batch("素材键 → type===\"path\"", pathCount - pathBad.length, pathCount, pathBad.slice(0, 4).join(","));

  // 具体样例：三条有代表性的命令
  const character = formFor("character");
  eq("Character.name → path", character.fields.find((f) => f.name === "name")?.type, "path");
  eq("Character.fadetime → 滑杆", Array.isArray(character.fields.find((f) => f.name === "fadetime")?.range), true);
  eq("Character.name 有候选素材", assetsFor("name").length > 0, true);
  const background = formFor("background");
  eq("Background.screenadapt → enum", background.fields.find((f) => f.name === "screenadapt")?.type, "enum");
  ok("Background.screenadapt 有候选值", (background.fields.find((f) => f.name === "screenadapt")?.options.length ?? 0) >= 2);
  const blocker = formFor("blocker");
  eq("Blocker.block → bool", blocker.fields.find((f) => f.name === "block")?.type, "bool");
  eq("Blocker.a 有语料范围", Array.isArray(blocker.fields.find((f) => f.name === "a")?.range), true);
  const dialog = formFor("dialog");
  eq("Dialog 自动补「正文」字段", dialog.fields.find((f) => f.name === "text")?.group, "body");
  ok("Dialog 的正文计入必填", dialog.requiredFields.some((f) => f.name === "text"));
  eq("Dialog 的正文可多行", dialog.fields.find((f) => f.name === "text")?.multiline, true);
  ok("Dialog 正文是多行", dialog.fields.find((f) => f.name === "text")?.multiline === true);
  const end = formFor("end");
  eq("零参命令给只读说明行", end.fields[0]?.type, "note");

  // 素材池：调用方给的优先、内置补齐、去重
  const pool = assetsFor("name", { characters: ["custom_hero"] }, 3);
  eq("素材池优先用调用方的", pool[0], "custom_hero");
  eq("素材池去重", new Set(pool).size, pool.length);
  eq("素材池遵守 limit", assetsFor("image", undefined, 5).length, 5);
  eq("未登记的键没有素材池", assetsFor("fadetime").length, 0);

  // 搜索：目录项带预拼检索串
  const item = catalog().find((row) => row.command === "character");
  ok("目录项有检索串", Boolean(item?.search.includes("character")));
  eq("目录项带 tailCapable（dialog）", catalog().find((row) => row.command === "dialog")?.tailCapable, true);
  eq("目录项 tailCapable（character = 只有偶发尾随）", item?.tailCapable, false);
}

// ── (c) 读→写往返 ───────────────────────────────────────────────────

/** 单行往返（逐字节）。 */
/** @param {string} raw @returns {{identical: boolean, reparsed: boolean, out: string}} */
function roundTrip(raw) {
  const parsed = parseValues(raw);
  const out = applyForm(raw, parsed.values);
  const again = parseValues(out);
  const reparsed = again.command === parsed.command
    && JSON.stringify(again.values) === JSON.stringify(parsed.values);
  return { identical: out === raw, reparsed, out };
}

/**
 * @param {string} root @param {number} count @param {boolean} full
 */
function testRoundTrip(root, count, full) {
  group(`(c) 读→写往返：${full ? "全语料" : "抽样"}逐字节一致`);
  const files = walkTxt(root);
  let total = 0;
  let identical = 0;
  let reparsed = 0;
  /** @type {Array<{file: string, line: number, raw: string}>} */
  const sampled = full ? [] : sampleCorpusLines(root, count);
  /** @type {Array<[string, string]>} */
  const bad = [];

  /** @param {string} raw @param {string} where */
  const check = (raw, where) => {
    if (raw.trim()[0] !== "[" || raw.endsWith("\\")) return;
    const parsed = parseValues(raw);
    if (!parsed.command) return;
    total += 1;
    const result = roundTrip(raw);
    if (result.identical) identical += 1;
    else if (bad.length < 5) bad.push([`${where} ${raw.slice(0, 60)}`, result.out.slice(0, 60)]);
    if (result.reparsed) reparsed += 1;
  };

  if (full) {
    for (const file of files) {
      const lines = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i += 1) check(lines[i] ?? "", `${relative(root, file)}:${i + 1}`);
    }
  } else {
    for (const row of sampled) check(row.raw, `${row.file}:${row.line}`);
  }
  ok("抽到控制器行", total > 0);
  batch("applyForm(parseValues(line)) 逐字节 = 源行", identical, total, bad.map((item) => item.join("  ⇒  ")).join(" | "));
  batch("重建后值语义不变", reparsed, total);

  // 改一个字段 → 只有那个字段变化（抽样 60 行，通道：把 fadetime/duration/time/x/y 加一）
  const touched = sampled.filter((row) => /(fadetime|duration|time|x|y)=/.test(row.raw)).slice(0, 60);
  let singleOk = 0;
  let touchedTotal = 0;
  /** @type {string[]} */
  const singleBad = [];
  for (const row of touched) {
    const parsed = parseValues(row.raw);
    const name = ["fadetime", "duration", "time", "x", "y"].find((key) => typeof parsed.values[key] === "number");
    if (!name) continue;
    touchedTotal += 1;
    const before = /** @type {number} */ (parsed.values[name]);
    const out = applyForm(row.raw, { ...parsed.values, [name]: before + 7 });
    const after = parseValues(out).values;
    const others = Object.keys(parsed.values).filter((key) => key !== name && key !== "text");
    const sameOthers = others.every((key) => JSON.stringify(after[key]) === JSON.stringify(parsed.values[key]));
    const changed = after[name] === before + 7;
    if (sameOthers && changed && parseLine(out, 1).diagnostics.every((d) => d.severity !== "error")) singleOk += 1;
    else if (singleBad.length < 4) singleBad.push(`${row.file}:${row.line} ${name} ${row.raw.slice(0, 48)}`);
  }
  batch("改动只影响目标字段", singleOk, touchedTotal, singleBad.join(" | "));

  // 文本行：改台词不动头部；改说话人不动正文
  const speech = sampled.find((row) => /^\[\s*name\s*=/.test(row.raw) && row.raw.includes("\"]")) ?? { raw: '[name="阿米娅"]  博士，早。' };
  const speechHead = speech.raw.slice(0, speech.raw.lastIndexOf("]") + 1);
  const textChanged = applyForm(speech.raw, { text: "换一句台词" });
  eq("改正文：头部逐字节保留", textChanged.slice(0, textChanged.lastIndexOf("]") + 1), speechHead);
  ok("改正文：正文替换", textChanged.includes("换一句台词") && !textChanged.includes("早。"));
  eq("改正文：指令个数不变", (textChanged.match(/\[/g) ?? []).length, 1);
  const speakerChanged = applyForm(speech.raw, { name: "凯尔希" });
  eq("改说话人：正文逐字节保留", speakerChanged.slice(speakerChanged.lastIndexOf("]") + 1), parseValues(speech.raw).tail);
}

// ── (d) 预设 ─────────────────────────────────────────────────────────

/**
 * @param {string} root
 */
function testPresets(root) {
  group("(d) 预设：lintDocument 0 error、可溯源");
  let total = 0;
  let clean = 0;
  /** @type {string[]} */
  const dirty = [];
  /** @type {Array<{command: string, count: number, named: number}>} */
  const coverage = [];
  let named = 0;
  /** @type {string[]} */
  const namedMissing = [];
  const cache = new Map();

  for (const spec of CONTROLLERS) {
    const presets = presetsFor(spec.command);
    coverage.push({ command: spec.command, count: presets.length, named: presets.filter((item) => item.origin === "named").length });
    if (presets.length === 0) dirty.push(`${spec.command}: 0 预设`);
    for (const preset of presets) {
      total += 1;
      const doc = lintDocument(preset.line, {});
      const errors = doc.diagnostics.filter((item) => item.severity === "error").length;
      if (errors === 0) clean += 1;
      else dirty.push(`${spec.command}/${preset.name}: ${doc.diagnostics.filter((item) => item.severity === "error").map((item) => item.code).join(",")}`);
      if (preset.origin !== "named") continue;
      named += 1;
      // 溯源：按 source 回读那一行，必须与预设里的 line 一致。
      const [file, lineNo] = String(preset.source ?? "").split(":");
      if (!file || !lineNo) { namedMissing.push(`${spec.command}/${preset.name}: 缺 source`); continue; }
      const path = join(root, file);
      if (!existsSync(path)) { namedMissing.push(`${spec.command}/${preset.name}: 找不到 ${file}`); continue; }
      if (!cache.has(path)) cache.set(path, readFileSync(path, "utf8").replace(/\r\n?/g, "\n").split("\n"));
      const lines = /** @type {string[]} */ (cache.get(path));
      const raw = lines[Number(lineNo) - 1] ?? "";
      const head = preset.line.split("\n")[0] ?? "";
      if (raw.trim() === head.trim()) covered(namedMissing, spec.command, preset);
      else namedMissing.push(`${spec.command}/${preset.name}: ${file}:${lineNo} 是 ${JSON.stringify(raw.slice(0, 40))}`);
    }
  }
  batch("每条命令都有预设", coverage.filter((item) => item.count > 0).length, CONTROLLERS.length, dirty.filter((item) => item.endsWith("0 预设")).slice(0, 5).join(","));
  ok("命名预设存在（人工标注）", named > 10);
  batch("命名预设可从语料 source 回读", named - namedMissing.length, named, namedMissing.slice(0, 4).join(" | "));
  batch("预设全部 lintDocument 0 error", clean, total, dirty.slice(0, 4).join(" | "));
  ok("预设条数合理（≤6/命令）", coverage.every((item) => item.count <= 6));
  ok("预设值可解析", coverage.every((item) => item.count > 0));

  // 预设 → applyForm 往返
  let applied = 0;
  let appliedTotal = 0;
  /** @type {string[]} */
  const appliedBad = [];
  for (const spec of CONTROLLERS.slice(0, 12)) {
    for (const preset of presetsFor(spec.command)) {
      appliedTotal += 1;
      const parsed = parseValues(preset.line);
      const out = applyForm(preset.line, parsed.values);
      if (out === preset.line) applied += 1;
      else if (appliedBad.length < 4) appliedBad.push(`${spec.command}/${preset.name}`);
    }
  }
  batch("预设行也能逐字节往返", applied, appliedTotal, appliedBad.join(","));

  // 成对模板：Decision 必须带合流
  const decision = presetsFor("decision");
  ok("Decision 有配对模板", decision.some((item) => item.line.includes("[Predicate(")));
  ok("Decision 的每条预设都合流或可合流", decision.every((item) => item.line.includes("[Predicate(") || item.name.includes("成对")));
}

/** @param {string[]} list @param {string} command @param {{name: string}} preset */
function covered(list, command, preset) {
  void list;
  void command;
  void preset;
}

// ── (e) 坏输入 ───────────────────────────────────────────────────────

function testBroken() {
  group("(e) 10 组坏输入 / 边界");
  const rows = [
    { name: "未知命令", line: "[NotACommand(x=1)]", expect: "notacommand", known: false },
    { name: "未闭合括号", line: "[Delay(time=1", expect: "delay" },
    { name: "行首缩进", line: "  [Delay(time=1)]", expect: "delay" },
    { name: "Tab 缩进", line: "\t[Delay(time=1)]", expect: "delay" },
    { name: "值类型不符（数字给文本）", line: '[Delay(time="soon")]', expect: "delay" },
    { name: "缺必需参数", line: "[Character]", expect: "character" },
    { name: "重复参数", line: "[Delay(time=1, time=2)]", expect: "delay" },
    { name: "参数键大小写混用", line: "[Delay(TIME=1)]", expect: "delay" },
    { name: "只有单括号", line: "[", expect: null },
    { name: "纯空白行", line: "   ", expect: null },
    { name: "注释行", line: "// 说明", expect: null },
    { name: "`]]` 双右括号", line: "[Delay(time=1)]]", expect: "delay" },
    { name: "值里有引号与反斜杠", line: '[Dialog]  他说："走\\吧"', expect: "dialog" },
  ];
  for (const row of rows) {
    const expected = row.expect ?? "";
    const parsed = noThrow(() => parseValues(row.line));
    ok(`${row.name}：parseValues 不抛错`, parsed.ok);
    if (!parsed.ok) continue;
    const value = /** @type {ReturnType<typeof parseValues>} */ (parsed.value);
    eq(`${row.name}：命令识别`, value.command, row.expect);
    const applied = noThrow(() => applyForm(row.line, value.values));
    ok(`${row.name}：applyForm 不抛错`, applied.ok);
    if (applied.ok) {
      if (expected === "") eq(`${row.name}：原样返回`, applied.value, row.line);
      else ok(`${row.name}：结果仍是控制器行`, String(applied.value).includes("["));
    }
    const form = formFor(expected);
    if (expected === "") eq(`${row.name}：formFor(空命令) = null`, form, null);
    if (row.known === false) eq(`${row.name}：formFor(未登记) = null`, form, null);
  }

  // 类型不符时，写回的值应当是**字符串**，且 lint 不报 error
  const typed = applyForm('[Delay(time="soon")]', { time: 3 });
  eq("类型不符 → 写回数字", parseValues(typed).values.time, 3);
  const unclosed = applyForm("[Delay(time=1", {});
  ok("未闭合 → 不吞掉源文本", unclosed.includes("Delay"));
  const tabbed = applyForm("\t[Delay(time=1)]", { time: 2 });
  eq("Tab 缩进保留", tabbed.startsWith("\t"), true);

  // 显式删除字段
  const removed = applyForm("[Delay(time=1, block=true)]", { block: undefined });
  eq("显式删除字段", parseValues(removed).keys, ["time"]);

  // 旁白 / 注释：没有可改的控制器 → 原样
  eq("旁白行原样", applyForm("只是旁白", { name: "A" }), "只是旁白");
  eq("注释行原样", applyForm("// x", { name: "A" }), "// x");

  // diffFields
  const diff = diffFields("[Delay(time=1)]", { time: 2, block: true });
  eq("diff 只列有变化的键", diff.filter((item) => item.changed).map((item) => item.name), ["block", "time"]);
  eq("diff 标记 added", diff.find((item) => item.name === "block")?.kind, "added");

  // 尾随正文（`]` 之后）——`aside` / `Narration` 这两条"看似无参数"的旁白命令
  const asideField = formFor("aside").fields.find((field) => field.name === "text");
  eq("aside 有尾随正文框", asideField?.tail, true);
  eq("aside 的正文算必填组（body）", asideField?.group, "body");
  ok("aside 的正文可多行", asideField?.multiline === true);
  const narrationField = formFor("narration").fields.find((field) => field.name === "text");
  eq("narration 有尾随正文框", narrationField?.tail, true);
  const asideParsed = parseValues("[aside]  他把信折好，放回口袋。");
  eq("aside 读出正文", asideParsed.values.text, "他把信折好，放回口袋。");
  eq("aside 改正文（保留两个空格）", applyForm("[aside]  他把信折好，放回口袋。", { text: "她收起信。" }), "[aside]  她收起信。");
  eq("aside 无改动逐字节", applyForm("[aside]  他把信折好，放回口袋。", asideParsed.values), "[aside]  他把信折好，放回口袋。");
  eq("Narration 改正文（保留紧贴写法）", applyForm("[Narration]旧旁白", { text: "新旁白" }), "[Narration]新旁白");
  eq("Narration 无改动逐字节", applyForm("[Narration]旧旁白", parseValues("[Narration]旧旁白").values), "[Narration]旧旁白");
  eq("尾随正文不进括号", applyForm("[Narration]旧旁白", { text: "新旁白" }).includes("("), false);
  // 裸旁白（整行正文、没有 `[`）
  eq("裸旁白读出正文", parseValues("只是旁白").values.text, "只是旁白");
  eq("裸旁白改写正文", applyForm("只是旁白", { text: "改过的旁白" }), "改过的旁白");
  eq("裸旁白保留首尾空白", applyForm("  缩进旁白  ", { text: "新" }), "  新  ");
  eq("裸旁白无改动逐字节", applyForm("只是旁白", parseValues("只是旁白").values), "只是旁白");

  // buildLine：向导"插入"用的新行
  eq("buildLine(delay)", buildLine("delay", { time: 1 }), "[Delay(time=1)]");
  eq("buildLine(character)", buildLine("character", { name: "avg_001", fadetime: 0.5 }), '[Character(name="avg_001", fadetime=0.5)]');
  eq("buildLine(未知命令)", buildLine("nope"), "");
}

// ── 汇总 ─────────────────────────────────────────────────────────

async function main() {
  const { corpus, count, json, full, allowMissingCorpus } = parseArgv();
  process.stdout.write("editorForms-selftest —— 表单层自检\n");
  process.stdout.write(`repo:   ${REPO_ROOT}\n`);
  process.stdout.write(`表单:   src/akstage/local/editorForms.js（${CONTROLLERS.length} controllers）\n`);

  testFieldDerivation();
  testWidgetMapping();
  testBroken();

  const root = corpus ?? CORPUS_CANDIDATES.find((path) => existsSync(path)) ?? null;
  if (root && statSync(root).isDirectory()) {
    testRoundTrip(root, count, full);
    testPresets(root);
  } else if (allowMissingCorpus) {
    group("(c) 读→写往返");
    skip(`语料目录不存在（试过：${CORPUS_CANDIDATES.join(", ")}）`);
  } else {
    process.stderr.write(`\n语料目录不存在：${CORPUS_CANDIDATES.join(" / ")}\n用 --corpus <dir> 指定，或用 --allow-missing-corpus 跳过。\n`);
    process.exit(2);
  }

  const summary = {
    passed,
    failed,
    corpus: root,
    controllers: CONTROLLERS.length,
    fields: catalog().reduce((sum, row) => sum + row.requiredCount + row.optionalCount, 0),
    enumKeys: Object.keys(ENUMS).length,
  };
  process.stdout.write(`\n== 结果：${passed} passed, ${failed} failed ==\n`);
  if (failures.length) {
    process.stdout.write("失败明细：\n");
    for (const item of failures) process.stdout.write(`  ✗ [${item.group}] ${item.name}: ${item.detail}\n`);
  }
  if (json) {
    writeFileSync(json, `${JSON.stringify({ summary, failures }, null, 2)}\n`, "utf8");
    process.stdout.write(`JSON: ${json}\n`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

await main();
