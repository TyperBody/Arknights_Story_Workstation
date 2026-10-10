/**
 * 编辑器表单：把「一行剧本」还原成可填的字段，再把用户改过的值**就地重建**成一行。
 *
 * 这是 YayinStoryStudio `AStoryXRebuilder` 在本 DSL 上的等价物：
 *
 * | YSS（`AStorySyntax/`） | 本模块 |
 * |---|---|
 * | `AStoryXController`：header + required + optional，每个参数带 `AStoryXValueMeta` 的 type/default/range/enum | `CONTROLLERS` → `formFor()` 的字段表（`type/default/options/range` 全部**派生**，不手抄） |
 * | `AStoryXValueMeta::getEnumCheckList()` | `ENUMS`（语料观察集）→ `field.options` |
 * | `AStoryXValueMeta::getFloatCheckRange()` | `OBSERVED_RANGES`（全语料实测 min/max/步长）→ `field.range` / `field.corpusCount` |
 * | `AStoryXRebuilder::rebuild(rule, type, reqPara, optParas)` | `formatLine(command, values)`（规范形态：canonical 大小写、`, ` 分隔） |
 * | `AStoryXRebuilder::rebuild(rule, parseData)`（按 ParseData 回填） | `parseValues(line)` → `applyForm(line, values)` = **就地补丁**：保留源里的写法/间隔/正文，只替换改动过的字段 |
 * | `AStoryXRule`（`BaseRule.json` 的规则选择） | 无：本 DSL 只有一套规则，`CONTROLLERS` 即规则表 |
 *
 * **与 YSS `AStoryXRebuilder::rebuild` 的差异（有意为之，已由 Lead 采纳）**：
 * YSS 的 `rebuild()` 每次都会"header + 必填 + 可选（按声明顺序）"**整行重排**；
 * 本模块的 `applyForm()` 是**就地补丁**，三条具体差异：
 * 1) **无改动 → 原样返回源行**（`values` 与 `parseValues(line).values` 全等时，
 *    连一个字符都不重排）；`formatLine()` 的 canonical 重排只在
 *    `options.canonical === true` / 换了控制器（`options.command`）时发生；
 * 2) **只重写改动过的键**：`[Character(name="a",fadetime=1)]` 里把 `fadetime` 改成
 *    2 → 只有 `fadetime=2` 这一段被替换（源里的大小写、`=` 两侧空格、`, ` 与 `,`
 *    的混用、参数顺序全部保留）；
 * 3) **`values` 里没列出的键原样保留**（不按 spec 补全、不删多余键）：YSS 会用
 *    ValueMeta 的 default 补齐可选参数，这里只在"换控制器"时才交给 `formatLine()`
 *    去补 —— 好处是 diff 只包含用户真正改过的东西（官方语料 1,073,321 行
 *    逐字节往返 100%，见 `scripts/fanfic/editorForms-selftest.mjs --full`）。
 * 另：`]` 之后的**正文**（`[name="X"]  台词`、`[Dialog]` 尾随、`[Narration]/[aside]`
 * 的旁白、`[animtext]…</>`）与首尾空白始终逐字节带回来。
 *
 * 内嵌四张只读表（文件末尾 `@generated:data` 区，由
 * `scripts/fanfic/editorForms-data.mjs` 从官方 5,735 个剧本 .txt 生成）：
 * `OBSERVED_RANGES` / `NAMED_PRESETS` / `CORPUS_ANCHORS` / `COMMON_ASSETS`。
 * 它们**只**影响滑杆范围 / 预设 / 素材候选；字段表始终从 `CONTROLLERS` 派生。
 *
 * @module editorForms
 */

import { CONTROLLERS, ENUMS, formatLine, parseLine } from "./editorModel.js";
import { splitTopLevel } from "./storyPack.js";

/** @typedef {import("./editorModel.js").ValueMeta} ValueMeta */
/** @typedef {import("./editorModel.js").ControllerSpec} ControllerSpec */
/** @typedef {import("./editorModel.js").Diagnostic} Diagnostic */
/** @typedef {Record<string, Partial<ControllerSpec> & {command: string}>} ControllerLike */
/** @typedef {Array<Partial<ControllerSpec> & {command: string}>} ControllerList */

/**
 * @typedef {object} FormField
 * @property {string} name            规范键名（大小写与声明一致）
 * @property {"string"|"number"|"bool"|"enum"|"path"|"vector"|"note"} type 控件类型（`note` = 只读说明行）
 * @property {"required"|"optional"|"meta"|"body"} group（`meta` = 只读说明行，`body` = 自动补的正文框）
 * @property {string} label           中文短标签（由 hint 派生）
 * @property {string} hint            完整说明
 * @property {boolean} engineRead     运行时当前版本是否读这个键（false → 表单里灰掉）
 * @property {string|number|boolean} [default]
 * @property {string[]} [options]    enum 的候选值
 * @property {[number, number, number]|null} [range] `[min, max, step]`：语料实测
 * @property {number} [corpusCount]   语料出现次数（0 = 没有观察样本）
 * @property {number} [constant]      语料里"恒为某值"（此时不给滑杆，只给数字输入）
 * @property {boolean} [integerish]   按整数渲染（引擎 Convert.ToInt32）
 * @property {boolean} [multiline]    `text` 类（多行文本框）
 * @property {boolean} [tail]         写在 `]` **之后**的尾随正文（不进 `(…)`）
 * @property {string} [separator]    `;` 分隔的多值字段
 * @property {string} [reason]        灰掉的原因
 */

/**
 * @typedef {object} FormModel
 * @property {string} command
 * @property {string} canonical
 * @property {string} category
 * @property {"A"|"B"|"C"} tier
 * @property {string} summary
 * @property {string} hint            参数习惯提示（`argless` 语义 / spec.note）
 * @property {boolean} engineRead
 * @property {string} example
 * @property {string} engineRef
 * @property {string} argless
 * @property {boolean} tailCapable  `]` 之后能否带正文（决定是否显示「正文」框）
 * @property {FormField[]} fields     必填在前、可选在后（组内按声明顺序）
 * @property {FormField[]} requiredFields  必填字段（含自动补的「正文」框）
 * @property {FormField[]} optionalFields
 * @property {FormField[]} metaFields      只读说明行（零参数指令）
 */

/**
 * @typedef {object} ValueEntry
 * @property {string} key            源里的键
 * @property {string} name           声明名（未声明时 = key）
 * @property {unknown} value
 * @property {string} raw            源里的值文本（含引号）
 * @property {boolean} declared
 * @property {string} segment        源里的 `key=value` 原文（逐字节）
 */

/**
 * @typedef {object} ParsedValues
 * @property {string} line
 * @property {"command"|"dialogue"|"narration"|"comment"|"blank"} kind
 * @property {string|null} command
 * @property {string|null} controllerRaw
 * @property {string|null} canonical
 * @property {string} nameRaw        `[` 与 `(`/`]` 之间的原文
 * @property {Record<string, unknown>} values 按声明名归一后的值
 * @property {Record<string, string>} raws     按声明名归一的源文本
 * @property {ValueEntry[]} entries
 * @property {string[]} keys        源里出现的声明名（源序）
 * @property {string[]} unknown     源里未声明的键
 * @property {Array<{name: string, text: string, sepBefore: string}>} spans 源里的 `分隔符+key=value` 片段（就地补丁按它逐字节还原）
 * @property {string} argsRaw       括号内原文（无括号 = ""）
 * @property {string} tail          `]` 之后的正文（逐字节）
 * @property {string} leading       `[` 之前的空白
 * @property {string} trailing      行尾空白
 * @property {boolean} hasParens
 * @property {Diagnostic[]} diagnostics
 */

/**
 * @typedef {object} Preset
 * @property {string} name
 * @property {Record<string, unknown>} values
 * @property {string} line           整行（可照抄）
 * @property {string} [source]      `文件:行`（命名/语料预设）
 * @property {number} [n]           语料出现次数
 * @property {"named"|"corpus"|"spec"} origin
 */

/**
 * @typedef {object} ApplyOptions
 * @property {string} [command]   换成别的控制器（未给 = 沿用源行的）
 * @property {unknown} [model]    编辑页模型（`{CONTROLLERS?, CATEGORY_LABELS?}`）
 * @property {boolean} [canonical] 强制走 `formatLine()` 的规范形态
 */

// ─────────────────────────────────────────────────────────────────────────────
// 一、字段派生（CONTROLLERS → FormField[]）
// ─────────────────────────────────────────────────────────────────────────────

/** 引用素材的键 → 资源池（用于「从素材里选」）。 */
const ASSET_KEYS = {
  image: "backgrounds",
  imagegroup: "backgrounds",
  cggroup: "images",
  cg: "images",
  res: "images",
  largeimg: "images",
  name: "characters",
  name2: "characters",
  head: "characters",
  char: "characters",
  key: "music",
  intro: "music",
  channel: "sounds",
  sound: "sounds",
};

const CORPUS_ONLY_REASON = "引擎当前版本不读这个键（写了不报错，只是没有效果）";
const UNREGISTERED_REASON = "运行时未注册这条指令（引擎会 warn 后跳过整行）";

/** 缺 `type` 时按名字猜（只服务"最小表"这类降级输入）。 */
const BOOL_NAMES = /^(block|isblock|keep|multi|fadeout|inverse|loop|clear|switch|mode|grad|end|join|isend|hidelog|random|stop|black|is_skippable|defaultvalue|canskip|skip)$/i;
const NUM_NAMES = /^(duration|fadetime|fadeintime|feedtime|fedetime|time|delay|volume|afrom|ato|from|to|amount|power|times|speed|scale|zoom|x|y|a|r|g|b|size|width|height|angle|alpha|randomness|vibrato|xstrength|ystrength|radius|delaytime)/i;

/** @param {string} name @returns {ValueMeta["type"]} */
function guessType(name) {
  if (BOOL_NAMES.test(name)) return "bool";
  if (NUM_NAMES.test(name)) return "number";
  return "string";
}

/**
 * 把 `{name, type?}` 之类的极简记录补成 ValueMeta（编辑页可能传"规范化后"的最小对象）。
 * @param {Partial<ValueMeta> & {name: string}} raw @returns {ValueMeta}
 */
function normalizeMeta(raw) {
  if (raw && typeof raw.type === "string" && raw.hint !== undefined) return /** @type {ValueMeta} */ (raw);
  const meta = /** @type {ValueMeta} */ ({ name: raw.name, type: raw.type ?? guessType(raw.name), hint: raw.hint ?? raw.name });
  for (const key of ["default", "min", "max", "enums", "aliases", "alt", "integerish", "strictRange", "strictEnum", "corpusOnly"]) {
    if (/** @type {Record<string, unknown>} */ (raw)[key] !== undefined) /** @type {Record<string, unknown>} */ (meta)[key] = /** @type {Record<string, unknown>} */ (raw)[key];
  }
  return meta;
}

/** @param {ValueMeta} meta @returns {FormField["type"]} */
function widgetTypeOf(meta) {
  if (meta.type === "bool") return "bool";
  if (meta.type === "number" || meta.type === "int") return "number";
  if (meta.type === "enum") return "enum";
  if (meta.type === "vector") return "vector";
  if (meta.type === "string" && Object.prototype.hasOwnProperty.call(ASSET_KEYS, meta.name)) return "path";
  return "string";
}

/**
 * 高频参数的**人工中文短标签**：表单里显示在左侧；`hint` 太长、或太"语料化"
 * （`语料 1903 行；运行时当前不读`）时用它。没登记的参数回退到 `hint` 的首段。
 * @type {Record<string, string>}
 */
const FIELD_LABELS = {
  name: "角色/说话人", name2: "第二位角色", text: "正文", head: "头像 key", avatarId: "头像 id",
  image: "图片 key", imagegroup: "图片组", cggroup: "CG 组", intro: "前奏 key", key: "音频 key",
  res: "资源 key", char: "角色", value: "值", values: "选项值", options: "选项标签",
  references: "分支值", channel: "通道号", slot: "槽位", focus: "高亮档",
  fadetime: "淡入秒数", duration: "时长（秒）", time: "秒数", delay: "打字间隔", block: "阻塞",
  isblock: "阻塞（旧名）", keep: "保持", loop: "循环", multi: "多行", clear: "清除",
  style: "样式", effect: "效果", amount: "强度", mode: "模式", action: "动作", type: "类型",
  screenadapt: "铺满方式", fit_mode: "适配方式", alignment: "对齐", size: "字号", color: "颜色",
  width: "宽度", height: "高度", x: "X", y: "Y", xpos: "X 站位", ypos: "Y 站位",
  offsetx: "X 偏移", offsety: "Y 偏移", xScale: "X 缩放", yScale: "Y 缩放",
  scale: "缩放", angle: "角度", alpha: "不透明度", a: "不透明度", r: "红", g: "绿", b: "蓝",
  afrom: "起始不透明度", ato: "结束不透明度", from: "起始", to: "结束", fillfrom: "起始填充", fillto: "结束填充",
  pfrom: "起点", pto: "终点", pduration: "位移时长", rduration: "旋转时长", aduration: "淡入时长",
  rfrom: "起始角度", rto: "结束角度", blackstart: "黑幕起始", blackend: "黑幕结束",
  xstrength: "横向强度", ystrength: "纵向强度", randomness: "随机度", vibrato: "抖动",
  volume: "音量", fadeout: "淡出", fade: "淡入", speed: "速度", focusx: "聚焦 X", focusy: "聚焦 Y",
  layer: "图层", crossfade: "交叉淡化", blackstart2: "第二角色黑幕起始", blackend2: "第二角色黑幕结束",
  id: "编号", widgetID: "控件编号", span: "跨度", events: "事件", note: "备注",
};

/** 不含中文/太长 → 用别的段。 */
const CLAUSE_OK = /[\u4e00-\u9fff]/;

/**
 * 中文短标签：登记表优先；否则取 `hint` 里第一段"像人话"的短语（≤12 字）。
 * @param {ValueMeta} meta @returns {string}
 */
function labelOf(meta) {
  const mapped = FIELD_LABELS[meta.name.toLowerCase()] ?? FIELD_LABELS[meta.name];
  if (mapped) return mapped;
  const clauses = String(meta.hint ?? "")
    .split(/[；;（(]/)
    .map((part) => part.replace(/\*\*/g, "").replace(/`/g, "").trim())
    .filter((part) => part && CLAUSE_OK.test(part) && !/^语料/.test(part));
  const first = clauses[0] ?? "";
  if (!first) return meta.name;
  return first.length > 12 ? `${first.slice(0, 12)}…` : first;
}

/** enum 候选：`ENUMS[meta.enums]` 为唯一来源。 */
/** @param {ValueMeta} meta @returns {string[]} */
function optionsOf(meta) {
  if (meta.type !== "enum") return [];
  const list = meta.enums ? ENUMS[meta.enums] : undefined;
  return Array.isArray(list) ? [...list] : [];
}

/**
 * 数值范围：命令专属（`character.fadetime`）→ 全语料并集（`*.fadetime`）→
 * spec 声明的 `min/max`；再与声明求交。`int`/`integerish` 用 1 步长。
 * @param {string} command @param {ValueMeta} meta
 * @returns {{range: [number, number, number]|null, corpusCount: number}}
 */
/**
 * @param {string} command @param {ValueMeta} meta
 * @returns {{range: [number, number, number]|null, corpusCount: number, constant: number|undefined}}
 */
function rangeOf(command, meta) {
  if (meta.type !== "number" && meta.type !== "int") return { range: null, corpusCount: 0, constant: undefined };
  const found = OBSERVED_RANGES[`${command}.${meta.name}`] ?? OBSERVED_RANGES[`*.${meta.name}`];
  const integer = meta.type === "int" || meta.integerish === true;
  if (!found) {
    if (meta.min === undefined && meta.max === undefined) return { range: null, corpusCount: 0, constant: undefined };
    const lo = typeof meta.min === "number" ? meta.min : 0;
    const hi = typeof meta.max === "number" ? meta.max : lo + 1;
    if (!(hi > lo)) return { range: null, corpusCount: 0, constant: lo };
    return { range: [lo, hi, integer ? 1 : 0.01], corpusCount: 0, constant: undefined };
  }
  const [lo, hi, step, count] = found;
  const min = typeof meta.min === "number" ? Math.max(lo, meta.min) : lo;
  const max = typeof meta.max === "number" ? Math.min(hi, meta.max) : hi;
  // 语料里"恒为同一个值"（span = 0）→ 滑杆会卡住；退回数字输入，并把常量显示成提示。
  if (!(max > min)) return { range: null, corpusCount: count, constant: min };
  return { range: [min, max, integer ? 1 : step], corpusCount: count, constant: undefined };
}

/**
 * 从 spec-like 记录派生字段（`required` + `optional`，**不手抄**）。
 * @param {Partial<ControllerSpec> & {command: string}} spec @param {string} command
 * @returns {FormField[]}
 */
function fieldsOf(spec, command) {
  const unregistered = spec.runtimeRegistered === false;
  /** @type {FormField[]} */
  const out = [];
  /** @type {Array<["required"|"optional", Array<Partial<ValueMeta> & {name: string}>]>} */
  const groups = [
    ["required", Array.isArray(spec.required) ? spec.required : []],
    ["optional", Array.isArray(spec.optional) ? spec.optional : []],
  ];
  for (const [group, metas] of groups) {
    for (const raw of metas) {
      if (!raw || typeof raw.name !== "string") continue;
      const meta = normalizeMeta(raw);
      const { range, corpusCount, constant } = rangeOf(command, meta);
      /** @type {FormField} */
      const field = {
        name: meta.name,
        type: widgetTypeOf(meta),
        group,
        label: labelOf(meta),
        hint: meta.hint,
        engineRead: !meta.corpusOnly && !unregistered,
        options: optionsOf(meta),
        range,
        corpusCount,
      };
      if (meta.default !== undefined) field.default = meta.default;
      if (constant !== undefined) field.constant = constant;
      if (meta.integerish || meta.type === "int") field.integerish = true;
      if (meta.type === "text") field.multiline = true;
      if (meta.type === "semilist") field.separator = ";";
      if (!field.engineRead) field.reason = unregistered ? UNREGISTERED_REASON : CORPUS_ONLY_REASON;
      out.push(field);
    }
  }
  return out;
}

/**
 * 取一份可用的 CONTROLLERS：`model.CONTROLLERS`（非空）→ 内置 → 最小表。
 * @param {unknown} [model] @returns {ControllerList}
 */
export function controllersOf(model) {
  const bag = model && typeof model === "object" ? /** @type {Record<string, unknown>} */ (model) : null;
  const list = bag && Array.isArray(bag.CONTROLLERS) ? /** @type {Array<Record<string, unknown>>} */ (bag.CONTROLLERS) : null;
  if (list && list.length) {
    const usable = list.filter((entry) => entry && typeof (entry.command ?? entry.canonical) === "string");
    if (usable.length) {
      return /** @type {ControllerList} */ (usable.map((entry) => (typeof entry.command === "string" ? entry : { ...entry, command: String(entry.canonical) })));
    }
  }
  return CONTROLLERS;
}

/**
 * 在当前 model / 内置表 / 最小表里找一条 spec-like 记录。
 * 先按 `command` 精确匹配，再按忽略大小写匹配。
 * @param {string} command @param {unknown} [model]
 * @returns {(Partial<ControllerSpec> & {command: string})|null}
 */
export function controllerOf(command, model) {
  const wanted = String(command ?? "").trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  for (const list of [controllersOf(model), MINIMAL_CONTROLLERS]) {
    for (const entry of list) {
      if (entry.command === wanted) return entry;
      if (entry.command.toLowerCase() === lower) return entry;
    }
  }
  return null;
}

/**
 * 派生一条命令的表单模型。`model` 可选：给了就用它的 `CONTROLLERS`（与页面一致），
 * 否则用内置表；都查不到时用最小表；仍然没有 → `null`。
 * @param {string} command @param {unknown} [model] @returns {FormModel|null}
 */
export function formFor(command, model) {
  const spec = controllerOf(command, model);
  if (!spec) return null;
  const name = String(spec.command).toLowerCase();
  const fields = fieldsOf(spec, name);
  const hint = typeof spec.note === "string" && spec.note
    ? spec.note
    : spec.argless === "clear" || spec.argless === "hide"
      ? `无参数 = ${spec.argless === "clear" ? "清除/复位" : "收起"}（官方语料里大量这么写）`
      : "";
  const body = bodyFieldFor(spec);
  if (body) fields.unshift(body);
  return {
    command: name,
    canonical: String(spec.canonical ?? name),
    category: String(spec.category ?? "Other"),
    tier: /** @type {"A"|"B"|"C"} */ (spec.tier ?? "A"),
    summary: String(spec.summary ?? ""),
    hint,
    engineRead: spec.runtimeRegistered !== false,
    example: String(spec.example ?? ""),
    engineRef: String(spec.engineRef ?? ""),
    argless: String(spec.argless ?? "none"),
    tailCapable: Boolean(body),
    fields,
    requiredFields: fields.filter((field) => field.group === "required" || field.group === "body"),
    optionalFields: fields.filter((field) => field.group === "optional"),
    metaFields: fields.filter((field) => field.group === "meta"),
  };
}

/** 零参数指令的只读说明行用的"键"（不会出现在 `values` 里）。 */
const NOTE_KEY = "$note";

/** `]` 之后能带正文的命令（dialog/旁白/`[aside]` 等；与 `formatLine` 的 `text` 语义一致）。 */
const TAIL_BODY = new Set([
  "dialog", "multiline", "narration", "aside", "endtip", "popupdialog", "tutorial",
  "title", "header", "animtext", "div", "voicewithin", "spellsticker",
]);

/**
 * 是否需要给表单补一个「正文」字段（`text`）：
 * - 控制器自己声明了 `text`（`Subtitle`/`Sticker`/…）→ 用声明的那个，不补；
 * - 否则，`]` 之后能带正文的命令（对话/旁白）→ 补一个 `text`（多行文本框）；
 * - 其余（`[Delay]`、`[Character]` …）→ 不补（源里偶发的尾随文本按原样保留）。
 * @param {Partial<ControllerSpec> & {command: string}} spec @returns {FormField|null}
 */
function bodyFieldFor(spec) {
  const command = String(spec.command ?? "").toLowerCase();
  const metas = [...(spec.required ?? []), ...(spec.optional ?? [])];
  if (metas.some((meta) => meta && meta.name === "text")) return null;
  if (!TAIL_BODY.has(command)) {
    // 真正"零参数"的指令（`[end]` / `[SkipToThis]` / `[AnimTextClean]`）：给一行
    // 只读说明，保证每条命令在表单里都至少有一个可看的条目。
    if (metas.length === 0) {
      /** @type {FormField} */
      const row = /** @type {FormField} */ ({
        name: NOTE_KEY,
        type: "note",
        group: "meta",
        label: "无参数",
        hint: String(spec.note ?? spec.summary ?? "这条命令不需要参数（直接 `[命令]`）"),
        engineRead: spec.runtimeRegistered !== false,
        options: [],
        range: null,
        corpusCount: 0,
      });
      if (spec.runtimeRegistered === false) row.reason = UNREGISTERED_REASON;
      return row;
    }
    return null;
  }
  const spoken = command === "dialog" || command === "narration" || command === "aside";
  return {
    name: "text",
    type: "string",
    group: "body",
    label: spoken ? "台词/正文（尾随）" : "正文（尾随）",
    hint: spoken
      ? "**尾随正文**：写在 `]` 之后（`[Narration]旁白…`、`[aside]  旁白…` 或 `[name=\"X\"]  台词`），不进 `(…)`；空 = 没有正文"
      : "**尾随正文**：写在 `]` 之后、两个空格起头；不进 `(…)`",
    engineRead: true,
    options: [],
    range: null,
    corpusCount: 0,
    multiline: true,
    tail: true,
  };
}

/** 中文分类标题（`model.CATEGORY_LABELS` 缺省时的兜底）。 */
export const CATEGORY_LABELS = /** @type {Record<string, string>} */ ({
  Comment: "注释", Text: "文本", Dialog: "对白", Background: "背景/叠图", Character: "立绘",
  Music: "音乐", SoundEffect: "音效", Mask: "遮罩/黑场", VisualEffect: "镜头/特效",
  Delay: "停顿", Choice: "选择", Branch: "分支", Variable: "变量", Judge: "判定", Other: "其他",
});

/** 面板/向导的分组顺序。 */
export const CATEGORY_ORDER = [
  "Text", "Dialog", "Background", "Character", "Music", "SoundEffect",
  "Mask", "VisualEffect", "Delay", "Choice", "Branch", "Variable", "Judge", "Comment",
];

/**
 * @typedef {object} CatalogItem
 * @property {string} command
 * @property {string} canonical
 * @property {string} category
 * @property {string} tier
 * @property {string} summary
 * @property {number} requiredCount
 * @property {number} optionalCount
 * @property {number} engineReadCount
 * @property {boolean} tailCapable  `]` 之后能带正文
 * @property {string} search  预拼的检索串（小写）
 */

/**
 * 向导/调色板的目录（按 分类 → 命令 排序）。
 * @param {unknown} [model] @returns {CatalogItem[]}
 */
export function catalog(model) {
  /** @type {CatalogItem[]} */
  const out = [];
  for (const entry of controllersOf(model)) {
    const command = String(entry.command ?? "").toLowerCase();
    if (!command) continue;
    const form = formFor(command, model);
    out.push({
      command,
      canonical: String(entry.canonical ?? command),
      category: String(entry.category ?? "Other"),
      tier: String(entry.tier ?? "A"),
      summary: String(entry.summary ?? ""),
      requiredCount: form ? form.requiredFields.length : 0,
      optionalCount: form ? form.optionalFields.length : 0,
      engineReadCount: form ? form.fields.filter((field) => field.engineRead).length : 0,
      tailCapable: (bodyFieldFor(controllerOf(command, model) ?? { command })?.group ?? "meta") === "body",
      search: `${command} ${String(entry.canonical ?? "")} ${String(entry.summary ?? "")} ${String(entry.category ?? "")}`.toLowerCase(),
    });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category, "zh") || a.command.localeCompare(b.command));
}

/**
 * @typedef {object} CatalogGroup
 * @property {string} category
 * @property {string} label
 * @property {CatalogItem[]} items
 */

/** @param {unknown} [model] @returns {CatalogGroup[]} */
export function catalogByCategory(model) {
  const groups = new Map();
  for (const item of catalog(model)) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  const bag = model && typeof model === "object" ? /** @type {Record<string, unknown>} */ (model) : null;
  const labels = bag && bag.CATEGORY_LABELS && typeof bag.CATEGORY_LABELS === "object"
    ? /** @type {Record<string, string>} */ (bag.CATEGORY_LABELS)
    : CATEGORY_LABELS;
  return [...groups.entries()]
    .map(([category, items]) => ({ category, label: String(labels[category] ?? category), items }))
    .sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a.category);
      const ib = CATEGORY_ORDER.indexOf(b.category);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.category.localeCompare(b.category, "zh");
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、读取一行（ParseData 的等价物）
// ─────────────────────────────────────────────────────────────────────────────

/** `[` 与 `(`（或 `]`）之间的原文（保留作者的写法）。 */
/** @param {string} src @returns {string} */
function nameRawOf(src) {
  const close = src.lastIndexOf("]");
  if (src[0] !== "[" || close <= 1) return "";
  const head = src.slice(1, close);
  const open = head.indexOf("(");
  return (open === -1 ? head : head.slice(0, open)).trim();
}

/** 括号内原文（无括号 → ""）。 */
/** @param {string} src @returns {string} */
function argsRawOf(src) {
  const close = src.lastIndexOf("]");
  const head = src[0] === "[" ? (close > 1 ? src.slice(1, close) : src.slice(1)) : "";
  const open = head.indexOf("(");
  if (open === -1) return "";
  const inner = head.slice(open + 1);
  return inner.endsWith(")") ? inner.slice(0, -1) : inner;
}

/**
 * 参数段（`分隔符 + key=value` 原文 + 解析值）：保留源序、源里 `=` 两侧的空格，
 * 以及**每个片段前的分隔符**（`, ` / `,` / ` ,` 混用也能逐字节还原）。
 * @param {string} src @returns {Array<{key: string, segment: string, raw: string, value: unknown, sepBefore: string}>}
 */
function segmentsOf(src) {
  const args = argsRawOf(src);
  if (!args) return [];
  /** @type {Array<{key: string, segment: string, raw: string, value: unknown, sepBefore: string}>} */
  const out = [];
  let cursor = 0;
  for (const piece of splitTopLevel(args)) {
    const at = args.indexOf(piece, cursor);
    if (at === -1) continue;
    const sepBefore = out.length === 0 ? "" : args.slice(cursor, at);
    cursor = at + piece.length;
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const key = piece.slice(0, eq).trim();
    if (!key) continue;
    const raw = piece.slice(eq + 1).trim();
    out.push({ key, segment: piece.trim(), raw, value: literalOf(raw), sepBefore });
  }
  return out;
}

/**
 * 字面量：与 `storyPack.parseValue` 同规则（引号去壳 + 转义、true/false、数字）。
 * @param {string} raw @returns {unknown}
 */
function literalOf(raw) {
  const text = raw.trim();
  if (text.length >= 2 && /^["']/.test(text) && text.endsWith(text[0])) {
    return text.slice(1, -1).replace(/\\(.)/g, (all, ch) => (ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch));
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/**
 * 把源行读成"可填值"。
 *
 * `values` / `raws` 按**声明名**归一（源里写成 `Name` 也能对上）；未声明的键
 * 原样收进 `values`，并列在 `unknown` 里。`tail` 是 `]` 之后的**原文**
 * （`[name="X"]  台词` 的台词就在这里）。
 *
 * @param {string} line @param {unknown} [model] @returns {ParsedValues}
 */
export function parseValues(line, model) {
  const src = String(line ?? "");
  const leading = /^\s*/.exec(src)?.[0] ?? "";
  // 允许整行前有缩进：结构解析在去掉前导空白后的 `core` 上做，`leading` 原样保留。
  const core = src.slice(leading.length);
  const dsl = parseLine(core, 1);
  const close = core.lastIndexOf("]");
  const tail = close >= 0 ? core.slice(close + 1) : "";
  // 容错：`[Delay(time=1`（没写 `]`）时内核判成 narration，命令名丢失 —— 这里从
  // `[Cmd(` 的形态里**恢复**命令名（改完后表单会顺手补上 `]`）。不改则原样返回。
  let controllerName = dsl.controller ?? null;
  if (!controllerName) {
    const token = /^\[\s*([A-Za-z_]\w*)\s*\(/.exec(core);
    const recovered = token ? controllerOf(token[1], model) : null;
    if (recovered) controllerName = String(recovered.command);
  }
  const spec = controllerName ? controllerOf(controllerName, model) : null;

  /** @type {Map<string, ValueMeta>} */
  const declared = new Map();
  if (spec) {
    for (const raw of [...(spec.required ?? []), ...(spec.optional ?? [])]) {
      if (raw && typeof raw.name === "string") declared.set(raw.name, normalizeMeta(raw));
    }
  }
  /** @type {Map<string, ValueMeta>} */
  const declaredCi = new Map();
  for (const [name, meta] of declared) declaredCi.set(name.toLowerCase(), meta);

  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Record<string, string>} */
  const raws = {};
  /** @type {ValueEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const keys = [];
  /** @type {string[]} */
  const unknown = [];

  /** @type {ParsedValues["spans"]} */
  const spans = [];
  for (const segment of segmentsOf(core)) {
    const meta = declared.get(segment.key) ?? declaredCi.get(segment.key.toLowerCase()) ?? null;
    const name = meta ? meta.name : segment.key;
    if (!Object.prototype.hasOwnProperty.call(values, name)) keys.push(name);
    values[name] = segment.value;
    raws[name] = segment.raw;
    entries.push({ key: segment.key, name, value: segment.value, raw: segment.raw, declared: Boolean(meta), segment: segment.segment });
    spans.push({ name, text: segment.segment, sepBefore: segment.sepBefore });
    if (!meta && !unknown.includes(segment.key)) unknown.push(segment.key);
  }

  // 裸旁白（整行就是正文、没有 `[`）：把整行当 `text` 暴露，检视器才能改。
  if (!controllerName && dsl.kind === "narration" && !core.startsWith("[")) {
    const body = core.trim();
    if (!Object.prototype.hasOwnProperty.call(values, "text")) keys.push("text");
    values.text = body;
    raws.text = JSON.stringify(body);
  }

  // 对话形态 `[name="X"]  台词`：`name` 在头里、正文在尾。
  // `[name=""]`（语料 2 万行，无名对白/旁白）speaker 是空串，也要收进来。
  if (dsl.kind === "dialogue" || dsl.speaker) {
    const meta = declared.get("name") ?? null;
    const name = meta ? meta.name : "name";
    if (!Object.prototype.hasOwnProperty.call(values, name)) keys.unshift(name);
    values[name] = dsl.speaker;
    raws[name] = JSON.stringify(dsl.speaker);
    entries.unshift({ key: "name", name, value: dsl.speaker, raw: JSON.stringify(dsl.speaker), declared: Boolean(meta), segment: `name=${JSON.stringify(dsl.speaker)}` });
  }

  // `]` 之后的正文（dialog/multiline/旁白风格）：当控制器**没有**声明 `text` 参数时，
  // 把它作为 `values.text` 暴露给表单（引擎读 `line.content` / 尾随文本）。
  // 它不进 `entries`/`spans`：重建时走尾随正文，而不是括号里的 `text=`。
  const declaresText = declared.has("text");
  if (!declaresText && tail.trim()) {
    if (!Object.prototype.hasOwnProperty.call(values, "text")) keys.push("text");
    values.text = tail.replace(/^\s+/, "");
    raws.text = JSON.stringify(values.text);
  }

  /** @type {ParsedValues["kind"]} */
  const kind = dsl.kind === "dialogue" ? "dialogue"
    : dsl.kind === "command" ? "command"
      : dsl.kind === "comment" ? "comment"
        : dsl.kind === "blank" ? "blank" : "narration";

  return {
    line: src,
    kind: controllerName && !dsl.controller ? "command" : kind,
    command: controllerName,
    controllerRaw: dsl.controllerRaw ?? (controllerName ? controllerName : null),
    canonical: dsl.canonical ?? (spec ? String(spec.canonical) : null),
    nameRaw: nameRawOf(core),
    values,
    raws,
    entries,
    keys,
    unknown,
    spans,
    argsRaw: argsRawOf(core),
    tail,
    leading,
    trailing: /[ \t]+$/.exec(src)?.[0] ?? "",
    hasParens: core.includes("("),
    diagnostics: dsl.diagnostics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、重建一行（Rebuilder）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用 `values` 重建整行。**没有列进 `values` 的字段原样保留**；
 * `undefined` = 删掉该字段；`""` = 保留 `key=""`。
 *
 * - 有可识别的控制器、且没换指令 → **就地补丁**（未改动的 `key=value` 逐字节照抄），
 *   所以 `applyForm(line, parseValues(line).values) === line`；
 * - `options.command` 指向别的控制器 → `formatLine()` 的规范形态（正文带过去）；
 * - 旁白 / 注释 / 空行且没给 `options.command` → **原样返回**。
 *
 * @param {string} line @param {Record<string, unknown>} [values] @param {ApplyOptions} [options]
 * @returns {string}
 */
export function applyForm(line, values = {}, options = {}) {
  const src = String(line ?? "");
  const withModel = { model: options.model };
  const parsed = parseValues(src, options.model);
  const wanted = String(options.command ?? parsed.command ?? "").toLowerCase();
  if (!wanted) {
    // 裸旁白：整行就是正文；`values.text` 有给就替换（`line` 的首尾空白保留）。
    if (Object.prototype.hasOwnProperty.call(values, "text") && parsed.kind === "narration" && !/^\s*\[/.test(src)) {
      const body = String(values.text ?? "");
      if (body === src.trim()) return src;
      return `${parsed.leading}${body}${parsed.trailing}`;
    }
    return src;
  }

  // `[name="杜宾"]  台词` 这种"头里带 name"的形态：`[` 与 `]` 之间不是 `Cmd(...)`，
  // 直接在**头部**改；正文（tail）逐字节带回来。
  const core = src.slice(parsed.leading.length);
  const nameOnlyHead = /^\[\s*name\s*=/.test(core) && !/^\(/.test(parsed.argsRaw);

  const spec = controllerOf(wanted, options.model);
  const metas = new Map();
  for (const raw of [...(spec?.required ?? []), ...(spec?.optional ?? [])]) {
    if (raw && typeof raw.name === "string") metas.set(raw.name, normalizeMeta(raw));
  }
  const textIsParam = metas.has("text");
  const has = (name) => Object.prototype.hasOwnProperty.call(values, name);

  // **无改动 → 逐字节返回源行**（编辑器"打开表单→直接应用"不该改写任何字符；
  // `parseValues(line).values` 就是"当前状态"，所以这条覆盖了 93% 的语料写法）。
  if (!options.command && !options.canonical && sameValues(values, parsed.values)) return src;

  /** @type {Map<string, {text: string, sepBefore: string}>} */
  const source = new Map();
  for (const span of parsed.spans) source.set(span.name, { text: span.text, sepBefore: span.sepBefore });

  /** @type {Record<string, string>} */
  const renderOne = {};
  const renderFor = (name) => {
    if (!has(name)) return undefined;
    const value = values[name];
    if (value === undefined) return null;                       // 删除
    if (name === "text" && !textIsParam) return undefined;       // 落到尾随正文
    if (Object.prototype.hasOwnProperty.call(renderOne, name)) return renderOne[name];
    const text = `${name}=${formatValue(value, metas.get(name))}`;
    renderOne[name] = text;
    return text;
  };

  // ── 形态 A：`[name="X"]` 头（或 `[Dialog]`）—— 只在"头"里改，正文原样 ────
  // 源里的头本身就是 `name="X"` 这个键值对；`parseValues` 已把它读进 `values.name`。
  if (nameOnlyHead) {
    /** @type {Array<[string, unknown]>} */
    const extra = [];
    for (const name of Object.keys(values)) {
      if (name === "name" || name === "text" || name === "command") continue;
      if (values[name] === undefined) continue;
      if (!metas.has(name)) continue;                            // 只认声明过的键
      if (Object.prototype.hasOwnProperty.call(parsed.values, name) && JSON.stringify(parsed.values[name]) === JSON.stringify(values[name])) continue;
      extra.push([name, values[name]]);
    }
    const headValue = has("name") ? values.name : parsed.values.name;
    const sourceUsesName = parsed.nameRaw.startsWith("name");
    if (extra.length === 0 && !options.canonical && !options.command) {
      // **保留源里的写法**：源是 `[name=…]` 就继续写 `name=`（含 `name=""` ——
      // 语料 2 万行用它表示"无名对白/旁白"）；源是 `[Dialog]` 时，只有填了
      // name 才升级成 `[name="X"]`。
      const empty = headValue === undefined || headValue === null || String(headValue) === "";
      const head = sourceUsesName
        ? `name=${formatValue(empty ? "" : headValue, metas.get("name"))}`
        : empty ? "Dialog" : `name=${formatValue(headValue, metas.get("name"))}`;
      return `${parsed.leading}[${head}]${tailOf(parsed, values, has, false)}`;
    }
    /** @type {Record<string, unknown>} */
    const flat = {};
    for (const [name, value] of extra) flat[name] = value;
    if (headValue !== undefined && headValue !== null) flat.name = headValue;
    flat.text = has("text") ? String(values.text ?? "") : parsed.tail.replace(/^\s+/, "");
    return formatLine("dialog", flat);
  }

  // ── 形态 B：`[Cmd(...)]` —— 就地补丁 ─────────────────────────────────────
  /** @type {string[]} */
  const order = [];
  for (const name of source.keys()) order.push(name);
  for (const name of parsed.keys) if (!order.includes(name)) order.push(name);
  for (const name of Object.keys(values)) {
    if (name === "command" || name === "text") continue;
    if (!order.includes(name)) order.push(name);
  }

  // 换指令 → `formatLine` 规范形态
  if (options.canonical || !parsed.command || parsed.command !== wanted) {
    /** @type {Record<string, unknown>} */
    const flat = {};
    for (const name of order) {
      if (name === "text" && !textIsParam) continue;
      if (has(name)) { if (values[name] !== undefined) flat[name] = values[name]; continue; }
      if (Object.prototype.hasOwnProperty.call(parsed.values, name)) flat[name] = parsed.values[name];
    }
    if (textIsParam) flat.text = has("text") ? String(values.text ?? "") : String(parsed.values.text ?? "");
    else if (has("text")) flat.text = String(values.text ?? "");
    else if (parsed.kind === "dialogue" && parsed.tail.trim()) flat.text = parsed.tail.replace(/^\s+/, "");
    return formatLine(wanted, flat);
  }

  /** @type {Array<string>} */
  const parts = [];
  for (const name of order) {
    if (name === "text" && !textIsParam) continue;               // 正文走 `]` 之后
    const span = source.get(name);
    const rendered = renderFor(name);
    if (rendered === null) continue;                             // 显式删除
    const sep = span ? span.sepBefore : (parts.length === 0 ? "" : (parsed.argsRaw.includes(", ") ? ", " : ","));
    const text = typeof rendered === "string" ? rendered : span ? span.text : undefined;
    if (text === undefined) continue;                            // 源里没有、也没给 → 不发明
    parts.push(`${sep}${text}`);
  }
  // `[Subtitle]` 的 `text=` 是**括号内**的参数（与 dialog 的 `]` 后正文不同）
  if (textIsParam && !order.includes("text")) {
    const sep = parts.length ? (parsed.argsRaw.includes(", ") ? ", " : ",") : "";
    parts.push(`${sep}text=${formatValue(has("text") ? values.text : parsed.values.text ?? "", metas.get("text"))}`);
  }
  const args = parts.join("");
  const head = `[${parsed.nameRaw || (spec ? spec.canonical : wanted)}${args ? `(${args})` : ""}]`;
  return `${parsed.leading}${head}${tailOf(parsed, values, has, textIsParam)}`;
}

/**
 * 值表比较（用于"无改动 → 逐字节返回源行"的判定）。
 * @param {Record<string, unknown>} a @param {Record<string, unknown>} b @returns {boolean}
 */
function sameValues(a, b) {
  const ka = Object.keys(a).filter((key) => key !== "command");
  const kb = Object.keys(b).filter((key) => key !== "command");
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

/**
 * `]` 之后的部分。
 * @param {ParsedValues} parsed @param {Record<string, unknown>} values
 * @param {(name: string) => boolean} has
 * @param {boolean} [textIsParam] `text=` 写在括号里时，正文**不**从 `text` 取
 * @returns {string}
 */
function tailOf(parsed, values, has, textIsParam = false) {
  const keepTrailing = parsed.tail.endsWith(parsed.trailing) ? "" : parsed.trailing;
  if (has("text") && !textIsParam) {
    const body = String(values.text ?? "");
    if (body === "") return parsed.trailing;                       // 清空正文
    // **保留源里的分隔写法**：源是"紧贴"（`[Narration]旁白`）就紧贴，
    // 源是两个空格（`[aside]  旁白`、`[name="X"]  台词`）就照旧两个空格。
    if (/^[ \t]/.test(parsed.tail)) return `  ${body}${parsed.trailing}`;
    return `${body}${parsed.trailing}`;
  }
  return `${parsed.tail}${keepTrailing}`;
}

/**
 * 缺省占位值（与 `editorModel` 的补全骨架同规则）。
 * @param {ValueMeta|undefined} meta @returns {unknown}
 */
function placeholderFor(meta) {
  if (!meta) return "";
  if (meta.type === "number" || meta.type === "int") return typeof meta.default === "number" ? meta.default : 0;
  if (meta.type === "bool") return typeof meta.default === "boolean" ? meta.default : false;
  if (meta.type === "enum") return meta.default ?? optionsOf(meta)[0] ?? "";
  if (meta.default !== undefined) return meta.default;
  return "";
}

/**
 * 值 → 原文（数字/布尔不加引号；字符串加引号并转义）。
 * @param {unknown} value @param {ValueMeta|undefined} meta @returns {string}
 */
function formatValue(value, meta) {
  if (Array.isArray(value)) return quote(value.map((item) => String(item)).join(";"));
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value ?? "");
  const type = meta ? meta.type : "string";
  if ((type === "number" || type === "int") && /^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)) return text;
  if (type === "bool" && /^(true|false)$/i.test(text)) return text.toLowerCase();
  if (text === "true" || text === "false") return text;
  return quote(text);
}

/** @param {string} value @returns {string} */
function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

/**
 * 构建一条**新的**命令行（向导"插入"用）：`buildLine("character", {name:"…"})`
 * → `[Character(name="…")]`。等价于 `formatLine` + 中文键顺序（声明顺序）。
 * @param {string} command @param {Record<string, unknown>} [values] @param {unknown} [model]
 * @returns {string}
 */
export function buildLine(command, values = {}, model) {
  const form = formFor(command, model);
  if (!form) return "";
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const field of form.fields) {
    if (Object.prototype.hasOwnProperty.call(values, field.name)) { ordered[field.name] = values[field.name]; continue; }
    if (Object.prototype.hasOwnProperty.call(values, field.name.toLowerCase())) ordered[field.name] = values[field.name.toLowerCase()];
  }
  if (Object.prototype.hasOwnProperty.call(values, "text")) ordered.text = values.text;
  return formatLine(form.command, ordered);
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、预设与 diff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 需要"成对写法"的命令：`[Decision]` 之后必须跟 `[Predicate]`（`values` 全覆盖）
 * 才算合流 —— 只插一行会让整篇报 4116。预设里直接给出成对的两行。
 * @type {Record<string, {companion: (values: Record<string, unknown>) => string, fill: (values: Record<string, unknown>) => Record<string, unknown>}>}
 */
const PAIRED = {
  decision: {
    /** 合流行：`references` 覆盖全部 `values`。 */
    companion: (values) => `[Predicate(references="${String(values.values ?? "1;2")}")]`,
    /** `values` 缺省时补的默认值（选项数 = 2 → `1;2`）。 */
    fill: (values) => {
      if (Object.prototype.hasOwnProperty.call(values, "values") && String(values.values ?? "") !== "") return values;
      const labels = String(values.options ?? "").split(";").filter(Boolean);
      return { ...values, values: labels.map((label, index) => `${index + 1}`).join(";") || "1;2" };
    },
  },
};

/**
 * 给"必须成对"的命令补默认值（`[Decision]` 缺 `values` → 按选项数补 `1;2`）。
 * 必须在 `formatLine()` **之前**调用：`values` 也是要写进这一行的参数。
 * @param {string} command @param {Record<string, unknown>} values @returns {Record<string, unknown>}
 */
function fillValues(command, values) {
  const paired = PAIRED[command];
  return paired ? paired.fill(values) : values;
}

/**
 * 给"必须成对"的命令补上后续行（`[Decision]` → `[Predicate]`）。
 * @param {string} command @param {string} line @param {Record<string, unknown>} values
 * @returns {string}
 */
function withCompanion(command, line, values) {
  const paired = PAIRED[command];
  return paired ? `${line}\n${paired.companion(values)}` : line;
}

/**
 * 一条命令的预设（3–6 组）：命名预设 → 语料高频写法 → 规格缺省/示例。
 * 名称与参数值全部来自真实语料行（`line` / `source` 保留出处）。
 * @param {string} command @param {unknown} [model] @returns {Preset[]}
 */
export function presetsFor(command, model) {
  const form = formFor(command, model);
  if (!form) return [];
  /** @type {Preset[]} */
  const out = [];
  /** @param {Preset} preset */
  const push = (preset) => {
    if (out.length >= 6) return;
    if (out.some((item) => item.name === preset.name)) return;
    out.push(preset);
  };
  for (const item of NAMED_PRESETS[form.command] ?? []) {
    const values = fillValues(form.command, valuesOfLine(item.line, model));
    const line = withCompanion(form.command, item.line, values);
    push({ name: line.includes("\n") ? `${item.name}（+ 合流）` : item.name, values, line, source: item.source, origin: "named" });
  }
  if (PAIRED[form.command]) {
    const values = { options: "选项一;选项二", values: "1;2" };
    push({ name: "成对模板（推荐）", values, line: withCompanion(form.command, formatLine(form.command, values), values), origin: "spec" });
  }
  for (const item of CORPUS_ANCHORS[form.command] ?? []) {
    const values = fillValues(form.command, valuesOfLine(item.line, model));
    const line = withCompanion(form.command, item.line, values);
    push({
      name: (item.n ? `${item.name}（语料 ${item.n} 行）` : item.name) + (line.includes("\n") ? "（+ 合流）" : ""),
      values,
      line,
      source: item.source,
      n: item.n,
      origin: "corpus",
    });
  }
  /** @type {Record<string, unknown>} */
  const minimal = {};
  for (const field of form.requiredFields) {
    if (field.name === NOTE_KEY) continue;
    minimal[field.name] = field.type === "note" ? "" : placeholderFrom(field);
  }
  const minimalFilled = fillValues(form.command, minimal);
  push({ name: "最小可用（只填必填）", values: minimalFilled, line: withCompanion(form.command, formatLine(form.command, minimalFilled), minimalFilled), origin: "spec" });
  if (form.example.trim()) {
    const parsed = parseValues(form.example, model);
    if (parsed.command === form.command) {
      const exampleValues = fillValues(form.command, valuesOfLine(form.example, model));
      const shown = withCompanion(form.command, form.example, exampleValues);
      push({ name: shown.includes("\n") ? "规格示例（+ 合流）" : "规格示例", values: exampleValues, line: shown, origin: "spec" });
    }
  }
  const full = { ...minimal };
  for (const field of form.optionalFields) {
    if (field.name === NOTE_KEY) continue;
    const value = field.type === "note" ? "" : placeholderFrom(field);
    if (field.name === "text") { full.text = ""; continue; }
    full[field.name] = value;
  }
  const fullFilled = fillValues(form.command, full);
  push({ name: "全字段（缺省值）", values: fullFilled, line: withCompanion(form.command, formatLine(form.command, fullFilled), fullFilled), origin: "spec" });
  return out.slice(0, 6);
}

/**
 * 字段（FormField）→ 缺省值（预设用）。
 * @param {FormField} field @returns {unknown}
 */
function placeholderFrom(field) {
  if (field.type === "number") return typeof field.default === "number" ? field.default : 0;
  if (field.type === "bool") return typeof field.default === "boolean" ? field.default : false;
  if (field.type === "enum") return String(field.default ?? field.options?.[0] ?? "");
  if (field.type === "vector") return String(field.default ?? "");
  if (field.type === "note") return "";
  return typeof field.default === "string" ? field.default : "";
}

/**
 * 一整行 → 可填值（预设用：对话行把正文并进 `text`）。
 * @param {string} line @param {unknown} [model] @returns {Record<string, unknown>}
 */
function valuesOfLine(line, model) {
  const parsed = parseValues(line, model);
  /** @type {Record<string, unknown>} */
  const out = { ...parsed.values };
  const spec = parsed.command ? controllerOf(parsed.command, model) : null;
  const declaresText = [...(spec?.required ?? []), ...(spec?.optional ?? [])].some((meta) => meta && meta.name === "text");
  if (!declaresText && parsed.tail.trim()) out.text = parsed.tail.replace(/^\s+/, "");
  return out;
}

/**
 * 两组值的差异（检视器显示"改了哪些字段"）。参数可以是**整行**或**值表**。
 * @param {string|Record<string, unknown>} a @param {string|Record<string, unknown>} b
 * @returns {Array<{name: string, before: unknown, after: unknown, changed: boolean, kind: "changed"|"added"|"removed"|"same"}>}
 */
export function diffFields(a, b) {
  const left = asValues(a);
  const right = asValues(b);
  /** @type {string[]} */
  const names = [];
  for (const name of Object.keys(left)) names.push(name);
  for (const name of Object.keys(right)) if (!names.includes(name)) names.push(name);
  return names.sort().map((name) => {
    const hasA = Object.prototype.hasOwnProperty.call(left, name);
    const hasB = Object.prototype.hasOwnProperty.call(right, name);
    const before = hasA ? left[name] : undefined;
    const after = hasB ? right[name] : undefined;
    const same = hasA === hasB && JSON.stringify(before) === JSON.stringify(after);
    return {
      name,
      before,
      after,
      changed: !same,
      kind: /** @type {"changed"|"added"|"removed"|"same"} */ (same ? "same" : !hasA ? "added" : !hasB ? "removed" : "changed"),
    };
  });
}

/** @param {string|Record<string, unknown>} input @returns {Record<string, unknown>} */
function asValues(input) {
  if (typeof input === "string") return valuesOfLine(input);
  return input && typeof input === "object" ? input : {};
}

/**
 * 「从素材里选」的候选：调用方给的池子在前，内置语料高频 key 补齐；去重、截断。
 * @param {string} name 字段名 @param {unknown} [assets] `{images,backgrounds,characters,music,sounds}`
 * @param {number} [limit] @returns {string[]}
 */
export function assetsFor(name, assets, limit = 80) {
  const bucket = ASSET_KEYS[name];
  if (!bucket) return [];
  const bag = assets && typeof assets === "object" ? /** @type {Record<string, unknown>} */ (assets) : {};
  const provided = Array.isArray(bag[bucket]) ? /** @type {unknown[]} */ (bag[bucket]).map((item) => String(item)) : [];
  const builtin = COMMON_ASSETS[bucket] ?? [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const key of [...provided, ...builtin]) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

/** 这个字段是否提供「从素材里选」。 */
/** @param {string} name @returns {boolean} */
export function hasAssetPool(name) {
  return Object.prototype.hasOwnProperty.call(ASSET_KEYS, name);
}

// ─────────────────────────────────────────────────────────────────────────────
// 五、降级用最小表（`model` 不可用**且**内置表也查不到时）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 最小内置表：最高频的一小撮控制器（字段与 `CONTROLLERS` 同形）。
 * 正常情况下 `formFor` 直接读 `CONTROLLERS`；这张表只在"模型加载失败"时兜底。
 * @type {ControllerList}
 */
export const MINIMAL_CONTROLLERS = [
  { command: "delay", canonical: "Delay", category: "Delay", tier: "A", summary: "等待若干秒（只认 time）", required: [{ name: "time", type: "number", hint: "秒数；缺键或非数字 → 0（不等待）", default: 0 }], optional: [], runtimeRegistered: true },
  { command: "dialog", canonical: "Dialog", category: "Dialog", tier: "A", summary: "对白 / 收起对白条", required: [], optional: [{ name: "name", type: "string", hint: "说话人；空 = 隐藏对话框" }], runtimeRegistered: true },
  { command: "background", canonical: "Background", category: "Background", tier: "A", summary: "切换背景（fadetime 淡入）", required: [{ name: "image", type: "string", hint: "背景 key" }], optional: [{ name: "screenadapt", type: "enum", hint: "铺满方式", default: "coverall", enums: "screenadapt" }, { name: "fadetime", type: "number", hint: "淡入秒数", default: 0 }, { name: "block", type: "bool", hint: "淡入是否阻塞推进", default: false }], runtimeRegistered: true },
  { command: "character", canonical: "Character", category: "Character", tier: "A", summary: "按角色摆放立绘（fadetime 淡入）", required: [{ name: "name", type: "string", hint: "角色 key；空 = 清槽" }], optional: [{ name: "fadetime", type: "number", hint: "淡入秒数", default: 0.15 }, { name: "name2", type: "string", hint: "第二立绘（双人同框）" }], runtimeRegistered: true },
  { command: "charslot", canonical: "charslot", category: "Character", tier: "A", summary: "按槽位摆放立绘（duration，默认瞬切）", required: [{ name: "slot", type: "string", hint: "槽位 l/m/r" }, { name: "name", type: "string", hint: "角色 key" }], optional: [{ name: "duration", type: "number", hint: "时长；0 = 瞬切", default: 0 }, { name: "isblock", type: "bool", hint: "是否阻塞", default: false }], runtimeRegistered: true },
  { command: "blocker", canonical: "Blocker", category: "Mask", tier: "A", summary: "黑场/色块（a=1 全黑，a=0 透明）", required: [], optional: [{ name: "a", type: "number", hint: "不透明度" }, { name: "r", type: "number", hint: "红" }, { name: "g", type: "number", hint: "绿" }, { name: "b", type: "number", hint: "蓝" }, { name: "fadetime", type: "number", hint: "淡入秒数" }, { name: "block", type: "bool", hint: "是否阻塞" }], runtimeRegistered: true },
  { command: "camerashake", canonical: "CameraShake", category: "VisualEffect", tier: "A", summary: "镜头震动（duration）", required: [], optional: [{ name: "duration", type: "number", hint: "时长" }, { name: "xstrength", type: "number", hint: "横向强度" }, { name: "ystrength", type: "number", hint: "纵向强度" }, { name: "randomness", type: "number", hint: "随机度" }], runtimeRegistered: true },
  { command: "cameraeffect", canonical: "CameraEffect", category: "VisualEffect", tier: "A", summary: "画面滤镜", required: [{ name: "effect", type: "enum", hint: "Grayscale / Colorinverse", enums: "camera_effect" }], optional: [{ name: "amount", type: "number", hint: "强度" }, { name: "fadetime", type: "number", hint: "淡入秒数" }, { name: "keep", type: "bool", hint: "是否保持" }], runtimeRegistered: true },
  { command: "subtitle", canonical: "Subtitle", category: "Text", tier: "A", summary: "居中字幕", required: [{ name: "text", type: "text", hint: "字幕正文" }], optional: [{ name: "x", type: "number", hint: "X" }, { name: "y", type: "number", hint: "Y" }, { name: "size", type: "number", hint: "字号", default: 24 }], runtimeRegistered: true },
  { command: "playmusic", canonical: "PlayMusic", category: "Music", tier: "A", summary: "播放 BGM", required: [{ name: "key", type: "string", hint: "循环段 key" }], optional: [{ name: "intro", type: "string", hint: "前奏 key" }, { name: "volume", type: "number", hint: "音量", default: 1 }], runtimeRegistered: true },
  { command: "stopmusic", canonical: "StopMusic", category: "Music", tier: "A", summary: "停止 BGM", required: [], optional: [{ name: "fadetime", type: "number", hint: "淡出秒数" }], runtimeRegistered: true },
  { command: "playsound", canonical: "PlaySound", category: "SoundEffect", tier: "A", summary: "播放音效", required: [{ name: "key", type: "string", hint: "音效 key" }], optional: [{ name: "volume", type: "number", hint: "音量" }], runtimeRegistered: true },
  { command: "decision", canonical: "Decision", category: "Choice", tier: "A", summary: "选项面板（配合 Predicate 合流）", required: [{ name: "options", type: "semilist", hint: "`;` 分隔的标签" }], optional: [{ name: "values", type: "semilist", hint: "`;` 分隔的值" }], runtimeRegistered: true },
  { command: "predicate", canonical: "Predicate", category: "Branch", tier: "A", summary: "分支闸门（最后一行写全部分支值 = 合流）", required: [{ name: "references", type: "semilist", hint: "`;` 分隔的值" }], optional: [], runtimeRegistered: true },
  { command: "endtip", canonical: "endtip", category: "Branch", tier: "A", summary: "收尾（运行时只认 endtip，没有 End）", required: [], optional: [{ name: "block", type: "bool", hint: "是否阻塞", default: true }], runtimeRegistered: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// 六、内嵌语料表（只读；`scripts/fanfic/editorForms-data.mjs` 生成）
//    只影响"滑杆范围 / 预设 / 素材候选"；字段表始终从 CONTROLLERS 派生。
// ─────────────────────────────────────────────────────────────────────────────

/* @generated:data */
/** 语料实测数值范围（`命令.参数` 或 `*.参数` → `[min, max, 滑杆步长, 样本数]`）。
 *  由官方剧本 .txt 全量扫描得出；`*.` 前缀 = 该参数在各命令里的并集。 */
export const OBSERVED_RANGES = {
  "*.a": [0, 1, 0.05, 72325],
  "*.aduration": [0, 3, 0.05, 36],
  "*.afrom": [0, 1, 0.05, 5573],
  "*.amount": [0, 1, 0.05, 2041],
  "*.angle": [-180, 180, 5, 19],
  "*.ato": [0, 1, 0.05, 4528],
  "*.b": [0, 255, 5, 69798],
  "*.bend": [0, 1, 0.05, 1654],
  "*.bfrom": [0, 15, 1, 990],
  "*.blackend": [0, 1, 0.05, 744],
  "*.blackend2": [0.25, 0.9, 0.05, 228],
  "*.blackstart": [0.05, 0.99, 0.05, 744],
  "*.blackstart2": [0.1, 0.4, 0.01, 228],
  "*.bstart": [0, 0.9, 0.05, 1652],
  "*.channel": [1, 23, 1, 2600],
  "*.crossfade": [0.5, 5, 0.1, 512],
  "*.delay": [0, 9, 0.1, 8444],
  "*.duration": [-1, 800, 10, 38992],
  "*.fade": [1, 1, 0.01, 114],
  "*.fadetime": [0, 100, 5, 107902],
  "*.fillfrom": [0, 1, 0.05, 1198],
  "*.fillto": [0, 1, 0.05, 1198],
  "*.focus": [-3, 3, 0.1, 56922],
  "*.from": [0, 1, 0.05, 631],
  "*.g": [0, 255, 5, 69808],
  "*.gfrom": [0, 255, 5, 990],
  "*.height": [1, 1.7, 0.05, 195],
  "*.initamount": [0, 1, 0.05, 364],
  "*.layer": [0, 5, 0.1, 1135],
  "*.movetime": [0, 30, 1, 14],
  "*.offsetX": [75, 125, 1, 584],
  "*.offsetY": [50, 100, 1, 584],
  "*.offsetx": [-300, 300, 10, 17],
  "*.pduration": [0, 120, 5, 34],
  "*.power": [-80, 400, 10, 1848],
  "*.r": [0, 255, 5, 69812],
  "*.random": [0, 90, 5, 164],
  "*.randomness": [0, 180, 5, 14527],
  "*.rfrom": [-5, 255, 5, 994],
  "*.scale": [0.2, 3.5, 0.1, 691],
  "*.sduration": [0, 40, 1, 22],
  "*.sfrom": [0.5, 1.5, 0.05, 29],
  "*.size": [14, 100, 5, 6092],
  "*.sto": [0.9, 1.8, 0.05, 32],
  "*.style": [1, 3, 0.05, 72],
  "*.time": [-0.6, 16, 1, 75153],
  "*.times": [0, 1000, 10, 1922],
  "*.to": [0, 1, 0.05, 631],
  "*.tsduration": [0, 1, 0.05, 62],
  "*.vibrato": [0, 100, 5, 14532],
  "*.volume": [0, 7, 0.1, 41255],
  "*.width": [1, 1280, 10, 6277],
  "*.x": [-1500, 1100, 10, 7086],
  "*.xFrom": [-1280, 620, 10, 570],
  "*.xScale": [0.4, 3.5, 0.1, 1804],
  "*.xScaleFrom": [0.36, 3, 0.05, 952],
  "*.xScaleTo": [0.25, 8, 0.1, 1141],
  "*.xTo": [-1440, 800, 10, 824],
  "*.xfrom": [-940, 120, 10, 11],
  "*.xpos": [-3000, 2000, 10, 4123],
  "*.xstrength": [0, 120, 5, 13762],
  "*.xto": [-800, 500, 10, 18],
  "*.y": [-1000, 2160, 10, 7130],
  "*.yFrom": [-1000, 2160, 10, 521],
  "*.yScale": [0.4, 3.5, 0.1, 1800],
  "*.yScaleFrom": [0.36, 3, 0.05, 955],
  "*.yScaleTo": [0.25, 8, 0.1, 1137],
  "*.yTo": [-700, 1890, 10, 777],
  "*.ypos": [-3000, 2000, 10, 948],
  "*.ystrength": [0, 120, 5, 14514],
  "*.yto": [-140, 350, 10, 17],
  "avgdisplay.afrom": [0, 1, 0.05, 26],
  "avgdisplay.ato": [0, 1, 0.05, 26],
  "avgdisplay.duration": [0.1, 30, 1, 32],
  "avgdisplay.layer": [1, 5, 0.1, 55],
  "avgdisplay.x": [-425, 342, 10, 11],
  "avgdisplay.y": [-350, 100, 10, 17],
  "background.fadetime": [0, 20, 1, 920],
  "background.height": [1, 1.7, 0.05, 193],
  "background.width": [1, 1.7, 0.05, 193],
  "background.x": [-450, 300, 10, 149],
  "background.xScale": [0.86, 2, 0.05, 411],
  "background.y": [-400, 197, 10, 187],
  "background.yScale": [0.86, 2, 0.05, 410],
  "backgroundtween.duration": [0, 110, 5, 506],
  "backgroundtween.x": [-100, 20, 5, 12],
  "backgroundtween.xFrom": [-650, 380, 10, 192],
  "backgroundtween.xScale": [0.9, 1.2, 0.01, 12],
  "backgroundtween.xScaleFrom": [1, 2, 0.05, 206],
  "backgroundtween.xScaleTo": [0.95, 1.8, 0.05, 231],
  "backgroundtween.xTo": [-650, 380, 10, 230],
  "backgroundtween.y": [-360, 0, 5, 12],
  "backgroundtween.yFrom": [-250, 300, 10, 134],
  "backgroundtween.yScale": [0.9, 1.2, 0.01, 12],
  "backgroundtween.yScaleFrom": [1, 2, 0.05, 206],
  "backgroundtween.yScaleTo": [0.95, 1.8, 0.05, 228],
  "backgroundtween.yTo": [-250, 300, 10, 182],
  "bgeffect.fade": [1, 1, 0.01, 114],
  "bgeffect.fadetime": [0, 5, 0.1, 148],
  "bgeffect.layer": [0, 5, 0.1, 980],
  "bgeffect.movetime": [0, 30, 1, 14],
  "bgeffect.x": [-600, 700, 10, 92],
  "bgeffect.xto": [-400, 500, 10, 14],
  "bgeffect.y": [-400, 500, 10, 73],
  "bgeffect.yto": [-140, 350, 10, 14],
  "blocker.a": [0, 1, 0.05, 72301],
  "blocker.afrom": [0, 1, 0.05, 989],
  "blocker.b": [0, 255, 5, 69797],
  "blocker.bfrom": [0, 15, 1, 990],
  "blocker.duration": [0, 1, 0.05, 18],
  "blocker.fadetime": [0, 100, 5, 72428],
  "blocker.g": [0, 255, 5, 69807],
  "blocker.gfrom": [0, 255, 5, 990],
  "blocker.r": [0, 255, 5, 69811],
  "blocker.rfrom": [0, 255, 5, 990],
  "cameraeffect.amount": [0, 1, 0.05, 2041],
  "cameraeffect.fadetime": [0, 18, 1, 1366],
  "cameraeffect.initamount": [0, 1, 0.05, 364],
  "camerashake.delay": [0.04, 0.5, 0.01, 24],
  "camerashake.duration": [-1, 800, 10, 14517],
  "camerashake.fadetime": [0.16, 1, 0.05, 92],
  "camerashake.randomness": [0, 180, 5, 14527],
  "camerashake.vibrato": [0, 100, 5, 14532],
  "camerashake.xstrength": [0, 120, 5, 13762],
  "camerashake.ystrength": [0, 120, 5, 14514],
  "cgitem.aduration": [0, 3, 0.05, 27],
  "cgitem.afrom": [0, 1, 0.05, 25],
  "cgitem.ato": [0, 1, 0.05, 28],
  "cgitem.layer": [1, 4, 0.05, 91],
  "cgitem.pduration": [0, 120, 5, 34],
  "cgitem.sduration": [0, 40, 1, 22],
  "cgitem.sfrom": [0.5, 1.5, 0.05, 29],
  "cgitem.sto": [0.9, 1.8, 0.05, 32],
  "character.blackend": [0, 1, 0.05, 744],
  "character.blackend2": [0.25, 0.9, 0.05, 228],
  "character.blackstart": [0.05, 0.99, 0.05, 744],
  "character.blackstart2": [0.1, 0.4, 0.01, 228],
  "character.fadetime": [0, 10, 0.1, 8927],
  "character.focus": [-3, 3, 0.1, 56920],
  "character.offsetX": [75, 125, 1, 584],
  "character.offsetY": [50, 100, 1, 584],
  "characteraction.duration": [0.5, 2, 0.05, 19],
  "characteraction.fadetime": [0, 10, 0.1, 4915],
  "characteraction.power": [-30, 300, 5, 1171],
  "characteraction.scale": [0.3, 1.5, 0.05, 22],
  "characteraction.time": [1, 10, 0.1, 9],
  "characteraction.times": [0, 1000, 10, 1243],
  "characteraction.xpos": [-3000, 2000, 10, 4122],
  "characteraction.ypos": [-3000, 2000, 10, 946],
  "charactercutin.fadetime": [0, 0.7, 0.05, 192],
  "charslot.afrom": [0, 1, 0.05, 4499],
  "charslot.ato": [0, 1, 0.05, 4446],
  "charslot.bend": [0, 1, 0.05, 1654],
  "charslot.bstart": [0, 0.9, 0.05, 1652],
  "charslot.duration": [-0.5, 60, 5, 21019],
  "charslot.fadetime": [0, 2, 0.05, 35],
  "charslot.power": [-80, 400, 10, 677],
  "charslot.random": [0, 90, 5, 164],
  "charslot.scale": [0.2, 3.5, 0.1, 669],
  "charslot.times": [0, 100, 5, 679],
  "curtain.a": [0, 1, 0.05, 22],
  "curtain.afrom": [0, 1, 0.05, 12],
  "curtain.fadetime": [0, 40, 1, 1137],
  "curtain.fillfrom": [0, 1, 0.05, 1198],
  "curtain.fillto": [0, 1, 0.05, 1198],
  "delay.time": [-0.6, 16, 1, 75097],
  "dialog.delay": [0.3, 2, 0.05, 20],
  "dialog.fadetime": [0, 2, 0.05, 48],
  "dialog.time": [0.5, 1.5, 0.05, 11],
  "focusout.duration": [0, 30, 1, 623],
  "focusout.from": [0, 1, 0.05, 631],
  "focusout.to": [0, 1, 0.05, 631],
  "hidecgitem.fadetime": [0.1, 5, 0.1, 18],
  "hideitem.fadetime": [0, 1, 0.05, 18],
  "image.fadetime": [0, 10, 0.1, 2138],
  "image.x": [-1500, 700, 10, 682],
  "image.xScale": [0.4, 3.5, 0.1, 1298],
  "image.xScaleFrom": [1, 1.7, 0.05, 23],
  "image.y": [-1000, 800, 10, 745],
  "image.yScale": [0.4, 3.5, 0.1, 1296],
  "image.yScaleFrom": [1, 1.7, 0.05, 24],
  "imagerotate.angle": [-180, 180, 5, 19],
  "imagerotate.fadetime": [0, 60, 1, 19],
  "imagetween.duration": [0, 120, 5, 1233],
  "imagetween.fadetime": [0, 5, 0.1, 37],
  "imagetween.x": [-200, 600, 10, 26],
  "imagetween.xFrom": [-630, 620, 10, 348],
  "imagetween.xScale": [0.4, 2, 0.05, 80],
  "imagetween.xScaleFrom": [0.832, 3, 0.05, 708],
  "imagetween.xScaleTo": [0.8, 8, 0.1, 890],
  "imagetween.xTo": [-820, 800, 10, 560],
  "imagetween.y": [-400, 370, 10, 24],
  "imagetween.yFrom": [-1000, 450, 10, 286],
  "imagetween.yScale": [0.4, 2, 0.05, 79],
  "imagetween.yScaleFrom": [0.832, 3, 0.05, 709],
  "imagetween.yScaleTo": [0.8, 8, 0.1, 889],
  "imagetween.yTo": [-700, 648, 10, 491],
  "interlude.aduration": [0.1, 2, 0.05, 9],
  "interlude.channel": [1, 6, 0.1, 754],
  "interlude.duration": [0, 40, 1, 93],
  "interlude.style": [1, 3, 0.05, 72],
  "interlude.tsduration": [0, 1, 0.05, 62],
  "largebg.fadetime": [0, 4, 0.1, 9],
  "largebg.x": [-1440, 0, 10, 63],
  "largebgtween.duration": [0, 120, 5, 147],
  "largebgtween.xFrom": [-1280, 0, 10, 27],
  "largebgtween.xScaleFrom": [0.36, 1.2, 0.05, 15],
  "largebgtween.xScaleTo": [0.25, 1, 0.05, 15],
  "largebgtween.xTo": [-1440, 100, 10, 32],
  "largebgtween.yFrom": [0, 2160, 10, 97],
  "largebgtween.yScaleFrom": [0.36, 1.2, 0.05, 15],
  "largebgtween.yScaleTo": [0.25, 1, 0.05, 15],
  "largebgtween.yTo": [-393, 1890, 10, 102],
  "musicvolume.fadetime": [0, 60, 1, 1829],
  "musicvolume.volume": [0, 1, 0.05, 1833],
  "playmusic.crossfade": [0.5, 5, 0.1, 510],
  "playmusic.delay": [0, 2, 0.05, 278],
  "playmusic.fadetime": [0, 5, 0.1, 138],
  "playmusic.volume": [0, 1, 0.05, 8692],
  "playsound.channel": [1, 23, 1, 1511],
  "playsound.delay": [0, 9, 0.1, 2037],
  "playsound.fadetime": [0.5, 6, 0.1, 38],
  "playsound.volume": [0, 7, 0.1, 29148],
  "showitem.fadetime": [0.1, 1, 0.05, 48],
  "showitem.offsetx": [0, 0, 0.01, 15],
  "showitem.width": [200, 200, 0.01, 15],
  "soundvolume.channel": [1, 4, 0.05, 19],
  "soundvolume.fadetime": [0, 50, 1, 1573],
  "soundvolume.volume": [0, 2, 0.05, 1577],
  "sticker.delay": [0, 1, 0.05, 750],
  "sticker.duration": [0, 15, 1, 722],
  "sticker.size": [20, 100, 5, 767],
  "sticker.width": [300, 1180, 10, 740],
  "sticker.x": [0, 1100, 10, 721],
  "sticker.y": [20, 630, 10, 721],
  "stopmusic.fadetime": [0, 10, 0.1, 8377],
  "stopmusic.time": [0, 3, 0.05, 25],
  "stopsound.channel": [1, 11, 0.1, 316],
  "stopsound.fadetime": [0, 15, 1, 3435],
  "subtitle.delay": [0, 0.7, 0.05, 5323],
  "subtitle.duration": [0, 2, 0.05, 25],
  "subtitle.size": [14, 44, 1, 5325],
  "subtitle.width": [200, 1280, 10, 5325],
  "subtitle.x": [50, 700, 10, 5327],
  "subtitle.y": [100, 620, 10, 5327],
  "timerclear.afrom": [1, 1, 0.01, 9],
  "timerclear.ato": [0, 0, 0.01, 9],
  "timerclear.duration": [0, 2, 0.05, 9],
  "verticalbg.y": [200, 2160, 10, 18],
};

/** 命名预设（参数取自真实语料行；`source` = `文件:行`，自检会回读核对）。 */
export const NAMED_PRESETS = {
  character: [
    { name: "入场（淡入）", source: "activities/a001/level_a001_02_end.txt:31", line: "[Character(name=\"avg_npc_010\",fadetime=0.5)]" },
    { name: "差分切换", source: "activities/a001/level_a001_01_beg.txt:86", line: "[Character(name=\"char_220_grani#5\",fadetime=1.5,block=true)]" },
    { name: "双人同框", source: "activities/a001/level_a001_01_beg.txt:32", line: "[Character(name=\"avg_npc_009\",name2=\"avg_npc_009\",focus=1,fedetime=1,block=true)]" },
  ],
  charslot: [
    { name: "精确站位", source: "activities/act14mini/level_act14mini_st01.txt:62", line: "[charslot(slot=\"m\",name=\"avg_npc_787_1#6$1\",duration=1)]" },
    { name: "聚焦", source: "activities/act14mini/level_act14mini_st01.txt:49", line: "[charslot(slot=\"m\",name=\"avg_npc_820_1#11$1\",focus=\"m\")]" },
  ],
  blocker: [
    { name: "全黑 0.5s", source: "activities/a001/level_a001_01_beg.txt:47", line: "[Blocker(a=1, r=0, g=0, b=0, fadetime=0.5,block=true)]" },
    { name: "全黑 2s", source: "activities/a001/level_a001_01_beg.txt:104", line: "[Blocker(a=1, r=0,g=0, b=0, fadetime=2, block=true)]" },
    { name: "白闪", source: "activities/act10d5/level_act10d5_st05.txt:521", line: "[Blocker(a=1, r=1, g=1, b=1, afrom=0, rfrom=0, gfrom=0, bfrom=0, fadetime=0.1, block=true)]" },
    { name: "淡出", source: "activities/a001/level_a001_01_beg.txt:12", line: "[Blocker(a=0, fadetime=0.6, block=false)]" },
  ],
  camerashake: [
    { name: "重震", source: "activities/a001/level_a001_02_beg.txt:161", line: "[CameraShake(duration=0.6, xstrength=5, ystrength=8, vibrato=30, randomness=90, block=true)]" },
    { name: "轻震", source: "activities/act11d0/level_act11d0_08_end.txt:558", line: "[CameraShake(duration=0.3, xstrength=10, ystrength=12, vibrato=30, randomness=10, fadeout=true, block=false)]" },
  ],
  cameraeffect: [
    { name: "灰化（情绪冷下来）", source: "activities/a001/level_a001_06_end.txt:50", line: "[CameraEffect(effect=\"Grayscale\", amount=0.8, keep=true)]" },
    { name: "还原", source: "activities/a001/level_a001_06_end.txt:56", line: "[CameraEffect(effect=\"Grayscale\", amount=0)]" },
    { name: "反色", source: "activities/act42side/level_act42side_03_beg.txt:280", line: "[cameraeffect(effect=\"Colorinverse\", keep=true)]" },
  ],
  background: [
    { name: "换背景（铺满 + 阻塞）", source: "activities/act12d0/level_act12d0_03_beg.txt:39", line: "[Background(image=\"bg_temple_1\",screenadapt=\"coverall\",block=true)]" },
    { name: "淡入换景", source: "activities/act12d0/level_act12d0_04_end.txt:196", line: "[Background(image=\"bg_temple_2\",fadetime=1,screenadapt=\"coverall\")]" },
  ],
  image: [
    { name: "整屏叠图（CG）", source: "activities/act13d5/level_act13d5_03_end.txt:194", line: "[Image(image=\"ac13_4\",x=0, y=0, xScale=1, yScale=1, fadetime=0, screenadapt=\"coverall\")]" },
    { name: "叠图位移", source: "activities/a001/level_a001_01_beg.txt:205", line: "[Image(image=\"ac1_2\",x=-100, y=0, xScale=1.2, yScale=1.2, fadetime=1,screenadapt=\"coverall\")]" },
  ],
  delay: [
    { name: "短停顿", source: "activities/a001/level_a001_01_beg.txt:269", line: "[Delay(time=0.5)]" },
    { name: "1 秒", source: "activities/a001/level_a001_01_beg.txt:4", line: "[Delay(time=1)]" },
    { name: "长停顿", source: "activities/a001/level_a001_02_beg.txt:96", line: "[Delay(time=3)]" },
  ],
  curtain: [
    { name: "自左", source: "activities/act14mini/level_act14mini_st05.txt:93", line: "[curtain(direction = 0,fillfrom = 0.2,fillto = 0.2,fadetime=0.01)]" },
    { name: "自右", source: "activities/act14mini/level_act14mini_st05.txt:91", line: "[curtain(direction = 2,fillfrom = 0.05,fillto = 0.05,fadetime=0.01)]" },
    { name: "上下", source: "activities/act14mini/level_act14mini_st05.txt:92", line: "[curtain(direction = 6,fillfrom = 0.05,fillto = 0.05,fadetime=0.01)]" },
  ],
  playmusic: [
    { name: "循环 BGM", source: "activities/act11mini/level_act11mini_st02.txt:6", line: "[playMusic(key=\"Sound_Beta_2/Music/act15side/m_sys_bitw_loop\", volume=0.4)]" },
    { name: "带前奏", source: "activities/a001/level_a001_01_beg.txt:3", line: "[PlayMusic(intro=\"$darkness01_intro\", key=\"$darkness01_loop\", volume=0.6, crossfade=1.5)]" },
  ],
  subtitle: [
    { name: "字幕（居中）", source: "activities/act10mini/level_act10mini_st01.txt:10", line: "[Subtitle(text=\"夜幕降临。\", x=300, y=370, alignment=\"center\", size=24, delay=0.04, width=700)]" },
  ],
  decision: [
    { name: "二选一", source: "activities/act12d0/level_act12d0_01_beg.txt:15", line: "[Decision(options=\"什么是自由？;我自由了！\", values=\"1;2\")]" },
    { name: "三选一", source: "activities/act10d5/level_act10d5_st06.txt:22", line: "[Decision(options=\"是乌萨斯自治团的……;……;呃，是谁来着？\", values=\"1;2;3\")]" },
  ],
  predicate: [
    { name: "分支闸门", source: "activities/act10d5/level_act10d5_st06.txt:10", line: "[Predicate(references=\"1\")]" },
    { name: "合流", source: "activities/act10d5/level_act10d5_st06.txt:35", line: "[Predicate(references=\"1;2;3\")]" },
  ],
  interlude: [
    { name: "横向切入", source: "activities/act16mini/level_act16mini_st02.txt:679", line: "[interlude(maskid = \"ui_cutin_mask_horizon\", style = 1, size = \"1280, 100\",offset = \"0,25\", channel = 2)]" },
    { name: "淡入", source: "activities/act16mini/level_act16mini_st02.txt:681", line: "[interlude(channel = 2, type = 1, slot = \"m\", offset = \"400,0\", name = \"cutin_char_18\", aduration = 0.1)]" },
  ],
  sticker: [
    { name: "便签（正文内联）", source: "activities/act11mini/level_act11mini_st06.txt:10", line: "[Sticker(id=\"st1\", text=\"<i>亲爱的K先生：</i>\", x=200,y=170, alignment=\"left\", size=24, delay=0.04, width=700)]" },
  ],
  focusout: [
    { name: "景深", source: "activities/act16mini/level_act16mini_st01.txt:786", line: "[focusout(duration=0, type=\"bg\", from=0, to=1, block=true)]" },
  ],
  theater: [
    { name: "开场", source: "activities/act14side/level_act14side_01_beg.txt:24", line: "[theater(mode=true)]" },
    { name: "退场", source: "activities/act14side/level_act14side_01_beg.txt:31", line: "[theater(mode=false)]" },
  ],
  skipnode: [
    { name: "跳过首节点", source: "activities/act45side/level_act45side_08_end.txt:9", line: "[skipnode(mode=\"nofirstskip\")]" },
    { name: "跳过", source: "activities/act45side/level_act45side_08_end.txt:19", line: "[skipnode(mode=\"skip\")]" },
  ],
  charactercutin: [
    { name: "切入角色", source: "obt/memory/story_cast3_1_1.txt:436", line: "[CharacterCutin(name=\"char_349_chiave#3\",widgetID=\"Chiave\",offsetx=-300,fadestyle:\"fade\",fadetime=0.51,width=200)]" },
  ],
  imagetween: [
    { name: "缓推 15s", source: "activities/a001/level_a001_01_beg.txt:13", line: "[ImageTween(xFrom=0, yFrom=0, xTo=0, yTo=-20, xScaleFrom=1, yScaleFrom=1, xScaleTo=1.1, yScaleTo=1.1, duration=15, block=false)]" },
    { name: "滑入", source: "activities/act12side/level_act12side_st01.txt:98", line: "[ImageTween(xFrom=-100, xTo=100, duration=10, block=false)]" },
  ],
  characteraction: [
    { name: "移动", source: "activities/act10mini/level_act10mini_st01.txt:107", line: "[characteraction(name=\"left\", type=\"move\", xpos=-200, fadetime=0.3, block=true)]" },
    { name: "退场", source: "activities/act13mini/level_act13mini_st02.txt:388", line: "[characteraction(name=\"right\", type=\"exit\", direction=\"right\",fadetime=2.5)]" },
  ],
  header: [
    { name: "标题 + 黑边", source: "activities/act10mini/level_act10mini_st02.txt:1", line: "[HEADER(key=\"title_test\", is_skippable=true, fit_mode=\"BLACK_MASK\")]" },
  ],
};

/** 语料高频写法（按参数键集合聚类后的代表行，`n` = 该形态的出现次数）。 */
export const CORPUS_ANCHORS = {
  dialog: [
    { name: "无参数", source: "activities/a001/level_a001_01_beg.txt:2", line: "[Dialog]", n: 64906 },
    { name: "常用（淡入）", source: "activities/a001/level_a001_01_beg.txt:48", line: "[Dialog(fadetime=0)]", n: 27 },
    { name: "全参数（2 项）", source: "activities/act18d3/level_act18d3_01_beg.txt:18", line: "[dialog(fadetime=1,block=true)]", n: 13 },
  ],
  playmusic: [
    { name: "最短写法", source: "activities/act25side/level_act25side_10_end.txt:264", line: "[playMusic(key=\"$calm_loop\",volume=0.6)]", n: 1464 },
    { name: "常用（intro/音频）", source: "activities/act9d0/level_act9d0_01_beg.txt:194", line: "[playMusic(intro=\"$w_intro\", key=\"$w_loop\", volume=0.7)]", n: 6570 },
    { name: "常用（crossfade/delay）", source: "activities/act5d1/ui_act5d1_cc.txt:5", line: "[PlayMusic(intro=\"$lab_intro\", key=\"$lab_loop\", volume=0.6, crossfade=1, delay=0.5)]", n: 266 },
  ],
  delay: [
    { name: "最短写法", source: "activities/a001/level_a001_01_beg.txt:4", line: "[Delay(time=1)]", n: 75100 },
    { name: "常用（阻塞/秒数）", source: "activities/act13d0/level_act13d0_st07.txt:933", line: "[Delay(time=1,block=true)]", n: 22 },
  ],
  blocker: [
    { name: "无参数", source: "obt/main/level_main_08-15_beg.txt:296", line: "[Blocker]", n: 2 },
    { name: "常用（阻塞/淡入）", source: "obt/main/level_main_06-02_beg.txt:4", line: "[Blocker(a=1, r=0,g=0,b=0,fadetime=1,block=true)]", n: 67919 },
    { name: "常用（阻塞/淡入）", source: "obt/main/level_main_05-04_end.txt:57", line: "[Blocker(a=1,fadetime=2,block=true)]", n: 2470 },
    { name: "全参数（10 项）", source: "activities/act13d5/level_act13d5_03_end.txt:192", line: "[Blocker(a=1, r=1, g=1, b=1, afrom=0, rfrom=0, gfrom=0, bfrom=0, fadetime=2, block=true)]", n: 979 },
  ],
  character: [
    { name: "无参数", source: "activities/a001/level_a001_01_beg.txt:19", line: "[Character]", n: 13704 },
    { name: "常用（focus/角色）", source: "activities/act14side/level_act14side_01_beg.txt:257", line: "[Character(name=\"char_empty\",name2=\"avg_npc_252\",focus=2)]", n: 54762 },
    { name: "常用（角色）", source: "obt/main/level_main_03-06_end.txt:14", line: "[Character(name=\"\")]", n: 54665 },
    { name: "全参数（7 项）", source: "activities/act18d3/level_act18d3_01_end.txt:353", line: "[character(name=\"avg_npc_186\",blackstart=0.25,blackend=0.4,name2=\"avg_npc_184\",blackstart2=0.25,blackend2=0.4,focus=2)]", n: 106 },
  ],
  image: [
    { name: "无参数", source: "activities/a001/level_a001_01_beg.txt:214", line: "[Image]", n: 3357 },
    { name: "常用（淡入/图片）", source: "activities/act16side/level_act16side_01_beg.txt:288", line: "[Image(image=\"26_i15\",screenadapt=\"showall\",fadetime=1)]", n: 549 },
    { name: "全参数（8 项）", source: "obt/main/level_main_14-06_beg.txt:249", line: "[Image(image=\"50_i26\",screenadapt=\"coverall\",xScale=2,yScale=2,x=300,y=300,fadetime=0,block=true)]", n: 16 },
  ],
  imagetween: [
    { name: "最短写法", source: "activities/act30side/level_act30side_st02.txt:902", line: "[ImageTween(xTo=0, duration=15)]", n: 11 },
    { name: "常用（阻塞/时长）", source: "obt/main/level_main_08-03_beg.txt:162", line: "[ImageTween(xScaleFrom=1, yScaleFrom=1, xScaleTo=1, yScaleTo=1, duration=15, block=false)]", n: 308 },
    { name: "常用（阻塞/时长）", source: "activities/act19side/level_act19side_07_end.txt:436", line: "[ImageTween(xFrom=-100, xTo=0,yFrom=-60,yTo=0,duration=60,xScaleFrom=1,xScaleTo=0.9,yScaleFrom=1,yScaleTo=0.9, block=false)]", n: 108 },
  ],
  background: [
    { name: "无参数", source: "activities/a001/level_a001_01_beg.txt:50", line: "[Background]", n: 868 },
    { name: "常用（图片/screenadapt）", source: "obt/memory/story_poca_1_1.txt:368", line: "[Background(image=\"bg_med\",screenadapt=\"showall\")]", n: 12094 },
    { name: "常用（阻塞/图片）", source: "activities/act41side/level_act41side_st03.txt:645", line: "[Background(image=\"bg_ceo\",screenadapt=\"coverall\", block=true)]", n: 2290 },
    { name: "全参数（8 项）", source: "activities/act27side/level_act27side_st01.txt:19", line: "[Background(image=\"bg_beach_2\",screenadapt=\"showall\",xScale=1.5,yScale=1.5,x=0,y=0,fadetime=0,block=true)]", n: 1 },
  ],
  stopmusic: [
    { name: "无参数", source: "activities/a001/level_a001_03_beg.txt:2", line: "[stopmusic]", n: 1970 },
    { name: "常用（淡入）", source: "activities/a001/level_a001_01_beg.txt:61", line: "[stopmusic(fadetime=1)]", n: 8376 },
    { name: "常用（秒数）", source: "activities/act11d0/level_act11d0_07_beg.txt:87", line: "[stopmusic(time=1)]", n: 25 },
    { name: "全参数（2 项）", source: "activities/act12side/level_act12side_st01.txt:765", line: "[stopmusic(fadetime=1,block=false)]", n: 1 },
  ],
  playsound: [
    { name: "最短写法", source: "activities/act10d5/level_act10d5_st05.txt:105", line: "[PlaySound(key=\"$radio\")]", n: 10409 },
    { name: "常用（音频/volume）", source: "activities/act12side/level_act12side_09_beg.txt:142", line: "[PlaySound(key=\"$fan\", volume=1)]", n: 23177 },
    { name: "常用（channel/音频）", source: "activities/act35side/level_act35side_07_end.txt:149", line: "[PlaySound(key=\"$phone\", volume=1, loop=true, channel=\"t\")]", n: 3016 },
    { name: "全参数（6 项）", source: "obt/memory/story_kirara_1_1.txt:606", line: "[PlaySound(key=\"$phonevibration\",channel=\"bgs\", volume=1, loop=true, block=false, volume=0.6)]", n: 11 },
  ],
  camerashake: [
    { name: "无参数", source: "activities/act16d5/level_act16d5_01_beg.txt:375", line: "[CameraShake]", n: 1 },
    { name: "常用（阻塞/时长）", source: "activities/act17side/level_act17side_03_end.txt:364", line: "[CameraShake(duration=1,xstrength=8,ystrength=6,vibrato=3,randomness=90,fadeout=true,block=true)]", n: 12816 },
    { name: "常用（阻塞/时长）", source: "activities/act13side/level_act13side_06_beg.txt:709", line: "[CameraShake(duration=0.2, ystrength=1, vibrato=1, randomness=1, fadeout=true, block=false)]", n: 752 },
    { name: "全参数（8 项）", source: "obt/memory/story_lolxh_1_1.txt:683", line: "[CameraShake(duration=3, xstrength=10, ystrength=10, vibrato=30, randomness=90, fadetime=1,fadeout=true, block=true)]", n: 51 },
  ],
  showitem: [
    { name: "最短写法", source: "obt/rune/rune_season_0_1/ui_rune_season_0_1_cc.txt:47", line: "[showitem(image=\"item_cc2_1\")]", n: 10 },
    { name: "常用（淡入/图片）", source: "activities/act16d5/level_act16d5_st01.txt:312", line: "[showitem(image=\"item_act16_1\",fadetime=1)]", n: 31 },
    { name: "常用（fadestyle/淡入）", source: "activities/act15side/level_act15side_st02.txt:311", line: "[ShowItem(image=\"item_act16_1\", fadestyle=\"horiz_expand_center\", fadetime=0.5, offsetx=0, width=200)]", n: 15 },
  ],
  hideitem: [
    { name: "无参数", source: "activities/a001/level_a001_01_beg.txt:242", line: "[hideitem]", n: 30 },
    { name: "常用（淡入）", source: "activities/act10d5/level_act10d5_st02.txt:55", line: "[hideitem(fadetime=1)]", n: 12 },
    { name: "全参数（2 项）", source: "activities/act12d0/level_act12d0_08_beg.txt:124", line: "[HideItem(fadetime=1,block=true)]", n: 6 },
  ],
  cameraeffect: [
    { name: "最短写法", source: "obt/main/level_main_17-09_end.txt:637", line: "[CameraEffect(effect=\"Chaos\", keep= false)]", n: 24 },
    { name: "常用（amount/效果）", source: "activities/act12mini/level_act12mini_st01.txt:377", line: "[CameraEffect(effect=\"Grayscale\", amount=0, keep=true)]", n: 680 },
    { name: "常用（amount/效果）", source: "activities/act46side/level_act46side_08_end.txt:26", line: "[CameraEffect(effect=\"Grayscale\",amount=1,fadetime=0,keep=true)]", n: 515 },
    { name: "全参数（6 项）", source: "activities/act53side/level_act53side_st01.txt:193", line: "[CameraEffect(effect=\"Grayscale\",fadetime=1,keep=true,initamount=1,amount=0,block=false)]", n: 330 },
  ],
  decision: [
    { name: "最短写法", source: "activities/act12d0/level_act12d0_03_end.txt:33", line: "[Decision(options=\"……\",values=\"1\")]", n: 4333 },
  ],
  predicate: [
    { name: "无参数", source: "obt/guide/shop/0_main_and_extraqc.txt:17", line: "[Predicate]", n: 4 },
    { name: "常用（references）", source: "activities/act10d5/level_act10d5_st06.txt:10", line: "[Predicate(references=\"1\")]", n: 5824 },
    { name: "常用（references/selectableCondition）", source: "activities/act1sandbox/battleavg/dialog_sandbox_0_mantic_market_1.txt:5", line: "[predicate(references=\"1.1\", selectableCondition=\"c0\")]", n: 119 },
  ],
  subtitle: [
    { name: "无参数", source: "activities/act10mini/level_act10mini_st01.txt:14", line: "[subtitle]", n: 2132 },
    { name: "常用（alignment/delay）", source: "activities/act21side/level_act21side_st04.txt:250", line: "[Subtitle(text=\"……\",x=250, y=350, alignment=\"left\", size=24, delay=0.04, width=700)]", n: 5279 },
    { name: "常用（alignment/delay）", source: "activities/act53side/level_act53side_06_end.txt:493", line: "[Subtitle(text=\"她哭了吗？\",multi = true, x=300, y=350, alignment=\"center\", size=24, delay=0.04, width=700)]", n: 21 },
    { name: "全参数（9 项）", source: "activities/act54side/level_act54side_02_beg.txt:73", line: "[Subtitle(text=\"“救救我，我已经赤裸无依……♪”\", x=360, y=270, alignment=\"center\",hidelog=true, size=26, delay=0.04, width=700,duration=0)]", n: 3 },
  ],
  characteraction: [
    { name: "最短写法", source: "obt/memory/story_kroos_1_1.txt:710", line: "[characteraction(name=\"left\", type=\"exit\",direction=\"left\")]", n: 4 },
    { name: "常用（阻塞/淡入）", source: "activities/act12mini/level_act12mini_st04.txt:801", line: "[characteraction(name=\"left\",type=\"move\",xpos=50,fadetime=0.7,block=true)]", n: 2559 },
    { name: "常用（阻塞/淡入）", source: "activities/act15d0/level_act15d0_07_beg.txt:102", line: "[characteraction(name=\"left\", type=\"jump\",power=0, xpos=450,times=1,fadetime=0.8,block=true)]", n: 727 },
    { name: "全参数（8 项）", source: "activities/act14side/level_act14side_08_end.txt:872", line: "[characteraction(name=\"right\", type=\"move\", xpos=80,ypos=0,power=60,times=2, fadetime=1,block=true)]", n: 68 },
  ],
  stopsound: [
    { name: "最短写法", source: "activities/act21mini/level_act21mini_st01.txt:121", line: "[stopsound(channel=\"a\")]", n: 148 },
    { name: "常用（channel/淡入）", source: "activities/act18mini/level_act18mini_st02.txt:29", line: "[stopsound(channel=\"w\",fadetime=1)]", n: 3430 },
    { name: "常用（channel/时长）", source: "obt/memory/story_tachak_1_1.txt:410", line: "[stopsound(channel=\"1\",duration=1)]", n: 4 },
    { name: "全参数（3 项）", source: "obt/memory/story_yu_1_1.txt:15", line: "[stopSound(key=\"$blizzard\",channel=\"bg\",fadetime=2)]", n: 4 },
  ],
  header: [
    { name: "无参数", source: "activities/act33side/level/act33side_09_a2.txt:1", line: "[header]", n: 4 },
    { name: "常用（fit_mode/is_skippable）", source: "activities/act10mini/level_act10mini_st02.txt:1", line: "[HEADER(key=\"title_test\", is_skippable=true, fit_mode=\"BLACK_MASK\")]", n: 1702 },
    { name: "常用（actId/npcId）", source: "obt/sandboxperm/sandbox_2/battleavg/dialog_xb2smy2_end.txt:1", line: "[header(actId=\"\", npcId=\"\")]", n: 191 },
    { name: "全参数（4 项）", source: "activities/act15side/level_act15side_entry.txt:1", line: "[HEADER(key=\"title_test\", is_skippable=true, fit_mode=\"BLACK_MASK\",is_video_only=true)]", n: 22 },
  ],
  musicvolume: [
    { name: "最短写法", source: "activities/act15d0/level_act15d0_01_end.txt:144", line: "[musicvolume(volume=0.4)]", n: 4 },
    { name: "常用（淡入/volume）", source: "activities/act12side/level_act12side_05_end.txt:28", line: "[musicvolume(volume=0,fadetime=0)]", n: 1828 },
    { name: "常用（channel/淡入）", source: "activities/act21side/level_act21side_04_end.txt:73", line: "[MusicVolume(channel=\"a\",volume=0.5, fadetime=2)]", n: 1 },
  ],
  charactercutin: [
    { name: "最短写法", source: "activities/act16side/level_act16side_02_beg.txt:52", line: "[CharacterCutin(widgetID=\"1\")]", n: 8 },
    { name: "常用（阻塞/淡入）", source: "activities/act16side/level_act16side_02_beg.txt:374", line: "[CharacterCutin(widgetID=\"1\",fadetime=0,block=true)]", n: 173 },
    { name: "常用（阻塞/widgetID）", source: "activities/act10mini/level_act10mini_st05.txt:517", line: "[CharacterCutin(widgetID=\"1\",block=true)]", n: 60 },
    { name: "全参数（7 项）", source: "obt/memory/story_hibisc_1_1.txt:368", line: "[CharacterCutin(widgetID=\"2\", style=\"cutin\", fadestyle= \"horiz_expand_center\", fadetime=0, offsetx=300, width=200, block=true)]", n: 1 },
  ],
  largebg: [
    { name: "无参数", source: "activities/act11d7/level_act11d7_st01.txt:12", line: "[largebg]", n: 59 },
    { name: "常用（imagegroup/solidheight）", source: "activities/act11d7/level_act11d7_st01.txt:6", line: "[largebg(imagegroup=\"bg_beach_1/bg_beach_2\", solidwidth=\"920/920\", solidheight=720,x=-180)]", n: 54 },
    { name: "全参数（7 项）", source: "activities/act42side/level_act42side_06_beg.txt:542", line: "[largebg(cggroup=\"61_i12/61_i11\", solidwidth=\"1600/1600\", solidheight=900,x=-160,xScale=0.8, yScale=0.8,fadetime=0)]", n: 1 },
  ],
  soundvolume: [
    { name: "最短写法", source: "obt/memory/story_platnm_1_1.txt:375", line: "[soundvolume(channel=\"bgs\",volume=0)]", n: 4 },
    { name: "常用（channel/淡入）", source: "activities/act23side/level_act23side_08_beg.txt:473", line: "[SoundVolume(volume=1,channel=\"a\",fadetime=3)]", n: 1573 },
  ],
  sticker: [
    { name: "最短写法", source: "activities/act11mini/level_act11mini_st06.txt:14", line: "[Sticker(id=\"st2\")]", n: 1433 },
    { name: "常用（阻塞/编号）", source: "obt/main/level_main_13-02_beg.txt:677", line: "[Sticker(id=\"st1\", multi = true, text=\"\\n……\",block = true)]", n: 1621 },
    { name: "常用（alignment/阻塞）", source: "activities/act19mini/level_act19mini_st01.txt:383", line: "[Sticker(id=\"st1\", multi = true, text=\"祝\", x=180,y=170, alignment=\"left\", size=24, delay=0.04, width=700,block = true)]", n: 358 },
    { name: "全参数（11 项）", source: "activities/act49side/level_act49side_02_end.txt:372", line: "[Sticker(id=\"st1\", multi = true, text=\"就\", x=300,y=330, alignment=\"center\", size=26, delay=0, width=700,block = false,duration=1)]", n: 6 },
  ],
  stickerclear: [
    { name: "无参数", source: "activities/act11mini/level_act11mini_st06.txt:20", line: "[stickerclear]", n: 28 },
  ],
  largebgtween: [
    { name: "最短写法", source: "activities/act49side/level_act49side_10_end.txt:486", line: "[largebgtween(duration = 3 ,yTo = 820,block = false)]", n: 3 },
    { name: "常用（阻塞/时长）", source: "activities/act33side/level_act33side_04_beg.txt:7", line: "[largebgtween(duration = 60,yFrom = 0, yTo = 100,block = false)]", n: 92 },
    { name: "常用（阻塞/时长）", source: "activities/act12side/level_act12side_01_beg.txt:484", line: "[largebgtween(xFrom=-180,xTo=-720,  duration=1, ease=\"1\", block=true)]", n: 16 },
    { name: "全参数（7 项）", source: "obt/main/level_main_15-15_end.txt:388", line: "[largebgtween(duration = 2,xScaleFrom=1.2, xScaleTo=1, yScaleFrom=1.2, yScaleTo=1, ease=\"InQuart\", block = false)]", n: 3 },
  ],
  backgroundtween: [
    { name: "最短写法", source: "obt/memory/story_blkkgt_1_1.txt:129", line: "[backgroundTween(yTo=40,duration=0.2)]", n: 2 },
    { name: "常用（阻塞/时长）", source: "obt/memory/story_jnight_1_1.txt:82", line: "[backgroundTween(xScaleFrom=1.2, yScaleFrom=1.2,xScaleTo=1, yScaleTo=1,duration=2,block=true)]", n: 73 },
    { name: "常用（阻塞/时长）", source: "obt/memory/story_jnight_1_1.txt:76", line: "[backgroundTween( xFrom=0, xTo=70, duration=1,block=true)]", n: 65 },
    { name: "全参数（10 项）", source: "activities/act17side/level_act17side_05_beg.txt:414", line: "[BackgroundTween(xFrom=0, yFrom=0, xTo=0, yTo=0, xScaleFrom=1.1, yScaleFrom=1.1, xScaleTo=1, yScaleTo=1, duration=4, block=true)]", n: 7 },
  ],
  charslot: [
    { name: "无参数", source: "activities/act14mini/level_act14mini_st01.txt:23", line: "[charslot]", n: 28453 },
    { name: "常用（focus/角色）", source: "activities/act16mini/level_act16mini_st01.txt:549", line: "[charslot(slot = \"m\", name = \"\", focus=\"m\")]", n: 93004 },
    { name: "常用（角色/slot）", source: "activities/act25side/level_act25side_06_end.txt:672", line: "[charslot(slot=\"m\",name=\"npc_10002\")]", n: 42363 },
    { name: "全参数（10 项）", source: "obt/main/level_main_12-02_end.txt:217", line: "[charslot(slot = \"r\", action=\"jump\",posfrom=\"0,0\",posto=\"60,0\",power=0,times=1,afrom=1,ato=1,duration=0.2,isblock=true)]", n: 6 },
  ],
  bgeffect: [
    { name: "无参数", source: "activities/act14mini/level_act14mini_st03.txt:40", line: "[bgeffect]", n: 693 },
    { name: "常用（layer/角色）", source: "activities/act15mini/level_act15mini_st02.txt:72", line: "[bgeffect(name=\"$eb_snow\",layer=0)]", n: 630 },
    { name: "全参数（7 项）", source: "activities/act40side/level_act40side_07_beg.txt:551", line: "[bgeffect(name=\"$eb_fireworks\",layer=1,x=80,xto=-20,yto=-70,y=-70,movetime = 25)]", n: 10 },
  ],
  curtain: [
    { name: "无参数", source: "activities/act14mini/level_act14mini_st05.txt:111", line: "[curtain]", n: 264 },
    { name: "常用（direction/淡入）", source: "obt/main/level_main_17-10_beg.txt:113", line: "[curtain(direction =1,fillfrom = 1,fillto = 1, fadetime=0)]", n: 635 },
    { name: "常用（direction/淡入）", source: "activities/act21mini/level_act21mini_st06.txt:1048", line: "[curtain(direction = 0,fillfrom =0.9,fillto =0,grad=true,fadetime=0.7)]", n: 334 },
    { name: "全参数（7 项）", source: "activities/act49side/level_act49side_01_end.txt:380", line: "[curtain(direction = 0,fillfrom = 0.01,fillto = 0.25,afrom=0.5,ato=0.5,fadetime=0,block=false)]", n: 6 },
  ],
  theater: [
    { name: "最短写法", source: "activities/act14side/level_act14side_01_beg.txt:24", line: "[theater(mode=true)]", n: 41 },
  ],
  video: [
    { name: "最短写法", source: "obt/main/level_main_08-16_end.txt:342", line: "[Video(res=\"video/01.mp4\")]", n: 28 },
  ],
  focusout: [
    { name: "最短写法", source: "activities/act33side/level_act33side_01_end.txt:610", line: "[focusout(type=\"bg\", from=1, to=0)]", n: 3 },
    { name: "常用（阻塞/时长）", source: "obt/memory/story_snhunt_1_1.txt:65", line: "[focusout(type=\"bg\",from=1,to=0,duration=1,block=true)]", n: 308 },
    { name: "常用（阻塞/时长）", source: "activities/act36side/level_act36side_01_end.txt:329", line: "[focusout(duration=5, type=\"cg\", id=\"54_i2\", from=1, to=0, block=false)]", n: 162 },
  ],
  interlude: [
    { name: "最短写法", source: "activities/act34side/level_act34side_07_beg.txt:405", line: "[interlude(clear=true)]", n: 8 },
    { name: "常用（channel/switch）", source: "activities/act46side/level_act46side_st04.txt:431", line: "[interlude(channel =5, switch = true)]", n: 327 },
    { name: "常用（channel/clear）", source: "activities/act51side/level_act51side_07_beg.txt:325", line: "[interlude(channel = 3,clear=true)]", n: 86 },
    { name: "全参数（8 项）", source: "activities/act37side/level_act37side_08_beg.txt:90", line: "[interlude(channel = 3, type = 3, slot = \"m\", switch = true, pfrom = \"235,0\", pto=\"235,0\", name = \"char_empty\", duration = 0)]", n: 25 },
  ],
  gridbg: [
    { name: "无参数", source: "activities/act18mini/level_act18mini_st03.txt:838", line: "[gridbg]", n: 112 },
    { name: "常用（淡入）", source: "activities/act31side/level_act31side_03_beg.txt:515", line: "[gridbg(fadetime=1)]", n: 3 },
  ],
  animtextclean: [
    { name: "无参数", source: "activities/act18mini/level_act18mini_st04.txt:173", line: "[animtextclean]", n: 250 },
  ],
  focusparam: [
    { name: "无参数", source: "activities/act19mini/level_act19mini_st04.txt:500", line: "[focusparam]", n: 6 },
    { name: "常用（blur/效果）", source: "activities/act47side/level_act47side_07_end.txt:508", line: "[focusparam(effect=\"Grayscale\", blur=true)]", n: 17 },
    { name: "常用（blur）", source: "activities/act49side/level_act49side_01_beg.txt:559", line: "[focusparam(blur=false)]", n: 2 },
  ],
  end: [
    { name: "无参数", source: "activities/act1dp/training/training_act1dp_tr01_beg.txt:75", line: "[end]", n: 534 },
  ],
  avgdisplay: [
    { name: "最短写法", source: "activities/act47side/level_act47side_08_end.txt:342", line: "[avgdisplay(id=\"1\")]", n: 56 },
    { name: "常用（编号/layer）", source: "activities/act21mini/level_act21mini_st04.txt:399", line: "[avgdisplay(id = \"1\", style = \"effect\", name = \"$e_blackmask\", slot = \"bgover\", layer = 1)]", n: 13 },
    { name: "全参数（9 项）", source: "activities/act20mini/level_act20mini_st01.txt:128", line: "[avgdisplay(id = \"1\", style = \"bg\", name = \"bg_black\",afrom=0,ato=0.3,duration=1,slot = \"bgover\", layer = 1,isblock=true)]", n: 9 },
  ],
  imagerotate: [
    { name: "最短写法", source: "activities/act25side/level_act25side_06_beg.txt:408", line: "[imagerotate(angle=0,fadetime=0.01)]", n: 1 },
    { name: "常用（angle/阻塞）", source: "activities/act39side/level_act39side_st01.txt:818", line: "[imagerotate(angle=0,fadetime=0,block = true)]", n: 10 },
    { name: "常用（angle/淡入）", source: "activities/act24side/level_act24side_03_beg.txt:268", line: "[imagerotate(angle=-5,fadetime=0,isblock=false)]", n: 4 },
    { name: "全参数（5 项）", source: "activities/act49side/level_act49side_06_end.txt:514", line: "[imagerotate(image=\"70_i11\",angle=0, fadetime=10, ease=\"OutCirc\", block=false)]", n: 1 },
  ],
  verticalbg: [
    { name: "无参数", source: "activities/act25side/level_act25side_10_end.txt:785", line: "[verticalbg]", n: 10 },
    { name: "常用（imagegroup/solidheight）", source: "obt/main/level_main_14-17_end.txt:686", line: "[verticalbg(imagegroup=\"50_g22_1/50_g22_2\", solidwidth=1280, solidheight=\"1512/1512\",y=1905)]", n: 12 },
    { name: "常用（imagegroup/solidheight）", source: "activities/act30side/level_act30side_07_beg.txt:241", line: "[verticalbg(imagegroup=\"45_i13R1/45_i13R2\", solidwidth=1600, solidheight=\"900/900\",x=-50,y=470)]", n: 3 },
    { name: "全参数（7 项）", source: "activities/act46side/level_act46side_02_beg.txt:120", line: "[verticalbg(cggroup=\"67_i15_1/67_i15_2\", solidwidth=\"1600\", solidheight=\"900/900\",y=200,xScale=0.8, yScale=0.8,fadetime=0)]", n: 2 },
  ],
  timerclear: [
    { name: "最短写法", source: "activities/act27side/level_act27side_07_end.txt:129", line: "[timerclear(afrom=1,ato=0,duration=2)]", n: 9 },
  ],
  cgitem: [
    { name: "最短写法", source: "activities/act53side/level_act53side_06_beg.txt:95", line: "[cgitem(image=\"cgitem_76_i16_3\")]", n: 1 },
    { name: "常用（aduration/afrom）", source: "activities/act36side/level_act36side_01_end.txt:334", line: "[cgitem(image=\"cgitem_54_i2\", style=\"cg\",afrom=0,ato=1,aduration=1.5,layer = 1)]", n: 13 },
    { name: "常用（阻塞/图片）", source: "activities/act47side/level_act47side_st01.txt:203", line: "[cgitem(image=\"cgitem_68_i01_4\", style=\"cg\",pfrom = \"0,0\",pto = \"0,-500\",pduration =0.5,layer =1,block=true)]", n: 13 },
    { name: "全参数（9 项）", source: "activities/act47side/level_act47side_08_end.txt:651", line: "[cgitem(image=\"cgitem_68_i13\", style=\"cg\",layer = 2, sfrom=1, sto=1.2,sduration=0,rfrom=-5, rto=-5,rduration=0)]", n: 4 },
  ],
  hidecgitem: [
    { name: "无参数", source: "activities/act28side/level_act28side_08_end.txt:514", line: "[hidecgitem]", n: 79 },
    { name: "常用（图片）", source: "activities/act36side/level_act36side_01_end.txt:340", line: "[hidecgitem(image=\"cgitem_54_i2\")]", n: 65 },
    { name: "全参数（2 项）", source: "activities/act36side/level_act36side_03_end.txt:526", line: "[hidecgitem(image=\"cgitem_54_i4\",fadetime=1)]", n: 14 },
  ],
  narration: [
    { name: "无参数", source: "activities/act29side/chat_1.txt:10", line: "[Narration]", n: 124 },
  ],
  skipnode: [
    { name: "最短写法", source: "activities/act45side/level_act45side_08_end.txt:19", line: "[skipnode(mode=\"skip\")]", n: 12 },
  ],
  multiline: [
    { name: "无参数", source: "activities/act49side/level_act49side_01_end.txt:920", line: "[multiline]", n: 3 },
  ],
  skiptothis: [
    { name: "无参数", source: "activities/act50side/training/training_act50side_01_b.txt:33", line: "[SkipToThis]", n: 5 },
  ],
  spellstickerclear: [
    { name: "最短写法", source: "obt/main/level_main_17-04_beg.txt:799", line: "[spellstickerclear(block=false)]", n: 10 },
  ],
};

/** 语料里最常见的素材 key（离线可用；给了 `resolveUrl` 时优先用调用方的）。 */
export const COMMON_ASSETS = {
  backgrounds: [
    "bg_black", "bg_corridor", "bg_room_2", "bg_desert_1", "bg_ltroom", "bg_forest", "bg_coldforest", "bg_bar_1",
    "bg_snowconutryinside", "bg_canteen", "bg_offce", "bg_warehouse", "bg_light", "bg_bridge", "bg_trainingcom", "bg_county_1",
    "bg_23_G05", "bg_wild_a", "bg_infirmary", "bg_laccolith", "bg_indoor_u", "bg_lmstreet_1", "bg_towerinside", "bg_barracks",
    "21_G7_decisivebattlealley_d", "bg_hotel", "bg_snow_2", "bg_cave_2", "bg_wild_m", "bg_23_G07", "bg_23_G01", "bg_battlefield",
    "bg_outcounty", "bg_rhodescom", "bg_kxstreet", "27_g26_dusk_wild", "bg_rhodesroom", "bg_manorindoor", "25_g11_yanroom", "25_mini02_victoria_street_n",
    "27_g7_subway", "bg_sportsbar", "33_g11_mansionhall", "bg_caveentrance", "bg_20_G02", "bg_cherunder_2", "bg_23_G10", "24_g5_guestroom",
    "bg_desert_3", "bg_lmstreet_2", "24_g12_mountpath", "26_g11_laterano_alley", "bg_ibindoor", "29_g7_mainstreet_n", "25_g04_yaninn", "bg_23_G08",
    "29_g4_corridor", "24_g8_nobleroom", "25_g06_mountainroad_d", "bg_lungmen_b", "33_g7_reception", "bg_ri_1", "bg_courtyard", "bg_indoor",
    "bg_wilderness_n", "26_g10_laterano_roof", "bg_jungle_1", "56_g2_newvolsiniistreet_n", "bg_arena_1", "bg_23_G03", "bg_white", "bg_village_2",
    "35_g11_yumendesert", "29_g9_headquarter", "29_g3_cottage", "33_g2_srcalley", "bg_23_G09", "31_g3_mini12_farmland", "bg_iceforest_1", "bg_landscape",
    "27_g16_lighthouse_street", "bg_ibbar", "bg_indoor4", "26_g9_laterano_street", "33_g4_srctheater", "21_G3_victoria_street_d", "bg_indoor_2", "bg_undergroud_u_2",
    "bg_windows", "bg_lungmen_o", "40_g1_blackforest", "bg_iceforest_2", "bg_wilderness_m", "61_g2_baptismlobby", "24_g1_snowyforest", "33_g5_srcpark",
    "42_g3_diner", "58_g1_yusrestaurant", "bg_ltstrongpoint", "bg_jungleentrance", "40_g2_glacier", "46_g6_rmbtmine", "bg_corridor_2", "49_g2_kazdelstreet_d",
    "34_g10_tent_inside", "72_g1_sjbstreet_d", "bg_ltalley", "bg_undergroundF", "52_mini01_katzdalesquare_d", "33_g8_srcroom", "38_g5_rhinelab_indoor", "35_g13_yanlivingroom",
    "25_g08_pavilion", "26_g8_laterano_dwelling", "33_g10_smallrestaurant", "44_g5_spiralstairs", "21_G9_rhodes_xqoffice", "27_g9_lightinduarea_street_d", "bg_arena_2", "35_mini01_villagevacancy",
    "46_g4_rmbtwild_d", "27_g24_cloudy_sea", "29_g2_edgeofbase", "44_g6_towerterrace", "28_g2_slumstreets", "29_g8_alley_n", "41_g1_siestacommercialstreet_d", "66_g12_deitygrypherburgmeeting",
    "bg_ltstreet1", "bg_village", "bg_nearllivingroom", "24_g3_mainhall", "24_g11_snowylane", "24_g10_manorhouse", "26_g12_laterano_office", "37_g9_airshipdockcorridor",
    "27_g17_lighthouse_alley", "29_g6_mainstreet", "bg_deluxeroom", "32_g3_school_indoor",
  ],
  characters: [
    "char_002_amiya_1", "char_003_kalts_1", "right", "left", "middle", "char_empty", "avg_4046_ebnhlz_1", "avg_npc_394_1",
    "avg_003_kalts_1", "avg_172_svrash_1", "avg_npc_012", "avg_1032_excu2_1", "avg_1037_amiya3_1", "avg_npc_061", "avg_322_lmlee_1", "avg_248_mgllan_1",
    "avg_npc_242", "avg_npc_053", "char_010_chen_1", "avg_1034_jesca2_1", "avg_4146_nymph_1", "char_187_ccheal_1", "avg_4065_judge_1", "avg_npc_1296_1",
    "avg_4121_zuole_1", "avg_npc_122", "avg_474_gladiia_1", "char_278_orchid_1", "avg_npc_229_1", "avg_194_leto_1", "avgnew_112_siege_1", "avg_npc_404_1",
    "avg_300_phenxi_1", "avg_1012_skadiSP_1", "char_101_sora_1", "char_2005_weiyw_1", "avg_npc_407_1", "char_195_glassb_2", "avg_1024_hbisc2_1", "avg_427_vigil_1",
    "char_007_closre_1", "char_017_homura_3", "avg_108_silent_1", "avg_4042_lumen_1", "char_102_texas_1", "avg_npc_123", "avg_npc_007", "avg_4114_harold_1",
    "avg_npc_262_1", "avg_174_slbell_1", "avg_npc_867_1", "char_263_skadi", "avg_135_halo_1", "avg_1028_texas2_1", "avg_4098_vvana_1", "avg_222_bpipe_1",
    "avg_npc_1966_1", "avg_245_cello_1", "avg_1040_blaze2_1", "char_016_medic", "avg_486_espumo_1", "avg_npc_006", "avg_npc_295_1", "avg_npc_297_1",
    "avg_1035_wisdel_1", "avg_npc_253_1", "avg_377_gdglow_1", "avg_198_blackd_1", "char_103_angel_1", "avg_npc_223", "avg_npc_405_1", "avg_4235_thumpy_1",
    "avg_4009_irene_1", "avg_213_mostma_1", "avg_npc_005", "avg_npc_177", "avg_npc_033", "avg_1020_reed2_1", "avg_479_sleach_1", "avg_npc_787_1",
    "avg_4116_blkkgt_1", "avg_4055_bgsnow_1", "avg_npc_254_1", "avg_4087_ines_1", "char_1011_purgatory_1", "avg_1023_ghost2_1", "avg_4123_ela_1", "avgnew_2014_nian_1",
    "avg_npc_008", "avg_2012_typhon_1", "avg_npc_176", "char_325_bison_1", "avgnew_455_nothing_1", "avg_npc_296_1", "avg_4058_pepe_1", "avg_492_quercu_1",
    "avg_2024_chyue_1", "avg_4142_laios_1", "avg_1502_crosly_1", "char_196_sunbr_1", "avg_npc_1034_1", "avg_npc_031", "avg_4047_pianst_1", "avg_npc_088",
    "char_282_catap_1", "avg_1026_gvial2_1", "avg_lolxh_4067_1", "avg_npc_222", "avg_4141_marcil_1", "char_1002_nsabr_2", "avg_4036_forcer_1", "char_358_lisa_1",
    "avg_155_tiger_1", "char_197_poca_1", "avg_249_mlyss_1", "char_015_lmg", "char_130_doberm_ex", "avg_npc_2321_1", "avg_502_Yato_1", "avg_4106_bryota_1",
    "avg_180_amgoat_1", "avg_npc_450_1", "avg_npc_535_1", "avg_npc_396_1", "avg_4138_narant_1", "avgnew_173_slchan_1", "avg_npc_1183_1", "char_136_hsguma",
    "avg_4040_rockr_1", "avg_4236_tmslot_1", "avg_npc_298_1", "avg_npc_250_1", "avg_341_sntlla_1", "avg_171_bldsk_1", "avg_npc_034", "avg_1051_headb2_1",
    "char_308_swire_1", "char_500_noirc_1", "avg_1015_aglna2_1", "avg_4182_oblvns_1", "char_345_folnic_1", "avg_npc_419_1", "avg_4072_ironmn_1", "avg_npc_2100_1",
    "char_003_kaltsn07_1", "avg_4228_closur_1", "avg_npc_054", "avg_4110_delphn_1", "avg_npc_896_1", "avg_npc_081", "avg_4081_warmy_1", "avg_npc_411_1",
    "avg_106_franka_1", "avg_npc_001", "char_249_muesys_1", "avg_4163_rosesa_1", "char_011_talula_1", "avg_1050_chen3_1", "avg_4119_wanqin_1", "avg_npc_1581_1",
    "char_108_silent_1", "avg_npc_484_1", "avg_npc_523_1", "avg_npc_447_1", "avg_npc_412_1", "char_416_zumama_1", "avg_206_gnosis_1", "char_456_ash_1",
    "avg_npc_002", "avg_npc_372_1", "avg_4147_mitm_1", "avg_4054_malist_1", "char_145_prove_1", "avg_282_catap_1", "avg_npc_052", "char_304_hvrain",
    "avg_4088_hodrer_1", "avg_4172_xingzh_1", "avg_1047_halo2_1", "avg_npc_120", "avg_4117_ray_1", "avg_4104_coldst_1", "avg_npc_240", "char_136_hsguma_ns_1",
    "avg_4048_doroth_1", "char_204_platnm_1", "avg_2023_ling_1", "char_411_tomimi_1", "avg_npc_140", "avg_4080_lin_1", "avg_1031_slent2_1", "avg_npc_402_1",
    "avg_4237_jcinta_1", "avg_npc_211_1", "avg_473_mberry_1", "avg_1019_siege2_1", "avg_4211_snhunt_1", "avg_npc_1542_1", "avg_npc_2379_1", "avg_npc_209_1",
  ],
  music: [
    "$darkness01_intro", "$darkness01_loop", "$path_intro", "$path_loop", "$nervous_intro", "$nervous_loop", "$m_dia_street_intro", "$m_dia_street_loop",
    "$warm_intro", "$warm_loop", "$mist_loop", "$drift_intro", "$drift_loop", "$mist_intro", "$loneliness_intro", "$loneliness_loop",
    "$normal_loop", "$farce_loop", "$farce_intro", "$calm_loop", "$ponder_intro", "$ponder_loop", "$suspenseful_intro", "$suspenseful_loop",
    "$distressed_intro", "$distressed_loop", "$darkness02_loop", "$darkness_03_loop", "$darkness02_intro", "$newhope01_loop", "$newhope01_intro", "$plot_intro",
    "$plot_loop", "$escape_intro", "$escape_loop", "$dignified_intro", "$dignified_loop", "$saferoom_loop", "$wasteland_loop", "$tense_intro",
    "$tense_loop", "$loading_intro", "$loading_loop", "$exciting_intro", "$exciting_loop", "$frontline_intro", "$frontline_loop", "$formal_loop",
    "$bar_intro", "$bar_loop", "$storyendjp_intro", "$storyendjp_loop", "$chasing_loop", "$sjoyasorrow_intro", "$sjoyasorrow_loop", "$monastery_sad_loop",
    "$comedy_loop", "$chasing_intro", "$tech_intro", "$tech_loop", "$warchaos_intro", "$warchaos_loop", "$darkalley_intro", "$darkalley_loop",
    "$batmeeting_intro", "$batmeeting_loop", "$calamity_intro", "$calamity_loop", "$empty", "$relax_intro", "$relax_loop", "$holiday_intro",
    "$holiday_loop", "$jealous_loop", "$normal02_intro", "$normal02_loop", "$jealous_intro", "$ghosthunter_intro", "$ghosthunter_loop", "$nightoflongmen_intro",
    "$nightoflongmen_loop", "$lab_intro", "$lab_loop", "$midautumn", "$newhope02_intro", "$newhope02_loop", "$marketplace_intro", "$marketplace_loop",
    "$dontmaketrouble_intro", "$dontmaketrouble_loop", "$indust_loop", "$corrosion_intro", "$corrosion_loop", "$indust_intro", "$m_bat_game02_intro", "$m_bat_game02_loop",
    "$rebel_intro", "$rebel_loop", "$victorianormal_loop", "$penguinlogistics_intro", "$penguinlogistics_loop", "$stranger_intro", "$stranger_loop", "$memory_loop",
    "$kjerag_n_intro", "$kjerag_n_loop", "$fesmetal_intro", "$fesmetal_loop", "$m_avg_ursusdaily_loop", "$longmenbat_intro", "$longmenbat_loop", "$cherimp_intro",
    "$cherimp_loop", "$chenandwei_intro", "$chenandwei_loop", "$ouat_loop", "$longmenoffice_intro", "$longmenoffice_loop", "$sacrifice_intro", "$sacrifice_loop",
    "$industv2_intro", "$industv2_loop", "$m_bat_imprisonment_intro", "$m_bat_imprisonment_loop", "$faceoff_loop", "$epic_intro", "$epic_loop", "$escapebattle_intro",
    "$escapebattle_loop", "$emperor_intro", "$emperor_loop", "$m_bat_essenceofevolution_intro", "$m_bat_essenceofevolution_loop", "$desolate_loop", "$m_sys_bitw_loop", "$ekg_loop",
    "$chill_loop", "$m_sys_act14mini_loop", "$bat_Imfxingback_intro", "$bat_Imfxingback_loop",
  ],
  sounds: [
    "$d_gen_walk_n", "$rungeneral", "$d_avg_clothmovement", "$e_skill_skulsrsword", "$d_gen_transmissionget", "$fightgeneral", "$dooropenquite", "$transmission",
    "$d_sp_ballista", "$bodyfalldown1", "$d_gen_explo_n", "$d_gen_soldiersrun", "$bodyfalldown2", "$doorknockquite", "$d_avg_paper1", "$d_avg_runstop",
    "$d_avg_snowbootwalk", "$d_avg_clothmovementsp", "$d_avg_crwddiscuss_outside", "$e_atk_arrow_h", "$d_avg_cloakmovement", "$flashback", "$d_avg_paper2", "$d_avg_walkfast",
    "$livecrowd", "$d_avg_rockfall", "$d_avg_snowstormflp", "$d_avg_penrustle", "$swordtsing1", "$doorclosequite", "$smallearthquake", "$sheildimpact",
    "$swordtsing4", "$d_avg_erthshkng", "$bodyfalldown3", "$d_gen_thunders_amb", "$b_char_defboost", "$d_avg_punch", "$d_avg_devicebeep", "$d_avg_punch02",
    "$d_avg_arrowshot", "$d_avg_footstep_stonestep", "$d_avg_walk_stage", "$d_avg_explosion_stone", "$bottlebroken", "$d_avg_crowdrun", "$drift", "$swordtsing2",
    "$d_avg_explosion", "$runsand", "$swordtsing3", "$phonevibration", "$d_avg_openftstpwalk", "$swordtsing5", "$d_avg_wind", "$d_avg_bldwhoosh",
    "$d_avg_singleblunt", "$d_avg_humanchange", "$d_avg_crwddiscuss_inside", "$firestorm",
  ],
};
/* @end:data */
