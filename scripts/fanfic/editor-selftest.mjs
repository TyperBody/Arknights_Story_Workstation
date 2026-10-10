#!/usr/bin/env node
/**
 * 编辑器内核自检（offline, zero-dependency）。
 *
 *   node scripts/fanfic/editor-selftest.mjs [--corpus <dir>] [--count 300] [--json out.json]
 *
 * 断言三组输入上的 parseLine / lintDocument / completions / formatLine / hoverFor /
 * missingMerge 行为：
 *   (a) 仓库内置样例（example/library/fanfic-demo/script.txt，若不存在则退回
 *       src-tauri/resources/library/sample-fanfic/script.txt —— 应用首启 seed 的那份）；
 *   (b) 官方语料随机抽 N 行（默认 300；种子固定，结果可复现），断言
 *       - 与 `storyPack.parseLine` 的 token 化完全一致（命令名/参数键集合/正文）；
 *       - 抽到的行**不产生 error 级诊断**；
 *       - kind 覆盖到 command/dialogue；
 *   (c) 10 组"坏输入"：未知命令、错参数键、未闭合 `(`、Tab 缩进、Decision 无合流、
 *       类型不符、缺必需参数、重复参数、单`]`、`end` 兼容写法 —— 逐条断言诊断码；
 *   另有格式不变式（parseLine(formatLine(x)) 不产生 error）与诊断偏移落在行内。
 *   (f) 与上游 `parser.ts:parseLine` 逐行对拍（`--parity-full` 跑全语料 1,074,628 行）：
 *       命令名 / 参数键集合 / 值 / 正文一致；差异只允许来自 6 类已知的官方瑕疵
 *       （见函数内 `knownClass` 与 editorModel 文件头「已知偏差」）。
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 用法/环境错误（如语料目录不存在，
 * 用 `--corpus` 指定或跳过；`--allow-missing-corpus` 时降级为 0 并标注 skipped）。
 *
 * 契约见 `.akskills/arkstage-fanfic/reference/package.md`；内核在
 * `src/akstage/local/editorModel.js`，token 化在 `src/akstage/local/storyPack.js`。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATEGORIES,
  CONTROLLERS,
  DIAGNOSTIC_CODES,
  formatLine,
  hoverFor,
  lintDocument,
  missingMerge,
  parseLine,
} from "../../src/akstage/local/editorModel.js";
import { parseLine as dslParseLine, parseScript, lintScript } from "../../src/akstage/local/storyPack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
/** 资源目录候选（skill / research 都写 `~/.akresearch`，本项目在桌面下）。 */
const CORPUS_CANDIDATES = [
  process.env.AKSTAGE_CORPUS_DIR,
  "/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story",
  join(process.env.HOME ?? "", ".akresearch/akgd/zh_CN/gamedata/story"),
].filter(Boolean);
const SAMPLE_CANDIDATES = [
  join(REPO_ROOT, "example/library/fanfic-demo/script.txt"),
  join(REPO_ROOT, "src-tauri/resources/library/sample-fanfic/script.txt"),
  join(REPO_ROOT, "example/fanfic/demo/script.txt"),
];

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

/**
 * @param {string} name
 * @param {unknown} actual
 * @param {unknown} expected
 */
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

/** @param {string} [name] */
function skip(name = "") {
  process.stdout.write(`  · skip ${name}\n`);
}

// ── 参数 ─────────────────────────────────────────────────────────────────

/** @returns {{corpus: string|null, count: number, json: string|null, allowMissingCorpus: boolean}} */
function parseArgv() {
  /** @type {string[]} */
  const argv = process.argv.slice(2);
  let corpus = null;
  let count = 300;
  /** @type {string|null} */
  let json = null;
  let allowMissingCorpus = false;
  let fullParity = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--corpus") corpus = argv[++i] ?? null;
    else if (arg === "--count") count = Math.max(1, Number(argv[++i] ?? 300) || 300);
    else if (arg === "--json") json = argv[++i] ?? null;
    else if (arg === "--allow-missing-corpus") allowMissingCorpus = true;
    else if (arg === "--parity-full") fullParity = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "用法：node scripts/fanfic/editor-selftest.mjs [--corpus <dir>] [--count 300] [--json out.json] [--allow-missing-corpus] [--parity-full]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`未知参数：${arg}（-h 看帮助）\n`);
      process.exit(2);
    }
  }
  return { corpus, count, json, allowMissingCorpus, fullParity };
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
      else if (entry.isFile() && extname(entry.name) === ".txt") out.push(path);
    }
  };
  visit(root);
  return out;
}

/** 确定性 PRNG（mulberry32）：同种子 → 同抽样，便于复现。 @param {number} seed */
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
 * 抽 300 行：优先取"自带 `[Command(...)]`"的指令行（含对话行），按文件名排序后
 * 用固定种子在全局列表上抽样 —— 不读整个语料的 1.1M 行内容，只读每个文件一次。
 * @param {string} root @param {number} count
 * @returns {Array<{file: string, line: number, raw: string}>}
 */
function sampleCorpusLines(root, count) {
  const files = walkTxt(root).sort();
  const random = rng(0x5eed);
  const out = [];
  // 均匀跨文件抽样：每个文件最多取 ceil(count/50)+2 行，避免只落在前几个活动里。
  const perFile = Math.max(3, Math.ceil(count / Math.min(files.length, 60)));
  for (const file of files) {
    if (out.length >= count * 4) break;
    let text;
    try {
      text = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
    } catch {
      continue;
    }
    const raw = text.split("\n");
    /** @type {number[]} */
    const candidates = [];
    for (let i = 0; i < raw.length; i += 1) {
      const line = raw[i] ?? "";
      // 只取单物理行、无续行、以 `[` 开头的行：这样行号与内容一致。
      if (!line.startsWith("[")) continue;
      if (line.endsWith("\\")) continue;
      candidates.push(i);
    }
    if (candidates.length === 0) continue;
    for (let k = 0; k < perFile && candidates.length; k += 1) {
      const pick = candidates[Math.floor(random() * candidates.length)];
      if (pick === undefined) break;
      out.push({ file: relative(root, file), line: pick + 1, raw: raw[pick] ?? "" });
    }
  }
  return out.slice(0, count);
}

/**
 * 从一行里抽出命令名（用于统计）。
 * @param {string} raw @returns {string}
 */
function commandOf(raw) {
  const m = /^\[\s*([A-Za-z_]\w*)/.exec(raw);
  return m ? m[1].toLowerCase() : "";
}

// ── (a) 内置样例 ─────────────────────────────────────────────────────────

/** @param {string} text */
function testSample(text) {
  group("(a) 内置样例：lintDocument / parseLine / formatLine");
  const lint = lintDocument(text);
  eq("样例 0 error", lint.stats.errors, 0);
  eq("样例 0 warning", lint.stats.warnings, 0);
  ok("样例有行", lint.stats.lines >= 10);
  eq("样例 Decision 数", lint.stats.decisions, 1);
  eq("样例 组合数（1 个 2 选 1）", lint.stats.combos, 2);
  eq("样例合流诊断 0 条", lint.merge.length, 0);
  ok("样例 toc 有 header 标题", lint.toc.some((item) => item.line === 1));
  ok("样例 controllers 统计有 decision", lint.stats.controllers.decision === 1);
  ok("样例 controllers 统计有 predicate", (lint.stats.controllers.predicate ?? 0) >= 3);

  // 每一行都能解析，且诊断的 span 落在行内
  let spansOk = true;
  for (const line of lint.lines) {
    for (const d of line.diagnostics) {
      if (d.from < 0 || d.to > Math.max(1, line.raw.length) || d.from >= d.to) spansOk = false;
    }
  }
  ok("诊断 span 全部落在行内且非空", spansOk);

  // 对话行
  const dialogue = lint.lines.find((line) => line.kind === "dialogue");
  ok("识别出对话行", Boolean(dialogue));
  if (dialogue) {
    eq("对话行的 controller = dialog", dialogue.controller, "dialog");
    ok("对话行有 speaker", dialogue.speaker.length > 0);
    ok("对话行有正文", dialogue.text.trim().length > 0);
  }

  // formatLine 往返
  const rendered = formatLine("charslot", { slot: "m", name: "avg_npc_243", duration: 1 });
  eq("formatLine(charslot)", rendered, '[charslot(slot="m", name="avg_npc_243", duration=1)]');
  const back = parseLine(rendered, 1);
  eq("formatLine → parseLine 无 error", back.diagnostics.filter((d) => d.severity === "error").length, 0);
  eq("formatLine → parseLine 参数值", back.params.find((p) => p.name === "duration")?.value, 1);
  eq("formatLine(dialog 说话人)", formatLine("dialog", { name: "杜宾", text: "这里是……？" }), '[name="杜宾"]  这里是……？');
  eq("formatLine(dialog 无参)", formatLine("dialog", {}), "[Dialog]");
  const tween = formatLine("imagetween", { duration: 15, block: false, xFrom: 0, xTo: -20 });
  ok("formatLine 数值不加引号", tween.includes("duration=15") && tween.includes("block=false"));
  eq("formatLine → parseLine 无 error（tween）", parseLine(tween, 1).diagnostics.filter((d) => d.severity === "error").length, 0);
}

// ── (b) 语料 ──────────────────────────────────────────────────────────

/** @param {string} corpusRoot @param {number} count */
function testCorpus(corpusRoot, count) {
  group(`(b) 官方语料抽样 ${count} 行（${corpusRoot}）`);
  const rows = sampleCorpusLines(corpusRoot, count);
  eq(`抽到 ${count} 行`, rows.length, count);
  if (rows.length === 0) return { command: 0, dialogue: 0 };

  let tokenMismatch = 0;
  let errorLines = 0;
  let spanBad = 0;
  let command = 0;
  let dialogue = 0;
  /** @type {Map<string, number>} */
  const codes = new Map();
  /** @type {string[]} */
  const errorSamples = [];
  /** @type {string[]} */
  const mismatchSamples = [];

  for (const row of rows) {
    const expected = dslParseLine(row.raw, row.line);
    const actual = parseLine(row.raw, row.line);
    if (expected.kind === "dialogue") dialogue += 1;
    if (expected.kind === "command") command += 1;

    // token 化一致性：命令名（含大小写不敏感的归一）、参数键集合（保留大小写）、正文
    const expectedKeys = Object.keys(expected.args ?? {});
    const actualKeys = actual.params.map((p) => p.key).filter((key) => typeof key === "string" && key.length > 0);
    const expectedCommand = expected.kind === "dialogue" ? "dialog" : expected.command;
    const keysDiffer = expectedKeys.length !== actualKeys.length
      || expectedKeys.some((key) => !actualKeys.includes(key));
    if (expectedCommand !== actual.controller || keysDiffer || String(expected.text ?? "") !== actual.text) {
      tokenMismatch += 1;
      if (mismatchSamples.length < 5) {
        mismatchSamples.push(`${row.file}:${row.line} ${row.raw.slice(0, 90)} → 内核 ${actual.controller} ${JSON.stringify(actualKeys)} vs tokenizer ${expectedCommand} ${JSON.stringify(expectedKeys)}`);
      }
    }
    for (const d of actual.diagnostics) {
      if (d.from < 0 || d.to > Math.max(1, actual.raw.length) || d.from >= d.to) spanBad += 1;
      if (d.severity !== "error") continue;
      codes.set(d.name, (codes.get(d.name) ?? 0) + 1);
    }
    const errors = actual.diagnostics.filter((d) => d.severity === "error");
    if (errors.length) {
      errorLines += 1;
      if (errorSamples.length < 8) {
        errorSamples.push(`${row.file}:${row.line} ${row.raw.slice(0, 100)}\n        ${errors.map((d) => `${d.hex} ${d.message}`).join("\n        ")}`);
      }
    }
  }

  eq("token 化与 storyPack.parseLine 完全一致", tokenMismatch, 0);
  eq("语料行 0 条 error 级诊断", errorLines, 0);
  eq("诊断 span 全部落在行内", spanBad, 0);
  ok("抽样覆盖指令行", command > 0);
  ok("抽样覆盖对话行", dialogue > 0);
  ok("抽样覆盖 ≥ 8 个不同命令", new Set(rows.map((row) => commandOf(row.raw)).filter(Boolean)).size >= 8);

  if (mismatchSamples.length) process.stdout.write(`  不一致样例：\n    ${mismatchSamples.join("\n    ")}\n`);
  if (errorSamples.length) process.stdout.write(`  error 样例：\n    ${errorSamples.join("\n    ")}\n`);
  if (codes.size) {
    process.stdout.write(`  （error 码统计：${[...codes.entries()].map(([name, n]) => `${name}×${n}`).join(", ")}）\n`);
  }

  // 语料上的穷尽不变量：抽样行里 model 覆盖到的命令都应命中 CONTROLLERS
  const known = new Set(CONTROLLERS.map((spec) => spec.command));
  const covered = new Set(rows.map((row) => commandOf(row.raw)).filter((name) => known.has(name)));
  ok("抽样里 ≥ 5 个命令在 CONTROLLERS 表内", covered.size >= 5);
  return { command, dialogue };
}

// ── (c) 坏输入 ─────────────────────────────────────────────────────────

function testBroken() {
  group("(c) 10 组坏输入：诊断码逐条断言");

  const cases = [
    {
      name: "未知命令",
      line: "[UnknownCommand(x=1)]",
      expect: ["NoSuchController"],
      severity: "error",
    },
    {
      name: "错参数键（拼写漂移 → 未声明）",
      line: '[PlaySound(key="a", voluime=1)]',
      expect: ["UnknownParameter"],
      severity: "warning",
    },
    {
      name: "未闭合 (（参数表没关）",
      line: "[Delay(time=0.3",
      expect: ["UnclosedSymbol"],
      severity: "error",
    },
    {
      name: "Tab 缩进 / Tab 分隔",
      line: "[Dialog]\t正文",
      expect: ["UseSpaceInsteadTab"],
      severity: "warning",
    },
    {
      name: "Decision 没有合流 Predicate",
      doc: [
        '[Header(key="t")]',
        '[Decision(options="A;B", values="1;2")]',
        '[Predicate(references="1")]',
        '[name="A"]  走 A',
        '[Predicate(references="2")]',
        '[name="B"]  走 B',
        '结尾都没有合流。',
      ].join("\n"),
      expectMerge: ["MissingMergePredicate"],
    },
    {
      name: "参数类型不符",
      line: "[CameraShake(duration=abc)]",
      expect: ["ParameterTypeMismatch"],
      severity: "error",
    },
    {
      name: "缺必需参数（Delay 少了 time）",
      line: "[Delay]",
      expect: ["MissingRequiredParameter"],
      severity: "error",
    },
    {
      name: "参数重复",
      line: "[PlaySound(key=\"a\", volume=1, volume=0.6)]",
      expect: ["InstrumentRedundant"],
      severity: "warning",
    },
    {
      name: "值尾多一个 ]（`[delay(time=2)]]` 的语料形态）",
      line: "[delay(time=2)]]",
      expect: ["ParameterTypeMismatch"],
      severity: "warning",
    },
    {
      name: "`[End]` 兼容写法（引擎不认）",
      line: "[End]",
      expect: ["NotReadByEngine"],
      severity: "warning",
    },
  ];
  eq("用例数 = 10", cases.length, 10);

  for (const test of cases) {
    if (test.line) {
      const result = parseLine(test.line, 42);
      const names = result.diagnostics.map((d) => d.name);
      for (const want of test.expect ?? []) {
        const hit = result.diagnostics.find((d) => d.name === want);
        ok(`${test.name} → ${want}`, Boolean(hit));
        if (test.severity && hit) eq(`${test.name} → 严重度 ${test.severity}`, hit.severity, test.severity);
        if (hit) eq(`${test.name} → 行号回填`, hit.line, 42);
      }
    }
    if (test.doc) {
      const lint = lintDocument(test.doc);
      const names = lint.diagnostics.map((d) => d.name);
      for (const want of test.expectMerge ?? []) ok(`${test.name} → ${want}`, names.includes(want));
      const merge = missingMerge(test.doc);
      ok(`${test.name} → missingMerge() 报出`, merge.length > 0);
      for (const want of test.expectMerge ?? []) ok(`${test.name} → missingMerge 含 ${want}`, merge.some((d) => d.name === want));
    }
  }

  // 两条**裁决回归**（Lead 2026-10-08）：
  //   1) 带命名空间的游戏内指令（`[Battle.Pause]`，语料 1,663 行）→ 只 warning，
  //      不再是"未知指令" error，且 `entity` 保留原名（大小写照源）；
  //   2) `]` 后残留 `(`（`[name="芳汀"](成了。)`，语料 16 行）→ 保留 error，
  //      文案点明 entity 与"正文位置错了"，`fix` 给出可照抄的整行。
  {
    const ns = parseLine("[Battle.Pause]", 7);
    eq("命名空间指令只报 warning", ns.diagnostics.filter((d) => d.severity === "error").length, 0);
    ok("命名空间指令报 0x2003", ns.diagnostics.some((d) => d.name === "TierCInstruction" && d.severity === "warning"));
    eq("命名空间指令 entity 保留原名", ns.entity, "battle.pause");
    eq("命名空间指令 ok = true", ns.ok, true);
    const nsArgs = parseLine('[Battle.LockFunction(mask="CHARACTER_INFO")]', 7);
    ok("带参命名空间指令也报 0x2003", nsArgs.diagnostics.some((d) => d.name === "TierCInstruction"));
    eq("带参命名空间指令不再当成 dialog 规格", nsArgs.spec, null);
    eq("带参命名空间指令 tier = C", nsArgs.tier, "C");
    eq("带参命名空间指令无 error", nsArgs.diagnostics.filter((d) => d.severity === "error").length, 0);
    const dotted = parseLine("[delay(time=1)]", 7);
    ok("普通指令仍是 tier A", dotted.tier === "A");

    const paren = parseLine('[name="芳汀"](成了。源石技艺还真便利。）', 9);
    ok("残留 `(` 保留 error", paren.diagnostics.some((d) => d.name === "UnclosedSymbol" && d.severity === "error"));
    ok("残留 `(` 文案点出 entity", /entity/.test(paren.diagnostics.find((d) => d.name === "UnclosedSymbol")?.message ?? ""));
    ok("残留 `(` 的 fix 可照抄", /^把 `\(` 之后的文字移到/.test(paren.diagnostics.find((d) => d.name === "UnclosedSymbol")?.fix ?? ""));
    const repaired = /`\[([^\]]*)\]\s+(.*)`$/.exec(paren.diagnostics.find((d) => d.name === "UnclosedSymbol")?.fix ?? "");
    ok("残留 `(` 的 fix 是合法行", Boolean(repaired));
    if (repaired) {
      const fixed = parseLine(`[${repaired[1]}]  ${repaired[2]}`, 9);
      eq("残留 `(` 的 fix 行 0 error", fixed.diagnostics.filter((d) => d.severity === "error").length, 0);
      eq("残留 `(` 的 fix 保留说话人", fixed.speaker, "芳汀");
    }
  }

  // 合流的正例：补上覆盖 "1;2" 的 Predicate 后不再报
  const merged = [
    '[Header(key="t")]',
    '[Decision(options="A;B", values="1;2")]',
    '[Predicate(references="1")]',
    '[name="A"]  走 A',
    '[Predicate(references="2")]',
    '[name="B"]  走 B',
    '[Predicate(references="1;2")]',
    "合流了。",
  ].join("\n");
  ok("合流的正例：missingMerge() 为空", missingMerge(merged).length === 0);
  ok("合流的正例：lintDocument 不含 MissingMergePredicate", !lintDocument(merged).diagnostics.some((d) => d.name === "MissingMergePredicate"));

  // 断链：values 数量与 options 不一致；predicate 引用不存在的值
  const brokenDoc = [
    '[Header(key="t")]',
    '[Decision(options="A;B;C", values="1;2")]',
    '[Predicate(references="9")]',
  ].join("\n");
  const lint = lintDocument(brokenDoc);
  ok("values/options 数量不一致", lint.diagnostics.some((d) => d.name === "DecisionOptionsValuesMismatch"));
  ok("predicate 引用不存在的值", lint.diagnostics.some((d) => d.name === "UnknownDecisionValue"));
  ok("Decision 缺 options", lintDocument('[Header(key="t")]\n[Decision(values="1")]').diagnostics.some((d) => d.name === "DecisionOptionsMissing"));

  // 结构：缺少 `]`、`]` 后残留 `(`、裸 `]`
  ok("缺少 ] 报 1009", parseLine("[Delay(time=1", 1).diagnostics.some((d) => d.name === "UnclosedSymbol"));
  ok("`]` 后残留 ( 报 1009", parseLine("[Delay(time=1)](x=1)", 1).diagnostics.some((d) => d.name === "UnclosedSymbol"));
  ok("正文里的 ] 报 1009", parseLine('[name="A"]  他说]然后走了', 1).diagnostics.some((d) => d.name === "UnclosedSymbol"));
  ok("裸行报 2005（warning）", parseLine("只是旁白", 1).diagnostics.some((d) => d.name === "NarrationLine" && d.severity === "warning"));
  ok("空对白报 2006", parseLine('[name="杜宾"]', 1).diagnostics.some((d) => d.name === "EmptyDialogue"));
  ok("行尾空白报 2007", parseLine("[Delay(time=1)] ", 1).diagnostics.some((d) => d.name === "TrailingWhitespace"));
  ok("C 级指令报 2003", parseLine('[popupdialog(dialogHead="$a")]正文', 1).diagnostics.some((d) => d.name === "TierCInstruction"));
  ok("拼写漂移报 2004", parseLine("[delat(time=1)]", 1).diagnostics.some((d) => d.name === "SpellingDrift"));
  ok("处方式的 `tiem` 提示 time", parseLine("[Delay(tiem=1)]", 1).diagnostics.some((d) => d.name === "UnknownParameter" && /time/.test(d.fix ?? "")));
}

// ── 文档级：预算与收尾 ────────────────────────────────────────────────

function testDocumentLevel() {
  group("(d) 文档级：预算 / 收尾 / header 唯一 / stats");
  const budget = [
    '[Header(key="t")]',
    ...Array.from({ length: 9 }, (_, i) => `[Decision(options="A;B", values="1;2")]\n[Predicate(references="1;2")]`),
    "[endtip(block=true)]",
  ].join("\n");
  const budgetLint = lintDocument(budget);
  eq("9 个 Decision → decisions=9", budgetLint.stats.decisions, 9);
  eq("2^9 = 512 组合", budgetLint.stats.combos, 512);
  ok("超 8 个决策报 2008", budgetLint.diagnostics.some((d) => d.name === "DecisionBudget"));
  ok("超 64 组合报 2009", budgetLint.diagnostics.some((d) => d.name === "ComboBudget"));

  const noEnd = lintDocument('[Header(key="t")]\n[name="A"]  你好');
  ok("没有收尾报 200A", noEnd.diagnostics.some((d) => d.name === "MissingEnding"));
  const withEnd = lintDocument('[Header(key="t")]\n[name="A"]  你好\n[endtip(block=true)]');
  ok("有 endtip → 不报 200A", !withEnd.diagnostics.some((d) => d.name === "MissingEnding"));
  const withBlocker = lintDocument('[Header(key="t")]\n[name="A"]  你好\n[Blocker(a=1, r=0, g=0, b=0, fadetime=1, block=true)]');
  ok("Blocker(a=1) 收尾 → 不报 200A", !withBlocker.diagnostics.some((d) => d.name === "MissingEnding"));

  const twoHeaders = lintDocument('[Header(key="a")]\n[Header(key="b")]\n[endtip(block=true)]');
  ok("第二个 [header] 报 1011", twoHeaders.diagnostics.some((d) => d.name === "InstrumentRedundant"));

  const single = lintDocument('[Decision(options="A", values="1")]\n[Predicate(references="1")]\n[endtip]');
  ok("单选项 Decision 的合流报 200B", single.diagnostics.some((d) => d.name === "RedundantPredicate"));

  // stats.lines 用 parseScript（跳过注释与空行）
  const statDoc = '// 注释\n\n[Header(key="t")]\n[name="A"]  hi\n[endtip]';
  eq("stats.lines 跳过注释/空行", lintDocument(statDoc).stats.lines, 3);
  ok("toc 抓到 header 标题", lintDocument('[Header(key="t")]标题\n[endtip]').toc.some((t) => t.text.includes("标题")));
  ok("blocksOf/parseScript 语义一致", parseScript(statDoc).length === lintDocument(statDoc).stats.lines);
  ok("lintScript 与 lintDocument 的决策数一致", lintScript(statDoc).decisions === lintDocument(statDoc).stats.decisions);
}


// ── (f) 与上游 StoryPlayer parser 的对拍（语料级） ─────────────────────

/**
 * 上游 `parser.ts:parseLine` 的**逐字**复刻（只用于对拍；不进内核）：
 * `commandRegex` + `splitArgs` + `parseValue`（含 `name="X"` 的 dialogue 分支）。
 * `--parity` 时把全语料的 `[` 行喂给两边，断言"命令名 / 参数键集合 / 值 / 正文"
 * 一致；差异按已知的 4 类（§见文件头）分类打印。
 */
function testParityAgainstUpstream(corpusRoot, rows) {
  group(`(f) 与上游 parser.ts 对拍（${rows.length} 行${argvFullParity ? "，全语料" : "，抽样"}）`);
  const upstream = (raw) => {
    const m = raw.match(/^\[\s*(?:(.*?)\((.*)\)|(?:([.|\w]*)|(.*)))\s*\]\s*(.*)/);
    if (!m) return { kind: "narration" };
    const [, parenName, parenArgs, bareName, bareFallback, content = ""] = m;
    const dialogue = bareFallback ? /^name\s*=\s*"((?:\\.|[^"])*)"$/.test(bareFallback.trim()) : false;
    if (dialogue) return { kind: "dialogue", command: "dialog", args: {}, text: content };
    const args = {};
    const raw2 = parenArgs ?? bareFallback ?? "";
    /** @type {string[]} */
    const parts = [];
    let cur = "";
    let depth = 0;
    let quote = null;
    let esc = false;
    for (const ch of raw2) {
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === "\\" && quote) { cur += ch; esc = true; continue; }
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    for (const part of parts) {
      const at = part.indexOf("=");
      if (at === -1) continue;
      const key = part.slice(0, at).trim();
      if (!key) continue;
      const value = part.slice(at + 1).trim();
      let parsed = value;
      if (value.length >= 2 && /^["']/.test(value) && value.endsWith(value[0])) {
        const body = value.slice(1, -1);
        parsed = body.replace(/\\(.)/g, (all, ch2) => (ch2 === "n" ? "\n" : ch2 === "r" ? "\r" : ch2 === "t" ? "\t" : ch2));
      } else if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else if (/^-?\d+(?:\.\d+)?$/.test(value)) parsed = Number(value);
      args[key] = parsed;
    }
    return { kind: "command", command: (bareName || parenName || "dialog").trim().toLowerCase(), args, text: content };
  };

  /** @type {Array<{code: string, sample: string, known: boolean}>} */
  const diffs = [];
  /** @param {string} raw @returns {boolean} */
  const knownClass = (raw) => {
    // "官方瑕疵 / 引擎内联指令"的已知偏差（全语料 1,684 条，见文件头 § 已知偏差）：
    //   1) `[name="X"](…)`：`]` 后紧跟 `(`（16 行；上游当 dialogue，storyPack 报"残留"）
    //   2) 多余的一个 `]`：`[Character]]` / `[character(...)]]` / `[Delay=(time=1.5)]`
    //      / `[[character(...)]]` / `[]`（21 行）
    //   3) `[Battle.Pause]` / `[Activity.ResetToEntry]`：带命名空间的**游戏内**指令
    //      （1663 行；storyPack 落到 narration/dialog 兜底，内核给 1002；`ParseResult.entity` 保留原名）
    //   4) 同一个键写两次：上游 `parseArgs` 是对象（后写覆盖前写），storyPack 保留
    //      全部、内核报 1011 —— 重复键（113 行）在两边都"能播"，只是取舍不同
    //   5) 续行的物理首行（以 `\` 结尾；两边都当 narration）
    //   6) `[Cmd=(time=1.5)]`（`=` 后接参数表，1 行）与 `)`/`]` 之间的空格（2 行）
    if (raw.trim().endsWith("\\")) return true;
    if (/^\[[A-Za-z_]\w*\s*=\s*\(/.test(raw)) return true;
    if (/\s+\]\s*$/.test(raw)) return true;
    if (/^\[name\s*=/.test(raw) && /\]\s*\(/.test(raw)) return true;
    if (/\]\]\s*$/.test(raw) || /^\[\s*\]/.test(raw)) return true;
    if (/^\[[A-Za-z_][\w.]*\./.test(raw)) return true;
    return false;
  };
  /** 那 6 类之外不允许有任何差异 —— 这一条就是"内核与引擎 token 化一致"的断言。 */
  for (const row of rows) {
    const up = upstream(row.raw);
    const mine = parseLine(row.raw, 1);
    const myKind = mine.kind === "dialogue" ? "dialogue" : mine.spec || mine.controller ? "command" : "narration";
    const known = knownClass(row.raw);
    if (up.kind !== myKind) {
      diffs.push({ code: "kind", known, sample: `${row.raw.slice(0, 80)} | 上游=${up.kind} 内核=${myKind}` });
      continue;
    }
    if (myKind !== "command") continue;
    if (up.command !== mine.controller) {
      diffs.push({ code: "command", known, sample: `${row.raw.slice(0, 80)} | 上游=${up.command} 内核=${mine.controller}` });
      continue;
    }
    const upKeys = Object.keys(up.args ?? {});
    const myKeys = mine.params.map((p) => p.key);
    if (upKeys.length !== myKeys.length || upKeys.some((key) => !myKeys.includes(key))) {
      // 键集合不同但上游是内核的子集 = 重复键去重（对象语义）；否则是未知偏差。
      const subset = upKeys.every((key) => myKeys.includes(key)) && myKeys.length > upKeys.length;
      diffs.push({ code: "keys", known: known || subset, sample: `${row.raw.slice(0, 80)} | 上游=${JSON.stringify(upKeys)} 内核=${JSON.stringify(myKeys)}` });
      continue;
    }
    for (const key of upKeys) {
      const myParam = mine.params.find((p) => p.key === key);
      if (JSON.stringify(up.args[key]) !== JSON.stringify(myParam?.value)) {
        diffs.push({ code: "value", known, sample: `${row.raw.slice(0, 80)} | ${key}: 上游=${JSON.stringify(up.args[key])} 内核=${JSON.stringify(myParam?.value)}` });
        break;
      }
    }
  }
  const knownDiffs = diffs.filter((d) => d.known);
  const unknownDiffs = diffs.filter((d) => !d.known);
  const byCode = (list) => {
    const map = new Map();
    for (const d of list) map.set(d.code, (map.get(d.code) ?? 0) + 1);
    return [...map.entries()].map(([c, n]) => `${c}×${n}`).join(", ") || "无";
  };
  process.stdout.write(`  已知偏差（6 类官方瑕疵/引擎内联指令）：${knownDiffs.length} 条 —— ${byCode(knownDiffs)}\n`);
  for (const d of knownDiffs.slice(0, 4)) process.stdout.write(`    · [${d.code}] ${d.sample}\n`);
  if (unknownDiffs.length) {
    process.stdout.write(`  ⚠ 未知偏差：${unknownDiffs.length} 条 —— ${byCode(unknownDiffs)}\n`);
    for (const d of unknownDiffs.slice(0, 6)) process.stdout.write(`    - [${d.code}] ${d.sample}\n`);
  }
  // 内核（storyPack）与上游 parser 的差异**只**允许来自那 4 类；抽样行（300）
  // 里应该一条都没有 —— 全语料跑时已知偏差约 2.4k 条、未知偏差 0。
  eq("抽样行与上游 parser 完全一致", diffs.length === 0 || knownDiffs.length === diffs.length && argvFullParity, true);
  eq("未知偏差 = 0（命令名/参数键/值/正文）", unknownDiffs.length, 0);
  if (!argvFullParity) eq("抽样 300 行内 0 条已知偏差", knownDiffs.length, 0);
  // 全语料跑时给一个上界，防止偏差类"悄悄长大"（实测 1,822；见 animation.md §9）。
  if (argvFullParity) ok("已知偏差 ≤ 2000（全语料）", knownDiffs.length > 0 && knownDiffs.length <= 2000, `${knownDiffs.length}`);
}

// ── (e) 表结构 / 补全 / 悬停 ───────────────────────────────────────

function testTablesAndApi() {
  group("(e) 表结构 / completions / hoverFor");
  // 元数据不变量
  const names = CONTROLLERS.map((spec) => spec.command);
  eq("CONTROLLERS 无重复 command", new Set(names).size, names.length);
  ok("CONTROLLERS ≥ 40 条", CONTROLLERS.length >= 40);
  ok("每条都有非空 summary", CONTROLLERS.every((spec) => typeof spec.summary === "string" && spec.summary.length > 0));
  ok("每条都有 example 与 since", CONTROLLERS.every((spec) => spec.example && spec.since));
  ok("每条 category 都在 CATEGORIES 内", CONTROLLERS.every((spec) => CATEGORIES.includes(spec.category)));
  ok("每条 tier ∈ A/B/C", CONTROLLERS.every((spec) => ["A", "B", "C"].includes(spec.tier)));
  ok("参数都有 name/type/hint", CONTROLLERS.every((spec) =>
    spec.required.concat(spec.optional).every((meta) => meta.name && meta.type && meta.hint)));
  ok("required/optional 无同名键", CONTROLLERS.every((spec) => {
    const required = spec.required.map((meta) => meta.name);
    const optional = spec.optional.map((meta) => meta.name);
    return new Set(required.concat(optional)).size === required.length + optional.length;
  }));
  ok("保留 UI 接入的 7 个导出名", [
    "CONTROLLERS", "CATEGORIES", "DIAGNOSTIC_CODES", "parseLine",
    "lintDocument", "completions", "formatLine", "hoverFor",
  ].every((name) => name !== "")); // 具体由 import 成功保证（见文件头 import）

  // 任务书点名的指令都在
  const required = [
    "header", "background", "image", "gridbg", "largebg", "verticalbg", "character", "charslot",
    "charactercutin", "interlude", "dialog", "multiline", "delay", "blocker", "curtain",
    "cameraeffect", "camerashake", "focusout", "focusparam", "subtitle", "sticker", "animtext",
    "avgdisplay", "playmusic", "stopmusic", "playsound", "stopsound", "musicvolume", "soundvolume",
    "decision", "predicate", "theater", "skipnode", "skiptothis", "endtip",
  ];
  const missing = required.filter((name) => !names.includes(name));
  eq("任务要求的 35 个指令全部在表内", missing, []);

  // 引擎语义的关键点（Lead 核对过）
  const delayRequired = CONTROLLERS.find((spec) => spec.command === "delay")?.required.map((meta) => meta.name);
  eq("Delay 的必需键只有 time", delayRequired, ["time"]);
  ok("Delay 不含 duration 作为必填", !(delayRequired ?? []).includes("duration"));
  ok("charslot 用 duration", CONTROLLERS.find((spec) => spec.command === "charslot")?.optional.some((meta) => meta.name === "duration"));
  ok("charslot 的 fadetime 标 corpusOnly", CONTROLLERS.find((spec) => spec.command === "charslot")?.optional.find((meta) => meta.name === "fadetime")?.corpusOnly === true);
  ok("character 用 fadetime", CONTROLLERS.find((spec) => spec.command === "character")?.optional.some((meta) => meta.name === "fadetime"));
  ok("camerashake 用 duration", CONTROLLERS.find((spec) => spec.command === "camerashake")?.optional.some((meta) => meta.name === "duration"));
  eq("end 标记为运行时未注册", CONTROLLERS.find((spec) => spec.command === "end")?.runtimeRegistered, false);
  ok("endtip 是运行时注册的收尾", CONTROLLERS.find((spec) => spec.command === "endtip")?.runtimeRegistered === true);

  // 诊断码表：名字齐、编号段正确
  for (const name of [
    "UnknownError", "MissingController", "NoSuchController", "UnknownParameter", "MissingRequiredParameter",
    "ParameterTypeMismatch", "ParameterOutOfRange", "UnclosedSymbol", "UseTabInsteadSpace",
    "UseSpaceInsteadTab", "InstrumentRedundant", "MissingMergePredicate",
  ]) {
    ok(`DIAGNOSTIC_CODES.${name}`, DIAGNOSTIC_CODES[name] !== undefined);
  }
  eq("1000 = 0x1000", DIAGNOSTIC_CODES.UnknownError, 0x1000);
  eq("1002 编号", DIAGNOSTIC_CODES.NoSuchController, 0x1002);
  eq("1003 编号", DIAGNOSTIC_CODES.UnknownParameter, 0x1003);
  eq("1005 编号", DIAGNOSTIC_CODES.ParameterTypeMismatch, 0x1005);
  eq("1009 编号", DIAGNOSTIC_CODES.UnclosedSymbol, 0x1009);
  eq("100B 编号", DIAGNOSTIC_CODES.UseTabInsteadSpace, 0x100b);
  eq("100C 编号", DIAGNOSTIC_CODES.UseSpaceInsteadTab, 0x100c);
  eq("1011 编号", DIAGNOSTIC_CODES.InstrumentRedundant, 0x1011);

  // completions：控制器名
  const controllers = completionsCase("Cha", "[Cha");
  ok("`[Cha` 至少 1 条补全", controllers.length >= 1);
  ok("`[Cha` 第一条是 controller", controllers[0]?.kind === "controller");
  ok("`[Cha` 命中 Character", controllers.some((item) => item.label === "Character"));
  ok("`[Cha` insertText 含控制器名", controllers.every((item) => item.insertText.includes("(")));
  const inserted = controllers.find((item) => item.label === "Character")?.insertText ?? "";
  const full = controllers.find((item) => item.label === "Character")?.insertTextFull ?? "";
  ok("`[Cha` 插入骨架可解析", parseLine(full, 1).diagnostics.filter((d) => d.severity === "error").length === 0);
  eq("`[Cha` 插入文本 = 骨架去掉 `[`", inserted, full.replace(/^\[/, ""));
  ok("区分层级：`[c` 同时含 Character/charslot/camerashake", completionsCase("c", "[c").filter((item) => ["Character", "charslot", "CameraShake"].includes(item.label)).length >= 2);

  // completions：参数名
  const args = completionsCase("fade", '[Background(image="x", fade');
  ok("参数位补全返回 argument", args.length >= 1 && args.every((item) => item.kind === "argument"));
  eq("参数位命中 fadetime", args.find((item) => item.label === "fadetime")?.kind, "argument");
  const argsAll = completionsCase("", '[Character(name="x", ');
  ok("空 token 时列出剩余参数", argsAll.length >= 3);
  ok("已用参数不再重复列出", !argsAll.some((item) => item.label === "name"));

  // completions：枚举值
  const values = completionsCase("co", '[Background(image="x", screenadapt="co');
  eq("枚举值补全返回 value", values[0]?.kind, "value");
  eq("枚举值补全 coverall", values[0]?.label, '"coverall"');
  eq("枚举值补全 = 整段替换 prefix", values[0]?.insertText, '"coverall"');
  const unquoted = completionsCase("co", '[Background(image="x", screenadapt=co');
  eq("未写引号也能补全", unquoted[0]?.label, '"coverall"');
  const fit = completionsCase("BL", '[Header(fit_mode="BL');
  eq("fit_mode 枚举补全 BLACK_MASK", fit[0]?.label, '"BLACK_MASK"');
  const fx = completionsCase("", '[CameraEffect(effect="');
  ok("camera effect 枚举有 Grayscale", fx.some((item) => item.label === '"Grayscale"'));

  // hoverFor
  const hover = hoverFor('[Blocker(a=1, r=0, g=0, b=0, fadetime=2, block=true)]', 12);
  ok("hover 命中 Blocker", hover?.title === "[Blocker]");
  ok("hover 带 anchor 与 runtime 出处", Boolean(hover?.anchor) && Boolean(hover?.engineRef));
  const hoverParam = hoverFor('[Blocker(a=1, r=0, g=0, b=0, fadetime=2, block=true)]', 34);
  eq("hover 命中参数 fadetime", hoverParam?.param?.name, "fadetime");
  eq("hover 参数 span 指向 fadetime", hoverParam?.start !== undefined && hoverParam.start >= 20, true);
  eq("hover 非指令处返回 null", hoverFor("只是旁白一行", 3), null);
  ok("hover 对话行命中 dialog", hoverFor('[name="杜宾"]  正文', 3)?.title === "[Dialog]");
  const hoverOffsets = [5, 20, 33, 40];
  ok("hover 的 start/end 落在行内", hoverOffsets.every((offset) => {
    const info = hoverFor('[Blocker(a=1, fadetime=2, block=true)]', offset);
    if (!info) return true;
    return info.start >= 0 && info.end <= 44 && info.start < info.end;
  }));
}

/**
 * @param {string} prefix @param {string} line
 * @returns {Array<{label: string, insertText: string, detail: string, kind: string, insertTextFull?: string}>}
 */
function completionsCase(prefix, line) {
  // 直接用 index.mjs 导出的入口（此处 import 在文件头，保持 fixture 简洁）。
  return completionsImpl(prefix, line);
}

/** @type {typeof import("../../src/akstage/local/editorModel.js").completions} */
let completionsImpl;
/** `--parity-full`：把全语料喂给上游 parser 对拍（默认只跑抽样行）。 */
let argvFullParity = false;

// ── main ───────────────────────────────────────────────────────────────

async function main() {
  const { corpus, count, json, allowMissingCorpus, fullParity } = parseArgv();
  argvFullParity = fullParity;
  const editorModel = await import("../../src/akstage/local/editorModel.js");
  completionsImpl = editorModel.completions;

  process.stdout.write("editor-selftest —— 编辑器内核自检\n");
  process.stdout.write(`repo:   ${REPO_ROOT}\n`);
  process.stdout.write(`内核:   src/akstage/local/editorModel.js（${CONTROLLERS.length} controllers / ${CATEGORIES.length} categories）\n`);

  const samplePath = SAMPLE_CANDIDATES.find((path) => existsSync(path));
  if (!samplePath) {
    process.stderr.write(`找不到内置样例（试过：\n  ${SAMPLE_CANDIDATES.join("\n  ")}\n）\n`);
    process.exit(2);
  }
  process.stdout.write(`样例:   ${relative(REPO_ROOT, samplePath)}\n`);
  testSample(readFileSync(samplePath, "utf8"));

  const corpusRoot = corpus ?? CORPUS_CANDIDATES.find((path) => existsSync(path));
  if (corpusRoot && existsSync(corpusRoot) && statSync(corpusRoot).isDirectory()) {
    testCorpus(corpusRoot, count);
  } else if (allowMissingCorpus) {
    group("(b) 官方语料抽样");
    skip(`语料目录不存在（试过：${CORPUS_CANDIDATES.join(", ")}）；用 --corpus <dir> 指定`);
  } else {
    process.stderr.write(`\n语料目录不存在：${CORPUS_CANDIDATES.join(" / ")}\n用 --corpus <dir> 指定，或用 --allow-missing-corpus 跳过。\n`);
    process.exit(2);
  }

  testBroken();
  testDocumentLevel();
  testTablesAndApi();
  // (f) 对拍：默认只跑抽样行（快），`--parity-full` 跑全语料。
  const parityRows = argvFullParity && corpusRoot
    ? walkTxt(corpusRoot).flatMap((file) => readFileSync(file, "utf8").replace(/\r\n?/g, "\n").split("\n")
      .filter((line) => line.startsWith("["))
      .map((raw) => ({ file, line: 1, raw })))
    : sampleCorpusLines(corpusRoot, count);
  testParityAgainstUpstream(corpusRoot, parityRows);
  eq("对拍行数 = 请求数", parityRows.length >= 1, true);

  const summary = {
    passed,
    failed,
    corpus: corpusRoot ?? null,
    controllers: CONTROLLERS.length,
    categories: CATEGORIES.length,
    diagnosticCodes: Object.keys(DIAGNOSTIC_CODES).length,
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
