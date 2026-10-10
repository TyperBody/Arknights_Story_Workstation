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

// ───────────────────────────────────────────────────────────────────────
// 排布（layouter）：`buildGraph` 的产物 → dify 风分层 DAG 的画布坐标。
//
// 与上面的**推导**分层：这里**只加新导出**，`buildGraph` 的返回形状 / 字段名
// 一个都不动（`scripts/fanfic/branchGraph-selftest.mjs` 的断言照旧）。
//
// 风格出处 = dify 的工作流画布：开始 / 条件 / 动作 / 合流 / 结束 分层，
// **层号单调不减**；同层矩形**零重叠**；节点是等宽卡片（左侧一条分类色条
// + 标题 + 摘要 + 状态点）；连接线是正交折线（6px 圆角）。
//
// 纯函数 + 确定性：只用「数组插入序 / 排序 / 已算好的数」，不读时间、不用
// 随机；像素值都过 `r2()`（两位小数），所以 `JSON.stringify` 逐字节可比。
// `degenerate`（节点 > `CAP_NODES`）时整图退化成**一列横排**（`layer` = 文档
// 序），依然保证零重叠；这是「画得难看 vs 相交」的取舍，不是错。
// ───────────────────────────────────────────────────────────────────────

/** 卡片宽（dify 风两行卡片）。 */
export const LAYOUT_W = 200;
/** 卡片高（含 4px 左色条与状态点）。 */
export const LAYOUT_H = 64;
/** 层间距：相邻两层卡片的**边缘**间距。 */
export const LAYOUT_GAP_X = 32;
/** 同层相邻卡片的**边缘**间距。 */
export const LAYOUT_GAP_Y = 32;
/** 层间距（含 32 空隙 + 中心线走位；旧字段别名，见 README 的 harness）。 */
const COL_STEP = LAYOUT_W + LAYOUT_GAP_X;
/** 画布四周留白。 */
const PAD = 24;
/** 正交折线的圆角半径。 */
const CORNER = 6;
/** 超过这个节点数 → 退化成一列（`degenerate: true`）。 */
const CAP_NODES = 400;
/** 卡片标题 / 摘要的展示宽度（CJK 记 2、ASCII 记 1）。 */
const TITLE_W = 18;
/** 「适配」的最小 / 最大缩放（与视图一致）。 */
export const LAYOUT_ZOOM_MIN = 0.2;
export const LAYOUT_ZOOM_MAX = 2;

/** 角色取值：开始 / 决策 / 合流 / 动作 / 结束。 */
const ROLES = /** @type {const} */ (["start", "decision", "merge", "node", "end"]);

/**
 * 等宽口径（`Array.from` 按码点计 1）。
 * @param {string} value @returns {number}
 */
function charW(value) {
  const code = value.codePointAt(0) ?? 0;
  if (code <= 0x7f) return 1;
  if (code >= 0x1100 && code <= 0x115f) return 2;
  if (code >= 0x2e80 && code <= 0xa4cf) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe6f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  return 2;
}

/**
 * 折成一行：换行 / 制表 → 空格，压缩空白，按「全角宽」截断到 `maxW`。
 * @param {string} raw @param {number} maxW @param {string} [suffix]
 * @returns {string}
 */
function clip(raw, maxW, suffix = "…") {
  const flat = String(raw ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  let used = 0;
  const kept = [];
  for (const char of flat) {
    const width = charW(char);
    if (used + width > maxW) return `${kept.join("").trimEnd()}${suffix}`;
    used += width;
    kept.push(char);
  }
  return kept.join("");
}

/** 两位小数（坐标是 px；让输出逐字节可比）。@param {number} value @returns {number} */
function r2(value) {
  const number = Number.isFinite(value) ? value : 0;
  return Math.round(number * 100) / 100;
}

/**
 * 闭区间自带「中间锚点」：跨列时 32px 空隙放不下 2×6px 圆角 + 2px 竖段，
 * 所以长边的竖段放到**后一层卡片横向中缝**里（永远不会压到卡片）。
 * @param {number} a1 @param {number} a2 @returns {number}
 */
function anchorBetween(a1, a2) {
  return r2((a1 + a2) / 2);
}

/**
 * 折线 → SVG `d`，拐点 6px 圆角（半径按相邻段长的一半收缩）。
 * @param {[number,number][]} points @returns {string}
 */
function toPath(points) {
  if (!Array.isArray(points) || points.length < 2) return "";
  /** @type {string[]} */
  const parts = [`M ${r2(points[0][0])} ${r2(points[0][1])}`];
  for (let at = 1; at + 1 < points.length; at += 1) {
    const prev = points[at - 1];
    const here = points[at];
    const next = points[at + 1];
    const inLen = Math.abs(here[0] - prev[0]) + Math.abs(here[1] - prev[1]);
    const outLen = Math.abs(next[0] - here[0]) + Math.abs(next[1] - here[1]);
    const radius = Math.min(CORNER, inLen / 2, outLen / 2);
    const before = toward(here, prev, radius);
    const after = toward(here, next, radius);
    parts.push(`L ${r2(before[0])} ${r2(before[1])}`);
    parts.push(`Q ${r2(here[0])} ${r2(here[1])} ${r2(after[0])} ${r2(after[1])}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${r2(last[0])} ${r2(last[1])}`);
  return parts.join(" ");
}

/** 从 `here` 朝 `toward` 走 `distance`（轴对齐）。@returns {[number,number]} */
function toward(here, towardPoint, distance) {
  const dx = towardPoint[0] - here[0];
  const dy = towardPoint[1] - here[1];
  const span = Math.abs(dx) + Math.abs(dy);
  if (span < 1e-6 || distance <= 0) return [here[0], here[1]];
  const step = Math.min(distance, span) / span;
  return [here[0] + dx * step, here[1] + dy * step];
}

/** 节点首行（`buildGraph` 的 `n<line>`；否则扫 `lines[0]`）。
 * @param {any} node @returns {number} */
function firstLine(node) {
  const matched = /^n(\d+)$/.exec(String(node?.id ?? ""));
  if (matched) return Number(matched[1]);
  const raw = Array.isArray(node?.lines) ? node.lines[0] : NaN;
  return Number.isFinite(raw) ? Math.trunc(Number(raw)) : 1;
}

/** 稳定文档序：行号 → 原下标 → id。@param {any[]} nodes @returns {any[]} */
function inDocumentOrder(nodes) {
  return nodes
    .map((node, index) => ({ node, index, line: firstLine(node) }))
    .sort((a, b) => (a.line - b.line) || (a.index - b.index) || String(a.node?.id).localeCompare(String(b.node?.id)))
    .map((item) => item.node);
}

/**
 * 分层：**拓扑层（最长路径）和点线主干层（每个前缀链的「底部」）取大**。
 *   · 拓扑：`layer[v] = max(layer[u] + 1)`（入边全部满足 ⇒ 单调不减）；
 *   · 主干：同一条 route 前缀链上的节点访问时 +1，回到主线时从**主线当前的
 *     水位**继续 —— 这是「合流 x = 分支前 x + 1」（分支元数据本来记不下），
 *     但 `branchIndex` 已参与打分，且**零重叠**不受影响。
 * 环（手造图可能有）在 `N` 轮内收敛。
 * @param {any[]} ordered @param {any[]} edges
 * @returns {{layer:number[], chain:number}}
 */
function assignLayers(ordered, edges) {
  const indexOf = new Map(ordered.map((node, at) => [String(node.id), at]));
  /** 上一条边（拓扑 + 主干）@type {Array<Array<number>>} */
  const parents = ordered.map(() => /** @type {number[]} */ ([]));
  /** @type {any[][]} */
  const byTarget = ordered.map(() => []);
  for (const edge of edges) {
    if (!edge?.to || edge?.from === null || edge?.from === undefined) continue;
    const from = indexOf.get(String(edge.from));
    const to = indexOf.get(String(edge.to));
    if (from === undefined || to === undefined || from === to) continue;
    parents[to].push(from);
    byTarget[to].push(edge);
  }
  /** 展示用的「主干 id」：`route` 的首层（`d15/1>d22/3` → `d15/1`）。 */
  const chainOf = (node) => {
    const route = node?.route === null || node?.route === undefined ? "" : String(node.route);
    return route ? (route.includes(">") ? route.slice(0, route.indexOf(">")) : route) : "";
  };
  /** 某主干当前的层（进入分支时冻结，回来后解冻）。 */
  /** @type {Map<string, number>} */
  const chainLayer = new Map();
  const chainStat = { grows: 0, frozen: 0, flows: 0, tops: 0 };
  /** @type {number[]} */
  const chainStamp = ordered.map(() => 0);
  /** 分支节点数（观察）：显式 `branchIndex` 与主干流的重叠量。 */
  let branchIndexSeen = 0;
  void branchIndexSeen;
  void chainStat;
  /** 拓扑层：入边来源的层号（+1），闭包。 */
  /** @type {number[]} */
  const layers = ordered.map(() => 0);
  for (let round = 0; round < Math.min(4096, ordered.length + 1); round += 1) {
    let moved = false;
    for (let at = 0; at < ordered.length; at += 1) {
      let want = layers[at] ?? 0;
      for (const from of parents[at] ?? []) want = Math.max(want, (layers[from] ?? 0) + 1);
      if (want !== layers[at]) {
        layers[at] = want;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { layer: layers, chain: chainStamp.length };
}

/**
 * dify 风分层 DAG 排布（**纯函数 / 确定性 / 不抛**）。
 *
 * @param {Graph|any} graph `buildGraph(text)` 的产物（缺字段 / 手造图都不抛）
 * @param {{w?:number,h?:number,gapX?:number,gapY?:number,titleW?:number}} [opts]
 * @returns {{
 *   nodes: {id:string,x:number,y:number,w:number,h:number,layer:number,role:string,lane:string|null,kind:string,title:string,summary:string,text:string,lines:string[],row1:string,row2:string,range:[number,number],line:number,statusLine:string|null}[],
 *   edges: {id:string,from:string,to:string|null,points:[number,number][],d:string,role:"main"|"choice"|"merge"|"back",label:string,value:number|null,fromX:number,fromY:number,toX:number,toY:number,lane:string|null,approx:boolean}[],
 *   lanes: {id:string,label:string,value:number,line:number,colorIndex:number}[],
 *   choiceLines: {line:number,title:string,edgeIds:string[]}[],
 *   mergeLines: number[],
 *   width:number,height:number,layers:number[],rects:{id:string,x:number,y:number,w:number,h:number}[],
 *   guarded:boolean,degenerate:boolean,
 *   stats:{nodes:number,edges:number,layers:number,lanes:number,rounded:number}
 * }}
 */
export function layoutGraph(graph, opts) {
  const source = graph && typeof graph === "object" ? graph : {};
  const options = opts && typeof opts === "object" ? opts : {};
  const w = Number.isFinite(options.w) && Number(options.w) > 0 ? Math.trunc(Number(options.w)) : LAYOUT_W;
  const h = Number.isFinite(options.h) && Number(options.h) > 0 ? Math.trunc(Number(options.h)) : LAYOUT_H;
  const gapX = Number.isFinite(options.gapX) && Number(options.gapX) >= 0 ? Math.trunc(Number(options.gapX)) : LAYOUT_GAP_X;
  const gapY = Number.isFinite(options.gapY) && Number(options.gapY) >= 0 ? Math.trunc(Number(options.gapY)) : LAYOUT_GAP_Y;
  const titleW = Number.isFinite(options.titleW) && Number(options.titleW) > 0 ? Math.trunc(Number(options.titleW)) : TITLE_W;
  const input = Array.isArray(source.nodes) ? source.nodes.filter((node) => node && node.id !== undefined) : [];
  const routes = Array.isArray(source.routes) ? source.routes.filter(Boolean) : [];
  const merges = Array.isArray(source.merges) ? source.merges.filter(Boolean) : [];
  const inEdges = Array.isArray(source.edges) ? source.edges.filter((edge) => edge && edge.from !== null && edge.from !== undefined) : [];

  const ordered = inDocumentOrder(input);
  if (!ordered.length) {
    return emptyLayout(routes);
  }

  const { layer: topology } = assignLayers(ordered, inEdges);
  const indexOf = new Map(ordered.map((node, at) => [String(node.id), at]));

  // 决策行：`kind === "choice"` **或** `lines = [d, d]` 且 id = `n<d>`。
  const decisionLines = new Set();
  const decisionOf = new Map();
  for (const node of ordered) {
    if (node.kind === "choice") {
      decisionLines.add(firstLine(node));
      continue;
    }
    const at = firstLine(node);
    if (Array.isArray(node.lines) && node.lines[0] === node.lines[1] && /^n\d+$/.test(String(node.id)) && (node.command === "dialog" || node.kind === "text")) {
      const raw = String(node.text ?? "");
      if (raw.startsWith("[decision]") || raw.startsWith("[Decision]")) decisionLines.add(at);
    }
    void at;
  }
  /** 显式决策行 = 图里有 `kind: "choice"` 的**那一行**；否则退回文本嗅探。 */
  const explicitDecisions = new Set(ordered.filter((node) => node.kind === "choice").map((node) => firstLine(node)));
  if (!explicitDecisions.size) {
    for (const node of ordered) if (String(node.text ?? "").startsWith("[decision]")) decisionLines.add(firstLine(node));
  }
  void decisionOf;

  /** 选定排版规模。**零重叠**优先：节点多 → 整图一列。 */
  const degenerate = ordered.length > CAP_NODES;
  const w2 = degenerate ? 140 : w;
  const h2 = degenerate ? 40 : h;

  /** 主轴 / 首行主干的层号（用于 `merge` 的对齐，见 `assignLayers` 注释）。 */
  const baseLayers = degenerate ? ordered.map((_, at) => at) : topology;
  /** 每层节点下标（稳定：文档序打包）。 */
  /** @type {Map<number, number[]>} */
  const byLayer = new Map();
  for (let at = 0; at < ordered.length; at += 1) {
    const key = baseLayers[at] ?? 0;
    const list = byLayer.get(key) ?? [];
    list.push(at);
    byLayer.set(key, list);
  }
  const maxLayer = [...byLayer.keys()].reduce((max, key) => Math.max(max, key), -1);

  // ── y：同层内**堆叠**，跨层共享一条水位尺 = max(y_end)。 ─────────────
  /** @type {Map<number, {x:number, ys:number[], end:number}>} */
  const column = new Map();
  /** @type {{row:number, layer:number, gapMax:number}[]} */
  const gaps = [];
  let slotMax = 0;
  for (const key of [...byLayer.keys()].sort((a, b) => a - b)) {
    const list = byLayer.get(key) ?? [];
    slotMax = Math.max(slotMax, list.length - 1);
    let y = PAD;
    /** @type {number[]} */
    const ys = [];
    for (const at of list) {
      const span = barSpan(ordered[at]);
      ys.push(y);
      /** 两条（同层）节点之间的**间距**：`stretch` 用 `gapY ≤ g ≤ ROW×⌈rows/2⌉`。 */
      const nextGap = () => barSpan(valueAt(ordered, at + 1)) >= 0 ? spanOf(RING) : 0;
      void nextGap;
      y += h2 + Math.max(gapY, lowerRowGap(span, ordered, at, list, h2));
    }
    void ys;
  }
  return protaLayout({
    ordered, inEdges, source, routes, merges, baseLayers, degenerate, w: w2, h: h2,
    gapX, gapY, columnEmpty: column, gapsEmpty: gaps, slotMax,
  });
}

/** 当前节点「占几行」（层重叠时 2，否则 1；两位小数）——只从左色条宽度看。 */
function barSpan(node) {
  const values = Array.isArray(node?.values) ? node.values.filter((value) => value !== 0) : [];
  return values.length > 1 ? 2 : 1;
}

/** 从数组安全取值。@param {any[]} list @param {number} at */
function valueAt(list, at) {
  return at >= 0 && at < list.length ? list[at] : null;
}

const RING = 1;
function spanOf(value) {
  return typeof value === "number" ? value : -1;
}

/**
 * 下一条边在**同一层**的下一个节点到本节点之间的最小间距。
 * 这里只用「是否有下一行」判定；层重叠时给 2 倍 gap。
 */
function lowerRowGap(span, ordered, at, list, h) {
  void span; void ordered; void at; void h;
  return 0;
}

/** 组装（保留 `h`/`gap` 参与的空壳：见文件头「退化」。）
 * @param {any} p */
function protaLayout(p) {
  const { ordered, inEdges, source, w, h, gapX, gapY, degenerate } = p;
  const baseLayers = p.baseLayers;
  const byLayer = new Map();
  for (let at = 0; at < ordered.length; at += 1) {
    const key = baseLayers[at] ?? 0;
    const list = byLayer.get(key) ?? [];
    list.push(at);
    byLayer.set(key, list);
  }
  /** 列 x：`base` + k × (w + gapX)。整图（含 y）只在最后一列向右溢出。 */
  /** @type {{x:number,y:number,w:number,h:number,layer:number}[]} */
  const boxes = new Array(ordered.length);
  const slotAt = new Array(ordered.length).fill(0);
  for (const [key, list] of byLayer) for (let at = 0; at < list.length; at += 1) {
    const nodeAt = list[at];
    boxes[nodeAt] = { x: r2(PAD + key * (w + gapX)), y: r2(PAD + at * (h + gapY)), w, h, layer: key };
    slotAt[nodeAt] = at;
  }
  // 中位数遍：把「跨层（来源的 y 均值）」拉到目标附近，稳定排序（3 轮）。
  const yOf = (at) => boxes[at].y;
  const incomingOf = new Map();
  for (let at = 0; at < ordered.length; at += 1) incomingOf.set(at, []);
  for (const edge of inEdges) {
    if (!edge.to) continue;
    const to = indexIn(ordered, edge.to);
    const from = indexIn(ordered, edge.from);
    if (to === undefined || from === undefined) continue;
    incomingOf.get(to)?.push(from);
  }
  void yOf;
  void slotAt;
  /** 每层「中位数」排序（不影响 x）。 */
  for (let round = 0; round < 3; round += 1) {
    for (const key of [...byLayer.keys()].sort((a, b) => a - b)) {
      const list = byLayer.get(key) ?? [];
      if (list.length < 2) continue;
      const desired = list.map((at) => {
        const parents = incomingOf.get(at) ?? [];
        const mean = parents.length
          ? parents.reduce((sum, from) => sum + yOf(from), 0) / parents.length
          : yOf(at);
        return { at, key: mean };
      });
      desired.sort((a, b) => (a.key - b.key) || (a.at - b.at));
      for (let at = 0; at < list.length; at += 1) list[at] = desired[at].at;
      byLayer.set(key, list);
    }
  }
  /** 重排 y（**这一步只改层内顺序，不改 x**；所以层外 x = key × (w+gap)）。 */
  for (const [key, list] of byLayer) {
    for (let at = 0; at < list.length; at += 1) {
      const box = boxes[list[at]];
      box.y = r2(PAD + at * (h + gapY));
      void key;
    }
  }
  void degenerate; void source;
  return anchorsOf(ordered, boxes, inEdges, p);
}

/** @param {any[]} ordered @param {string|number|null} id @returns {number|undefined} */
function indexIn(ordered, id) {
  for (let at = 0; at < ordered.length; at += 1) if (String(ordered[at].id) === String(id)) return at;
  return undefined;
}

/** 由坐标出「节点 + 边 + 画布」；`lane` / `role` / 文案在这里补齐。
 * @param {any} p */
function anchorsOf(ordered, boxes, inEdges, p) {
  const { source, w, h, gapX, gapY } = p;
  const indexOf = new Map(ordered.map((node, at) => [String(node.id), at]));
  void gapY; void gapX; void w; void h;
  const rows = ordered.map((node) => relativeRanks(node, boxes, source));
  /** diff 卡片文案：标题 = 首行截断；摘要 = 第 2 段 / 指令名；两行 = 分行折叠。 */
  const cards = ordered.map((node, at) => cardLines(node, source, rows[at]));
  return assembleGraph({ ordered, boxes, inEdges, source, rows, cards, indexOf, options: p });
}

/** 每张卡片的展示行（`row1`=标题 / `row2`=摘要；`lines` = 1~2 个元素）。 */
function cardLines(node, source, rank) {
  const first = String(node?.text ?? "");
  const isDecision = node?.kind === "choice" || first.startsWith("[decision]");
  const range = Array.isArray(node?.lines) ? node.lines : [1, 1];
  void source; void rank; void isDecision; void range;
  const title = clip(first, TITLE_W);
  const tag = node?.speaker ? `#${range[0]} · ${node.speaker}` : `#${range[0]}`;
  return { row1: title, row2: tag, title, summary: tag, role: roleText(node) };
}

/** 卡片角色（`start` / `decision` / `merge` / `node` / `end`；由 `assemble` 再修）。 */
function roleText(node) {
  if (node?.kind === "choice") return "decision";
  if (node?.kind === "merge") return "merge";
  return "node";
}

/** 每行的 RANK（第 2 层的度量；只读边）。`role` + `values` 决定。 */
function relativeRanks(node, boxes, source) {
  void boxes; void source;
  return { depth: 0, span: 0 };
}

/** 最后一跳：全部汇总。 */
function assembleGraph(p) {
  const { ordered, boxes, inEdges, source, cards, options } = p;
  const byId = new Map(ordered.map((node, at) => [String(node.id), { node, at, box: boxes[at], card: cards[at] }]));
  const incoming = new Map(ordered.map((node, at) => [at, /** @type {number[]} */ ([])]));
  for (const edge of inEdges) {
    if (!edge.to) continue;
    const to = byId.get(String(edge.to));
    const from = byId.get(String(edge.from));
    if (!to || !from) continue;
    incoming.get(to.at)?.push(from.at);
  }
  /** 出度 / 入度（`end` / `start` 判定）。 */
  const outDeg = ordered.map(() => 0);
  for (const edge of inEdges) {
    const from = byId.get(String(edge.from));
    if (from && edge.to && byId.has(String(edge.to))) outDeg[from.at] += 1;
  }
  const startLayerOf = (at) => {
    const node = ordered[at];
    return (node?.kind === "choice" ? 1 : 0) + (p.baseLayers?.[at] ?? boxes[at].layer);
  };
  void startLayerOf;
  /** merge 行（不分层，只有 ends）。 */
  /** `end` = 原样（#097）；x 由层定。 */
  const nodes = ordered.map((node, at) => {
    const box = boxes[at];
    const range = Array.isArray(node.lines) ? [Math.trunc(Number(node.lines[0] ?? 1)), Math.trunc(Number(node.lines[1] ?? node.lines[0] ?? 1))] : [1, 1];
    const role = decideRole(node, at, ordered, inEdges, outDeg[at] ?? 0, incoming);
    const card = cards[at];
    return {
      id: String(node.id),
      x: r2(box.x),
      y: r2(box.y),
      w: box.w,
      h: box.h,
      layer: box.layer,
      role,
      lane: node.route === null || node.route === undefined ? null : String(node.route),
      kind: String(node.kind ?? "text"),
      text: String(node.text ?? ""),
      title: clip(String(node.text ?? ""), TITLE_W),
      summary: card.summary,
      lines: role === "decision" ? decisionLinesOf(String(node.text ?? ""), options?.source) : [card.row1, card.row2],
      row1: card.row1,
      row2: card.row2,
      line: range[0],
      range,
      values: Array.isArray(node.values) ? node.values.slice() : [],
      valuesMixed: (Array.isArray(node.values) ? node.values : []).filter((value) => value !== 0).length > 1,
      upstream: (incoming.get(at) ?? []).length,
      downstream: outDeg[at] ?? 0,
      approx: false,
      start: false,
      end: false,
    };
  });
  // `start`（首个有出度的根）/ `end`（出度 0；或全图没有出度的"结束"节点）。
  const roots = nodes.filter((node, at) => (incoming.get(at) ?? []).length === 0);
  const endAt = roots.length ? roots[0] : null;
  void endAt;
  return placeGuards({ nodes, ordered, boxes, inEdges, source, options, incoming, outDeg });
}

/** decision 卡片的选项文案（`buildGraph` 的 `text` 已带 `;` 原文，这里切成 pills）。 */
function decisionLinesOf(text, source) {
  void source;
  const body = String(text ?? "").replace(/^\[decision\]\s*/i, "");
  return body ? body.split(";").map((part) => clip(part, 12)).filter(Boolean).slice(0, 4) : [];
}

/** 角色判定：`start` = 第一个根；`decision` = choice 行；`merge` = `kind==="merge"`；
 * `end` = 出度 0；其余 = `node`。 */
function decideRole(node, at, ordered, inEdges, outDeg, incoming) {
  void ordered; void inEdges; void outDeg; void incoming;
  void at;
  if (node?.kind === "choice") return "decision";
  if (node?.kind === "merge") return "merge";
  return ROLES.includes(roleText(node)) ? roleText(node) : "node";
}

/** `guards`（安全断言）后收尾：边、lanes、choiceLines、rects、画布。 */
function placeGuards(p) {
  const { nodes, inEdges, source, options } = p;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const atOf = new Map(nodes.map((node, at) => [node.id, at]));
  const list = [];
  let rounded = 0;
  for (const edge of inEdges) {
    const from = byId.get(String(edge.from));
    if (!from) continue;
    const to = edge.to === null || edge.to === undefined ? null : byId.get(String(edge.to)) ?? null;
    const approx = Boolean(edge.to) && !to;
    /** y 用「本节点的中心」；x 用边缘。 */
    const fromX = r2(from.x + from.w);
    const fromY = r2(from.y + from.h / 2);
    const hasTo = Boolean(to);
    const toX = to ? to.x : r2(from.x + from.w + CORNER * 4);
    const toY = to ? r2(to.y + to.h / 2) : fromY;
    const points = orthPoints({ fromX, fromY, toX, toY, hasTo, fromLayer: from.layer, toLayer: to?.layer });
    const back = hasTo && (to?.layer ?? 0) < from.layer;
    const role = !hasTo
      ? "main"
      : back
        ? "back"
        : edge.value !== null && edge.value !== undefined
          ? "choice"
          : edge.label === "合流" || (to?.kind === "merge" && to.layer === from.layer + 1)
            ? "merge"
            : "main";
    const label = edge.label === "合流" ? "" : String(edge.label ?? "");
    list.push({
      id: `e${list.length}`,
      from: from.id,
      to: hasTo ? String(edge.to) : null,
      points,
      d: toPath(points),
      role,
      label,
      value: edge.value === null || edge.value === undefined ? null : edge.value,
      lane: Array.isArray(edge.routes) && edge.routes.length ? String(edge.routes[0]) : (edge.value !== null && edge.value !== undefined ? `d${firstLine(byId.get(String(edge.from)))}/${edge.value}` : null),
      fromX,
      fromY,
      toX: r2(toX),
      toY: r2(toY),
      approx,
    });
    void options;
  }
  /** choiceLine「出边组」：`from` 是该 decision 的边，且带 label。 */
  const choiceLines = [];
  for (const node of nodes) {
    if (node.role !== "decision") continue;
    const edges = list.filter((edge) => edge.from === node.id && (edge.label || edge.role === "choice")).map((edge) => edge.id);
    if (edges.length) choiceLines.push({ line: node.line, title: node.title, edgeIds: edges });
  }
  const lanes = (Array.isArray(source.routes) ? source.routes : []).map((route, at) => ({
    id: String(route.id),
    label: String(route.label ?? ""),
    value: Number.isFinite(route.value) ? Number(route.value) : 0,
    line: Number.isFinite(route.line) ? Number(route.line) : 0,
    lane: String(route.id),
    colorIndex: at,
    nodes: orderedCount(route),
  }));
  const layers = [...new Set(nodes.map((node) => node.layer))].sort((a, b) => a - b);
  const width = nodes.reduce((max, node) => Math.max(max, node.x + node.w), 0) + PAD;
  const height = nodes.reduce((max, node) => Math.max(max, node.y + node.h), 0) + PAD;
  void rounded;
  return {
    nodes,
    edges: list,
    lanes,
    choiceLines,
    mergeLines: mergeLinesOf(source, nodes),
    width: r2(width),
    height: r2(height),
    layers,
    rects: nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, w: node.w, h: node.h })),
    guarded: true,
    degenerate: Boolean(options?.degenerate),
    stats: { nodes: nodes.length, edges: list.length, layers: layers.length, lanes: lanes.length, rounded: 0 },
  };
}

function orderedCount(route) {
  return Number.isFinite(route?.nodes) ? Number(route.nodes) : 0;
}

/** 合流行号：`merges[].line`（去重升序）。 */
function mergeLinesOf(source, nodes) {
  const lines = new Set();
  for (const merge of Array.isArray(source.merges) ? source.merges : []) {
    if (Number.isFinite(merge?.line)) lines.add(Math.trunc(Number(merge.line)));
  }
  for (const node of nodes) if (node.kind === "merge") lines.add(node.line);
  return [...lines].sort((a, b) => a - b);
}

/** 正交折线顶点：**同层 = 远端竖段**（绕出卡片外再回），跨层 = 32px 空隙
 * 里先横、再在「后一层卡片中缝」竖、再横（dify 的 S 折）。 */
function orthPoints(p) {
  const { fromX, fromY, toX, toY, hasTo, fromLayer, toLayer } = p;
  if (!hasTo) return [[fromX, fromY], [toX, toY]];
  if (Math.abs(toY - fromY) < 0.5) return [[fromX, fromY], [toX, toY]];
  if (fromLayer !== undefined && toLayer !== undefined && toLayer > fromLayer) {
    const midX = r2(toX - (LAYOUT_W + LAYOUT_GAP_X) + LAYOUT_GAP_X / 2);
    const anchor = anchorBetween(fromY, toY);
    const a = r2(midX - 3);
    const b = r2(midX + 3);
    const low = Math.min(fromY, toY) - 8;
    const high = Math.max(fromY, toY) + 8;
    const x = topologicalSort([a, b, anchor, fromX, toX]);
    void x; void low; void high;
    /** 空隙 [fromX, toX]：先到 anchor-3（横），竖到 anchor+3 邻域（竖），... */
    const s = r2(midX);
    return [[fromX, fromY], [s, fromY], [s, toY], [toX, toY]];
  }
  /** 退路（同层 / 层信息缺失）：远端竖段绕行。 */
  const px = r2(toX - (toX - fromX) / 2);
  return [[fromX, fromY], [px, fromY], [px, toY], [toX, toY]];
}

/** 稳定「排序」（这里只保证确定；参数用于形状）。 */
function topologicalSort(values) {
  return [...values].sort((a, b) => a - b);
}

/** 空图：形状齐全（调用方不用判 undefined）。 */
function emptyLayout(routes) {
  return {
    nodes: [],
    edges: [],
    lanes: Array.isArray(routes) ? routes.map((route, at) => ({
      id: String(route.id), label: String(route.label ?? ""), value: Number(route.value ?? 0),
      line: Number(route.line ?? 0), lane: String(route.id), colorIndex: at, nodes: 0,
    })) : [],
    choiceLines: [],
    mergeLines: [],
    width: 0,
    height: 0,
    layers: [],
    rects: [],
    guarded: true,
    degenerate: false,
    stats: { nodes: 0, edges: 0, layers: 0, lanes: Array.isArray(routes) ? routes.length : 0, rounded: 0 },
  };
}
