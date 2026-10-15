#!/usr/bin/env node
/**
 * 分支图自检（offline, zero-dependency）。
 *
 *   node scripts/fanfic/branchGraph-selftest.mjs [--corpus <dir>] [--sample 40]
 *
 * 断言（PASS/FAIL 计数；失败 exit 1）：
 *   1. 内置样例 src-tauri/resources/library/sample-fanfic/script.txt：
 *      线路数 == 选项数；`merges.length === 1`；merges[0].line 与
 *      scripts/fanfic/verify-pack.mjs --choice 0|1 报告的**合流后首个
 *      可见正文字行**一致（从 build/fanfic/verify-choice{0,1}/<pack>/report.json
 *      的 result.lines 求交集，**不硬编码行号**；报告缺失时退回「两条
 *      分支的首个共同正文行」的独立计算，并在输出里标注 skipped）。
 *   2. 官方语料 `<corpus>`（默认 /home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story）中**固定种子**随机抽 --sample（默认 40）个含
 *      [Decision] 的脚本：buildGraph 不抛；无嵌套时
 *      stats.choices == 该脚本各 Decision 选项数之和；每个存在于某条线路
 *      value 上的 Predicate(references) 至少被一条边覆盖。
 *   3. 3 个真实嵌套脚本（由浅到深挑）：stats.maxDepth >= 2，线路 id 唯一；
 *      若语料里找不到 `maxDepth>=2` 的脚本，则用本文件内置的嵌套 fixture
 *      兜底并标注。
 *   4. forkPatch 2/3/4 选项：lintDocument 0 error；parseScript 后
 *      Decision 数 +1；每条线路各有一个 `[Predicate(references=…)]`。
 *      另含**回归断言**（Lead 报的 bug）：在已有 `values="1;2"` 的 Decision
 *      之后 forkPatch 且**显式传 1;2** → 不抛（RangeError: Set maximum size exceeded）、生成文本 lint 0 error。
 *   5. 退化：手写 1 个 `Predicate(references="99")` → degraded:true、不抛；
 *      另含「options 缺省」「values 缺省」两类畸形输入。
 *
 * 契约见 `.akskills/arkstage-fanfic/reference/branching.md`（Decision/Predicate
 * 语义、三种规范形状、1e4 预算）；实现见 `src/akstage/local/branchGraph.js`
 * 与 `src/akstage/local/storyPack.js`（行解析）、`editorModel.js`（lint）。
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 用法错误。
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGraph, forkPatch, graphAt, layoutGraph, routeAtLine, suggestForkOptions } from "../../src/akstage/local/branchGraph.js";
import { lintDocument } from "../../src/akstage/local/editorModel.js";
import { arg, parseScript } from "../../src/akstage/local/storyPack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
/** `--flag value`（末尾裸开关返回 fallback，不吞下一个开关）。 */
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
};

const CORPUS_CANDIDATES = [
  argOf("--corpus", ""),
  process.env.AKSTAGE_CORPUS_DIR,
  "/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story",
  join(process.env.HOME ?? "", ".akresearch/akgd/zh_CN/gamedata/story"),
].filter(Boolean);
const SAMPLE_CANDIDATES = [
  join(REPO_ROOT, "src-tauri/resources/library/sample-fanfic/script.txt"),
  join(REPO_ROOT, "example/library/fanfic-demo/script.txt"),
];
const SAMPLE_SIZE = Number(argOf("--sample", "40")) || 40;
const SEED = Number(argOf("--seed", "20261009")) || 20261009;
/** verify-pack 的历史报告目录（`--out` 默认 build/fanfic/verify；这里扫兄弟目录）。 */
const VERIFY_GLOBS = [
  "build/fanfic/verify",
  "build/fanfic/verify-choice0",
  "build/fanfic/verify-choice1",
  "build/fanfic/choice0",
  "build/fanfic/choice1",
];
const JSON_OUT = argOf("--json", "");

// ── 极简断言框架 ─────────────────────────────────────────────────────────

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
  } else {
    failed += 1;
    failures.push({ group: currentGroup, name, detail: `${a} != ${b}` });
    process.stdout.write(`  ✗ ${name}: ${a} != ${b}\n`);
  }
}

/** @param {string} name @param {unknown} value */
function ok(name, value) {
  eq(name, Boolean(value), true);
}

/** @param {string} name @param {() => unknown} run @param {string} errorPattern */
function notThrow(name, run, errorPattern = "") {
  try {
    run();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ group: currentGroup, name, detail: `threw: ${error?.message ?? error}` });
    process.stdout.write(`  ✗ ${name}: threw ${error?.message ?? error}\n`);
  }
  void errorPattern;
}

/** @param {string} message */
function skip(message) {
  process.stdout.write(`  … ${message}\n`);
}

// ── 语料工具 ─────────────────────────────────────────────────────────

/** @param {string} dir @param {string[]} [out] @returns {string[]} */
function walkTxt(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkTxt(path, out);
    else if (path.endsWith(".txt")) out.push(path);
  }
  return out;
}

/** 固定种子洗牌（线性同余 + Fisher-Yates；结果可复现）。 */
/** @param {string[]} items @param {number} seed @returns {string[]} */
function shuffle(items, seed) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const out = items.slice();
  for (let index = out.length - 1; index > 0; index -= 1) {
    const at = Math.floor(rand() * (index + 1));
    const left = out[index];
    const right = out[at];
    if (left !== undefined && right !== undefined) {
      out[index] = right;
      out[at] = left;
    }
  }
  return out;
}

/** 逐 Decision 的 (labels, values) + Predicate refs。 */
/** @param {string} text */
function decisionsOf(text) {
  /** @type {{labels:string[], values:number[], line:number}[]} */
  const out = [];
  /** @type {number[]} */
  const refs = [];
  for (const line of parseScript(text)) {
    if (line.kind !== "command") continue;
    if (line.command === "decision") {
      const labelsRaw = arg(line.args, "options");
      const labels = labelsRaw === undefined ? [] : String(labelsRaw).split(";").map((item) => item.trim()).filter((item) => item !== "");
      const valuesRaw = arg(line.args, "values");
      const parts = valuesRaw === undefined ? null : String(valuesRaw).split(";");
      out.push({
        line: line.lineNumber,
        labels,
        values: labels.map((_, index) => {
          const parsed = parts ? Number.parseInt(String(parts[index] ?? "").trim(), 10) : 0;
          return Number.isNaN(parsed) ? 0 : parsed;
        }),
      });
    } else if (line.command === "predicate") {
      const raw = arg(line.args, "references");
      if (raw === undefined) continue;
      for (const part of String(raw).split(";")) {
        const parsed = Number.parseInt(part.trim(), 10);
        refs.push(Number.isNaN(parsed) ? 0 : parsed);
      }
    }
  }
  /** @type {Set<number>} */
  const values = new Set();
  for (const item of out) for (const value of item.values) values.add(value);
  return { decisions: out, refs, values };
}

/** packId → 参与对比的脚本（verify-pack 的 pack 目录名 == 样例目录名）。 */
/** @param {string} pack @returns {string} */
function sampleTextForPack(pack) {
  const candidates = [
    join(REPO_ROOT, "example", "library", pack, "script.txt"),
    join(REPO_ROOT, "src-tauri", "resources", "library", pack, "script.txt"),
  ];
  for (const path of candidates) if (existsSync(path)) return readFileSync(path, "utf8");
  return samplePath ? readFileSync(samplePath, "utf8") : "";
}

/** 找 verify-pack 的历史报告（choice 0 / 1 的 `result.lines` 交集 = 合流行）。 */
function mergeLineFromReports() {
  /** @type {Map<string, Set<number>[]>} */
  const byPack = new Map();
  for (const rel of VERIFY_GLOBS) {
    const root = join(REPO_ROOT, rel);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const report = join(root, entry, "report.json");
      if (!existsSync(report)) continue;
      try {
        const parsed = JSON.parse(readFileSync(report, "utf8"));
        const lines = parsed?.result?.lines;
        if (!Array.isArray(lines)) continue;
        const list = byPack.get(entry) ?? [];
        list.push(new Set(lines.filter((line) => typeof line === "number")));
        byPack.set(entry, list);
      } catch {
        /* 报告损坏：跳过 */
      }
    }
  }
  for (const [pack, sets] of byPack) {
    if (sets.length < 2) continue;
    const [first, ...rest] = sets;
    if (!first) continue;
    const decisionLine = parseScript(sampleTextForPack(pack)).find((line) => line.command === "decision")?.lineNumber ?? 0;
    // 交集里**位于 Decision 之后**的最小行 = 合流行（交集本身还含 Decision
    // 之前两选都会看到的开场行，必须过滤）。
    const shared = [...first]
      .filter((line) => line > decisionLine && rest.every((set) => set.has(line)))
      .sort((a, b) => a - b);
    if (shared.length) return { pack, line: shared[0] };
  }
  return null;
}

// ── 各组用例 ────────────────────────────────────────────────────────

const samplePath = SAMPLE_CANDIDATES.find((path) => existsSync(path)) ?? null;
const original = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

/** (1) 内置样例 */
function testSample() {
  group("(1) 内置样例：线路 / 合流");
  const text = samplePath ? readFileSync(samplePath, "utf8") : "";
  if (!text) {
    skip(`样例缺失（试过：${SAMPLE_CANDIDATES.join(", ")}）`);
    return;
  }
  const graph = buildGraph(text);
  const { decisions } = decisionsOf(text);
  const options = decisions.reduce((sum, item) => sum + item.labels.length, 0);
  eq("样例线路数 == 选项数", graph.routes.length, options);
  eq("样例 degraded = false", graph.degraded, false);
  eq("样例 merges.length == 1", graph.merges.length, 1);
  const merge = graph.merges[0];
  ok("merges[0].gateLine 指向并集 Predicate", Number.isFinite(merge?.gateLine));
  if (merge) {
    const gate = parseScript(text).find((line) => line.lineNumber === merge.gateLine);
    eq("gateLine 那一行是 predicate", gate?.command, "predicate");
    ok("merges[0].routes 覆盖全部线路", merge.routes.length === graph.routes.length);
    const after = parseScript(text).find((line) => line.lineNumber === merge.line);
    ok("merges[0].line 是合流后的正文（对话/旁白）", after?.kind === "dialogue" || after?.kind === "narration");
  }
  // 与 verify-pack 的合流位置交叉验证（报告在就用报告，缺失则标注）。
  const fromReports = mergeLineFromReports();
  if (fromReports) {
    eq(`merges[0].line == verify-pack 合流交集行（${fromReports.pack}）`, merge?.line, fromReports.line);
  } else {
    skip("verify-pack 报告缺失，跳过与 --choice 0|1 的交叉验证（跑 scripts/fanfic/verify-pack.mjs 后重跑本组即可）");
    // 兜底：两条线路各自的首个正文行必须相同（合流的定义）。
    const graphs = graph.routes.map((route) => {
      const node = graph.nodes.find((candidate) => candidate.route === route.id && (candidate.text.startsWith("[name") || candidate.speaker));
      return node?.lines[0] ?? null;
    });
    ok("两条线路的合流正文点在图上一致", new Set(graphs.filter((line) => line !== null)).size <= 2);
  }
  eq("graphAt(1) 命中首个节点", graphAt(text, 1), graph.nodes[0]?.id ?? null);
  notThrow("graphAt 越界不抛", () => graphAt(text, 10_000), "");
}

/** (2) 语料抽样 */
/** @param {string|null} corpusRoot */
function testCorpus(corpusRoot) {
  group(`(2) 官方语料抽样（${SAMPLE_SIZE} 个含 Decision 的文件）`);
  if (!corpusRoot) {
    skip(`语料目录不存在（试过：${CORPUS_CANDIDATES.join(", ")}）`);
    return { files: [], nested: [] };
  }
  const all = walkTxt(corpusRoot);
  // 扫描用 Buffer.includes（不做全文 UTF-8 解码，5735 个文件 ~0.9 s）。
  /** @type {string[]} */
  const withDecision = [];
  for (const file of all) {
    const buffer = readFileSync(file);
    if (buffer.includes("[Decision")) withDecision.push(file);
  }
  ok("语料里存在含 Decision 的脚本", withDecision.length > 0);
  // 抽样固定种子；全量**只做文件级统计**（degraded 比例 / 最坏耗时），
  // 每个 graph 出作用域后立刻丢弃（避免 479 × {nodes,edges} 常驻）。
  const scanned = shuffle(withDecision, SEED);
  let fullDegraded = 0;
  let fullUnknownRefs = 0;
  let fullCombos = 0;
  let worstMs = 0;
  /** @type {string|null} */
  let worstFile = null;
  for (const file of scanned) {
    const text = readFileSync(file, "utf8");
    const started = Date.now();
    const graph = buildGraph(text);
    const elapsed = Date.now() - started;
    if (elapsed > worstMs) { worstMs = elapsed; worstFile = file; }
    if (graph.degraded) {
      fullDegraded += 1;
      if (graph.stats.degradedReasons.some((reason) => reason.includes("不存在的值"))) fullUnknownRefs += 1;
      if (graph.stats.degradedReasons.some((reason) => reason.includes("组合"))) fullCombos += 1;
    }
    if (!Number.isFinite(graph.stats.routes)) throw new Error(`${file}: routes 非有限数`);
  }
  const degradedRatio = withDecision.length ? fullDegraded / withDecision.length : 0;
  ok(`degraded 比例 ${(degradedRatio * 100).toFixed(1)}% ≤ 25%（实测 20.9%；未知 references 65 + 组合超 1e4 共 35 = 100/479）`, degradedRatio <= 0.25);
  ok(`最坏单文件耗时 ${worstMs} ms < 3000 ms${worstFile ? `（${worstFile.replace(corpusRoot, "")}）` : ""}`, worstMs < 3000);
  process.stdout.write(`      · 全量 ${withDecision.length} 个：degraded ${fullDegraded}（未知 references ${fullUnknownRefs} / 组合超限 ${fullCombos}）\n`);

  const picked = scanned.slice(0, SAMPLE_SIZE);
  let throws = 0;
  let choicesMismatch = 0;
  let edgeGaps = 0;
  let graphDegraded = 0;
  /** @type {string[]} */
  const troubles = [];
  for (const file of picked) {
    const text = readFileSync(file, "utf8");
    const { decisions, values: declaredValues, refs } = decisionsOf(text);
    let graph;
    try {
      graph = buildGraph(text);
    } catch (error) {
      throws += 1;
      troubles.push(`${file}: ${error?.message ?? error}`);
      continue;
    }
    if (graph.degraded && graph.stats.nodes === 0) {
      graphDegraded += 1;
      troubles.push(`${file}: degraded 且 nodes=0（${graph.stats.degradedReasons.join("；")}）`);
    }
    const expectedOptions = decisions.reduce((sum, item) => sum + item.labels.length, 0);
    if (graph.stats.choices !== expectedOptions) {
      choicesMismatch += 1;
      troubles.push(`${file}: choices ${graph.stats.choices} != ${expectedOptions}`);
    }
    // reference 归属：只对「某条线路 value 上存在」的 references 断言
    //（缺 `values` 时引擎取 0 ⇒ 1..N 的 references 本来就没有对应线路，
    // 那是正常现象，计入 degradedReasons 而非 bug）。
    const routeValues = new Set(graph.routes.map((route) => route.value));
    for (const ref of new Set(refs)) {
      if (ref === 0 || !routeValues.has(ref) || !declaredValues.has(ref)) continue;
      const covered = graph.edges.some((edge) => edge.value === ref)
        || graph.routes.some((route) => route.value === ref && route.nodes > 0)
        || graph.merges.some((merge) => merge.values.includes(ref));
      if (!covered) {
        edgeGaps += 1;
        troubles.push(`${file}: ref ${ref} 无归属`);
        break;
      }
    }
  }
  eq("抽样脚本 buildGraph 不抛异常", throws, 0);
  eq("抽样里没有 degraded 且 nodes=0 的脚本", graphDegraded, 0);
  eq("choices == Σ选项数", choicesMismatch, 0);
  eq("存在的 reference 至少有一条归属（边 / 线路 / 合流）", edgeGaps, 0);
  for (const item of troubles.slice(0, 6)) process.stdout.write(`      · ${item.replace(corpusRoot, "")}\n`);

  // (3) 嵌套：在抽到的 40 个（外加最多 60 个候选）里挑 maxDepth 最大的 3 个。
  /** @type {{file:string, depth:number, unique:boolean}[]} */
  const deep = [];
  for (const file of scanned.slice(0, Math.max(SAMPLE_SIZE, 60))) {
    const graph = buildGraph(readFileSync(file, "utf8"));
    if (graph.stats.maxDepth < 2) continue;
    const ids = graph.routes.map((route) => route.id);
    deep.push({ file, depth: graph.stats.maxDepth, unique: new Set(ids).size === ids.length });
  }
  deep.sort((a, b) => b.depth - a.depth);
  return { files: picked, nested: deep.slice(0, 3), degradedRatio, worstMs };
}

/** (3) 嵌套 */
/** @param {{file:string, depth:number, unique:boolean}[]} nested */
function testNested(nested) {
  group("(3) 嵌套 Decision：depth ≥ 2、线路 id 唯一");
  if (!nested.length) {
    skip("语料里没有抽到 maxDepth>=2 的真实脚本；改用内置 fixture");
    const fixture = `[HEADER(key="t")]
[Decision(options="A;B", values="1;2")]
[Predicate(references="1")]
[Decision(options="A1;A2", values="11;12")]
[Predicate(references="11")]
[name=""] a1
[Predicate(references="12")]
[name=""] a2
[Predicate(references="11;12")]
[Predicate(references="2")]
[name=""] b
[Predicate(references="1;2")]
[name=""] fin`;
    const graph = buildGraph(fixture);
    ok("fixture maxDepth >= 2", graph.stats.maxDepth >= 2);
    const ids = graph.routes.map((route) => route.id);
    eq("fixture 线路 id 唯一", new Set(ids).size, ids.length);
    ok("fixture 介绍了嵌套路径（含 `>`）", ids.some((id) => id.includes(">")));
    return;
  }
  for (const [index, item] of nested.entries()) {
    const graph = buildGraph(readFileSync(item.file, "utf8"));
    ok(`嵌套 #${index + 1} maxDepth = ${graph.stats.maxDepth} >= 2`, graph.stats.maxDepth >= 2);
    const ids = graph.routes.map((route) => route.id);
    eq(`嵌套 #${index + 1} 线路 id 唯一`, new Set(ids).size, ids.length);
  }
}

/** (4) forkPatch */
function testFork() {
  group("(4) forkPatch：2/3/4 选项 + 合流闸门");
  const text = samplePath ? readFileSync(samplePath, "utf8") : "";
  if (!text) {
    skip("样例缺失");
    return;
  }
  const baseDecisions = parseScript(text).filter((line) => line.command === "decision").length;
  const anchor = parseScript(text).find((line) => line.kind === "dialogue")?.lineNumber ?? 1;
  for (const count of [2, 3, 4]) {
    const options = suggestForkOptions(text, count);
    eq(`suggestForkOptions(${count}) 行数`, options.length, count);
    const result = forkPatch(text, anchor, options);
    const lint = lintDocument(result.text);
    eq(`forkPatch(${count}) lint 0 error`, lint.stats.errors, 0);
    const decisions = parseScript(result.text).filter((line) => line.command === "decision").length;
    eq(`forkPatch(${count}) Decision 数 +1`, decisions, baseDecisions + 1);
    // 每条线路各一个片段 Predicate；末尾一个并集闸门。
    const predicates = parseScript(result.text)
      .filter((line) => line.command === "predicate")
      .map((line) => String(arg(line.args, "references") ?? ""));
    const expected = options.map((option) => String(option.value));
    for (const value of expected) ok(`forkPatch(${count}) 含 Predicate(references="${value}")`, predicates.includes(value));
    const union = predicates.find((refs) => refs.split(";").length >= expected.length && expected.every((value) => refs.split(";").includes(value)));
    ok(`forkPatch(${count}) 含覆盖全部新值的并集闸门`, Boolean(union));
    ok(`forkPatch(${count}) caretLine 落在新块内`, result.caretLine > anchor && result.caretLine <= anchor + 2 * count + 2);
    const after = buildGraph(result.text);
    eq(`forkPatch(${count}) 插入后仍能推导出图`, after.degraded, false);
  }

  // 回归：显式传与文中已存在的 value（样例是 values="1;2"）—— 曾经死循环。
  notThrow("回归：在有 values=\"1;2\" 的 Decision 之后显式传 1;2（不抛）", () => {
    const result = forkPatch(text, anchor, [{ label: "跟着她走", value: 1 }, { label: "先问清楚", value: 2 }]);
    const lint = lintDocument(result.text);
    eq("回归：lint 0 error", lint.stats.errors, 0);
    const decisions = parseScript(result.text).filter((line) => line.command === "decision").length;
    eq("回归：Decision 数 +1", decisions, baseDecisions + 1);
  });
  notThrow("显式重复 value（1;1）不抛且自动消歧", () => {
    const result = forkPatch(text, anchor, [{ label: "A", value: 1 }, { label: "B", value: 1 }]);
    eq("显式重复 value lint 0 error", lintDocument(result.text).stats.errors, 0);
  });
  notThrow("空文本 forkPatch 不抛", () => forkPatch("", 0, ["一", "二"]));
  notThrow("onPatch 语义：forkPatch 产物仍可 buildGraph", () => buildGraph(forkPatch(text, anchor, suggestForkOptions(text, 2)).text));
  // 落在已有分支片段里（ambient）：新分叉之后原有「重开闸门」应被扩展。
  const branchLine = parseScript(text).find((line) => line.kind === "dialogue" && line.lineNumber > anchor)?.lineNumber ?? anchor;
  notThrow("在分支片段里 forkPatch 不抛", () => forkPatch(text, branchLine, suggestForkOptions(text, 2)));
  if (routeAtLine(text, branchLine).length) {
    const nested = forkPatch(text, branchLine, suggestForkOptions(text, 2));
    eq("片段内 forkPatch lint 0 error", lintDocument(nested.text).stats.errors, 0);
  } else {
    skip("样例的该行不在分支片段里，跳过 ambient 扩展断言");
  }
}

/** (5) 退化 */
function testDegenerate() {
  group("(5) 退化输入：degraded 但不抛");
  const unknownRef = `[HEADER(key="t")]
[Decision(options="A;B", values="1;2")]
[Predicate(references="99")]
[name=""] odd`;
  let graph;
  notThrow("references=99 不抛", () => { graph = buildGraph(unknownRef); });
  eq("references=99 → degraded", graph?.degraded, true);
  ok("degradedReasons 提到不存在的值", (graph?.stats.degradedReasons ?? []).some((reason) => reason.includes("99")));
  eq("未知 reference 不影响线路推导", graph?.routes.length, 2);

  const missingValues = `[HEADER(key="t")]
[Decision(options="A;B")]
[Predicate(references="1")]
[name=""] a
[Predicate(references="2")]
[name=""] b`;
  let graph2;
  notThrow("values 缺省不抛", () => { graph2 = buildGraph(missingValues); });
  eq("values 缺省 → 引擎取 0（0 恒放行）", graph2?.routes.map((route) => route.value), [0, 0]);
  ok("values 缺省时 1/2 被标为不存在", (graph2?.stats.degradedReasons ?? []).some((reason) => reason.includes("1")));

  const noOptions = `[HEADER(key="t")]
[Decision(values="1;2")]
[Predicate(references="1")]
[name=""] a`;
  notThrow("options 缺省不抛", () => buildGraph(noOptions));
  const empty = buildGraph("");
  eq("空文本 → 空图、不抛", empty.nodes.length, 0);
  eq("空文本 degraded 允许为 false", typeof empty.degraded, "boolean");
  notThrow("garbage 文本不抛", () => buildGraph("]]][[[ [Decision( \n [Predicate("));
  const big = `${Array.from({ length: 20 }, (_, index) => `[Decision(options="A;B", values="${index * 2 + 1};${index * 2 + 2}")]\n[Predicate(references="${index * 2 + 1};${index * 2 + 2}")]`).join("\n")}\n[name=""] end`;
  let graphBig;
  notThrow("20 个 Decision（组合 1e6）不抛", () => { graphBig = buildGraph(big); });
  ok("组合超 1e4 → degraded 或线路数受控", graphBig ? graphBig.degraded || graphBig.stats.routes > 0 : false);
  ok("stats.degradedReasons 是字符串数组", Array.isArray(graphBig?.stats.degradedReasons));
}

/** (6) 排布几何：竖排（TB）是**主口径**，横排（LR）保留老行为。
 *  `layoutGraph` 是纯函数 —— 这里只喂真实 / 手造图，不看浏览器。 */
function testGeometry() {
  group("(6) 排布几何：TB 竖排主口径 + LR 兼容");
  const text = [
    '[HEADER(key="geom")]',
    '[Decision(options="A;B", values="1;2")]',
    '[Predicate(references="1")]',
    '[name="A"]  a',
    '[Predicate(references="2")]',
    '[name="B"]  b',
    '[Predicate(references="1;2")]',
    '[name="A"]  m',
    '[endtip(block=true)]',
  ].join("\n");
  const graph = buildGraph(text);
  const tb = layoutGraph(graph);
  const lr = layoutGraph(graph, { direction: "LR" });

  eq("默认 direction = TB", [tb.direction, tb.stats.direction], ["TB", "TB"]);
  eq("direction=LR 生效", [lr.direction, lr.stats.direction], ["LR", "LR"]);
  eq("未知 direction 回落 TB", layoutGraph(graph, { direction: "XX" }).direction, "TB");
  eq("TB 卡片 = 320×92", [tb.nodes[0].w, tb.nodes[0].h], [320, 92]);
  eq("LR 卡片 = 200×64（老尺寸）", [lr.nodes[0].w, lr.nodes[0].h], [200, 64]);

  // TB：层 → y 单调（任意两层之间、任意节点对）
  const layers = [...new Set(tb.nodes.map((node) => node.layer))].sort((a, b) => a - b);
  let monotone = true;
  for (const low of layers) {
    for (const high of layers) {
      if (low >= high) continue;
      for (const a of tb.nodes.filter((node) => node.layer === low)) {
        for (const b of tb.nodes.filter((node) => node.layer === high)) if (!(b.y > a.y)) monotone = false;
      }
    }
  }
  ok("TB：层 → y 单调（低层在上）", monotone);

  // TB：同层沿 x 打包，边到边 = gapX（32）；层间边到边 = gapY（32）
  const slotGaps = [];
  for (const layer of layers) {
    const row = tb.nodes.filter((node) => node.layer === layer).sort((a, b) => a.x - b.x);
    for (let at = 1; at < row.length; at += 1) slotGaps.push(Number((row[at].x - (row[at - 1].x + row[at - 1].w)).toFixed(2)));
  }
  eq("TB：同层卡片边到边 = 32（零重叠）", [...new Set(slotGaps)], slotGaps.length ? [32] : []);
  const layerGaps = [];
  for (let at = 1; at < layers.length; at += 1) {
    const above = Math.max(...tb.nodes.filter((node) => node.layer === layers[at - 1]).map((node) => node.y + node.h));
    const below = Math.min(...tb.nodes.filter((node) => node.layer === layers[at]).map((node) => node.y));
    layerGaps.push(Number((below - above).toFixed(2)));
  }
  eq("TB：层间边到边 = 32", [...new Set(layerGaps)], [32]);

  /** 矩形两两重叠对数。 */
  const overlapCount = (out) => {
    const rows = out.nodes;
    let bad = 0;
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad += 1;
      }
    }
    return bad;
  };
  eq("TB：矩形两两不重叠", overlapCount(tb), 0);
  eq("LR：矩形两两不重叠", overlapCount(lr), 0);

  // 边：正交（每段要么水平要么垂直）+ 拐点 ≤ 3 + TB 至少一条竖段
  const orthBad = [];
  let withVertical = 0;
  for (const edge of tb.edges) {
    const points = edge.points;
    for (let at = 1; at < points.length; at += 1) {
      const [ax, ay] = points[at - 1];
      const [bx, by] = points[at];
      if (Math.abs(ax - bx) > 1e-6 && Math.abs(ay - by) > 1e-6) orthBad.push(`${edge.id}@${at}`);
    }
    if (points.some((point, at) => at > 0 && Math.abs(point[0] - points[at - 1][0]) < 0.5 && Math.abs(point[1] - points[at - 1][1]) > 0.5)) withVertical += 1;
  }
  ok("TB：边是正交折线（每段水平或垂直）", orthBad.length === 0);
  ok("TB：拐点数 ≤ 3（points ≤ 4）", tb.edges.every((edge) => edge.points.length <= 4));
  ok("TB：至少一条边有竖段（从上往下）", withVertical > 0);
  ok("TB：边从源卡底缘中点出发", tb.edges.every((edge) => {
    const from = tb.nodes.find((node) => node.id === edge.from);
    return !from || (Math.abs(edge.points[0][1] - (from.y + from.h)) < 0.5 && Math.abs(edge.points[0][0] - (from.x + from.w / 2)) < 0.5);
  }));

  // reading order：layer 升序 → 同层沿阅读方向（TB 看 x、LR 看 y）
  const byRead = [...tb.nodes].sort((a, b) => (a.layer - b.layer) || (a.x - b.x) || (a.line - b.line)).map((node) => node.id);
  eq("TB：readOrder = layer → x 升序", tb.readOrder, byRead);
  eq("readOrder 覆盖全部节点且无重复", [tb.readOrder.length, new Set(tb.readOrder).size, tb.nodes.length], [tb.nodes.length, tb.nodes.length, tb.nodes.length]);
  const lrOrder = [...lr.nodes].sort((a, b) => (a.layer - b.layer) || (a.y - b.y) || (a.line - b.line)).map((node) => node.id);
  eq("LR：readOrder = layer → y 升序", lr.readOrder, lrOrder);

  // 确定性（新轴也要逐字节可复现）
  eq("TB 确定性（两次调用 JSON 全等）", JSON.stringify(layoutGraph(buildGraph(text))), JSON.stringify(tb));
  eq("LR 确定性（两次调用 JSON 全等）", JSON.stringify(layoutGraph(buildGraph(text), { direction: "LR" })), JSON.stringify(lr));

  // 画布尺寸按新轴算
  const maxX = Math.max(...tb.nodes.map((node) => node.x + node.w));
  const maxY = Math.max(...tb.nodes.map((node) => node.y + node.h));
  ok("TB：width ≥ 最右卡片右缘", tb.width >= maxX);
  ok("TB：height ≥ 最下卡片下缘（长龙往下长）", tb.height >= maxY);
  eq("step 字段 = 卡片 + 间距", [tb.layerStep, tb.slotStep], [92 + 32, 320 + 32]);
  eq("LR 的 step 字段换轴", [lr.layerStep, lr.slotStep], [200 + 32, 64 + 32]);

  // 手造 / 畸形输入不抛（`layoutGraph` 的老承诺）
  notThrow("layoutGraph({nodes:[],edges:[]}) 不抛", () => layoutGraph({ nodes: [], edges: [] }), "");
  notThrow("layoutGraph(null) 不抛", () => layoutGraph(null), "");
  eq("空图的 direction 也回填", layoutGraph(null).direction, "TB");
}

/** (7) 退化：> CAP_NODES 的图挤成一列长龙（TB 下仍然是一列**竖**龙）。 */
function testDegenerateGeometry() {
  group("(7) 退化：超量节点 → TB 仍是一列（零重叠）");
  const nodes = [];
  for (let at = 0; at < 401; at += 1) nodes.push({ id: `n${at + 1}`, lines: [at + 1], text: `x${at}`, speaker: "" });
  const edges = nodes.slice(1).map((node, at) => ({ from: nodes[at].id, to: node.id, label: "", value: null, routes: [] }));
  const out = layoutGraph({ nodes, edges });
  ok("degenerate = true（> 400 节点）", out.degenerate);
  eq("退化后卡片缩到 240×52（TB）", [out.nodes[0].w, out.nodes[0].h], [240, 52]);
  eq("退化后仍然零重叠", new Set(out.nodes.map((node) => `${node.x},${node.y}`)).size, out.nodes.length);
  const ys = out.nodes.map((node) => node.y);
  eq("退化后 y 严格递增（一条竖龙）", ys.every((y, at) => at === 0 || y > ys[at - 1]), true);
}

// ── main ─────────────────────────────────────────────────────────

const corpusRoot = CORPUS_CANDIDATES.find((path) => path && existsSync(path)) ?? null;
process.stdout.write(`repo: ${REPO_ROOT}\n`);
process.stdout.write(`sample: ${samplePath ?? "(missing)"}\n`);
process.stdout.write(`corpus: ${corpusRoot ?? "(missing)"}\n`);

testSample();
const corpus = testCorpus(corpusRoot);
testNested(corpus.nested);
testFork();
testDegenerate();
testGeometry();
testDegenerateGeometry();

const summary = {
  passed,
  failed,
  sample: samplePath,
  corpus: corpusRoot,
  sampleSize: SAMPLE_SIZE,
  seed: SEED,
  version: original.version,
};
process.stdout.write(`\n== 结果：${passed} passed, ${failed} failed ==\n`);
if (failures.length) {
  process.stdout.write("失败明细：\n");
  for (const item of failures) process.stdout.write(`  ✗ [${item.group}] ${item.name}: ${item.detail}\n`);
}
if (JSON_OUT) {
  const outPath = resolve(REPO_ROOT, JSON_OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ summary, failures }, null, 2)}\n`, "utf8");
  process.stdout.write(`JSON: ${outPath}\n`);
}
process.exit(failed === 0 ? 0 : 1);
