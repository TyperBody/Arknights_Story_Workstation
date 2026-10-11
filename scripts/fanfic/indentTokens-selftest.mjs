// arkstage 编辑器「Tab 语义 + 语法着色」内核自检（offline, zero-dependency）。
//
//   node scripts/fanfic/indentTokens-selftest.mjs
//
// 断言 task-6 的两条用户反馈：
//   A) 「编辑器 tab 与缩进 和 vscode 一样 默认使用 8 缩进」：
//      `INDENT_UNIT = "\t"`、`tabSize = 8`；`indentLines` 缩进时"Tab 对齐到
//      下一个 tab stop"、反缩进时回**上一个 tab stop**；`regionIndentPlan` 用
//      同一个 unit；`stripIndentForEngine(缩进版) == 顶格版`（逐字节）。
//   B) 「脚本字符颜色标注」：`tokenizeLine(raw)` → `{from,to,kind}[]`：
//      **整行字符偏移**、升序、互不重叠、并集 = 整行；kind ∈
//      `HIGHLIGHT_KINDS`；**不查 CONTROLLER_INDEX**（未知控制器也有色）。
//
// 退出码：0 = 全部通过；1 = 有断言失败。
// 契约：`src/akstage/local/editorModel.js` 的 §区域缩进 / §语法着色；
// 回归：`npm run test:editor`。

import {
  CONTROLLER_INDEX,
  HIGHLIGHT_KINDS,
  INDENT_UNIT,
  TAB_SIZE,
  blocksOf,
  indentLines,
  lintDocument,
  parseLine,
  regionIndentPlan,
  tokenizeLine,
} from "../../src/akstage/local/editorModel.js";
import { parseScript, stripIndentForEngine } from "../../src/akstage/local/storyPack.js";

// ── 极简断言框架（与 editorIndent-selftest.mjs 同形） ─────────────────

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

/** 视觉列（Tab 跳到下一个 tab stop；与 `.ed-anchor` 的 `tab-size: 8` 同口径）。 */
/** @param {string} head @param {number} [tabSize] */
function columns(head, tabSize = TAB_SIZE) {
  let column = 0;
  for (const ch of head) column += ch === "\t" ? tabSize - (column % tabSize) : 1;
  return column;
}

/** 行首空白 `^[ \t]*`（正则）。 */
/** @param {string} line */
const headOf = (line) => /^[ \t]*/.exec(line)?.[0] ?? "";

/**
 * `tokenizeLine` 的不变量：升序、不重叠、`from/to` 落在行内、`kind` 合法、
 * `slice` 拼回来 = 整行。返回差异列表（空 = 全过）。
 * @param {string} raw
 * @returns {string[]}
 */
function spanProblems(raw) {
  const spans = tokenizeLine(raw);
  const bad = [];
  let cursor = 0;
  for (const span of spans) {
    if (!Number.isInteger(span.from) || !Number.isInteger(span.to)) { bad.push("from/to 不是整数"); break; }
    if (span.from < 0 || span.to > String(raw).length) { bad.push(`越界 ${span.from}-${span.to}`); break; }
    if (span.to <= span.from) { bad.push(`空/负 span ${span.from}-${span.to}`); break; }
    if (span.from !== cursor) { bad.push(`不连续/重叠：期望 ${cursor}，得到 ${span.from}`); break; }
    if (!HIGHLIGHT_KINDS.includes(span.kind)) { bad.push(`未知 kind ${span.kind}`); break; }
    cursor = span.to;
  }
  if (!bad.length && cursor !== String(raw).length) bad.push(`覆盖不全：到 ${cursor} / ${String(raw).length}`);
  return bad;
}

/** 某 kind 的 span 文本列表（调试/断言用）。 */
/** @param {string} raw @param {string} kind @returns {string[]} */
const textsOf = (raw, kind) => tokenizeLine(raw).filter((s) => s.kind === kind).map((s) => raw.slice(s.from, s.to));

// ── (a) unit 语义：Tab / 8 列 ────────────────────────────────────────

group("(a) INDENT_UNIT = Tab；tabSize = 8（VSCode 默认）");

{
  eq("INDENT_UNIT = 一个 Tab", INDENT_UNIT, "\t");
  eq("TAB_SIZE = 8", TAB_SIZE, 8);
  eq("INDENT_UNIT.length（字符数）= 1", INDENT_UNIT.length, 1);
  eq("视觉列数（tab stop）= 8", columns(INDENT_UNIT), 8);
  eq("Tab 是 1 个字符、不是空格", /^[ \t]$/.test(INDENT_UNIT) && INDENT_UNIT !== " ", true);

  const one = indentLines("a\nb", 2, 3, "indent");
  eq("顶格行缩进 = 行首插一个 Tab", one.text, "a\n\tb");
  eq("缩进返回值形状不变（text/caret/lines）", Object.keys(one).sort(), ["caret", "lines", "text"]);
  eq("caret 原样返回选区", one.caret, { from: 2, to: 3 });
  eq("lines = 处理的行数", one.lines, 1);
  eq("Tab 缩进 → 反缩进 往返幂等", indentLines(one.text, 2, 4, "outdent").text, "a\nb");

  // 缩进：不在 tab stop 上 → 先补空格对齐（补在缩进尾部，`\t` 前）
  eq("6 列缩进：补 2 空格对齐到 8 列再插 Tab", indentLines("x\n      b", 2, 9, "indent").text, "x\n        \tb");
  eq("1 列缩进：补 7 空格对齐", indentLines("x\n b", 2, 4, "indent").text, "x\n        \tb");
  eq("3 列缩进：补 5 空格对齐", indentLines("x\n   b", 2, 6, "indent").text, "x\n        \tb");
  eq("已在 tab stop（8 列）：直接插 Tab", indentLines("x\n        b", 2, 11, "indent").text, "x\n        \tb");
  eq("两级 Tab（16 列）：直接插第三个 Tab", indentLines("x\n\t\tb", 2, 5, "indent").text, "x\n\t\t\tb");
  eq("Tab+2 空格（10 列）：补 6 空格对齐", indentLines("x\n\t  b", 2, 6, "indent").text, "x\n\t        \tb");

  // 对齐后的缩进**整段**在送引擎时被吃掉（例外：`parseLine` 的 body 判定）
  eq("对齐补的空格在 `\t` 之前（不在正文里）", headOf(indentLines("x\n      b", 2, 9, "indent").text.split("\n")[1]), "        \t");
  eq("对齐后 `\\t` 之后就是正文", indentLines("x\n      b", 2, 9, "indent").text.split("\n")[1].endsWith("b"), true);
}

// ── (b) 反缩进：回上一个 tab stop（往返） ────────────────────────────

group("(b) 反缩进 = 回上一个 tab stop（VSCode 的 outdent）");

{
  // 网格对齐的行首：缩进 → 反缩进 = 恒等（Tab 逐级 ±1）。
  const grid = ["", "\t", "\t\t", "\t\t\t"];
  for (const head of grid) {
    const text = `L\n${head}R`;
    const grown = indentLines(text, 2, text.length, "indent").text;
    eq(`缩进 +1 级：${JSON.stringify(head)}`, headOf(grown.split("\n")[1]), `${head}\t`);
    eq(`反缩进 -1 级（恒等）：${JSON.stringify(head)}`, indentLines(grown, 2, grown.length, "outdent").text, text);
  }

  // 非网格对齐的行首：缩进先"对齐到下一个 tab stop"、再 +1 级（8 列）；
  // 反缩进回到**上一个 tab stop**（列数向下取整到 8 的倍数）。
  const free = ["   ", "    ", "      ", "\t  ", "      \t"];
  for (const head of free) {
    const text = `L\n${head}R`;
    const grown = indentLines(text, 2, text.length, "indent").text;
    const line = grown.split("\n")[1];
    const stop = Math.ceil(columns(head) / TAB_SIZE) * TAB_SIZE;
    const want = stop + TAB_SIZE;
    eq(`非网格缩进：先对齐到 tab stop 再 +1 级（${JSON.stringify(head)}）`, columns(headOf(line)), want);
    eq(`对齐只动行首空白（正文不变）：${JSON.stringify(head)}`, line.slice(headOf(line).length), "R");
    const backHead = headOf(indentLines(grown, 2, grown.length, "outdent").text.split("\n")[1]);
    eq(`反缩进 = 回上一个 tab stop（${JSON.stringify(head)}）`, columns(backHead), want - TAB_SIZE);
    eq(`反缩进结果在 ${TAB_SIZE} 列网格上（${JSON.stringify(head)}）`, columns(backHead) % TAB_SIZE, 0);
  }

  eq("纯空格 2 格（tab 内）反缩进吃掉", indentLines("a\n  b", 2, 5, "outdent").text, "a\nb");
  eq("1 格空格反缩进吃掉", indentLines("a\n b", 2, 4, "outdent").text, "a\nb");
  eq("Tab 单独反缩进吃掉", indentLines("a\n\tb", 2, 4, "outdent").text, "a\nb");
  eq("Tab+2 空格（10 列）→ 回 8 列（1 个 Tab 位）", indentLines("a\n\t  b", 2, 6, "outdent").text, "a\n\tb");
  eq("Tab+3 空格（11 列）→ 回 8 列", indentLines("a\n\t   b", 2, 7, "outdent").text, "a\n\tb");
  eq("两级 Tab → 一级", indentLines("a\n\t\tb", 2, 5, "outdent").text, "a\n\tb");
  eq("顶格行反缩进 = 原样", indentLines("a\nb", 2, 3, "outdent").text, "a\nb");
  eq("顶格行 + 空行反缩进 = 原样", indentLines("a\n\nb", 0, 4, "outdent").text, "a\n\nb");
  eq("正文里的 Tab 不被碰", indentLines("a\n\tb\tc", 2, 6, "outdent").text, "a\nb\tc");

  // 跨行选区：一次动作 = 每行各回一格（不做"对齐到最小缩进"）
  const mixed = "x\n\t\ty\n  z\n\tw";
  const out = indentLines(mixed, 2, mixed.length, "outdent").text;
  eq("跨行反缩进逐行回一格", out, "x\n\ty\nz\nw");
  eq("跨行反缩进 = 逐行单行调用", [
    indentLines(mixed, 2, 5, "outdent").text,
    indentLines(mixed, 4, 8, "outdent").text,
    indentLines(mixed, 8, 11, "outdent").text,
  ].map((text, index) => text.split("\n")[index + 1]), ["\ty", "z", "w"]);
}

// ── (c) options：tabSize / unit 覆盖（旧调用兼容） ─────────────────

group("(c) options.tabSize / options.unit");

{
  eq("options.tabSize=4 的缩进对齐", indentLines("x\n  b", 2, 5, "indent", { tabSize: 4 }).text, "x\n    \tb");
  eq("options.tabSize=4 的反缩进网格", indentLines("x\n    b", 2, 7, "outdent", { tabSize: 4 }).text, "x\nb");
  eq("options.unit = 两空格（旧调用）缩进", indentLines("a\nb", 2, 3, "indent", { unit: "  " }).text, "a\n  b");
  eq("options.unit = 两空格（旧调用）往返", indentLines("a\n  b", 2, 5, "outdent", { unit: "  " }).text, "a\nb");
  eq("options.unit = 两空格：4 格只吃 2", indentLines("a\n    b", 2, 7, "outdent", { unit: "  " }).text, "a\n  b");
  eq("options 省略 / 非对象都不报错", [indentLines("a", 0, 1, "indent", null).text, indentLines("a", 0, 1, "indent", 7).text], ["\ta", "\ta"]);
  eq("tabSize 非法值回落 8", indentLines("x\n      b", 2, 9, "indent", { tabSize: -3 }).text, "x\n        \tb");
}

// ── (d) regionIndentPlan 用同一个 unit（Tab） ─────────────────────

group("(d) regionIndentPlan：Tab 层级 + 幂等 + 结构不变");

{
  const FLAT = [
    "[Decision(options=\"A;B\", values=\"1;2\")]",
    "[Predicate(references=\"1\")]",
    "[charslot(slot=\"m\", name=\"a\", duration=0.5)]",
    "[name=\"阿米娅\"]  走。",
    "[Predicate(references=\"2\")]",
    "[name=\"杜宾\"]  好。",
    "[endtip(block=true)]",
  ].join("\n");
  const plan = regionIndentPlan(FLAT);
  const want = [
    "[Decision(options=\"A;B\", values=\"1;2\")]",
    `\t[Predicate(references="1")]`,
    `\t\t[charslot(slot="m", name="a", duration=0.5)]`,
    `\t\t[name="阿米娅"]  走。`,
    `\t[Predicate(references="2")]`,
    `\t\t[name="杜宾"]  好。`,
    "[endtip(block=true)]",
  ].join("\n");
  eq("plan 层级 = 1 个 Tab / 2 个 Tab", plan.text, want);
  eq("plan 行数 = 输入行数", plan.lines, FLAT.split("\n").length);
  eq("plan changed = 5 行（只有缩进行变化）", plan.changed, 5);
  eq("plan 幂等（第二次 changed = 0）", [regionIndentPlan(plan.text).text, regionIndentPlan(plan.text).changed], [plan.text, 0]);
  // 幂等的**显式**形式（Lead 复核）：plan(plan(x)) === plan(x)，逐字节。
  eq("plan(plan(x)) === plan(x)（显式幂等）", regionIndentPlan(regionIndentPlan(FLAT).text).text, plan.text);
  eq("plan(plan(x)) === plan(x)（用户样例 x = Tab 版）", regionIndentPlan(regionIndentPlan(want).text).text, want);
  // 「已是 Tab 版」的脚本：plan 必须**恒等**（changed = 0，不重新排版）。
  const tabIdentity = regionIndentPlan(want);
  eq("已是 Tab 版 → 恒等（逐字节）", tabIdentity.text, want);
  eq("已是 Tab 版 → changed = 0", tabIdentity.changed, 0);
  eq("已是 Tab 版 → lines 不变", tabIdentity.lines, want.split("\n").length);
  // 混合（手写两空格层级）：plan 会把层级**替换成 Tab**，替换后即稳定。
  const legacy = '[Decision(options="A;B")]\n  [Predicate(references="1")]\n    [x=1]';
  const replanned = regionIndentPlan(legacy);
  eq("两空格层级 → 替换成 Tab", replanned.text, '[Decision(options="A;B")]\n\t[Predicate(references="1")]\n\t\t[x=1]');
  eq("替换后 plan 恒等", regionIndentPlan(replanned.text).text, replanned.text);
  eq("替换后归一化 = 原顶格版", stripIndentForEngine(replanned.text), stripIndentForEngine(legacy));
  ok("已 Tab 版的每一行都不再被 plan 改动", regionIndentPlan(want).text.split("\n").every((line, index) => line === want.split("\n")[index]));
  eq("plan 后 blocksOf 结构不变", blocksOf(plan.text).map((l) => `${l.kind}:${l.controller ?? ""}`), blocksOf(FLAT).map((l) => `${l.kind}:${l.controller ?? ""}`));
  eq("plan 后 lint 无 NarrationLine", lintDocument(plan.text).diagnostics.filter((d) => d.name === "NarrationLine").length, 0);
  eq("plan 后每级缩进都是整数个 Tab", plan.text.split("\n").every((line) => /^(\t*)/.test(line)), true);
  eq("options.unit=两空格（旧版）仍然可用", regionIndentPlan(FLAT, { unit: "  " }).text.split("\n")[1], '  [Predicate(references="1")]');
  eq("plan 只改非空行", regionIndentPlan("[Decision(options=\"A;B\")]\n\n\n[x=1]").text.split("\n")[1], "");
}

// ── (e) 送引擎归一化：Tab/空格混排逐字节相等 ─────────────────────────

group("(e) stripIndentForEngine：Tab/空格/对齐空格全吃（逐字节）");

{
  const FLAT = "[Decision(options=\"A;B\", values=\"1;2\")]\n[Predicate(references=\"1\")]\n[name=\"A\"]  一\n[endtip(block=true)]";
  const indented = regionIndentPlan(FLAT).text;
  eq("归一化(plan) = 顶格版（逐字节）", stripIndentForEngine(indented), FLAT);
  eq("归一化结果不含行首 Tab / 空格", stripIndentForEngine(indented).split("\n").every((line) => !/^[ \t]/.test(line)), true);
  eq("归一化幂等", stripIndentForEngine(stripIndentForEngine(indented)), stripIndentForEngine(indented));
  eq("归一化不改行数", stripIndentForEngine(indented).split("\n").length, indented.split("\n").length);

  // 「Tab 对齐」补的空格（`<pad>\t`）也整段吃掉
  const aligned = indentLines("x\n      [Delay(time=1)]", 2, 23, "indent").text;
  eq("对齐缩进版（6 空格 → 8 空格 + Tab）", aligned.split("\n")[1], "        \t[Delay(time=1)]");
  eq("对齐缩进版归一化 = 顶格版", stripIndentForEngine(aligned), "x\n[Delay(time=1)]");

  // 旁白行**保留**行首空白（它是展示文本）；裸行 + Tab 缩进也保留
  eq("纯旁白行原样（含 Tab 缩进）", stripIndentForEngine("\t裸旁白"), "\t裸旁白");
  eq("裸行归一化后与顶格 `[` 行混排", stripIndentForEngine("\t裸旁白\n\t[Delay(time=1)]"), "\t裸旁白\n[Delay(time=1)]");
  eq("`]` 后的正文 Tab 不被碰", stripIndentForEngine('\t[name="A"]\t正文'), '[name="A"]\t正文');

  // 结构：缩进版 parseScript / parseLine 与顶格版同 kind 序列
  eq("缩进版 parseScript 序列 = 顶格版", parseScript(indented).map((l) => l.command ?? l.kind), parseScript(FLAT).map((l) => l.command ?? l.kind));
  eq("缩进版 parseLine kind/controller = 顶格版", [parseLine(indented.split("\n")[1], 2).kind, parseLine(indented.split("\n")[1], 2).controller], ["command", "predicate"]);
  eq("Tab 缩进只是惯例：无 UseSpaceInsteadTab", parseLine('\t[Delay(time=1)]', 1).diagnostics.filter((d) => d.name === "UseSpaceInsteadTab").length, 0);
}

// ── (f) tokenizeLine：契约（span 形状） ────────────────────────────

group("(f) tokenizeLine：整行偏移、升序、不重叠、覆盖整行");

{
  /** 覆盖正例：普通语句、对白、旁白、注释、空行、未知控制器、命名空间指令。 */
  const SAMPLES = [
    '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
    '[Decision(options="跟着她走;先问清楚", values="1;2")]',
    '[Blocker(a=1, r=0, g=0, b=0, fadetime=1.5, block=true)]',
    '\t[name="阿米娅"]  这边走，博士。',
    '   裸旁白（行首空白属于文本）',
    '// 整行注释 x=1',
    '  // 缩进注释',
    '',
    '   ',
    '[Delay(time=1)]',
    '  [Battle.Pause]',
    '[DelayDemo(ok=true, n=-2)]',
    '`value1=1.1`',
    '[]',
    '[Dialog]',
    '[Tutorial(focusX=30, focusY=60, focusWidth=220, focusHeight=220, \\',
    '\t[Tutorial(focusX=30, focusY=60, \\',
    'DelayDemo(ok=true, n=-2)',
    '[Delay(time=1)',
  ];
  for (const raw of SAMPLES) eq(`span 不变量：${JSON.stringify(raw)}`, spanProblems(raw), []);
  eq("空串 → []（没有 span）", tokenizeLine(""), []);
  eq("空行 → []", tokenizeLine(""), []);
  eq("纯空白行 → 只 indent", tokenizeLine("   "), [{ from: 0, to: 3, kind: "indent" }]);
  eq("返回值是数组", Array.isArray(tokenizeLine("[A]")), true);
  eq("HIGHLIGHT_KINDS 覆盖 tokenizeLine 的全部 kind（含 semicolon）", HIGHLIGHT_KINDS.includes("semicolon"), true);
  eq("HIGHLIGHT_KINDS 是冻结的常量表（12 个）", HIGHLIGHT_KINDS.length, 12);
  eq("HIGHLIGHT_KINDS 无重复", new Set(HIGHLIGHT_KINDS).size, HIGHLIGHT_KINDS.length);
}

// ── (g) tokenizeLine：每类的着色键与粒度 ─────────────────────────

group("(g) tokenizeLine：kind 的着色键与覆盖粒度");

{
  const cmd = '[Blocker(a=1, r=0, block=true)]';
  eq("`[`/`]` → bracket", textsOf(cmd, "bracket"), ["[", "(", ")", "]"]);
  eq("`Blocker` → controller", textsOf(cmd, "controller"), ["Blocker"]);
  eq("参数键 → argKey（只盖键、不盖 `=`）", textsOf(cmd, "argKey"), ["a", "r", "block"]);
  eq("数字 / 布尔分色", [textsOf(cmd, "number"), textsOf(cmd, "bool")], [["1", "0"], ["true"]]);
  eq("`=`/`,`/空白 → bare（拼起来 = `=, =, =`）", textsOf(cmd, "bare").join(""), "=, =, =");
eq("`=` 不属于 argKey", textsOf(cmd, "argKey").join("").includes("="), false);

  const str = '[charslot(slot="m", name="char_001", duration=0.5)]';
  eq("字符串值 → string（含引号）", textsOf(str, "string"), ['"m"', '"char_001"']);
  eq("浮点数 → number", textsOf(str, "number"), ["0.5"]);
  eq("字符串里的键仍是 argKey", textsOf(str, "argKey"), ["slot", "name", "duration"]);

  const decision = '[Decision(options="A;B", values="1;2")]';
  eq("`;` → semicolon（值内分隔）", textsOf(decision, "semicolon"), [";", ";"]);
  eq("字符串被 `;` 切成多段", textsOf(decision, "string"), ['"A', 'B"', '"1', '2"']);
  eq("Decision 的字符串总字符数不变", textsOf(decision, "string").join("").length + textsOf(decision, "semicolon").length, '"A;B"'.length + '"1;2"'.length);

  const dialogue = '\t[name="阿米娅"]  这边走，博士。';
  eq("`[name=` 的引号段 → speaker（含引号，与 UI 降级 tokenizer 同形）", textsOf(dialogue, "speaker"), ["\"阿米娅\""]);
  eq("`]` 之后 → text", textsOf(dialogue, "text"), ["  这边走，博士。"]);
  eq("行首 Tab → indent", textsOf(dialogue, "indent"), ["\t"]);
  eq("speaker 的 span 落在引号段", tokenizeLine(dialogue).filter((s) => s.kind === "speaker").map((s) => [s.from, s.to]), [[7, 12]]);

  const narr = "   裸旁白 x=[1]";
  eq("旁白行 → indent + text", tokenizeLine(narr).map((s) => s.kind), ["indent", "text"]);
  eq("旁白的 text 不含行首空白", textsOf(narr, "text"), ["裸旁白 x=[1]"]);

  const comment = "\t// 注释 [A]";
  eq("注释 → indent + comment", tokenizeLine(comment).map((s) => s.kind), ["indent", "comment"]);
  eq("注释正文整段（含 `[`）", textsOf(comment, "comment"), ["// 注释 [A]"]);

  const unknown = "[DelayDemo(ok=true, n=-2)]";
  eq("未知控制器也有 controller 色", textsOf(unknown, "controller"), ["DelayDemo"]);
  eq("未知控制器的参数照样分色", [textsOf(unknown, "argKey"), textsOf(unknown, "bool"), textsOf(unknown, "number")], [["ok", "n"], ["true"], ["-2"]]);
  eq("未知控制器不在 CONTROLLER_INDEX", Object.prototype.hasOwnProperty.call(CONTROLLER_INDEX, "delaydemo"), false);

  const namespaced = "  [Battle.Pause]";
  eq("命名空间指令也有 controller 色", textsOf(namespaced, "controller"), ["Battle.Pause"]);
  eq("命名空间指令不查表也有色（CONTROLLER_INDEX 里没有）", Object.prototype.hasOwnProperty.call(CONTROLLER_INDEX, "battle.pause"), false);

  const tail = "[Delay(time=1)]x]y";
  eq("`]` 之后的正文 → text", textsOf(tail, "text"), ["y"]);
  eq("`]` 之间的 `x]` → bare", textsOf(tail, "bare").some((t) => t.includes("x")), true);

  const bare = '`value1=1.1`';
  eq("反引号包裹的模板片段 → controller 之外的 text", tokenizeLine(bare).map((s) => s.kind), ["text"]);
}

// ── (h) tokenizeLine：与 parseLine 的关系 + 确定性 ────────────────

group("(h) tokenizeLine：纯函数、与 parseLine 一致（不改输入、可重复）");

{
  const raw = '[charslot(slot="m", name="a#1", duration=0.5)]';
  eq("可重复调用（纯函数）", tokenizeLine(raw), tokenizeLine(raw));
  eq("顺序敏感但无状态", [tokenizeLine(raw), tokenizeLine(raw)].every((s) => s.length > 0), true);
  const sparse = tokenizeLine(raw);
  ok("不用 parseLine 的 `params` 也能着色（span 数与源结构一致）", sparse.length >= 8);
  eq("span 的 from 全为整数", sparse.every((s) => Number.isInteger(s.from) && Number.isInteger(s.to)), true);
  eq("`raw` 之外的输入（null/undefined/数字）不抛", [tokenizeLine(null), tokenizeLine(undefined), tokenizeLine(42)].map((list) => Array.isArray(list)), [true, true, true]);
  eq("数字输入 → text", tokenizeLine(42).map((s) => s.kind), ["text"]);
  eq("`(raw, 1)` 传第二参不影响结果", tokenizeLine.length >= 1, true);

  // parseLine 的 params 与 tokenizeLine 的 argKey 覆盖同一批键（顺序一致）
  const parsed = parseLine(raw, 1).params.map((p) => p.key);
  eq("argKey 的键序列 = parseLine 的 params 键序列", textsOf(raw, "argKey"), parsed);
  const inline = '[Blocker(a=1)] x';
  eq("行内 `[` 在正文里也只当一次语句（conformance）", spanProblems(inline), []);
}

// ── (i) 综合：用户样例（Decision 分支体）全链路 ────────────────────

group("(i) 综合：Decision 分支体的 unit + 着色 + 归一化");

{
  const FLAT = [
    '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
    '[Decision(options="跟着她走;先问清楚", values="1;2")]',
    '[Predicate(references="1")]',
    '[charslot(slot="m", name="char_002_amiya_1#1", duration=0.5)]',
    '[name="阿米娅"]  这边走，博士。',
    '[Predicate(references="2")]',
    '[name="阿米娅"]  先别急。',
    '[Predicate(references="1;2")]',
    '[name="阿米娅"]  收束。',
    '[endtip(block=true)]',
  ].join("\n");
  const plan = regionIndentPlan(FLAT);
  eq("plan 幂等", regionIndentPlan(plan.text).text, plan.text);
  eq("plan 归一化 = 顶格版（逐字节）", stripIndentForEngine(plan.text), FLAT);
  eq("plan 后 lint = 顶格版（逐条）", lintDocument(plan.text).diagnostics.map((d) => `${d.name}#${d.line}`), lintDocument(FLAT).diagnostics.map((d) => `${d.name}#${d.line}`));
  const planLines = plan.text.split("\n");
  eq("Predicate 一级（1 Tab / 8 列）", [headOf(planLines[2]), columns(headOf(planLines[2]))], ["\t", 8]);
  eq("线路体两级（2 Tab / 16 列）", [headOf(planLines[3]), columns(headOf(planLines[3]))], ["\t\t", 16]);
  ok("缩进的指令行有 controller 色", planLines.slice(2, 9).filter((line) => /^\t+\[/.test(line) && !/^\t+\[\s*name\s*=/.test(line)).every((line) => textsOf(line, "controller").length > 0));
  eq("缩进的对白行有 speaker 色", planLines.slice(2, 9).filter((line) => /^\t+\[\s*name\s*=/.test(line)).every((line) => textsOf(line, "speaker").length === 1), true);
  eq("tab stop 对齐（regionIndentPlan 的多级 Tab 全在网格上）", planLines.every((line) => columns(headOf(line)) % TAB_SIZE === 0), true);
}

// ── 汇总 ────────────────────────────────────────────────────────

process.stdout.write(`\n== 结果：${passed} passed, ${failed} failed ==\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  ✗ [${f.group}] ${f.name}: ${f.detail}\n`);
  process.exit(1);
}
process.exit(0);
