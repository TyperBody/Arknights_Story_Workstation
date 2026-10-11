// arkstage 编辑器「区域缩进」内核自检（offline, zero-dependency）。
//
//   node scripts/fanfic/editorIndent-selftest.mjs
//
// 断言 task-2 的语义（用户原话「编辑器编码页面 大多数是字符 不方便中文用户入手 …
// 希望增加区域缩进」）：
//   (a) 编辑器容忍行首空白：缩进版与顶格版 `parseScript` / `blocksOf` 给出
//       **同一** kind（+controller）序列；`raw` 保留原样、`leading` 挂出；
//       缩进惯例 = **1 个 Tab**（`tabSize = 8`）⇒ 纯 Tab 无 100C；
//       "Tab 后跟空格"（混排）才有提示级 `UseSpaceInsteadTab`。
//   (b) 缩进版 lint 无 `NarrationLine`；缩进版与顶格版诊断（码/行/消息）
//       逐条一致（8 列制表位），只差整体 span 偏移。
//   (c) 送引擎归一化：`storyPack.stripIndentForEngine` / `library.stripControls`
//       把缩进版还原成与顶格版**逐字节相等**的引擎脚本文本（旁白行/续行原样）；
//       demo runtime 的 `story.script` 缩进一版也对拍通过。
//   (d) `buildHook` 的 `story.script` = 归一化文本；`revision` 与顶格版一致。
//   (e) `indentLines` 区间缩进/反缩进：Tab 一级、缩进先对齐到 tab stop、
//       反缩进回上一个 tab stop、往返幂等、只动行首空白、`options.unit` 兼容。
//   (f) `regionIndentPlan` 幂等、`[Decision]`/`[Predicate]`/线路体层级正确，
//       且作用后 `blocksOf` 结构（kind + controller）不变、lint 无 NarrationLine。
//
// 退出码：0 = 全部通过；1 = 有断言失败。
// 契约见 `docs/fanfic/README.md`「区域缩进」；内核在
// `src/akstage/local/{storyPack,editorModel,library}.js`。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DIAGNOSTIC_CODES,
  INDENT_UNIT,
  blocksOf,
  indentLines,
  lintDocument,
  parseLine,
  regionIndentPlan,
} from "../../src/akstage/local/editorModel.js";
import {
  parseLine as dslParseLine,
  parseScript,
  stripIndent,
  stripIndentForEngine,
} from "../../src/akstage/local/storyPack.js";
import { buildHook, cleanTags, stripControls } from "../../src/akstage/local/library.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const RUNTIME_PATH = join(REPO_ROOT, "example/fanfic/demo/build/runtime.json");

// ── 极简断言框架（与 editor-selftest.mjs 同形） ─────────────────────────

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

// ── 样例（用户贴的那份：`[Decision]`/`[Predicate]` 分支体） ────────────

/** 顶格版（引擎直接可播）。 */
const FLAT = [
  '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
  '[Background(image="bg_black", x=0, y=0, fadetime=0, block=true)]',
  '[charslot(slot="m", name="char_130_doberm_ex", duration=0.5)]',
  '[name="杜宾"]  这里是……？',
  '[Decision(options="跟着她走;先问清楚", values="1;2")]',
  '[Predicate(references="1")]',
  '[charslot(slot="m", name="char_002_amiya_1#1", duration=0.5)]',
  '[name="阿米娅"]  这边走，博士。',
  '[Predicate(references="2")]',
  '[name="阿米娅"]  先别急，我把情况说清楚。',
  '[End]',
].join("\n");

/** 手写缩进版：Decision 顶格、Predicate 一级、线路体两级（一条线用 Tab）。 */
const INDENTED = [
  '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
  '[Background(image="bg_black", x=0, y=0, fadetime=0, block=true)]',
  '[charslot(slot="m", name="char_130_doberm_ex", duration=0.5)]',
  '[name="杜宾"]  这里是……？',
  '[Decision(options="跟着她走;先问清楚", values="1;2")]',
  `${INDENT_UNIT}[Predicate(references="1")]`,
  `${INDENT_UNIT}${INDENT_UNIT}[charslot(slot="m", name="char_002_amiya_1#1", duration=0.5)]`,
  `${INDENT_UNIT}${INDENT_UNIT}[name="阿米娅"]  这边走，博士。`,
  `${INDENT_UNIT}[Predicate(references="2")]`,
  `\t[name="阿米娅"]  先别急，我把情况说清楚。`,
  "[End]",
].join("\n");

/** 续行（行尾 `\`，官方 `[FocusParam]` 写法）+ 真旁白行。 */
const CONTINUATION_FLAT = [
  '[FocusParam(target="x", \\',
  'animStyle="Highlight", \\',
  'protectTime=0.5)]',
  '    这是缩进的旁白',
  '',
].join("\n");

/** 同上，但指令三行**逐行缩进**（旁白行保持）。 */
const CONTINUATION_INDENTED = [
  `${INDENT_UNIT}[FocusParam(target="x", \\`,
  `${INDENT_UNIT}animStyle="Highlight", \\`,
  `${INDENT_UNIT}protectTime=0.5)]`,
  '    这是缩进的旁白',
  '',
].join("\n");

/** demo runtime 的 story.script（应用真正喂给引擎的形态）。 */
let DEMO_SCRIPT = "";
try {
  DEMO_SCRIPT = String(JSON.parse(readFileSync(RUNTIME_PATH, "utf8"))?.story?.script ?? "");
} catch {
  DEMO_SCRIPT = "";
}

/** 结构签名：kind + controller（`parseScript` / `blocksOf` 共用）。 */
/** @param {Array<{kind: string, controller?: string|null, command?: string|null}>} rows */
const sig = (rows) => rows.map((row) => (row.kind === "dialogue" ? "dialogue:dialog" : `${row.kind}:${row.controller ?? row.command ?? ""}`)).join(" ");

/** 诊断签名：码/行/严重度/消息（不含 span —— 缩进版整体平移是预期的）。 */
/** @param {Array<{code: number, line: number, message: string, name: string, severity: string}>} list */
const diagSig = (list) => list.map((d) => `${d.name}#${d.line}#${d.severity}#${d.message}`);

/** 去掉"行首缩进级别"之外的所有诊断（用于缩进版 vs 顶格版逐条对拍）。 */
/** @param {Array<{name: string}>} list */
const routeSig = (list) => list.filter((d) => d.name !== "UseSpaceInsteadTab" || true);

// ── (a) 解析容忍 ────────────────────────────────────────────────────────

group("(a) 解析容忍：缩进版 = 顶格版（kind/controller 序列一致）");

{
  const flatRows = parseScript(FLAT).map((l) => ({ kind: l.kind, controller: l.kind === "dialogue" ? "dialog" : l.command }));
  const indentRows = parseScript(INDENTED).map((l) => ({ kind: l.kind, controller: l.kind === "dialogue" ? "dialog" : l.command }));
  eq("parseScript 行数一致", indentRows.length, flatRows.length);
  eq("storyPack parseScript 序列一致（缩进 vs 顶格）", sig(indentRows), sig(flatRows));
  eq("blocksOf 序列一致（缩进 vs 顶格）", sig(blocksOf(INDENTED)), sig(blocksOf(FLAT)));

  const rawLines = INDENTED.split("\n");
  const parsed = parseScript(INDENTED);
  ok("parseScript 的 raw 保留行首空白", parsed[5].raw === rawLines[5]);
  eq("parseScript 的 leading = 行首空白", parsed[5].leading, INDENT_UNIT);
  eq("Tab 缩进的 leading", parsed[9].leading, "\t");

  const one = dslParseLine('  [Delay(time=1)]', 7);
  eq("storyPack.parseLine 缩进行 → command", [one.kind, one.command], ["command", "delay"]);
  eq("storyPack.parseLine 的 raw/leading", [one.raw, one.leading], ["  [Delay(time=1)]", "  "]);
  const narr = dslParseLine("    裸旁白", 8);
  eq("storyPack.parseLine 旁白行保留 raw", [narr.kind, narr.raw, narr.leading], ["narration", "    裸旁白", "    "]);

  const editorLine = parseLine('  [Delay(time=1)]', 7);
  eq("editorModel.parseLine 缩进行 → command", [editorLine.kind, editorLine.controller], ["command", "delay"]);
  ok("editorModel.parseLine 缩进行无 error", !editorLine.diagnostics.some((d) => d.severity === "error"));

  // Tab 缩进行也算命令；Tab = **惯例**（`tabSize = 8`）→ 只在
  // "Tab 后面又跟空格"（混排）时给提示级 `UseSpaceInsteadTab`。
  const tabLine = parseLine('\t[Delay(time=1)]', 9);
  eq("Tab 缩进行 → command", [tabLine.kind, tabLine.controller], ["command", "delay"]);
  eq("纯 Tab 缩进无 UseSpaceInsteadTab（Tab 就是惯例）", tabLine.diagnostics.filter((d) => d.name === "UseSpaceInsteadTab").length, 0);
  eq("纯 Tab 缩进无 BadIndentation", tabLine.diagnostics.filter((d) => d.name === "BadIndentation").length, 0);
  ok("Tab 缩进行没有 error", !tabLine.diagnostics.some((d) => d.severity === "error"));

  const mixedLine = parseLine('\t  [Delay(time=1)]', 9);
  const mixedDiag = mixedLine.diagnostics.filter((d) => d.name === "UseSpaceInsteadTab");
  eq("Tab 后跟空格（混排）→ UseSpaceInsteadTab（提示级）", mixedDiag.map((d) => d.severity), ["warning"]);
  eq("混排 span 指向 Tab 后的空格", [mixedDiag[0].from, mixedDiag[0].to], [1, 3]);
  ok("混排行没有 error", !mixedLine.diagnostics.some((d) => d.severity === "error"));

  // 带 @tag 的缩进行：`label=@tag` 形态（控制位就是 `name` 参数的别名）。
  const tagged = parseLine('  [charslot(slot="m", name="char_002_amiya_1#1", duration=0.5)]', 3);
  eq("@tag 缩进行 → command charslot", [tagged.kind, tagged.controller], ["command", "charslot"]);
  ok("@tag 缩进行无 error", !tagged.diagnostics.some((d) => d.severity === "error"));

  // 行首空格不在 8 列制表位上：0x1019 提示级（惯例 = 1 个 Tab = 8 列一级）
  const odd = parseLine("   [Delay(time=1)]", 4);
  eq("三格缩进 → BadIndentation（提示级）", odd.diagnostics.filter((d) => d.name === "BadIndentation").map((d) => [d.severity, d.from, d.to]), [["warning", 0, 3]]);
  eq("BadIndentation 码 = 0x1019", DIAGNOSTIC_CODES.BadIndentation, 0x1019);
  eq("两格缩进 → BadIndentation（不是 8 的整倍数）", parseLine("  [Delay(time=1)]", 4).diagnostics.some((d) => d.name === "BadIndentation"), true);
  eq("8 格缩进无 BadIndentation", parseLine("        [Delay(time=1)]", 4).diagnostics.some((d) => d.name === "BadIndentation"), false);
  eq("Tab 缩进走 100C 不走 1019", parseLine('\t[Delay(time=1)]', 4).diagnostics.some((d) => d.name === "BadIndentation"), false);
}

// ── (b) 诊断 ────────────────────────────────────────────────────────

group("(b) 诊断：缩进版 lint 无 NarrationLine");

{
  const flatLint = lintDocument(FLAT);
  const indentedLint = lintDocument(INDENTED);
  eq("缩进版无 NarrationLine", indentedLint.diagnostics.filter((d) => d.name === "NarrationLine").length, 0);
  eq("顶格版也无 NarrationLine", flatLint.diagnostics.filter((d) => d.name === "NarrationLine").length, 0);
  eq("缩进版 stats.lines = 顶格版", indentedLint.stats.lines, flatLint.stats.lines);
  eq("缩进版 decisions/combos = 顶格版", [indentedLint.stats.decisions, indentedLint.stats.combos], [flatLint.stats.decisions, flatLint.stats.combos]);
  eq("缩进版 controllers = 顶格版", indentedLint.stats.controllers, flatLint.stats.controllers);
  // Tab 是惯例：整篇诊断**逐条一致**（`UseSpaceInsteadTab` 只给「Tab 后跟空格」的混排）。
  eq("缩进版诊断 = 顶格版（Tab 缩进不再多提示）", diagSig(indentedLint.diagnostics), diagSig(flatLint.diagnostics));
  eq("缩进版没有 UseSpaceInsteadTab（纯 Tab 缩进）", indentedLint.diagnostics.filter((d) => d.name === "UseSpaceInsteadTab").length, 0);

  // span：缩进版 = 顶格版 + shift（同一行只差整体偏移；`BadIndentation` 只在
  // 「空格不在 8 列制表位」时出现，所以这里用 8 格缩进对齐）。
  const flatPixel = parseLine('[Delay(time=1)]bogus(x=1)', 5).diagnostics.map((d) => [d.name, d.from, d.to]);
  const indPixel = parseLine('        [Delay(time=1)]bogus(x=1)', 5).diagnostics.map((d) => [d.name, d.from, d.to]);
  ok("缩进行诊断 span = 顶格行 + shift（8 格 = 1 个 tab stop）", JSON.stringify(indPixel.map(([n, f, t]) => [n, f - 8, t - 8])) === JSON.stringify(flatPixel));
  ok("诊断 span 落在行内", indPixel.every(([, f, t]) => f >= 0 && f < t && t <= '        [Delay(time=1)]bogus(x=1)'.length));
  eq("8 格缩进行没有 BadIndentation", parseLine('        [Delay(time=1)]bogus(x=1)', 5).diagnostics.filter((d) => d.name === "BadIndentation").length, 0);

  const contLint = lintDocument(CONTINUATION_INDENTED);
  const contFlat = lintDocument(CONTINUATION_FLAT);
  // 续行版本里第 4 行是**真旁白**（行首空白属于展示文本）→ 仍报 NarrationLine。
  const contOnly = (text) => text.split("\n").slice(0, 3).join("\n");
  eq("续行缩进版：指令部分无 NarrationLine", lintDocument(contOnly(CONTINUATION_INDENTED)).diagnostics.filter((d) => d.name === "NarrationLine").length, 0);
  eq("续行缩进版：真旁白行保留 NarrationLine（1 条）", contLint.diagnostics.filter((d) => d.name === "NarrationLine").length, 1);
  // 续行物理行**带行首缩进**（`\t[Tutorial(…, \` 的下一行）时，`parseLine` 看不到
  // 上一行 → 会在这一行报 `UseTabInsteadSpace`（参数表内的 Tab，提示级）。
  // 这不是"缩进"的锅：拼行后由引擎的 `commandRegex` 照播（`stripIndentForEngine`
  // 只去**行首**空白）。所以只对拍"去掉该提示"的签名（与 task-2 口径一致）。
  const stripTab = (list) => list.filter((d) => !(d.name === "UseTabInsteadSpace" && d.message.includes("参数表内用了 Tab")));
  eq("续行缩进版诊断（去 100B）= 顶格版", diagSig(stripTab(contLint.diagnostics)), diagSig(stripTab(contFlat.diagnostics)));
  eq("顶格续行版没有 100B", contFlat.diagnostics.filter((d) => d.name === "UseTabInsteadSpace").length, 0);

  // 旁白行被缩进 = 仍是旁白（NarrationLine 保留：它就是展示文本）
  ok("缩进旁白行仍报 NarrationLine", parseLine("    裸旁白", 2).diagnostics.some((d) => d.name === "NarrationLine"));
}

// ── (c) 送引擎归一化 ────────────────────────────────────────────────

group("(c) 归一化：stripIndentForEngine / stripControls 送引擎前文本");

{
  eq("stripIndentForEngine(缩进版) = 顶格版（逐字节）", stripIndentForEngine(INDENTED), FLAT);
  eq("stripIndent 去空格", stripIndent("  [Delay(time=1)]"), "[Delay(time=1)]");
  eq("stripIndent 去 Tab", stripIndent("\t[Delay(time=1)]"), "[Delay(time=1)]");
  eq("stripIndent 旁白行原样", stripIndent("  裸旁白"), "  裸旁白");
  eq("stripIndent 只吃行首空白（正文不动）", stripIndent('  [name="x"]  正文  '), '[name="x"]  正文  ');
  eq("stripIndentForEngine：续行后的物理行保留两格（旁白同）", stripIndentForEngine(CONTINUATION_INDENTED),
    `[FocusParam(target="x", \\\n${INDENT_UNIT}animStyle="Highlight", \\\n${INDENT_UNIT}protectTime=0.5)]\n    这是缩进的旁白\n`);
  eq("stripIndentForEngine(continuation-flat) 恒等", stripIndentForEngine(CONTINUATION_FLAT), CONTINUATION_FLAT);
  eq("stripControls 去 @tag 再去缩进", stripControls('  [Character@left(name="x")]'), '[Character(name="x")]');
  eq("cleanTags 只去 @tag（保留缩进）", cleanTags('  [Character@left(name="x")]'), '  [Character(name="x")]');
  eq("stripControls 对顶格 demo 脚本是恒等", DEMO_SCRIPT ? stripControls(DEMO_SCRIPT) : "", DEMO_SCRIPT);

  if (DEMO_SCRIPT) {
    const demoIndented = regionIndentPlan(DEMO_SCRIPT).text;
    eq("demo：缩进版归一化 = 顶格 demo（逐字节）", stripIndentForEngine(demoIndented), DEMO_SCRIPT);
    eq("demo：stripControls(缩进版) = stripControls(顶格版)", stripControls(demoIndented), stripControls(DEMO_SCRIPT));
    ok("demo 脚本含 Decision/Predicate", /\[Decision/.test(DEMO_SCRIPT) && /\[Predicate/.test(DEMO_SCRIPT));
  } else {
    eq("demo runtime 可读（story.script 存在）", DEMO_SCRIPT.length > 0, true);
  }

  // 归一化的两条不变量：行数不变；只有 `[` 开头的行被改。
  const engineLines = stripIndentForEngine(INDENTED).split("\n");
  const sourceLines = INDENTED.split("\n");
  ok("归一化不改行数", engineLines.length === sourceLines.length);
  ok("归一化后没有行首空白", engineLines.every((line) => !/^[ \t]/.test(line)));
  ok("归一化只改 `[` 开头的行（旁白原样）", stripIndentForEngine("x\n  裸旁白").split("\n")[1] === "  裸旁白");
  ok("归一化可重复应用（幂等）", stripIndentForEngine(stripIndentForEngine(INDENTED)) === stripIndentForEngine(INDENTED));

  // 续行拼掉后：引擎看到的正文与顶格版相同（`\` 直接拼接，缩进进了参数表但
  // `parseArgs` 会 trim 每个键值 → 参数值一致）。
  const paramsOf = (text) => {
    const line = stripIndentForEngine(text).split("\n").slice(0, 3).join("").replace(/\\/g, "");
    return parseLine(line, 1).params.map((p) => [p.key, String(p.value)]);
  };
  eq("续行拼接后参数值与顶格版一致", paramsOf(CONTINUATION_INDENTED), paramsOf(CONTINUATION_FLAT));
  ok("续行拼接后参数值与顶格版都非空", paramsOf(CONTINUATION_FLAT).length > 0);
}

// ── (d) buildHook（送引擎的 hook） ────────────────────────────────

group("(d) buildHook：story.script 归一化、revision 与顶格版一致");

{
  const pack = (script) => ({ id: "fanfic-demo", script, assets: {}, patches: {}, runtime: null });
  const upstream = { bundle: { entry: "x", prelude: [], modules: [], styles: [], data: {} } };
  const flatHook = buildHook(pack(FLAT), upstream);
  const indentHook = buildHook(pack(INDENTED), upstream);
  ok("buildHook 返回 hook", Boolean(flatHook && indentHook));
  eq("story.script = 归一化文本（缩进版）", indentHook.story.script, flatHook.story.script);
  eq("story.script 逐字节 = stripIndentForEngine(缩进版)", indentHook.story.script, stripIndentForEngine(INDENTED));
  eq("revision 与顶格版一致", indentHook.revision, flatHook.revision);
  eq("story.title = pack.id", indentHook.story.title, "fanfic-demo");

  const tagged = buildHook(pack(`${INDENT_UNIT}[Character@left(name="x")]\n${INDENT_UNIT}[Delay(time=1)]\n[End]\n`), upstream);
  eq("buildHook 同时去 @tag 与缩进", tagged.story.script, '[Character(name="x")]\n[Delay(time=1)]\n[End]\n');
  eq("buildHook 不改旁白行", buildHook(pack("  裸旁白\n"), upstream).story.script, "  裸旁白\n");
}

// ── (e) indentLines ────────────────────────────────────────────

group("(e) indentLines：Tab 一级 + tab-stop 对齐（往返幂等）");

{
  const text = "a\nb\nc\nd";
  const one = indentLines(text, 2, 3, "indent");
  eq("缩进第 2 行（一级 = 1 个 Tab）", one.text, "a\n\tb\nc\nd");
  eq("caret 原样返回选区", one.caret, { from: 2, to: 3 });
  eq("缩进行数", one.lines, 1);
  eq("反缩进回到原文（往返幂等）", indentLines(one.text, 2, 3, "outdent").text, text);

  const two = indentLines(text, 2, 5, "indent");
  eq("跨行选区：两行都缩进（按全部缩进）", two.text, "a\n\tb\n\tc\nd");
  eq("direction=-1 等价 outdent", indentLines(two.text, 2, 7, -1).text, text);
  eq("direction=+1 等价 indent", indentLines("a\nb", 2, 3, 1).text, "a\n\tb");

  const back1 = indentLines("a\n\tb\n\tc\nd", 2, 7, "outdent");
  eq("多行选择时两行都反缩进", back1.text, text);
  eq("反缩进 = 每行回上一个 tab stop（`\\t\\t` → `\\t`）", indentLines("a\n\tb\n\t\tc\nd", 2, 9, "outdent").text, "a\nb\n\tc\nd");

  eq("from/to 反序自动交换", indentLines("a\nb\nc", 4, 2, "indent").text, "a\n\tb\nc");
  eq("选区贴到行尾也含整行", indentLines("a\nb\nc", 2, 2, "indent").text, "a\n\tb\nc");
  eq("选区从行首开始只算该行", indentLines("a\nb\nc", 0, 0, "indent").text, "\ta\nb\nc");
  eq("选区到下一行行首不含下一行", indentLines("a\nb\nc", 0, 2, "indent").text, "\ta\nb\nc");

  eq("顶格行反缩进 = 原样", indentLines("a\nb", 2, 3, "outdent").text, "a\nb");
  eq("Tab 缩进行反缩进（一级 = 1 个 Tab）", indentLines("a\n\tb", 2, 4, "outdent").text, "a\nb");
  eq("纯空格缩进（1…8 格）反缩进回顶格", indentLines("a\n    b", 2, 7, "outdent").text, "a\nb");
  eq("Tab+2 空格（10 列）反缩进回 tab stop（8 列）", indentLines("a\n\t  b", 2, 6, "outdent").text, "a\n\tb");

  // 缩进：行首缩进不在 tab stop 上 → 先补空格对齐、再插 Tab
  eq("6 列缩进后按 tab stop 对齐（补 2 空格再 Tab）", indentLines("a\n      b", 2, 9, "indent").text, "a\n        \tb");
  eq("缩进不改行尾空白", indentLines("a\nb  ", 2, 3, "indent").text, "a\n\tb  ");
  eq("选区含空行：空行也缩进", indentLines("a\n\nb", 0, 4, "indent").text, "\ta\n\t\n\tb");
  eq("空行缩进后可原样还原", indentLines("\ta\n\t\n\tb", 0, 8, "outdent").text, "a\n\nb");

  const literal = 'a\n[name="x"]  两个空格正文\nb';
  const literalOne = indentLines(literal, 2, literal.length, "indent").text;
  eq("缩进不改正文里的空格数", literalOne.split("\n")[1], '\t[name="x"]  两个空格正文');
  eq("往返幂等", indentLines(literalOne, 2, literalOne.length, "outdent").text, literal);
  const quoted = '[Delay(time=1)]  a  b   c';
  eq("字符串/正文内部的连续空格原样", indentLines(quoted, 0, quoted.length, "indent").text, `\t${quoted}`);

  // options：`tabSize` / `unit` 覆盖（旧的两空格调用逐字节可用）
  eq("options.tabSize=4 决定对齐网格", indentLines("a\n  b", 2, 5, "indent", { tabSize: 4 }).text, "a\n    \tb");
  eq("options.unit=\"  \" 兼容两空格（缩进）", indentLines("a\nb", 2, 3, "indent", { unit: "  " }).text, "a\n  b");
  eq("options.unit=\"  \" 兼容两空格（反缩进）", indentLines("a\n    b", 2, 7, "outdent", { unit: "  " }).text, "a\n  b");
}

// ── (f) regionIndentPlan ─────────────────────────────────────────

group("(f) regionIndentPlan：层级正确 + 幂等 + blocksOf 结构不变");

{
  const plan = regionIndentPlan(FLAT);
  const expected = [
    '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
    '[Background(image="bg_black", x=0, y=0, fadetime=0, block=true)]',
    '[charslot(slot="m", name="char_130_doberm_ex", duration=0.5)]',
    '[name="杜宾"]  这里是……？',
    '[Decision(options="跟着她走;先问清楚", values="1;2")]',
    `${INDENT_UNIT}[Predicate(references="1")]`,
    INDENT_UNIT.repeat(2) + '[charslot(slot="m", name="char_002_amiya_1#1", duration=0.5)]',
    `${INDENT_UNIT.repeat(2)}[name="阿米娅"]  这边走，博士。`,
    `${INDENT_UNIT}[Predicate(references="2")]`,
    `${INDENT_UNIT.repeat(2)}[name="阿米娅"]  先别急，我把情况说清楚。`,
    "[End]",
  ].join("\n");
  eq("regionIndentPlan(flat) 层级正确（Decision 顶格 / Predicate 一级 / 线路体两级）", plan.text, expected);
  eq("plan 行数 = 输入行数", plan.lines, FLAT.split("\n").length);
  const again = regionIndentPlan(plan.text);
  eq("regionIndentPlan 幂等", again.text, plan.text);
  eq("幂等后 changed = 0", again.changed, 0);

  const lines = plan.text.split("\n");
  const width = (line) => (/^[ \t]*/.exec(line)?.[0] ?? "").length;
  eq("Decision 顶格", width(lines[4]), 0);
  eq("Predicate#1 一级", width(lines[5]), INDENT_UNIT.length);
  eq("线路体两级（charslot）", width(lines[6]), INDENT_UNIT.length * 2);
  eq("线路体两级（name）", width(lines[7]), INDENT_UNIT.length * 2);
  eq("Predicate#2 回到一级", width(lines[8]), INDENT_UNIT.length);
  eq("第二条线路体两级", width(lines[9]), INDENT_UNIT.length * 2);
  eq("End 顶格", width(lines[10]), 0);

  eq("blocksOf(缩进计划) 结构不变", sig(blocksOf(plan.text)), sig(blocksOf(FLAT)));
  eq("lint(缩进计划) 无 NarrationLine", lintDocument(plan.text).diagnostics.filter((d) => d.name === "NarrationLine").length, 0);
  eq("lint(缩进计划) 与顶格同诊断签名", diagSig(lintDocument(plan.text).diagnostics), diagSig(lintDocument(FLAT).diagnostics));
  eq("归一化(plan) = 顶格版（逐字节）", stripIndentForEngine(plan.text), FLAT);

  // 手写缩进版（含 Tab）再跑一遍：plan 归一到两空格
  const replan = regionIndentPlan(INDENTED);
  eq("plan 幂等（Tab 版输入）", regionIndentPlan(replan.text).text, replan.text);
  eq("plan 后 Tab 缩进 → 空格", replan.text.split("\n")[9].startsWith(INDENT_UNIT.repeat(2) + "[name="), true);
  eq("plan 后全部行首是 2 的倍数空格", replan.text.split("\n").every((line) => /^( {2})*/.test(line)), true);
  eq("plan 后归一化与手写版一致", stripIndentForEngine(replan.text), stripIndentForEngine(INDENTED));
  eq("plan 后 blocksOf 结构不变（Tab 版）", sig(blocksOf(replan.text)), sig(blocksOf(INDENTED)));

  // 合流 Predicate（references 覆盖全部 values）也按线路头处理
  const merged = regionIndentPlan(`${FLAT}\n[Predicate(references="1;2")]\n[name="阿米娅"]  收束。`);
  const mergedLines = merged.text.split("\n");
  eq("合流 Predicate 一级", (/^[ \t]*/.exec(mergedLines[11])?.[0] ?? "").length, INDENT_UNIT.length);
  eq("合流后的体两级", (/^[ \t]*/.exec(mergedLines[12])?.[0] ?? "").length, INDENT_UNIT.length * 2);

  // EOF 收束：最后一条线路体不越界
  const eof = regionIndentPlan('[Decision(options="a;b", values="1;2")]\n[Predicate(references="1")]\n[name="A"]  一\n[Predicate(references="2")]\n[name="B"]  二');
  eq("EOF 前的线路体仍是两级", eof.text.split("\n")[4], `${INDENT_UNIT.repeat(2)}[name="B"]  二`);
  eq("EOF 版幂等", regionIndentPlan(eof.text).text, eof.text);

  // demo runtime 脚本（应用真正喂引擎的形态）
  if (DEMO_SCRIPT) {
    const demoPlan = regionIndentPlan(DEMO_SCRIPT);
    eq("demo：plan 结构不变（blocksOf）", sig(blocksOf(demoPlan.text)), sig(blocksOf(DEMO_SCRIPT)));
    eq("demo：plan 幂等", regionIndentPlan(demoPlan.text).text, demoPlan.text);
    eq("demo：归一化(plan) = 原 demo 脚本（逐字节）", stripIndentForEngine(demoPlan.text), DEMO_SCRIPT);
    eq("demo：stripControls(plan) = stripControls(原)", stripControls(demoPlan.text), stripControls(DEMO_SCRIPT));
    eq("demo：plan 后无 NarrationLine", lintDocument(demoPlan.text).diagnostics.filter((d) => d.name === "NarrationLine").length, 0);
  }

  // 续行 + 旁白：plan 只把结构行按层级排，旁白归一化后保留行首空白
  const contPlan = regionIndentPlan(CONTINUATION_FLAT);
  eq("续行/旁白：归一化后结构行不变", stripIndentForEngine(contPlan.text).split("\n").slice(0, 3), CONTINUATION_FLAT.split("\n").slice(0, 3));
  eq("缩进旁白归一化后保留行首空白", stripIndentForEngine(CONTINUATION_INDENTED).split("\n")[3], "    这是缩进的旁白");
}

// ── 汇总 ────────────────────────────────────────────────────────

process.stdout.write(`\n== 结果：${passed} passed, ${failed} failed ==\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  ✗ [${f.group}] ${f.name}: ${f.detail}\n`);
  process.exit(1);
}
process.exit(0);
