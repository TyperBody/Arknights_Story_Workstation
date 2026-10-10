// 分支图（branch graph）：把 PRTS `#datas_txt` 剧本里的 Decision/Predicate
// 反向推导成「节点 / 多线路」——**没有跳转**：分支 = 值门，线路只能由**值域**推出。
//
// 纯 ESM、JSDoc 类型；`frontend/tsconfig.app.json` 已 `allowJs` + include
// `../src/akstage`，供 `frontend/src/components/editor/BranchGraph.tsx`（视图）与
// `scripts/fanfic/branchGraph-selftest.mjs`（离线自检）共用；风格对齐
// `src/akstage/local/editorModel.js`（Controller/ValueMeta/Diagnostic 那套）。
//
// ── 语义权威（本文件只做推导，**不重写** DSL 解析） ─────────────────────
//   · 行/参数 token 化：`./storyPack.js` 的 `parseScript` / `parseArg` / `arg`
//     —— 与应用、离线 lint、上游 `engine/parser.ts` 同形。
//   · 闸门 `passesGate`（原生 `Torappu.AVG.DecisionCommandPredicator.
//     NeedToExecuteCommand`；网页端 `engine/log/semantics.ts::passesGate`，
//     由 `engine/runtime.ts` 的 processLoop 逐行调用）四条规则：
//       1) 行本身是 `predicate` → **永远放行**（它要更新 references）；
//       2) `selectedValue === 0` → 放行（0 = 未选择，初始态）；
//       3) `references === null || references.length === 0` → 放行（无约束）；
//       4) 否则 `references.includes(selectedValue)` → 放行，不然**这一行**
//          被静默跳过（跳过的是行，不是区间——区间边界由后续 Predicate 改写）。
//   · 决策 `parseDecision`（原生 `DecisionPanel._ExecuteDecision`；
//     `engine/runtime.ts` 的 `case "decision"`）：**先重置**
//     `selectedValue = 0; references = null`，再按 `;` 拆 `options`（标签）与
//     `values`（整数；`values[i] ?? 0`，NaN→0；`options` 缺省 = 无效 decision，
//     只重置不分叉）。**写入值，不是跳转。**
//   · 合流 = 一条 references 覆盖**全部 values** 的 `[Predicate]`（不是 goto）。
//     官方三种规范形状（含紧随 Decision 的「重开闸门」）与状态预算
//     `MAX_STATES = 1e4` 逐字见
//     `.akskills/arkstage-fanfic/reference/branching.md` §1 / §2 / §3.1
//     （`engine/log/symbolicFlow.ts`）。
//
// ── 推导规则（= task-16 验收标准） ─────────────────────────────────────
//   1) 一条 `[Decision]` 产生 N 条线路（N = 选项数）；label = options[i]，
//      value = `values[i] ?? 0`（**与引擎一致**）。`storyPack.lintScript` 在
//      `values` 缺省时用 `1..N`，那是 lint 的方便写法；线路图以引擎为准 ——
//      缺省 0 恒放行，等于「该选项不受任何闸门约束」。
//   2) `[Predicate]` 之后的节点归属：`references` 含哪个 value 就挂到哪条线；
//      空/缺省 → 全放行；**多值**且不覆盖某个 Decision 的全部 values →
//      节点同时属于这几条线（数据上取「按行归属」：`route` = 唯一线路 id，
//      否则 null 并在 `merges` 侧体现；官方形状 B 的「重开闸门」即此）。
//   3) 合流点：某 Decision 的全部线路都到达的地方（覆盖全部 values 的
//      `[Predicate]` 之后、**两条线都能看到的第一句正文**）。`merges[].line`
//      取该正文字行；`merges[].gateLine` 取那条并集 Predicate 行。
//      内置样例里两条选择在第 30 行合流（`verify-pack.mjs --choice 0|1` 的
//      `lines` 交集 = 30），自检与它交叉验证、不硬编码行号。
//   4) 嵌套：`depth`（= 图上 x 列）= 该行所属线路**尚未合流的决策层数**；
//      线路 id 用 `d<line>/<value>` 的路径形式（嵌套 `>` 连接：
//      `d15/1>d22/3`），稳定可复现，不含数组下标。
//   5) 退化（`degraded: true` + `stats.degradedReasons[]`，**绝不抛异常**）：
//      `references` 引用了任何 Decision 都没有的 value；理论组合数
//      `∏ options > 1e4`；并行线路数超过 `MAX_LINEAGES`（截断并标注）。

import { arg, parseScript } from "./storyPack.js";

/** 引擎 / LOG ALL 的状态上限（`engine/log/symbolicFlow.ts::MAX_STATES`）。 */
const MAX_COMBOS = 1e4;
/** 同时并行的**线路数**上限（纯防御；正常脚本远小于此）。 */
export const MAX_LINEAGES = 1024;
/** 节点摘要 / tooltip 的截断。 */
const SUMMARY_CHARS = 80;
/** 相邻**解析行**的原始行距 ≤ 此值时才并入同一节点（跨空行/短注释）。 */
const GROUP_GAP_LINES = 4;

/**
 * 一条线路 = 某条 `[Decision]` 的一个选项；嵌套时是路径（`a>b`）。
 *
 * @typedef {object} Route
 * @property {string} id           路径 id（`d15/1` / `d15/1>d22/3`）
 * @property {string} label        选项文本（options[i]）
 * @property {number} value        选项值（values[i]，缺省 0）
 * @property {string} opts        同一 Decision 的全部选项文本（`;` 连接）
 * @property {number} line        产生本线路的 Decision 行号（1 基）
 * @property {number} depth       决策层数（1 = 顶层 Decision 的选项）
 * @property {string|null} parent 父线路 id（`null` = 主线）
 * @property {number} nodeId      该线路第一个节点的 id（没有内容时 = 合流/结束节点）
 * @property {number} nodes       该线路覆盖的节点数
 * @property {number[]} gates     放行过本线路的 predicate values（升序去重）
 */

/**
 * 一个节点 = 一段连续文本（台词 / 旁白 / 演出指令块），带起止行号。
 *
 * @typedef {object} Node
 * @property {string} id
 * @property {[number, number]} lines  [首行, 末行]（1 基，含中间的空行/注释）
 * @property {"text"|"choice"|"merge"} kind
 * @property {string|null} route       所属线路 id（主线 / 合流 = null）
 * @property {number} depth            x 轴列 = 该节点的决策层数
 * @property {string} text             首行摘要
 * @property {string} command         触发该节点的控制器名（dialogue = 说话人行）
 * @property {string} [speaker]
 * @property {number[]} values        本节点处仍能看到的 selectedValue 集合（升序）
 */

/**
 * @typedef {object} Edge
 * @property {string|null} from
 * @property {string|null} to      `null` = 线路 / 剧本在此结束
 * @property {string} label        选项文本；"合流"；""
 * @property {number|null} value   选项值；非选择边 = `null`
 * @property {string[]} routes     走过这条边的线路 id（升序）
 */

/**
 * @typedef {object} Merge
 * @property {number} line         合流点（并集闸门之后第一条**正文**行；见文件头 §3）
 * @property {number} gateLine     并集闸门（`[Predicate]`）所在行
 * @property {string[]} routes     汇合的线路 id（升序）
 * @property {number[]} values     这些线路的 value（升序去重）
 */

/**
 * @typedef {object} GraphStats
 * @property {number} lines
 * @property {number} parsedLines
 * @property {number} decisions
 * @property {number} choices      选项总数（= 无嵌套时的线路数）
 * @property {number} routes
 * @property {number} nodes
 * @property {number} edges
 * @property {number} merges
 * @property {number} forks        没有并集闸门的 Decision 数量（可能「掉线」）
 * @property {number} maxDepth
 * @property {number} combos       ∏ 选项数（引擎 1e4 上限）
 * @property {number} lineagesMax  仿真中同时存在的最大线路（选择轨迹）数
 * @property {string[]} degradedReasons
 */

/**
 * @typedef {object} Graph
 * @property {Node[]} nodes
 * @property {Edge[]} edges
 * @property {Route[]} routes
 * @property {Merge[]} merges
 * @property {boolean} degraded
 * @property {GraphStats} stats
 */

/**
 * 仿真中的一条「选择轨迹」：已做过哪些选择（`trace` = 稳定签名），
 * 以及**尚未合流**的决策链（`chain`）。
 *
 * @typedef {object} Lineage
 * @property {string} trace          选择签名（`15:1|22:3`；主线 = `""`）
 * @property {string[]} chain        未合流线路的 id（外层 → 内层）
 * @property {number[]} chainValues   对应 value
 * @property {number} value          最后一个选择的 value（没选过 = 0）
 * @property {number[]|null} refs   当前 references
 */

/**
 * 一行的推导结果（buildGraph 与 forkPatch 共用）。
 *
 * @typedef {object} FrameRow
 * @property {number} line
 * @property {number} kind           0 text / 1 choice / 2 merge（内部用小整数）
 * @property {string|null} route
 * @property {number} depth
 * @property {number} traces         同时可见的选择轨迹数
 * @property {number[]} values       同时可见的 selectedValue 集合
 * @property {string[]} chains       同时可见的 chain id（`""` = 主线）
 */

/** 闸门（逐字对齐 `engine/log/semantics.ts::passesGate`）。
 * @param {number} value @param {number[]|null} refs @returns {boolean} */
function gatePasses(value, refs) {
  if (value === 0) return true;
  if (refs === null || refs.length === 0) return true;
  return refs.includes(value);
}

/** `;` → 整数数组；NaN/空段 → 0；参数缺省 → `null`。
 * 与 `semantics.ts::toIntList` / `parsePredicateReferences` 一致。
 * @param {unknown} raw @returns {number[]|null} */
function parseIntList(raw) {
  if (raw === undefined || raw === null) return null;
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(";");
  return parts.map((segment) => {
    const parsed = Number.parseInt(String(segment).trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

/** `;` → 标签数组（options）。@param {unknown} raw @returns {string[]} */
function parseLabels(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  return String(raw).split(";").map((item) => item.trim());
}

/** @param {unknown} value @returns {number} */
function asInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** @param {string} value @param {number} [max] @returns {string} */
function summarize(value, max = SUMMARY_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 一个 Decision 的静态信息。
 * @typedef {object} DecisionInfo
 * @property {number} line
 * @property {string[]} labels
 * @property {number[]} values
 * @property {string} opts
 * @property {number[]} childValues  实际分叉出的 value（去重、升序）
 * @property {string[]} childIds
 * @property {number|null} closedAt  并集 Predicate 的行号
 */

/** @param {number} value @returns {string} */
const keyOf = (value) => String(value);

/** 路径末尾（`>` 之后）那一层的**规范 id**：剥掉去重后缀 `~N`。
 * `d4/11~2` → `d4/11`；`d2/1>d4/11` → `d4/11`。
 * @param {string} chain @returns {string} */
function canonicalBase(chain) {
  const tail = chain.includes(">") ? chain.slice(chain.lastIndexOf(">") + 1) : chain;
  return tail.replace(/~\d+$/, "");
}

/** 从「未合流的层」里摘掉某个 Decision 的层（逐层比对**规范** base，
 * 所以外层合流不会摘掉仍在开的**内层**决策；`~N` 后缀先剥）。
 * @param {string[]} chain @param {string[]} bases @returns {string[]} */
function stripLayer(chain, bases) {
  return chain.filter((id) => !bases.includes(canonicalBase(id)));
}

/** Decision 第 `index` 个选项在**引擎**里的值：`values[i] ?? 0`（NaN→0）。
 * `values` 传了但缺项 → 0（原生 `_GetOptionValue` 越界返回 0）；
 * `values` 完全缺省也 → 0，故该选项不受任何闸门约束（0 恒放行）。
 * 注意 `storyPack.lintScript` 在缺省时用 `1..N`，那是 lint 的方便写法。
 * @param {string[]|null} parts @param {number} index @returns {number} */
function optionValue(parts, index) {
  if (!parts) return 0;
  return asInt(parts[index] ?? 0);
}

/**
 * 走一遍脚本：产出节点 / 边 / 线路 / 合流 + 退化原因。buildGraph 与 forkPatch
 * 共用（后者需要知道插入点处**正在放行**的线路）。
 *
 * @param {string} text
 * @returns {Graph}
 */
function simulate(text) {
  const source = String(text ?? "");
  const parsed = parseScript(source);
  const rawLines = source.replace(/\r\n?/g, "\n").split("\n").length;

  /** @type {Map<number, DecisionInfo>} */
  const decisions = new Map();
  const decisionValues = new Set();
  const refsSeen = new Set();
  /** @type {string[]} */
  const degradedReasons = [];
  let combos = 1;

  // ── 预扫：Decision / Predicate 的静态信息 ──────────────────────────
  for (const line of parsed) {
    if (line.kind !== "command") continue;
    if (line.command === "decision") {
      const labels = parseLabels(arg(line.args, "options"));
      const rawValues = arg(line.args, "values");
      const parts = rawValues === undefined || rawValues === null
        ? null
        : (Array.isArray(rawValues) ? rawValues.map(String) : String(rawValues).split(";"));
      const values = labels.map((_, index) => optionValue(parts, index));
      decisions.set(line.lineNumber, {
        line: line.lineNumber,
        labels,
        values,
        opts: labels.join(";"),
        childValues: [],
        childIds: [],
        closedAt: null,
      });
      for (const value of values) decisionValues.add(value);
      combos *= Math.max(1, labels.length);
    } else if (line.command === "predicate") {
      for (const ref of parseIntList(arg(line.args, "references")) ?? []) refsSeen.add(ref);
    }
  }
  for (const ref of refsSeen) if (ref !== 0 && !decisionValues.has(ref)) degradedReasons.push(`Predicate 引用了脚本里不存在的值 ${ref}`);
  if (combos > MAX_COMBOS) degradedReasons.push(`分支组合 ${combos} > ${MAX_COMBOS}（引擎状态上限，LOG ALL 会退化）`);

  /** @type {Route[]} */
  const routes = [];
  /** @type {Map<string, Route>} */
  const routeById = new Map();
  /** 每解析行一帧（节点分组 / `forkPatch` 的 ambient 都读它）。 */
  /** @type {FrameRow[]} */
  const frames = [];
  /** 已落定的合流（`[Decision]` 全 values 被一条 Predicate 覆盖）。 */
  /** @type {Merge[]} */
  const merges = [];
  /** `references` ⊇ 该 Decision 全部 values、但还没找到正文行的 Decision。 */
  /** @type {DecisionInfo[]} */
  const awaitingContent = [];

  /** 选/建一条线路记录。
   * @param {string} id @param {string} label @param {number} value
   * @param {number} line @param {string|null} parent @param {string} opts @returns {Route} */
  const routeFor = (id, label, value, line, parent, opts) => {
    const existing = routeById.get(id);
    if (existing) return existing;
    /** @type {Route} */
    const route = {
      id, label, value, opts, line,
      depth: id.split(">").length,
      parent,
      nodeId: -1,
      nodes: 0,
      gates: [],
    };
    routeById.set(id, route);
    routes.push(route);
    return route;
  };

  /**
   * 作用域栈 —— DSL 没有跳转，「层」只能由**值门**推出来：
   *   · `[Decision]` 压入一层决策作用域（登记该层各选项的线路 id）；
   *   · references 恰好命中该层 1 个 value ＝ 开片段 ⇒ 记住这条线路 id，
   *     之后嵌套的 `[Decision]` 用它作 `a>b` 前缀；
   *   · references 覆盖该层**全部** values ＝ 合流 ⇒ 弹出该层及以上，
   *     并挂起 merges 候选（`merges.line` 由随后第一条正文行落定）；
   *   · references 缺省 / 为空 ⇒ 全放行（`null` = 结束分支模式）⇒ 清栈。
   * 复杂度 O(行长)（官方最长 1813 行的脚本里 68 个 Decision 也不会指数爆炸）。
   *
   * @typedef {object} Scope
   * @property {"decision"|"fragment"} kind
   * @property {number} line                 开这一层的行号
   * @property {number[]} values             decision = 本层全部 values；fragment = 本条分支的值
   * @property {Map<number,string>} ids     decision：value → 线路 id
   * @property {string} chain               fragment 的线路 id（decision = ""）
   * @property {number[]} gates             fragment：本层已放行的 value
   */
  /** @type {Scope[]} */
  let scopes = [];
  let maxDepth = 0;
  let scopesMax = 1;
  /** fragment 层 → 线路 id，按栈序 `>` 串联（Decision 只是分层标记，不出现在 id 里）。 */
  const prefixOf = () => scopes.filter((scope) => scope.kind === "fragment").map((scope) => scope.chain).filter(Boolean).join(">");
  /** 当前 fragment 层数（x 轴列 = 已是几层分支之内）。 */
  const fragDepth = () => scopes.filter((scope) => scope.kind === "fragment").length;

  /** `[Decision]` 登记一层：为每个选项算出线路 id。**id 只由 fragment 前缀决定**
   * （`storyPack` 的合流判定也是按“层的全部 values”配对，不按 Decision 顺序），
   * 同一 fragment 前缀下 `d<line>/<value>` 天然唯一 ⇒ 嵌套时 id 稳定为
   * `d29/3>d60/1`，同一层重复出现也不会撞车。
   * @param {DecisionInfo} info @returns {Map<number,string>} */
  const openDecision = (info) => {
    const prefix = prefixOf();
    /** @type {Map<number,string>} */
    const ids = new Map();
    info.childIds = [];
    info.childValues = [];
    const used = new Set();
    for (const [index, label] of info.labels.entries()) {
      const value = info.values[index] ?? 0;
      const base = `d${info.line}/${keyOf(value)}`;
      let local = base;
      for (let dup = 1; used.has(local); dup += 1) local = `${base}~${dup}`;
      used.add(local);
      const id = prefix ? `${prefix}>${local}` : local;
      ids.set(value, id);
      routeFor(id, String(label ?? ""), value, info.line, prefix || null, info.opts);
      if (!info.childIds.includes(id)) info.childIds.push(id);
      if (!info.childValues.includes(value)) info.childValues.push(value);
    }
    return ids;
  };

  for (const line of parsed) {
    const isPredicate = line.kind === "command" && line.command === "predicate";
    const isDecision = line.kind === "command" && line.command === "decision";
    const newRefs = isPredicate ? parseIntList(arg(line.args, "references")) : null;
    const prefix = prefixOf();
    /** 帧默认：主线（无 fragment）或当前前缀。 */
    /** @type {FrameRow} */
    const frame = {
      line: line.lineNumber,
      kind: 0,
      route: prefix || null,
      depth: fragDepth(),
      traces: 1,
      values: scopes.filter((scope) => scope.kind === "fragment").map((scope) => scope.values[0] ?? 0),
      chains: [prefix],
    };
    if (!frame.values.length) frame.values = [0];
    frames.push(frame);

    if (isDecision) {
      const info = decisions.get(line.lineNumber);
      if (!info) continue;
      if (info.labels.length === 0) { frame.kind = 1; continue; }
      const ids = openDecision(info);
      scopes.push({ kind: "decision", line: line.lineNumber, values: info.values, ids, chain: "", gates: [] });
      frame.kind = 1;
      frame.depth = fragDepth();
      maxDepth = Math.max(maxDepth, frame.depth + 1);
      scopesMax = Math.max(scopesMax, scopes.length);
      continue;
    }

    if (isPredicate) {
      if (newRefs === null || newRefs.length === 0) {
        scopes = [];
        frame.kind = 2;
        continue;
      }
      // 最内层仍开着的 decision 层：片段 / 合流都由它判定。
      let at = -1;
      for (let index = scopes.length - 1; index >= 0; index -= 1) if (scopes[index]?.kind === "decision") { at = index; break; }
      if (at < 0) continue;
      const layer = /** @type {Scope} */ (scopes[at]);
      const info = decisions.get(layer.line);
      if (!info) continue;
      const inside = layer.values.filter((value) => newRefs.includes(value));
      if (inside.length === layer.values.length && layer.values.length > 0) {
        // 合流：整层闭合（`storyPack.lintScript` 的 merged 同款：values ⊆ wanted）。
        if (layer.values.length >= 2) {
          info.closedAt = line.lineNumber;
          awaitingContent.push(info);
        }
        scopes = scopes.slice(0, at);
        frame.kind = 2;
        continue;
      }
      if (inside.length === 1) {
        // 片段：进入该层的一条分支。fragment 的 line id = 当前 fragment 前缀
        // + 本层的 `d<line>/<value>` —— 嵌套时形如 `d29/3>d60/1`。
        const value = inside[0] ?? 0;
        const id = layer.ids.get(value) ?? (prefix ? `${prefix}>d${layer.line}/${keyOf(value)}` : `d${layer.line}/${keyOf(value)}`);
        const label = String(info.labels[layer.values.indexOf(value)] ?? "");
        const route = routeFor(id, label, value, layer.line, prefix || null, info.opts);
        if (value !== 0 && !route.gates.includes(value)) route.gates.push(value);
        frame.route = id;
        frame.depth = fragDepth() + 1;
        frame.values = [value];
        frame.chains = [id];
        scopes = [
          ...scopes.slice(0, at + 1),
          { kind: "fragment", line: line.lineNumber, values: [value], ids: new Map([[value, id]]), chain: id, gates: [value] },
        ];
        maxDepth = Math.max(maxDepth, frame.depth);
        scopesMax = Math.max(scopesMax, scopes.length);
        continue;
      }
      // references 命中该层 ≥2 个 value、但没覆盖整层：同时可见 ⇒ 合流区域
      //（值域全局共享；官方形状 B 的「重开闸门」也走这里）。
      frame.kind = 2;
      frame.values = inside;
      frame.chains = inside.map((value) => layer.ids.get(value) ?? "");
      frame.traces = inside.length;
      frame.route = frame.chains.filter(Boolean).join(">") || null;
      scopes = [
        ...scopes.slice(0, at + 1),
        { kind: "fragment", line: line.lineNumber, values: inside, ids: new Map(inside.map((value) => [value, layer.ids.get(value) ?? ""])), chain: frame.route ?? "", gates: inside },
      ];
      frame.depth = fragDepth();
      continue;
    }

    // 普通行：合流之后的第一条**正文**行 = `merges.line`（分支部的
    // `[Character]`/`[Background]` 等 buildup 不算）。
    if (awaitingContent.length && (line.kind === "dialogue" || line.kind === "narration")) {
      while (awaitingContent.length) {
        const info = /** @type {DecisionInfo} */ (awaitingContent.shift());
        const gateLine = /** @type {number} */ (info.closedAt);
        merges.push({
          line: line.lineNumber,
          gateLine,
          routes: [...new Set(info.childIds)].sort(),
          values: [...new Set(info.childValues)].sort((a, b) => a - b),
        });
      }
    }
  }

  for (const info of awaitingContent) {
    merges.push({
      line: /** @type {number} */ (info.closedAt),
      gateLine: /** @type {number} */ (info.closedAt),
      routes: [...new Set(info.childIds)].sort(),
      values: [...new Set(info.childValues)].sort((a, b) => a - b),
    });
  }
  /** 没有并集闸门的 Decision = fork（后续内容只属于最后一条分支）。 */
  const forks = [...decisions.values()].filter((info) => info.labels.length >= 2 && info.closedAt === null);

  // ── 节点分组（kind + route + depth + 行类型；相邻才合并） ──────────
  /** @type {Map<number, import("./storyPack.js").ParsedLine>} */
  const lineByNumber = new Map(parsed.map((line) => [line.lineNumber, line]));
  /** @type {Node[]} */
  const nodes = [];
  /** @type {Map<string, Node>} */
  const nodeByRoute = new Map();
  let previousLine = /** @type {number|null} */ (null);
  let currentNode = /** @type {Node|null} */ (null);
  let currentKey = "";
  const KIND_NAMES = /** @type {const} */ (["text", "choice", "merge"]);
  for (const frame of frames) {
    const line = lineByNumber.get(frame.line);
    if (!line) continue;
    /** @type {"text"|"choice"|"merge"} */
    const kind = KIND_NAMES[frame.kind] ?? "text";
    const speaker = frame.kind === 0 && line.kind === "dialogue" ? String(line.speaker ?? "").trim() : "";
    const tag = frame.kind === 1
      ? `choice:${frame.line}`
      : line.kind === "dialogue"
        ? `dlg:${speaker}`
        : line.kind === "narration"
          ? "narr"
          : `cmd:${String(line.command ?? "")}`;
    const key = `${kind}|${frame.route ?? "-"}|${frame.depth}|${tag}`;
    const contiguous = previousLine !== null && frame.line - previousLine <= GROUP_GAP_LINES;
    if (currentNode && currentKey === key && contiguous) {
      currentNode.lines[1] = Math.max(currentNode.lines[1], frame.line);
      for (const value of frame.values) if (!currentNode.values.includes(value)) currentNode.values.push(value);
      currentNode.values.sort((a, b) => a - b);
      previousLine = frame.line;
      continue;
    }
    /** @type {Node} */
    const node = {
      id: `n${frame.line}`,
      lines: [frame.line, frame.line],
      kind,
      route: frame.route,
      depth: frame.depth,
      text: summarize(nodeText(line)),
      command: line.kind === "dialogue" ? "dialog" : String(line.command ?? ""),
      ...(speaker ? { speaker } : {}),
      values: [...frame.values],
    };
    nodes.push(node);
    if (frame.route && !nodeByRoute.has(frame.route)) nodeByRoute.set(frame.route, node);
    currentNode = node;
    currentKey = key;
    previousLine = frame.line;
  }
  /** 行 → 节点（边 / 归属用）。 */
  /** @type {Map<number, Node>} */
  const nodeByLine = new Map();
  for (const node of nodes) for (let line = node.lines[0]; line <= node.lines[1]; line += 1) nodeByLine.set(line, node);

  // ── 线路 → 节点归属（按**前缀**：`d2/1>d5/11` 同时属于 `d2/1`） ────
  for (const route of routes) {
    const owned = nodes.filter((node) => node.route !== null && (node.route === route.id || node.route.startsWith(`${route.id}>`)));
    route.nodes = owned.length;
    route.nodeId = owned[0] ? Number(owned[0].id.slice(1)) : -1;
  }
  // 首节点没有 route（Decision 之前的主线）→ 归给「第一条线路的起点」之前的节点
  // 保持不变（route: null = 主线）；这里只补「有 route 却还没设 nodeId」的。
  for (const route of routes) {
    if (route.nodeId >= 0) continue;
    const first = nodes.find((node) => node.route === null && node.lines[0] <= route.line);
    route.nodeId = first ? Number(first.id.slice(1)) : (nodes[0] ? Number(nodes[0].id.slice(1)) : -1);
  }

  // ── 边 ────────────────────────────────────────────────────────
  /** @type {Map<string, Edge>} */
  const edgeIndex = new Map();
  /** @param {Node|null} from @param {Node|null} to @param {string} label
   * @param {number|null} value @param {string} routeId @returns {Edge|null} */
  const link = (from, to, label, value, routeId) => {
    if (!from) return null;
    const key = `${from.id}|${to?.id ?? "-"}|${label}|${value === null ? "" : value}`;
    const existing = edgeIndex.get(key);
    if (existing) {
      if (routeId && !existing.routes.includes(routeId)) existing.routes.push(routeId);
      return existing;
    }
    /** @type {Edge} */
    const edge = { from: from.id, to: to?.id ?? null, label, value, routes: routeId ? [routeId] : [] };
    edgeIndex.set(key, edge);
    return edge;
  };
  /** @type {Map<string, Node>} */
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  /** 文档序的「顺序边」：同前缀 / 进入更深层 / 进入合流区域才连。 */
  for (let index = 0; index + 1 < nodes.length; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    if (!from || !to) continue;
    if (from.kind === "choice") continue; // 选项边单独生成
    if (to.kind === "merge") {
      link(from, to, "合流", null, from.route ?? "");
      continue;
    }
    if (to.kind === "choice" && from.route === to.route) {
      link(from, to, "", null, from.route ?? "");
      continue;
    }
    if (to.route === from.route) {
      link(from, to, "", null, from.route ?? "");
      continue;
    }
    // 更深（进入 fragment 的嵌套）或回到主线：都连一条（跨层的虚线语义由
    // 颜色/虚线表达，图上仍是同一条边）。
    if (to.route === null || (to.route !== null && (to.route.startsWith(`${from.route ?? ""}>`) || from.route === null))) {
      link(from, to, "", null, from.route ?? to.route ?? "");
    }
  }
  // 选择边：每个 Decision 的每个选项一条（分支内容为空也保留 → to: null）。
  for (const info of decisions.values()) {
    const choice = nodes.find((node) => node.id === `n${info.line}`);
    if (!choice) continue;
    for (const id of [...new Set(info.childIds)]) {
      const route = routeById.get(id);
      if (!route) continue;
      const target = route.nodeId >= 0 ? nodeById.get(`n${route.nodeId}`) ?? null : null;
      link(choice, target, route.label, route.value, id);
    }
  }
  for (const node of nodes) if (!edgesTouching(edgeIndex, node.id)) link(node, null, "结束", null, node.route ?? "");

  merges.sort((a, b) => a.line - b.line);
  const routeList = routes.sort((a, b) => (a.line - b.line) || (a.value - b.value) || a.id.localeCompare(b.id));
  return {
    nodes,
    edges: [...edgeIndex.values()],
    routes: routeList,
    merges,
    degraded: degradedReasons.length > 0,
    stats: {
      lines: rawLines,
      parsedLines: parsed.length,
      decisions: [...decisions.values()].filter((info) => info.labels.length > 0).length,
      choices: [...decisions.values()].reduce((sum, info) => sum + info.labels.length, 0),
      routes: routeList.length,
      nodes: nodes.length,
      edges: edgeIndex.size,
      merges: merges.length,
      forks: forks.length,
      maxDepth: routeList.reduce((max, route) => Math.max(max, route.depth), 0),
      combos,
      lineagesMax: scopesMax,
      degradedReasons,
    },
  };
}

/** 节点标题文本（含对话说话人 / 指令名）。@param {import("./storyPack.js").ParsedLine} line @returns {string} */
function nodeText(line) {
  if (line.kind === "dialogue") {
    const speaker = String(line.speaker ?? "").trim();
    const text = summarize(line.text);
    return speaker ? `${speaker}：${text}` : text;
  }
  if (line.kind === "narration") return summarize(line.raw);
  const values = Object.values(line.args ?? {}).filter((value) => typeof value === "string" && value.length > 0);
  const detail = String(line.tail ?? "").trim() || String(values[0] ?? "");
  const label = `[${String(line.command ?? "")}]`;
  return detail ? `${label} ${detail}` : label;
}

/** @param {Map<string, Edge>} index @param {string} id @returns {boolean} */
function edgesTouching(index, id) {
  for (const edge of index.values()) if (edge.from === id || edge.to === id) return true;
  return false;
}

/**
 * 把脚本推导成「节点 + 多线路」。**不抛异常**；退化时 `degraded: true`。
 *
 * @param {string} text
 * @returns {Graph}
 */
export function buildGraph(text) {
  try {
    return simulate(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      nodes: [],
      edges: [],
      routes: [],
      merges: [],
      degraded: true,
      stats: {
        lines: String(text ?? "").split("\n").length,
        parsedLines: 0,
        decisions: 0,
        choices: 0,
        routes: 0,
        nodes: 0,
        edges: 0,
        merges: 0,
        forks: 0,
        maxDepth: 0,
        combos: 0,
        lineagesMax: 0,
        degradedReasons: [`解析失败：${message}`],
      },
    };
  }
}

/**
 * 该行所属节点 id（光标 → 高亮；点节点 → 跳行）。落在空行 / 注释
 * （`parseScript` 丢弃的行）上时归属**下一个**节点，末尾归属最后一个节点；
 * 没有任何节点 → `null`。
 *
 * @param {string} text
 * @param {number} line 1 基行号
 * @returns {string|null}
 */
export function graphAt(text, line) {
  const graph = buildGraph(text);
  if (!graph.nodes.length) return null;
  const target = Number.isFinite(line) ? Math.trunc(line) : 0;
  for (const node of graph.nodes) if (target >= node.lines[0] && target <= node.lines[1]) return node.id;
  for (const node of graph.nodes) if (node.lines[0] > target) return node.id;
  return graph.nodes[graph.nodes.length - 1]?.id ?? null;
}

/** 该行**正在放行**的线路（`[]` = 主线；`forkPatch` 的 ambient）。
 * @param {string} text @param {number} line @returns {string[]} */
export function routeAtLine(text, line) {
  try {
    const graph = buildGraph(text);
    const frame = graph.nodes
      .filter((node) => node.lines[0] <= line)
      .sort((a, b) => a.lines[0] - b.lines[0])
      .at(-1);
    if (!frame) return [];
    const route = frame.route ?? graph.routes.find((item) => item.nodeId === Number(frame.id.slice(1)))?.id ?? null;
    return route ? [route] : [];
  } catch {
    return [];
  }
}

/** @param {string} text @returns {Set<number>} */
function usedValues(text) {
  const used = new Set();
  try {
    const graph = buildGraph(text);
    for (const route of graph.routes) used.add(route.value);
    for (const merge of graph.merges) for (const value of merge.values) used.add(value);
    for (const line of parseScript(String(text ?? ""))) {
      if (line.kind !== "command" || line.command !== "predicate") continue;
      for (const ref of parseIntList(arg(line.args, "references")) ?? []) used.add(ref);
    }
  } catch {
    /* 解析失败：按空 */
  }
  used.delete(0);
  return used;
}

/** 选 `n` 个脚本里**没用过**的正整数（值域全局共享，撞车会误放行别的线路）。
 * @param {number} n @param {Set<number>} used @returns {number[]} */
function allocateValues(n, used) {
  const out = [];
  const limit = Math.max(n * 8, n + 8);
  for (let candidate = 1; candidate <= limit && out.length < n; candidate += 1) if (!used.has(candidate)) out.push(candidate);
  let spill = (used.size ? Math.max(...used) : 0) + 1;
  while (out.length < n) {
    if (!used.has(spill)) out.push(spill);
    spill += 1;
  }
  return out;
}

/**
 * 「⤳ 在此分叉」弹窗的默认表格：n 行占位标签 + 已避开冲突的值。
 *
 * @param {string} text
 * @param {number} [count] clamp 2..8（缺省 2）
 * @returns {{label:string, value:number}[]}
 */
export function suggestForkOptions(text, count = 2) {
  const wanted = Math.min(8, Math.max(2, Math.trunc(count) || 2));
  const values = allocateValues(wanted, usedValues(text));
  const words = ["选项一", "选项二", "选项三", "选项四", "选项五", "选项六", "选项七", "选项八"];
  return Array.from({ length: wanted }, (_, index) => ({ label: words[index] ?? `选项${index + 1}`, value: values[index] ?? index + 1 }));
}

/** `options` / `values` 都以 `;` 分隔：标签里不能有 `"` / `;` / 换行。
 * @param {string} raw @returns {string} */
function sanitizeLabel(raw) {
  const text = String(raw ?? "").replace(/"/g, "'").replace(/;/g, "；").replace(/[\r\n]+/g, " ").trim();
  return text || "选项";
}

/**
 * 在 `afterLine`（1 基；0 = 全文最前，超出 = 末尾）之后插入一条 `[Decision]`、
 * 每条线路一条**只含本支**的 `[Predicate]` + 一行占位对白 `[name=""] …`，
 * 末尾一条**并集闸门**（references = 该处既有线路值 ∪ 新值，覆盖新 Decision
 * 的全部 values —— `storyPack.lintScript` 的合流判定，见
 * `../../scripts/fanfic/../src/akstage/local/storyPack.js` 的 merged 分支）。
 *
 * 插在已有分支片段里时（`routeAtLine` 有值），顺带把其后的「重开闸门」式
 * Predicate（references 含该线路的 value）扩展成也包含新值——否则新线路会在
 * 原有合流处被永久挡掉（值域全局共享，见文件头）。行号 / 文档顺序稳定。
 *
 * @param {string} text
 * @param {number} afterLine
 * @param {(string|{label?:string, value?:number})[]} [options] 缺省 = suggestForkOptions
 * @returns {{text:string, caretLine:number}}
 */
export function forkPatch(text, afterLine, options) {
  const source = String(text ?? "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const anchor = Math.min(lines.length, Math.max(0, Math.trunc(afterLine) || 0));
  const parentRoutes = routeAtLine(source, anchor);
  const parent = parentRoutes.length === 1 ? parentRoutes[0] ?? null : null;
  const ambient = parent ? (buildGraph(source).routes.find((route) => route.id === parent)?.value ?? 0) : 0;
  const rows = normalizeForkOptions(source, options);
  const labels = rows.map((row) => sanitizeLabel(row.label));
  const values = rows.map((row) => row.value);

  /** @type {string[]} */
  const block = [`[Decision(options="${labels.join(";")}", values="${values.join(";")}")]`];
  for (let index = 0; index < labels.length; index += 1) {
    block.push(`[Predicate(references="${values[index]}")]`);
    block.push(`[name=""]  ${labels[index]}`);
  }
  if (labels.length > 1) {
    const closing = [...new Set([...(ambient ? [ambient] : []), ...values])].sort((a, b) => a - b);
    block.push(`[Predicate(references="${closing.join(";")}")]`);
  }

  const head = lines.slice(0, anchor);
  const tail = parent !== null && ambient !== 0 ? reopenTail(lines.slice(anchor), ambient, values) : lines.slice(anchor);
  const next = [...head, ...block, ...tail];
  return { text: next.join(eol), caretLine: anchor + 3 };
}

/** 把 anchor 之后「覆盖整个 ambient」的 Predicate 扩上新值（重开闸门）。
 * @param {string[]} lines @param {number} ambient @param {number[]} added @returns {string[]} */
function reopenTail(lines, ambient, added) {
  return lines.map((line) => {
    const parsed = parseScript(line)[0];
    if (!parsed || parsed.kind !== "command" || parsed.command !== "predicate") return line;
    const refs = parseIntList(arg(parsed.args, "references"));
    if (refs === null || refs.length === 0) return line;
    if (!refs.includes(ambient)) return line;
    if (added.every((value) => refs.includes(value))) return line;
    const merged = [...new Set([...refs, ...added])].sort((a, b) => a - b);
    return line.replace(/references\s*=\s*(?:"[^"]*"|'[^']*'|[^,\s)]+)/, `references="${merged.join(";")}"`);
  });
}

/**
 * 规范化「在此分叉」的输入行（2..8 条）。
 *
 * 值分配的两条语义（**不要**改成一条）：
 *   · **显式传入**的 value 只跟**本次插入的其它行**去重 —— 用户自己写的值
 *     就是有意复用（新 `[Decision]` 会重新写 `selectedValue`，与文中已有的
 *     同值不冲突；样例里 `values="1;2"` 之后再插 1;2 是完全合法的用法）。
 *     若拿它去避让脚本里已有的值，`fresh` 会被按「自动分配的行数」申请为 0 条，
 *     循环里又不断 `used.add` → 值无限递增（`Set maximum size exceeded`）。
 *   · **自动分配**的 value（行里没给）避开脚本里已有的值域 + 本次已占用的值
 *     （值域全局共享，撞车会让别人的闸门顺带放行你的线路）。
 *
 * @param {string} source
 * @param {(string|{label?:string, value?:number})[]|undefined} options
 * @returns {{label:string, value:number}[]}
 */
function normalizeForkOptions(source, options) {
  const raw = Array.isArray(options) && options.length ? options : suggestForkOptions(source, 2);
  const used = usedValues(source);
  /** @type {{label:string, value:number|null}[]} */
  const rows = raw.slice(0, 8).map((item) => {
    if (typeof item === "string") return { label: item, value: null };
    const value = typeof item?.value === "number" && Number.isFinite(item.value) ? Math.trunc(item.value) : null;
    return { label: String(item?.label ?? ""), value };
  });
  const fresh = allocateValues(rows.filter((row) => row.value === null).length, used);
  let cursor = 0;
  /** 自动分配的兜底序列（从 `max(used)+1` 起，不用 `used.add` 自增）。 */
  let spill = (used.size ? Math.max(...used) : 0) + 1;
  const nextFresh = () => {
    if (cursor < fresh.length) return fresh[cursor++];
    while (used.has(spill) || taken.has(spill)) spill += 1;
    const value = spill;
    spill += 1;
    return value;
  };
  const taken = new Set();
  return rows.map((row, index) => {
    const label = row.label || `选项${index + 1}`;
    if (row.value !== null) {
      let value = row.value;
      while (taken.has(value)) value += 1; // 只跟本次插入的其它行去重（≤8 次）
      taken.add(value);
      return { label, value };
    }
    const value = nextFresh();
    taken.add(value);
    used.add(value);
    return { label, value };
  });
}
