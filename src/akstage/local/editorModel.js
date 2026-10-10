// 编辑器内核（editor model）：Controller / Rule / ValueMeta / Diagnostic / ParseData。
//
// 纯 ESM、零依赖；应用（frontend/src/pages/StoryEditorPage.tsx）与离线脚本
// （scripts/fanfic/editor-selftest.mjs）共用这一份实现。Token 化**不重写**：
// 行解析全部走 ./storyPack.js 的 parseLine / parseScript / splitTopLevel / lintScript，
// 本文件只在其上加「控制器规格 → 参数诊断 → 补全 → 格式化 → 悬停」四层。
//
// ─────────────────────────────────────────────────────────────────────────────
// 一、借自 YayinStoryStudio AStorySyntax 的**概念**（不是代码）
// ─────────────────────────────────────────────────────────────────────────────
//
// | YSS（YayinStoryStudio / ASERStudio）      | 本文件                                  |
// |-------------------------------------------|-----------------------------------------|
// | `AStoryXController`（header/必需参数/可选  | `ControllerSpec` + `CONTROLLERS`：       |
// |  参数前缀/类型/范围/枚举、isMonotonicity） |  command/canonical/category/tier/        |
// |                                           |  required[]/optional[]/example            |
// | `AStoryXControllerType`（Background…Branch）| `CATEGORIES`（14 个 YSS 风格分类）       |
// | `AStoryXRule`（一个规则 = 一组控制器 + 元数据）| `CONTROLLERS` 一张表（本 DSL 只有一套规则）|
// | `AStoryXValueMeta`（type/default/min/max/enums）| `ValueMeta`（type/default/min/max/enums）|
// | `AStoryXDiagnosticData`（type + line + column）| `Diagnostic`（code/name/severity/line/**from/to**）|
// | `AStoryXControllerParseData`（必需参数 + 可选 | `ParseResult`：required[]/optional[]/params[] |
// |  参数 + getCursorInWhichParameter + diagnostics）|  + text/diagnostics                     |
// | `AStoryXRule::getAvailableRuleNames` / rule JSON | `CONTROLLER_INDEX`（command → spec）  |
// | YSS `#useRule:BaseRule` 预处理器           | 我们的首行 `[header(key=…)]`             |
//
// YSS-Controller → 本 DSL 指令 的映射表（21 个 YSS 控制器，见
// `AStoryXController.h` 的 ControllerType 与 `Rules/BaseRule.json`）：
//
// | YSS Controller  | YSS header / 参数风格                    | 我们的 DSL                                  |
// |-----------------|------------------------------------------|---------------------------------------------|
// | Background      | `背景：img/FadeInTime/…`（`/` 分前缀）   | `[Background(image=…,fadetime=…,screenadapt=…)]` |
// | Music           | `音乐：key:Vol/Fade`                     | `[PlayMusic(key=…)]` / `[StopMusic]` / `[MusicVolume]` |
// | SoundEffect     | `音效：key:Vol/Steps`                    | `[PlaySound(key=…)]` / `[StopSound]` / `[SoundVolume]` |
// | Mask            | `遮罩：true`                              | `[Blocker(a=…,r=…,r/g/b…)]`（黑场）           |
// | ColorMask       | `色层：r,g,b,a/FadeIn`                    | `[Blocker(a=…)]` + `[curtain(…)]`            |
// | Shake           | `抖动：intensity/FadeIn`                  | `[CameraShake(duration=…,xstrength=…)]`      |
// | Character       | `--char:variant/SlotIndex/…`             | `[Character(name="char_002_amiya_1#1",fadetime=…)]` / `[charslot(slot="m",name=…)]` |
// | Interlude       | `插播：char:variant/Type/IsOn`           | `[interlude(type=…,channel=…,slot=…)]` / `[CharacterCutin(widgetID=…)]` |
// | Choice          | `选项：内容\`变量`                        | `[Decision(options="a;b",values="1;2")]`     |
// | Judge           | `判断：Name/Expressions`                  | `[Predicate(references="1;2")]`（闸门）       |
// | Branch          | `分支：Name/Branches`                     | `[Predicate]` + `[skipnode(mode=…)]`/`[SkipToThis]` |
// | Delay           | `+1.5`（行首内联）                        | `[Delay(time=1.5)]`                          |
// | VisualEffect    | `特效：name:Pos/RenderOrder`              | `[CameraEffect(effect="Grayscale")]` / `[focusout]` / `[bgeffect]` |
// | Filter          | `滤镜：Type&Intensity`                    | `[CameraEffect(effect="Grayscale",amount=…)]` |
// | Cut             | `裁切：Intensity/Angle`                   | `[curtain(direction=0..7)]`（转场）           |
// | AnimatedText    | `动态文本：内容:Type`                     | `[animtext(id=…,name=…,style=…)]`            |
// | FreeText        | `自由文本：内容/Alignment`                | `[Subtitle(text=…,x=…,y=…)]` / `[Sticker(id=…,text=…)]` |
// | Sign            | `标记：Name`                              | `[Predicate]` 用作锚点（无直接对应）           |
// | Narration       | `*正文`                                   | 裸行（无 `[]`）或 `[Narration]`              |
// | Dialog          | `说话人<Tab>正文`（无 header）            | `[name="说话人"]  正文` / `[Dialog]` / `[multiline]` |
// | Preprocessor    | `#useRule:BaseRule`                       | `[header(key="…")]` + `// 注释`              |
//
// 三条结构性差异（YSS 方言 ≠ 我们的 datas_txt）：
//   1) **行首形态**：YSS 用中文 header（`背景：`、`音效：`）+ 前缀分隔参数（`/`）；
//      我们用 `[Controller(key=value, …)]`，所有参数都是显式 `key=value`，
//      没有「必需参数靠位置、可选参数靠前缀」的单调性概念（→ 本文件里 required/
//      optional 只影响诊断与补全顺序，不影响解析）。
//   2) **立绘/停顿的内联写法**：YSS 写 `--char:variant/slot` 与行首 `+1.5`；
//      我们写 `[Character(name="char_002_amiya_1#1",fadetime=0.5)]`（按角色）或
//      `[charslot(slot="m",name="avg_npc_243",duration=1)]`（按槽位），
//      停顿写 `[Delay(time=1.5)]`——**只有 `time` 生效**，`duration`/`TIME` 都会
//      被引擎当成 0（commands.md §3；`runtime.ts` 的 `exactArg(args,"time")`）。
//   3) **对话与分支**：YSS 的 Dialog 控制器没有 header（`说话人<Tab>正文`），
//      分支是 `判断/分支` 两个控制器；我们对话写作 `[name="X"]  正文`（整行严格
//      匹配 `^name\s*=\s*"…"$`），分支是 `[Decision]`（写值）+ `[Predicate]`
//      （逐行闸门），**Decision 不是跳转**，必须有覆盖全部 values 的合流 Predicate
//      （`missingMerge()` / `lintDocument()` 用 `storyPack.lintScript` 的语义查）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 二、导出契约（task-6 固定；UI task-7 按名接入）
// ─────────────────────────────────────────────────────────────────────────────
//
//   CONTROLLERS       ControllerSpec[]，命令 → 规格（参数 / 分类 / 分级 / 示例 / 文档锚点）
//   CATEGORIES        string[]，YSS 风格分类（有序；用于「控制器」面板分组）
//   CATEGORY_LABELS   Record<category, 中文标题>
//   DIAGNOSTIC_CODES Record<name, code>（YSS 编号：0x1000 段 error / 0x2000 段 warning）
//   DIAGNOSTIC_TABLE {code, hex, name, severity, zh, yss}[]（code → 含义 + YSS 对应）
//   DIAGNOSTIC_SEVERITY / DIAGNOSTIC_NAMES
//   ENUMS             Record<key, string[]>，语料实测枚举值（补全用）
//   CONTROLLER_INDEX  Record<command, ControllerSpec>
//   parseLine(line, lineNumber) → ParseResult
//   lintDocument(text)  → DocumentLint {lines, diagnostics, stats, toc, merge}
//   missingMerge(input) → Diagnostic[]（Decision/Predicate 合流检查，语义同 lintScript）
//   completions(prefix, context) → Completion[]；`context` 见下方「补全的替换语义」
//   formatLine(controller, values) → string（palette「插入」/ 未来 formatter）
//   HOOVER (= HOVER)  Record<command, HoverEntry>；hoverFor(text, offset) → HoverInfo|null
//   辅助：diagnostic / parseControllerSpec / lineDiagnosticsOf / diagnosticsByLine /
//         documentOf / blocksOf / CATEGORY_LABELS
//
// 补全的替换语义（UI 按 `[from, cursor)` 整段替换 `insertText` 即可）：
//   - kind "controller"：`[Cha` → insertText `Character(name="")]`（含 `]`）；
//     `insertTextFull` 是带 `[` 的整行骨架（palette 用）。
//   - kind "argument"：`fade` → `fadetime=0.15`（含 `=` 与缺省值）。
//   - kind "value"：`"cov` / `cov` → `"coverall"`（带引号；整段替换 prefix）。
//   `context` 接受 `{text|line, cursor, prefix, assets}`；`assets` 给
//   `{images,backgrounds,characters,music,sounds}` 可补资源 key。
//
// 偏移约定（给波浪线用）：`from`/`to` 是**该行内**的 0 基字符下标，`to` 为开区间；
//   `from === to` 时取 `to = from + 1`（保证可见）；行级诊断 span 覆盖控制器名，
//   文档级诊断（line = 0 或整行）span 覆盖整行（`from = 0, to = raw.length`）。
//   `line` 为 1 基（与 storyPack 一致）；`on line 0` 表示整篇（预算类警告）。
//
// 诊断码（本 DSL 的用法；`DIAGNOSTIC_TABLE` 里带 YSS 原名）：
//   0x1000 UnknownError                 兜底内部错误
//   0x1001 MissingController             `[ ]` 里没有控制器名（YSS: RuleNotSelected）
//   0x1002 NoSuchController             未知指令（引擎 warn + 跳过）
//   0x1003 UnknownParameter             未声明参数键（引擎静默忽略；YSS: UnexpectedParameter）
//   0x1004 MissingRequiredParameter      缺必需参数（`argless: clear/hide` 的指令降为 warning）
//   0x1005 ParameterTypeMismatch        类型不符（数字/布尔）
//   0x1006 ParameterOutOfRange          数值越界 / 枚举值不在观察集（warning：引擎回落默认）
//   0x1009 UnclosedSymbol               `]`/`"`/`(` 未闭合、`]` 后有残余 `(`、正文混入 `]`
//   0x100B UseTabInsteadSpace            `[...]` 内用了 Tab（惯例是空格；YSS 反义同号）
//   0x100C UseSpaceInsteadTab            `]` 后的分隔/行首缩进用了 Tab 或单个空格
//   0x1011 InstrumentRedundant          同一行重复参数 / 第二处 `[header]`（YSS: InstrumentRedundant）
//   0x1014 MissingMergePredicate         Decision 后没有覆盖全部 values 的合流 Predicate
//   0x1015 DecisionOptionsValuesMismatch values 数量与 options 数量不一致
//   0x1016 DecisionOptionsMissing        Decision 缺 options（runtime warn, 不弹面板）
//   0x1017 OrphanPredicate              Predicate 前没有（未合流的）Decision
//   0x1018 UnknownDecisionValue          Predicate 引用了 Decision 里不存在的值
//   0x2000 UnknownWarning                兜底警告（YSS: UnknownWarning）
//   0x2001 NoSuchResource               资源不存在（保留：需要项目资源表才能查）
//   0x2002 NotReadByEngine              指令未在运行时注册（`[End]`）或参数当前版本不读
//   0x2003 TierCInstruction             C 级指令 / 带命名空间的游戏内指令（网页端多数忽略）
//   0x2004 SpellingDrift                命令名拼写漂移（引擎按字面分发 → 未知指令）
//   0x2005 NarrationLine                裸文本行（只作旁白）
//   0x2006 EmptyDialogue                空对白（隐藏对话框；可当分节拍）
//   0x2007 TrailingWhitespace          行尾空白
//   0x2008 DecisionBudget               决策数超预算（LOG ALL 状态爆炸）
//   0x2009 ComboBudget                  分支组合数超上限（引擎退化为全量文本）
//   0x200A MissingEnding                没有收尾（`[endtip]` / `[Blocker(a=1,…)]`）
//   0x200B RedundantPredicate           单选项 Decision 的合流 Predicate（冗余但可用）
//
// 已知偏差（`storyPack` token 化 vs 上游 `parser.ts:parseLine` —— 全语料 1,074,628
// 条 `[` 行实测 1,822 条，全部有因、都可播；`editor-selftest.mjs --parity-full`
// 逐行对拍，未知偏差 = 0。作者可读版见 `.akskills/arkstage-fanfic/reference/
// animation.md` §9）：
//   1) `[name="X"]` 的说话人（**已修**）：storyPack 曾把捕获组再 `slice(1,-1)`；
//      现 `unescapeBody()` 与内核 `dialogueSpeaker()` 逐字节一致（4,000 行对拍 0 差）。
//   2) 多写一个 `]`（31 行）：`[Character]]` / `[character(…)] ]` / `[delay(time=2)]]`
//      → 内核 1009（`Character` 归 1009 + `entity`；带参数的再叠 1005 因为值里
//      混进 `)]`）；`[Delay=(time=1.5)]`、`[Dialog ]` 归第 6 类。
//      （`[Delay(time=1)]x]y` 这类正文里混 `]` 是**另一**回事：上游同样按最后
//      一个 `]` 截断，storyPack 会把 `]x` 吃进前一个参数值；内核给 1009。）
//   3) 带命名空间的**游戏内**指令（1,663 行）：`[Battle.Pause]`、
//      `[Activity.ResetToEntry]`、`[SandboxV2.EnsureDungeonStable]`… 上游
//      `commandRegex` 的 `[.|\w]*` 认点号、按字面 dispatcher；网页端
//      StoryPlayer 没有这个 case → 静默忽略该行。内核给 warning（0x2003），
//      不再报"未知指令"error（0x1002），并在 `ParseResult.entity` 保留原名。
//   4) `]` 后紧跟 `(` 的 16 行对话：`[name="芳汀"](成了。)`。上游 commandRegex
//      的**贪婪** `(.*)` 把它读成 `name` 的"参数表"（仍是 dialogue），storyPack
//      按"`)` 后有残留"报 narration；内核给 1009。
//   5) 同一个键写两次（113 行）：上游 `parseArgs` 是对象（后写覆盖前写），
//      storyPack 保留全部、内核报 1011（`InstrumentRedundant`）。
//   6) `)`/`]` 之间的空格与 `[Cmd=(…)]`（3 行）：值里会多带 `)` / 键变成 `Cmd=`。
//
// 例：
//   import { parseLine, lintDocument, completions, formatLine, hoverFor } from "./editorModel.js";
//   parseLine('[Delay(tiem=1)]', 3).diagnostics[0].code   // 0x1003（并提示 time）
//   formatLine("delay", { time: 0.3 })                    // '[Delay(time=0.3)]'

import {
  SPELLING_FIX,
  TIER_A,
  TIER_B,
  TIER_C,
  lintScript,
  parseLine as parseDslLine,
  parseScript,
  splitTopLevel,
} from "./storyPack.js";

/** 指令参考（人读文档）。 */
const DOC_COMMANDS =
  "https://github.com/djkcyl/arkstage/blob/master/.akskills/arkstage-fanfic/reference/commands.md";
/** 动画与演出契约（fadetime/duration/isblock 的逐命令清单）。 */
const DOC_ANIMATION =
  "https://github.com/djkcyl/arkstage/blob/master/.akskills/arkstage-fanfic/reference/animation.md";
/** 分支契约（Decision/Predicate）。 */
const DOC_BRANCHING =
  "https://github.com/djkcyl/arkstage/blob/master/.akskills/arkstage-fanfic/reference/branching.md";
/** 上游运行时（参数键的唯一权威）。 */
const ENGINE_RUNTIME = ".akresearch/repo/src/widgets/StoryPlayer/engine/runtime.ts";
/** 上游解析器（`[header]` 的元数据读取）。 */
const ENGINE_PARSER = ".akresearch/repo/src/widgets/StoryPlayer/engine/parser.ts";
/** 本 DSL 的规则世代（PRTS StoryPlayer，2026-10 抓取；即 runtime 里引用的 2.7.71 / build 2761）。 */
const SINCE = "prts-2.7.71";

// ── 类型 ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {"string"|"text"|"number"|"int"|"bool"|"enum"|"semilist"|"vector"} ValueType
 */

/**
 * @typedef {object} ValueMeta
 * @property {string} name      规范键名（大小写敏感，引擎按字面查）
 * @property {ValueType} type
 * @property {string} hint      一句话说明（悬停/补全 detail）
 * @property {string|number|boolean} [default] 引擎缺省值（补全骨架用）
 * @property {number} [min]
 * @property {number} [max]
 * @property {string} [enums]   ENUMS 的键
 * @property {string[]} [aliases] 语料里见过的同义键（本表只登记、不查）
 * @property {string} [alt]     满足该必需参数的另一个键（`res`/`url`）
 * @property {boolean} [integerish] 小数按引擎的 Convert.ToInt32 取整 → 不算类型错
 * @property {boolean} [strictRange] 显式声明"这个 min/max 是硬约束"（默认软校验）
 * @property {boolean} [strictEnum]  显式声明"这个枚举值是硬约束"（默认软校验）
 * @property {boolean} [corpusOnly] 官方语料有、**运行时当前版本不读**（→ 0x2002）
 */

/**
 * @typedef {object} ControllerSpec
 * @property {string} command            小写命令名（分发用）
 * @property {string} canonical          语料主流写法（formatLine 用）
 * @property {string} category           CATEGORIES 成员
 * @property {"A"|"B"|"C"} tier          storyPack 的分级
 * @property {string} summary            一句话说明（悬停标题下）
 * @property {string} example            逐字示例（corpus 行 / parser 产物 / 文档示例）
 * @property {"corpus"|"parser"|"docs"} exampleSource
 * @property {string} since              规则世代（见 SINCE）
 * @property {string} anchor             文档锚点（commands.md / animation.md）
 * @property {string} engineRef          运行时出处（case 名 / 行号）
 * @property {ValueMeta[]} required
 * @property {ValueMeta[]} optional
 * @property {"clear"|"hide"|"none"} [argless] 无参时的语义（决定缺参诊断的严重度）
 * @property {boolean} [runtimeRegistered] 默认 true；false = 运行时未注册（0x2002）
 * @property {string} [special]         "dialog"（`[name=…]` 形态）等
 * @property {string} [note]            额外注意事项
 */

/**
 * @typedef {object} Diagnostic
 * @property {number} code
 * @property {string} name
 * @property {"error"|"warning"} severity
 * @property {string} message
 * @property {number} line  1 基；0 = 整篇
 * @property {number} from  行内 0 基起始下标
 * @property {number} to    行内 0 基结束下标（开区间）
 * @property {string} [fix] 修复建议
 * @property {string} [hex] 显示用十六进制码（"1003"）
 */

/**
 * @typedef {object} ParseParam
 * @property {string} name          声明名
 * @property {string} [key]         源里的键（大小写可能与声明不同）
 * @property {unknown} value         解析后的值（storyPack.parseLine 的 args）
 * @property {string} [raw]         源里的值文本（含引号）
 * @property {ValueType} type
 * @property {string} hint
 * @property {string|number|boolean} [default]
 * @property {string} [enums]
 * @property {boolean} provided
 * @property {boolean} known
 * @property {boolean} corpusOnly
 * @property {number} from
 * @property {number} to
 */

/**
 * @typedef {object} ParseResult
 * @property {boolean} ok            无 error 级诊断
 * @property {number} line           = lineNumber（1 基）
 * @property {string} raw
 * @property {"command"|"dialogue"|"narration"|"comment"|"blank"} kind
 * @property {string|null} controller 小写命令名（dialog / 裸行 narration 为 "dialog"/null）
 * @property {string|null} controllerRaw 源里的写法
 * @property {string|null} canonical
 * @property {ControllerSpec|null} spec
 * @property {string|null} category
 * @property {"A"|"B"|"C"|null} tier
 * @property {ParseParam[]} required 声明必需参数（含缺失项，provided=false）
 * @property {ParseParam[]} optional 源里出现的已声明可选参数
 * @property {ParseParam[]} params   源里出现的全部参数（含未声明），按源序
 * @property {string[]} missing      缺失的必需参数名
 * @property {string} text          `]` 之后的正文 / 裸行正文
 * @property {string} speaker       `[name="X"]` 的说话人（"" = 无）
 * @property {string} comment       `//` 注释正文
 * @property {string} entity        源里"看起来想写"的实体名（`character`；带点命名空间原样保留，如 `battle.pause`）
 * @property {string} malformed     storyPack.parseLine 的结构性错误（"" = 无）
 * @property {Diagnostic[]} diagnostics
 */

/**
 * @typedef {object} DocumentLint
 * @property {ParseResult[]} lines
 * @property {Diagnostic[]} diagnostics
 * @property {{controllers: Record<string, number>, decisions: number, combos: number, lines: number, errors: number, warnings: number}} stats
 * @property {Array<{line: number, text: string}>} toc
 * @property {Diagnostic[]} merge   Decision/Predicate 合流诊断（= missingMerge）
 */

/**
 * @typedef {object} Completion
 * @property {string} label
 * @property {string} insertText    替换当前 token 的文本（前缀补全语义）
 * @property {string} detail
 * @property {"controller"|"argument"|"value"|"snippet"} kind
 * @property {string} [insertTextFull] 含 `[` 的整段骨架（供整 token 替换）
 * @property {string} [documentation]
 */

/**
 * @typedef {object} CompletionAssets
 * @property {string[]} [images]      叠图/CG key（assets/avg/images）
 * @property {string[]} [backgrounds] 背景 key（assets/avg/backgrounds）
 * @property {string[]} [characters]  角色 key
 * @property {string[]} [music]       BGM key
 * @property {string[]} [sounds]      音效 key
 */

/**
 * @typedef {object} CompletionContext
 * @property {string} [text]   光标所在行（完整行）
 * @property {string} [line]   `text` 的别名（编辑页 task-7 用 `{line, cursor, prefix}`）
 * @property {number} [cursor] 光标列（0 基；缺省 = 行尾）
 * @property {string} [prefix] 正在补全的 token（覆盖自动探测）
 * @property {CompletionAssets} [assets] 可选资源表（值补全用）
 */

/**
 * @typedef {object} HoverEntry
 * @property {string} command
 * @property {string} title
 * @property {string} summary
 * @property {string} anchor
 * @property {string} engineRef
 * @property {"A"|"B"|"C"} tier
 * @property {string} category
 * @property {string} example
 */

/**
 * @typedef {object} HoverInfo
 * @property {string} title
 * @property {string} summary
 * @property {string} anchor
 * @property {string} engineRef
 * @property {"A"|"B"|"C"|null} tier
 * @property {string|null} category
 * @property {string} from
 * @property {string} to
 * @property {number} start  0 基起始（供 UI 高亮）
 * @property {number} end
 * @property {{name: string, type: ValueType, hint: string, default?: string|number|boolean, enums?: string}|null} param
 * @property {string} [example]
 */

// ── 分类（YSS ControllerType 的词汇；Variable/Judge 保留给 C 级 condition 家族） ──

/** @type {string[]} */
export const CATEGORIES = [
  "Background",
  "Character",
  "Dialog",
  "Text",
  "Music",
  "SoundEffect",
  "Mask",
  "VisualEffect",
  "Delay",
  "Choice",
  "Branch",
  "Variable",
  "Judge",
  "Comment",
];

/** @type {Record<string, string>} */
export const CATEGORY_LABELS = {
  Background: "背景 / 图层",
  Character: "立绘 / 角色",
  Dialog: "对白 / 旁白",
  Text: "字幕 / 贴纸 / 文本",
  Music: "音乐 (BGM)",
  SoundEffect: "音效",
  Mask: "遮罩 / 幕布",
  VisualEffect: "镜头 / 特效",
  Delay: "停顿",
  Choice: "选择",
  Branch: "分支 / 收尾",
  Variable: "变量（C 级）",
  Judge: "判定（C 级）",
  Comment: "注释 / 文档元数据",
};

// ── 诊断码表（编号沿用 YSS AStoryXDiagnosticData；语义按本 DSL 调整） ──────────

/**
 * @typedef {object} DiagnosticMeta
 * @property {number} code
 * @property {string} hex
 * @property {string} name
 * @property {"error"|"warning"} severity
 * @property {string} zh
 * @property {string} yss
 */

/** @type {DiagnosticMeta[]} */
export const DIAGNOSTIC_TABLE = [
  { code: 0x1000, hex: "1000", name: "UnknownError", severity: "error", zh: "内部错误（兜底）", yss: "UnknownError" },
  { code: 0x1001, hex: "1001", name: "MissingController", severity: "error", zh: "`[ ]` 里没有控制器名", yss: "RuleNotSelected" },
  { code: 0x1002, hex: "1002", name: "NoSuchController", severity: "error", zh: "未知指令（引擎 warn 后跳过该行）", yss: "NoSuchController" },
  { code: 0x1003, hex: "1003", name: "UnknownParameter", severity: "warning", zh: "未声明的参数键（引擎静默忽略）", yss: "UnexpectedParameter" },
  { code: 0x1004, hex: "1004", name: "MissingRequiredParameter", severity: "error", zh: "缺必需参数", yss: "MissingRequiredParameter" },
  { code: 0x1005, hex: "1005", name: "ParameterTypeMismatch", severity: "error", zh: "参数类型不符", yss: "ParameterTypeMismatch" },
  { code: 0x1006, hex: "1006", name: "ParameterOutOfRange", severity: "warning", zh: "数值越界 / 枚举值不在观察集", yss: "ParameterOutOfRange" },
  { code: 0x1009, hex: "1009", name: "UnclosedSymbol", severity: "error", zh: "`]` / `\"` / `(` 未闭合，或正文混入 `]`", yss: "UnclosedSymbol" },
  { code: 0x100B, hex: "100B", name: "UseTabInsteadSpace", severity: "warning", zh: "`[...]` 内用了 Tab（惯例是空格）", yss: "UseTabInsteadSpace" },
  { code: 0x100C, hex: "100C", name: "UseSpaceInsteadTab", severity: "warning", zh: "`]` 后分隔 / 行首缩进用了 Tab 或单个空格", yss: "UseSpaceInsteadTab" },
  { code: 0x1011, hex: "1011", name: "InstrumentRedundant", severity: "warning", zh: "重复的参数键 / 第二处 `[header]`", yss: "InstrumentRedundant" },
  { code: 0x1014, hex: "1014", name: "MissingMergePredicate", severity: "error", zh: "Decision 后没有覆盖全部 values 的合流 Predicate", yss: "（DSL 专有）" },
  { code: 0x1015, hex: "1015", name: "DecisionOptionsValuesMismatch", severity: "error", zh: "values 数量与 options 数量不一致", yss: "（DSL 专有）" },
  { code: 0x1016, hex: "1016", name: "DecisionOptionsMissing", severity: "error", zh: "Decision 缺 options（不弹面板、只 warn）", yss: "（DSL 专有）" },
  { code: 0x1017, hex: "1017", name: "OrphanPredicate", severity: "warning", zh: "Predicate 前没有（未合流的）Decision", yss: "（DSL 专有）" },
  { code: 0x1018, hex: "1018", name: "UnknownDecisionValue", severity: "warning", zh: "Predicate 引用了 Decision 中不存在的值", yss: "（DSL 专有）" },
  { code: 0x2000, hex: "2000", name: "UnknownWarning", severity: "warning", zh: "内部警告（兜底）", yss: "UnknownWarning" },
  { code: 0x2001, hex: "2001", name: "NoSuchResource", severity: "warning", zh: "资源不存在（需要项目资源表）", yss: "NoSuchResource" },
  { code: 0x2002, hex: "2002", name: "NotReadByEngine", severity: "warning", zh: "运行时未注册该指令 / 该参数当前版本不读", yss: "（DSL 专有）" },
  { code: 0x2003, hex: "2003", name: "TierCInstruction", severity: "warning", zh: "C 级指令 / 带命名空间的游戏内指令（网页端多数忽略）", yss: "（DSL 专有）" },
  { code: 0x2004, hex: "2004", name: "SpellingDrift", severity: "warning", zh: "命令名拼写漂移（引擎按字面分发 → 未知指令）", yss: "（DSL 专有）" },
  { code: 0x2005, hex: "2005", name: "NarrationLine", severity: "warning", zh: "裸文本行：只会作为旁白出现", yss: "（DSL 专有）" },
  { code: 0x2006, hex: "2006", name: "EmptyDialogue", severity: "warning", zh: "空对白（隐藏对话框；可当分节拍）", yss: "（DSL 专有）" },
  { code: 0x2007, hex: "2007", name: "TrailingWhitespace", severity: "warning", zh: "行尾有空白", yss: "（DSL 专有）" },
  { code: 0x2008, hex: "2008", name: "DecisionBudget", severity: "warning", zh: "决策数超预算（LOG ALL 状态爆炸）", yss: "（DSL 专有）" },
  { code: 0x2009, hex: "2009", name: "ComboBudget", severity: "warning", zh: "分支组合数超上限（引擎退化为全量文本）", yss: "（DSL 专有）" },
  { code: 0x200A, hex: "200A", name: "MissingEnding", severity: "warning", zh: "没有收尾（`[endtip]` / `[Blocker(a=1,…)]`）", yss: "（DSL 专有）" },
  { code: 0x200B, hex: "200B", name: "RedundantPredicate", severity: "warning", zh: "单选项 Decision 的合流 Predicate（冗余但可用）", yss: "（DSL 专有）" },
];

/** @type {Record<string, number>} */
export const DIAGNOSTIC_CODES = (() => {
  /** @type {Record<string, number>} */
  const out = {};
  for (const entry of DIAGNOSTIC_TABLE) out[entry.name] = entry.code;
  return out;
})();

/** @type {Record<string, "error"|"warning">} */
export const DIAGNOSTIC_SEVERITY = (() => {
  /** @type {Record<string, "error"|"warning">} */
  const out = {};
  for (const entry of DIAGNOSTIC_TABLE) out[entry.name] = entry.severity;
  return out;
})();

/** @type {Record<number, string>} */
export const DIAGNOSTIC_NAMES = (() => {
  /** @type {Record<number, string>} */
  const out = {};
  for (const entry of DIAGNOSTIC_TABLE) out[entry.code] = entry.name;
  return out;
})();

/** @type {Record<string, DiagnosticMeta>} */
const DIAGNOSTIC_BY_NAME = (() => {
  /** @type {Record<string, DiagnosticMeta>} */
  const out = {};
  for (const entry of DIAGNOSTIC_TABLE) out[entry.name] = entry;
  return out;
})();

/**
 * 造一条诊断（内部）。
 * @param {string} name
 * @param {number} line
 * @param {number} from
 * @param {number} to
 * @param {string} message
 * @param {string} [fix]
 * @param {"error"|"warning"} [severity] 覆盖码表的严重度
 * @returns {Diagnostic}
 */
function diag(name, line, from, to, message, fix = "", severity) {
  const meta = DIAGNOSTIC_BY_NAME[name] ?? DIAGNOSTIC_BY_NAME.UnknownError;
  const lo = Math.max(0, Math.trunc(from));
  const hi = Math.max(lo + 1, Math.trunc(to));
  return {
    code: meta.code,
    hex: meta.hex,
    name: meta.name,
    severity: severity ?? meta.severity,
    message,
    line: Math.trunc(line),
    from: lo,
    to: hi,
    ...(fix ? { fix } : {}),
  };
}

/**
 * 按名字造诊断（导出给 UI/脚本复用；不在表里的名字 → 0x1000）。
 * @param {string} name
 * @param {number} line
 * @param {number} from
 * @param {number} to
 * @param {string} message
 * @param {string} [fix]
 * @param {"error"|"warning"} [severity] 覆盖码表的严重度
 * @returns {Diagnostic}
 */
export function diagnostic(name, line, from, to, message, fix = "", severity) {
  return diag(name, line, from, to, message, fix, severity);
}

// ── 枚举（官方语料全量扫描；只放"观察到的值"，不是白名单） ────────────────────

/** @type {Record<string, string[]>} */
export const ENUMS = {
  fit_mode: ["DEFAULT", "BLACK_MASK"],
  char_sort_type: [
    "BY_LEVEL_UP", "BY_LEVEL_DOWN", "BY_RARITY_UP", "BY_RARITY_DOWN",
    "BY_GAIN_TIME_UP", "BY_GAIN_TIME_DOWN", "BY_NAME_UP", "BY_NAME_DOWN",
    "BY_COST_UP", "BY_COST_DOWN", "BY_HP_UP", "BY_HP_DOWN",
    "BY_ATK_UP", "BY_ATK_DOWN", "BY_DEF_UP", "BY_DEF_DOWN",
    "BY_RES_UP", "BY_RES_DOWN", "BY_FAVOR_UP", "BY_FAVOR_DOWN",
    "BY_RESPAWN_UP", "BY_RESPAWN_DOWN", "BY_BLOCKNUM_UP", "BY_BLOCKNUM_DOWN",
    "BY_ATKSPEED_UP", "BY_ATKSPEED_DOWN", "BY_HANDBOOKSTAGE_UP", "BY_HANDBOOKSTAGE_DOWN",
  ],
  screenadapt: ["coverall", "showall", "fill", "height", "width"],
  ease: ["Linear", "InSine", "OutSine", "InOutSine", "InQuad", "OutQuad", "InOutQuad", "InCubic", "OutCubic", "InOutCubic", "InExpo", "OutExpo", "InOutExpo", "InBack", "OutBack", "InOutBack", "InElastic", "OutElastic", "InOutElastic", "InBounce", "OutBounce", "InOutBounce"],
  camera_effect: ["Grayscale", "Colorinverse", "Chaos"],
  dialog_style: ["self", "other", "answer", "ask"],
  alignment: ["left", "center", "right", "middle"],
  animation_alignment: ["Left", "Center", "Right"],
  char_slot: ["l", "m", "r", "left", "center", "right", "char_left", "char_middle", "char_right", "all", "custom"],
  char_enter: ["left", "right", "up", "down"],
  char_action: ["move", "jump", "shake", "zoom", "exit", "setpos", "rotate", "shakemove"],
  char_direction: ["left", "right"],
  blocker_style: ["default", "slider", "verticalslider"],
  curtain_direction: ["0", "1", "2", "3", "4", "5", "6", "7"],
  focusout_type: ["bg", "cg", "char", "cgitem", "lbg"],
  interlude_type: ["0", "1", "2", "3", "uichar", "bg", "char"],
  fd_style: ["photo", "cutin", "cg", "blocker"],
  cutin_style: ["cutin"],
  cutin_fadestyle: ["fade", "horiz_expand_center", "horiz_expand_left2right", "horiz_expand_right2left", "vert_expand_center", "vert_expand_top2bottom", "vert_expand_bottom2top"],
  animtext_style: ["avg_both", "avg_only_medium", "avg_only_heavy", "line", "listing"],
  avgdisplay_style: ["animetext", "spine", "effect", "bgeffect", "bg", "animekv", "character"],
  avgdisplay_slot: ["bgover", "charover", "cgover"],
  skip_mode: ["skip", "nofirstskip"],
  playmode: ["show", "hide"],
  animtext_pos: ["-400,-200", "0,0"],
};

// ── 控制器规格（= YSS 的 Rule + Controller + ValueMeta） ──────────────────────

/**
 * 声明一个参数（ValueMeta）。
 * @param {string} name
 * @param {ValueType} type
 * @param {string} hint
 * @param {Partial<ValueMeta>} [extra]
 * @returns {ValueMeta}
 */
function P(name, type, hint, extra = {}) {
  return { name, type, hint, ...extra };
}

/**
 * 声明一个控制器规格（必填/可选 + 元数据）。
 * @param {Partial<ControllerSpec> & {command: string, canonical: string, category: string, tier: "A"|"B"|"C", summary: string, example: string, exampleSource: "corpus"|"parser"|"docs", engineRef: string, anchor?: string}} input
 * @returns {ControllerSpec}
 */
function C(input) {
  return {
    tier: input.tier,
    anchor: input.anchor ?? DOC_COMMANDS,
    since: input.since ?? SINCE,
    required: input.required ?? [],
    optional: input.optional ?? [],
    runtimeRegistered: input.runtimeRegistered ?? true,
    ...input,
  };
}

/** 常用参数组（五个 `*bg` / `image` 家族共用）。 */
const P_BG_TRANSFORM = [
  P("screenadapt", "enum", "铺满方式；贴图非 1280×720 时写 coverall", { default: "coverall", enums: "screenadapt", strictEnum: true }),
  P("block", "bool", "淡入是否阻塞推进（fadetime>0 才生效）", { default: false }),
  P("fadetime", "number", "淡入秒数；会被演出速度缩放", { default: 0, min: 0 }),
  P("x", "number", "像素偏移 X", { default: 0 }),
  P("y", "number", "像素偏移 Y", { default: 0 }),
  P("xScale", "number", "X 缩放", { default: 1 }),
  P("yScale", "number", "Y 缩放", { default: 1 }),
  P("width", "number", "宽度倍率（SetNativeSize 后相乘）", { default: 1 }),
  P("height", "number", "高度倍率（SetNativeSize 后相乘）", { default: 1 }),
  P("tiled", "bool", "平铺", { default: false }),
];

/**
 * 大背景家族（gridbg/largebg/verticalbg）的**可选**参数。
 * `imagegroup` 在三个控制器里已列为 required，这里不再重复（required 在前）。
 */
const P_GROUPED_BG = [
  P("cggroup", "string", "改用 assets/avg/images/ 的图组（imagegroup 的替代）", { default: "", alt: "imagegroup" }),
  P("solidwidth", "string", "`/` 分隔的每片宽度", { default: "" }),
  P("solidheight", "string", "`/` 分隔的每片高度", { default: "" }),
  P("fadetime", "number", "淡入秒数", { default: 0.15, min: 0 }),
  P("block", "bool", "是否阻塞推进", { default: false }),
  P("initposmode", "string", "初始定位模式（default/center）", { default: "default" }),
  P("x", "number", "像素偏移 X", { default: 0 }),
  P("y", "number", "像素偏移 Y", { default: 0 }),
  P("xScale", "number", "X 缩放", { default: 1 }),
  P("yScale", "number", "Y 缩放", { default: 1 }),
];

/**
 * 控制器规格表：一条 = YSS 的「规则里的一个控制器 + 它的 ValueMeta 元数据」。
 * `tier` 与 storyPack 的 TIER_A/B/C 一致；`required/optional` 的键名**必须是
 * 运行时真正读的键**（`runtime.ts` 的 case 块；`corpusOnly` 标记的除外）。
 * @type {ControllerSpec[]}
 */
export const CONTROLLERS = [
  C({
    command: "header", canonical: "header", category: "Comment", tier: "A",
    summary: "首行元数据；`]` 后尾随文本 = 剧情标题（`[header]` 应只出现一次）",
    example: "[HEADER(is_tutorial=true, is_skippable=false, is_autoable=false)]  电玩城拉索战教学_a",
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_PARSER}:312 metadataValue(header.args, "fit_mode"|"char_sort_type"|…)`,
    argless: "none",
    note: "key/is_* 只影响播放器行为；fit_mode 接受数字（0=DEFAULT/1=BLACK_MASK）",
    optional: [
      P("key", "string", "剧情 id（`$` 变量/存档用）", { default: "" }),
      P("is_skippable", "bool", "允许跳过", { default: true }),
      P("is_autoable", "bool", "允许自动播放", { default: true }),
      P("is_tutorial", "bool", "教学关标记", { default: false }),
      P("is_video_only", "bool", "纯视频（`[endtip]` 不阻塞）", { default: false }),
      P("fit_mode", "enum", "画面适配模式（DEFAULT/BLACK_MASK）", { default: "DEFAULT", enums: "fit_mode" }),
      P("char_sort_type", "enum", "角色排序（BY_*）", { default: "BY_GAIN_TIME_DOWN", enums: "char_sort_type" }),
      P("npcId", "string", "关联 NPC id", { default: "" }),
      P("actId", "string", "所属活动 id", { default: "" }),
      P("withdrawWithoutAnim", "bool", "撤场无动画", { default: false }),
      P("deny_auto_switch_scene", "bool", "禁止自动切场景", { default: false }),
      P("dont_clear_gameobjectpool_onstart", "bool", "启动时不清对象池", { default: false }),
    ],
  }),
  C({
    command: "background", canonical: "Background", category: "Background", tier: "A",
    summary: "切换背景（`image` 为空 = 清背景）",
    example: '[Background(image="27_g7_subway",screenadapt="coverall", block=true)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:1301 case "background"`,
    argless: "clear",
    required: [P("image", "string", "assets/avg/backgrounds/<key>；留空 = 清背景", { default: "" })],
    optional: P_BG_TRANSFORM.concat([
      P("duration", "number", "语料出现、运行时当前不读", { default: 0, corpusOnly: true, aliases: ["time"] }),
      P("isblock", "bool", "语料出现、运行时当前不读（用 block）", { default: false, corpusOnly: true }),
    ]),
  }),
  C({
    command: "image", canonical: "Image", category: "Background", tier: "A",
    summary: "叠图 / CG 层（无 `image` = 清屏）",
    example: '[Image(image="ac1_0",x=0, y=0, xScale=1, yScale=1, fadetime=0, screenadapt="cvoerall")]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:1743 case "image"`,
    argless: "clear",
    required: [P("image", "string", "assets/avg/images/<key>；留空 = 清屏", { default: "" })],
    note: "语料里的 `screenadapt=\"cvoerall\"` 是官方错拼，引擎回落默认适配",
    optional: P_BG_TRANSFORM.concat([
      P("layer", "int", "层序（语料 7 行；运行时当前不读）", { default: 0, corpusOnly: true }),
      P("time", "number", "语料出现、运行时当前不读", { default: 0, corpusOnly: true }),
      P("xFrom", "number", "语料出现、运行时当前不读（用 ImageTween）", { corpusOnly: true }),
      P("xTo", "number", "语料出现、运行时当前不读", { corpusOnly: true }),
      P("yFrom", "number", "语料出现、运行时当前不读", { corpusOnly: true }),
      P("yTo", "number", "语料出现、运行时当前不读", { corpusOnly: true }),
    ]),
  }),
  C({
    command: "gridbg", canonical: "gridbg", category: "Background", tier: "A",
    summary: "2×2 网格拼贴背景（无参 = 清除；`fadetime` 不被缩放）",
    example: '[gridbg(imagegroup="44_g13_afterglow_L1/44_g13_afterglow_R1", solidwidth="1280/1280", solidheight="720/720",x=-200,fadetime=1)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:1386 case "gridbg"`,
    argless: "clear",
    required: [P("imagegroup", "string", "`/` 分隔的图组", { default: "" })],
    optional: P_GROUPED_BG,
  }),
  C({
    command: "largebg", canonical: "largebg", category: "Background", tier: "A",
    summary: "超宽背景（横向卷轴）",
    example: '[largebg(imagegroup="bg_beach_1/bg_beach_2", solidwidth="920/920", solidheight=720,x=-180)]',
    exampleSource: "corpus",
    engineRef: `${ENGINE_RUNTIME}:1587 case "largebg"`,
    argless: "clear",
    required: [P("imagegroup", "string", "`/` 分隔的图组", { default: "" })],
    optional: P_GROUPED_BG,
  }),
  C({
    command: "verticalbg", canonical: "verticalbg", category: "Background", tier: "A",
    summary: "纵向长背景（上下卷轴）",
    example: '[verticalbg(imagegroup="38_g17_2/38_g17_1", solidwidth=1280, solidheight="1116.25/1117.5",x=0,y=920)]',
    exampleSource: "corpus",
    engineRef: `${ENGINE_RUNTIME}:1475 case "verticalbg"`,
    argless: "clear",
    required: [P("imagegroup", "string", "`/` 分隔的图组", { default: "" })],
    optional: P_GROUPED_BG,
  }),
  C({
    command: "character", canonical: "Character", category: "Character", tier: "A",
    summary: "按角色摆放立绘（自动选槽；`fadetime` 淡入；**从不阻塞**）",
    example: '[character(name="avg_377_gdglow_1#1$1",fadetime=1.5)]',
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#3-character-与-charslot-怎么选`,
    engineRef: `${ENGINE_RUNTIME}:2367 case "character"`,
    argless: "clear",
    required: [P("name", "string", "`base#差分$组@别名`；空 = 清槽", { default: "" })],
    note: "多角色站位/精确移动用 [charslot]；`block`/`isblock` 运行时都恒不阻塞",
    optional: [
      P("name2", "string", "右侧第二位角色（`base#差分`）", { default: "" }),
      P("focus", "int", "高亮档：左/中 `<=1` 高亮，右 `0|2` 高亮", { default: 0 }),
      P("fadetime", "number", "淡入秒数（缺省 0.15）", { default: 0.15, min: 0 }),
      P("transtype", "int", "ECharTransType：0 NONE / 1 ALPHA_IN / 2 ALPHA_OUT", { default: 0 }),
      P("enter", "enum", "入场方向（配合 xpos1/ypos1；middle 无效）", { enums: "char_enter" }),
      P("enter2", "enum", "第二位角色的入场方向", { enums: "char_enter" }),
      P("xpos1", "int", "入场滑入起点 X（需与 ypos1 同时给）", { default: 0 }),
      P("ypos1", "int", "入场滑入起点 Y（Unity y 向上）", { default: 0 }),
      P("xpos2", "int", "第二角色的滑入起点 X", { default: 0 }),
      P("ypos2", "int", "第二角色的滑入起点 Y", { default: 0 }),
      P("blackstart", "number", "黑幕起始 0..1", { default: 0, min: 0, max: 1 }),
      P("blackend", "number", "黑幕结束 0..1", { default: 0, min: 0, max: 1 }),
      P("blackstart2", "number", "第二角色黑幕起始 0..1", { default: 0, min: 0, max: 1 }),
      P("blackend2", "number", "第二角色黑幕结束 0..1", { default: 0, min: 0, max: 1 }),
      P("block", "bool", "语料 1903 行；运行时当前不读（Character 恒不阻塞）", { default: false, corpusOnly: true }),
      P("isblock", "bool", "语料出现；运行时读但恒 false", { default: false, corpusOnly: true }),
      P("offsetX", "int", "语料 584 行；运行时当前不读", { default: 0, corpusOnly: true }),
      P("offsetY", "int", "语料 584 行；运行时当前不读", { default: 0, corpusOnly: true }),
      P("slot", "enum", "语料 12 行；运行时当前不读（按角色自动选槽）", { enums: "char_slot", corpusOnly: true }),
    ],
  }),
  C({
    command: "charslot", canonical: "charslot", category: "Character", tier: "A",
    summary: "按槽位放/移/淡出立绘（`duration` 淡入，缺省 **0 = 瞬切**）",
    example: '[charslot(slot="m",name="avg_npc_243",duration=1)]',
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#3-character-与-charslot-怎么选`,
    engineRef: `${ENGINE_RUNTIME}:2182 case "charslot"`,
    argless: "clear",
    required: [
      P("slot", "enum", "槽位：l/m/r（left/center/right 亦可）；空 = 清全部内置槽", { default: "m", enums: "char_slot" }),
      P("name", "string", "`base#差分$组@别名`；`char_empty` 或空 = 清该槽", { default: "" }),
    ],
    note: "`duration` 是唯一的淡入键（`fadetime` 运行时**不读**）；`isblock` 只在 `end!=false` 时阻塞",
    optional: [
      P("duration", "number", "淡入秒数（0 = 瞬切；会被演出速度缩放）", { default: 0, min: 0 }),
      P("focus", "string", "高亮：all/l/m/r/custom（无 focus = 全部高亮）", { default: "all", enums: "char_slot" }),
      P("action", "enum", "局部动作", { enums: "char_action" }),
      P("posfrom", "string", "起点坐标 `x,y`（移动/缩放动作）", { default: "" }),
      P("posto", "string", "终点坐标 `x,y`", { default: "" }),
      P("poszoom", "string", "缩放目标 `x,y`", { default: "" }),
      P("power", "number", "动作强度", { default: 0, min: 0 }),
      P("times", "int", "次数（抖动/跳动）；小数按 Convert.ToInt32 取整", { default: 1 }),
      P("random", "int", "随机度 0..100；语料多数写 `random=true`（Convert.ToInt32 → 1）", { default: 10 }),
      P("scale", "number", "缩放（xscale/yscale 的缺省）", { min: 0 }),
      P("xscale", "number", "X 缩放", { min: 0 }),
      P("yscale", "number", "Y 缩放", { min: 0 }),
      P("scaleX", "number", "X 缩放（语料小写写法优先）", { min: 0 }),
      P("angle", "number", "旋转角度", { default: 0 }),
      P("circles", "int", "旋转圈数", { default: 0 }),
      P("inverse", "bool", "反向（抖动/旋转）", { default: false }),
      P("stop", "bool", "停止当前动作", { default: false }),
      P("bstart", "number", "黑幕起始", { min: 0, max: 1 }),
      P("bend", "number", "黑幕结束", { min: 0, max: 1 }),
      P("afrom", "number", "Alpha 起点（0..1）；缺省按名字路径 = 淡入", { min: 0, max: 1 }),
      P("ato", "number", "Alpha 终点（0..1）", { min: 0, max: 1 }),
      P("isblock", "bool", "`end` 为真时是否阻塞推进", { default: false }),
      P("end", "string", "`\"false\"` 时不阻塞；其余（含缺省）= 允许阻塞", { default: "true" }),
      P("fadetime", "number", "语料 35 行；运行时**不读**（用 duration）", { corpusOnly: true, default: 0 }),
      P("block", "bool", "语料 248 行；运行时**不读**（用 isblock）", { default: false, corpusOnly: true }),
      P("isCopy", "bool", "语料 139 行；运行时当前不读", { default: false, corpusOnly: true }),
    ],
  }),
  C({
    command: "dialog", canonical: "Dialog", category: "Dialog", tier: "A",
    summary: '对白/隐藏对话框；二创写 `[name="说话人"]  正文`，无参 `[Dialog]` = 收起对白条',
    example: "[Dialog(delay=1.5, style=\"ask\")]是穆西尔先生吗？我们之前有沟通过……",
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#6-对白与推进`,
    engineRef: `${ENGINE_RUNTIME}:1206 case "dialog"（只读 name；正文取 \\] 后的尾随文本）`,
    argless: "hide",
    special: "dialog",
    required: [],
    note: "[name=\"X\"] 必须是整行严格形状；`]` 后两个空格是二创惯例",
    optional: [
      P("name", "string", "说话人（`[name=\"X\"]` 形态）；空 = 隐藏对话框", { default: "" }),
      P("style", "enum", "对白样式（self/other/answer/ask）；运行时当前不读", { enums: "dialog_style", corpusOnly: true }),
      P("delay", "number", "打字间隔；运行时当前不读", { default: 0.04, corpusOnly: true }),
      P("head", "string", "头像 key（char_/npc_）；运行时当前不读", { default: "", corpusOnly: true }),
      P("avatarId", "string", "头像 id；运行时当前不读", { default: "", corpusOnly: true }),
      P("imagegroup", "string", "兜底形态 `[key=value]` 会落到 dialog；主流用 [Image]", { default: "", corpusOnly: true }),
      P("clearlog", "bool", "清日志；运行时当前不读", { default: false, corpusOnly: true }),
    ],
  }),
  C({
    command: "multiline", canonical: "multiline", category: "Dialog", tier: "A",
    summary: "同一段对白续写（打字机追加；正文取尾随文本）",
    example: '[multiline(name="维娜")]我会再和她……',
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#6-对白与推进`,
    engineRef: `${ENGINE_RUNTIME}:2948 case "multiline"`,
    argless: "hide",
    required: [],
    note: "没有尾随文本 → 收起对白条（与 `[Dialog]` 同）",
    optional: [
      P("name", "string", "说话人", { default: "" }),
      P("delay", "number", "打字延迟缩放", { default: 0.04 }),
      P("end", "bool", "`true` = 这是最后一段（下一段不再追加）", { default: false }),
    ],
  }),
  C({
    command: "delay", canonical: "Delay", category: "Delay", tier: "A",
    summary: "停顿 N 秒（**只读 `time`**；缺键/非数字 = 0）",
    example: "[Delay(time=0.3)]",
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#3-delay-的坑time-是唯一能生效的键`,
    engineRef: `${ENGINE_RUNTIME}:1243 case "delay"（exactArg(args,"time")）`,
    argless: "none",
    required: [P("time", "number", "秒数；缺键或非数字 → 0（不等待）", { default: 0, min: 0 })],
    optional: [
      P("duration", "number", "官方语料里当 time 用；运行时**不读**", { corpusOnly: true, default: 0 }),
      P("block", "bool", "语料 22 行；运行时当前不读", { default: false, corpusOnly: true }),
    ],
    note: "`TIME`/`times`/`tinme` 大小写或拼写不符 → 查不到 `time` → 0（commands.md §3）",
  }),
  C({
    command: "blocker", canonical: "Blocker", category: "Mask", tier: "A",
    summary: "全屏色块（黑场/白闪/滑幕）；`a` 是不透明度（1 = 全黑）",
    example: "[Blocker(a=1, r=0, g=0, b=0, fadetime=0, block=true)]",
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#4-场景切换的标准姿势`,
    engineRef: `${ENGINE_RUNTIME}:2100 case "blocker"`,
    argless: "none",
    required: [],
    optional: [
      P("a", "number", "不透明度 0..1（缺省 1；渲染时 clamp01）", { default: 1, min: 0, max: 1, strictRange: true }),
      P("r", "number", "红；0..1 或 0..255 都行（`255` = 通道拉满）", { default: 0, min: 0, max: 255 }),
      P("g", "number", "绿；0..1 或 0..255", { default: 0, min: 0, max: 255 }),
      P("b", "number", "蓝；0..1 或 0..255", { default: 0, min: 0, max: 255 }),
      P("style", "enum", "default/slider/verticalslider（滑幕）", { default: "default", enums: "blocker_style" }),
      P("inverse", "bool", "反向滑幕", { default: false }),
      P("image", "string", "纹理 key（滑幕用）", { default: "" }),
      P("fadetime", "number", "过渡秒数（缺省 0.4；>0 且 block 才阻塞）", { default: 0.4, min: 0 }),
      P("block", "bool", "是否阻塞推进", { default: false }),
      P("afrom", "number", "起始 Alpha（NaN = 用 a）", { min: 0, max: 1 }),
      P("rfrom", "number", "起始红", { min: 0, max: 1 }),
      P("gfrom", "number", "起始绿", { min: 0, max: 1 }),
      P("bfrom", "number", "起始蓝", { min: 0, max: 1 }),
    ],
  }),
  C({
    command: "curtain", canonical: "curtain", category: "Mask", tier: "A",
    summary: "幕布推进转场；`direction` 0 自左 / 2 自右 / 4 自上 / 6 自下（缺省 = 清除）",
    example: "[curtain(direction = 0,fillfrom = 0.01,fillto = 0.11,grad = true, fadetime=1.5)]",
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#5-情绪节拍`,
    engineRef: `${ENGINE_RUNTIME}:2139 case "curtain"`,
    argless: "clear",
    required: [],
    optional: [
      P("direction", "enum", "0..7；<0 = 清除全部幕布", { default: 0, enums: "curtain_direction" }),
      P("fillfrom", "number", "填充起点（缺省 1）", { default: 1 }),
      P("fillto", "number", "填充终点（缺省 0）", { default: 0 }),
      P("grad", "bool", "渐变边缘", { default: false }),
      P("fadetime", "number", "过渡秒数（缺省 0.4）", { default: 0.4, min: 0 }),
      P("block", "bool", "是否阻塞推进", { default: false }),
      P("delay", "number", "延迟秒数", { default: 0, min: 0 }),
      P("a", "number", "Alpha 终点", { min: 0, max: 1 }),
      P("afrom", "number", "Alpha 起点", { min: 0, max: 1 }),
    ],
  }),
  C({
    command: "cameraeffect", canonical: "CameraEffect", category: "VisualEffect", tier: "A",
    summary: "全屏后处理：`Grayscale`（灰化）/ `Colorinverse`；`Chaos` 会 warn",
    example: '[CameraEffect(effect="Grayscale", amount=0.5, keep=true, fadetime=0, block=true)]',
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#5-情绪节拍`,
    engineRef: `${ENGINE_RUNTIME}:2847 case "cameraeffect"`,
    argless: "clear",
    required: [P("effect", "enum", "Grayscale / Colorinverse（Chaos 未实现）", { default: "Grayscale", enums: "camera_effect" })],
    optional: [
      P("amount", "number", "强度 0..1", { default: 1, min: 0, max: 1, strictRange: true }),
      P("keep", "bool", "保留到下一次设置", { default: false }),
      P("fadetime", "number", "过渡秒数（缺省 0.4）", { default: 0.4, min: 0 }),
      P("initamount", "number", "初始强度", { default: 0, min: 0, max: 1 }),
      P("block", "bool", "是否阻塞推进", { default: false }),
    ],
  }),
  C({
    command: "camerashake", canonical: "CameraShake", category: "VisualEffect", tier: "A",
    summary: "镜头抖动；`duration` < 0 或不写 = 无限（10s 兜底）",
    example: "[CameraShake(duration=1, xstrength=30, ystrength=30, vibrato=30, randomness=90, fadeout=true, block=false)]",
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#5-情绪节拍`,
    engineRef: `${ENGINE_RUNTIME}:2894 case "camerashake"`,
    argless: "none",
    required: [],
    optional: [
      P("duration", "number", "秒数；负数/缺省 = 无限（10s）", { default: 1 }),
      P("xstrength", "number", "X 振幅", { default: 1, min: 0 }),
      P("ystrength", "number", "Y 振幅", { default: 0, min: 0 }),
      P("vibrato", "int", "抖动频率", { default: 10, min: 0 }),
      P("randomness", "number", "随机度（语料 30..180；引擎只做阈值比较）", { default: 90 }),
      P("fadeout", "bool", "结尾淡出", { default: false }),
      P("block", "bool", "是否阻塞推进", { default: false }),
      P("stop", "bool", "停止当前抖动", { default: false }),
      P("strength", "number", "语料旧写法（单键）；运行时**不读**", { corpusOnly: true }),
      P("fadetime", "number", "语料 92 行；运行时当前不读", { corpusOnly: true, default: 0 }),
      P("delay", "number", "语料 24 行；运行时当前不读", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "focusout", canonical: "focusout", category: "VisualEffect", tier: "A",
    summary: "背景/角色聚焦淡出（景深）",
    example: '[focusout(duration=0, type="bg", from=0, to=1, block=true)]',
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#5-情绪节拍`,
    engineRef: `${ENGINE_RUNTIME}:2916 case "focusout"`,
    argless: "clear",
    required: [P("type", "enum", "目标：bg / cg / char / cgitem / lbg", { default: "bg", enums: "focusout_type" })],
    optional: [
      P("duration", "number", "过渡秒数（0 = 立即）", { default: 0, min: 0 }),
      P("from", "number", "起始档（<0 = 保持当前）", { min: 0 }),
      P("to", "number", "结束档", { default: 0 }),
      P("id", "string", "目标 id", { default: "" }),
      P("block", "bool", "是否阻塞推进", { default: false }),
      P("fadetime", "number", "语料 2 行；运行时当前不读", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "focusparam", canonical: "focusparam", category: "VisualEffect", tier: "A",
    summary: "聚焦参数（配合 `[focusout]`）：灰化 / 模糊",
    example: '[focusparam(blur=false, effect="Grayscale")]',
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#5-情绪节拍`,
    engineRef: `${ENGINE_RUNTIME}:2935 case "focusparam"`,
    argless: "none",
    required: [],
    optional: [
      P("effect", "enum", "Grayscale / Colorinverse（其余 = None）", { default: "Grayscale", enums: "camera_effect" }),
      P("blur", "bool", "是否模糊（缺省 true）", { default: true }),
    ],
  }),
  C({
    command: "subtitle", canonical: "Subtitle", category: "Text", tier: "A",
    summary: "屏幕独立字幕（不占对白条）",
    example: '[Subtitle(text="“工厂在欢迎我们？”", x=300, y=370, alignment="center", size=24, delay=0.04, width=700)]',
    exampleSource: "corpus",
    anchor: `${DOC_ANIMATION}#6-对白与推进`,
    engineRef: `${ENGINE_RUNTIME}:2982 case "subtitle"`,
    argless: "hide",
    required: [P("text", "text", "字幕正文；可为空（框架仍在）", { default: "" })],
    optional: [
      P("x", "number", "坐标 X", { default: 0 }),
      P("y", "number", "坐标 Y", { default: 0 }),
      P("alignment", "enum", "left / center / right", { default: "center", enums: "alignment" }),
      P("size", "int", "字号（缺省 24）", { default: 24, min: 1 }),
      P("delay", "number", "打字间隔", { default: 0.04, min: 0 }),
      P("width", "int", "换行宽度（缺省 1280）", { default: 1280, min: 1 }),
      P("multi", "bool", "语料 38 行；运行时当前不读", { default: false, corpusOnly: true }),
      P("duration", "number", "语料 34 行；运行时当前不读", { corpusOnly: true, default: 0 }),
      P("hidelog", "bool", "语料 3 行；运行时当前不读", { default: false, corpusOnly: true }),
      P("color", "string", "语料/文档写法；运行时当前不读", { default: "", corpusOnly: true }),
      P("afrom", "number", "语料 6 行；运行时当前不读", { corpusOnly: true }),
      P("ato", "number", "语料 6 行；运行时当前不读", { corpusOnly: true }),
      P("block", "bool", "语料 2 行；运行时当前不读", { default: false, corpusOnly: true }),
      P("fadetime", "number", "语料 3 行；运行时当前不读", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "sticker", canonical: "Sticker", category: "Text", tier: "B",
    summary: "气泡 / 歌词 / 板书贴纸（`multi=true` 续写同一 id）",
    example: '[Sticker(id="st1", multi = true, text="愿广阔的大地保佑吾王♪", x=300,y=200, alignment="center", size=24, delay=0.04, width=700,block = true)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:3028 case "sticker"`,
    argless: "hide",
    required: [P("id", "string", "贴纸 id（同一 id + multi = 续写）", { default: "st1" })],
    optional: [
      P("text", "text", "正文（show 分支必填）", { default: "" }),
      P("x", "number", "坐标 X（0..1280，越界即丢弃）", { default: 0, min: 0, max: 1280 }),
      P("y", "number", "坐标 Y（0..720）", { default: 0, min: 0, max: 720 }),
      P("width", "int", "换行宽度", { default: 700, min: 1 }),
      P("size", "int", "字号", { default: 24, min: 1 }),
      P("alignment", "enum", "left / center / right", { default: "left", enums: "alignment" }),
      P("delay", "number", "打字间隔", { default: 0.04, min: 0 }),
      P("duration", "number", "隐藏/停留秒数（负数 = 用池里的默认）", { default: -1 }),
      P("multi", "bool", "续写同一 id", { default: false }),
      P("block", "bool", "是否阻塞推进（缺省：新建时 true）", { default: true }),
      P("hidelog", "bool", "语料 60 行；运行时当前不读", { default: false, corpusOnly: true }),
      P("aduration", "number", "语料 1 行；运行时当前不读", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "animtext", canonical: "animtext", category: "Text", tier: "B",
    summary: "地名/时间浮字（正文含 `<p=1>` / `<p=2>`）",
    example: '[animtext(id = "at1", name = "group_location_stamp", style="avg_both", pos = "-400,-200", block = false)]<p=1>伦蒂尼姆地下隧道</><p=2>1098年9月28日 4:53 P.M.</>',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:2667 case "animtext"`,
    argless: "none",
    required: [
      P("id", "string", "浮字 id", { default: "at1" }),
      P("name", "string", "贴图名（group_*）", { default: "group_location_stamp" }),
    ],
    optional: [
      P("style", "enum", "版式（avg_both 等）", { default: "avg_both", enums: "animtext_style" }),
      P("pos", "vector", "坐标 `x,y`", { default: "-400,-200" }),
      P("block", "bool", "是否阻塞推进", { default: false }),
    ],
  }),
  C({
    command: "avgdisplay", canonical: "avgdisplay", category: "VisualEffect", tier: "B",
    summary: "通用显示（style/slot 走对应家族贴图）",
    example: '[avgdisplay(id = "2", style = "bg", name = "bg_black", afrom = 0 ,ato = 0.5, duration = 2, slot = "bgover", layer = 1)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:2688 case "avgdisplay"`,
    argless: "hide",
    required: [P("id", "string", "显示槽 id", { default: "1" })],
    optional: [
      P("style", "enum", "bg/character/animekv/bgeffect/effect/spine/animetext", { default: "bg", enums: "avgdisplay_style" }),
      P("slot", "enum", "bgover/charover/cgover", { default: "bgover", enums: "avgdisplay_slot" }),
      P("name", "string", "资源 key", { default: "" }),
      P("layer", "int", "层序（缺省 1）", { default: 1 }),
      P("duration", "number", "过渡秒数", { default: 0, min: 0 }),
      P("afrom", "number", "Alpha 起点", { min: 0, max: 1 }),
      P("ato", "number", "Alpha 终点", { min: 0, max: 1 }),
      P("x", "number", "坐标 X", { min: -2000 }),
      P("xfrom", "number", "起点 X", { min: -2000 }),
      P("xto", "number", "终点 X", { min: -2000 }),
      P("y", "number", "坐标 Y"),
      P("yfrom", "number", "起点 Y"),
      P("yto", "number", "终点 Y"),
      P("scalex", "number", "X 缩放", { min: 0 }),
      P("scalexfrom", "number", "起点 X 缩放", { min: 0 }),
      P("scalexto", "number", "终点 X 缩放", { min: 0 }),
      P("scaley", "number", "Y 缩放", { min: 0 }),
      P("scaleyfrom", "number", "起点 Y 缩放", { min: 0 }),
      P("scaleyto", "number", "终点 Y 缩放", { min: 0 }),
      P("entryfrom", "number", "入场动画起点", { min: 0 }),
      P("entryto", "number", "入场动画终点", { min: 0 }),
      P("entryindex", "int", "入场动画下标", { default: 0, min: 0 }),
      P("rox", "number", "X 轴旋转", { default: 0 }),
      P("roy", "number", "Y 轴旋转", { default: 0 }),
      P("roz", "number", "Z 轴旋转", { default: 0 }),
      P("block", "bool", "是否阻塞推进", { default: false }),
      P("isblock", "bool", "语料 9 行；运行时**不读**（用 block）", { default: false, corpusOnly: true }),
    ],
  }),
  C({
    command: "playmusic", canonical: "PlayMusic", category: "Music", tier: "A",
    summary: "放 BGM（`intro` 为前奏，播完自动接 `key` 循环）",
    example: '[playMusic(intro="$loading_intro",key="$loading_loop", volume=0.6)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:2751 case "playmusic"`,
    argless: "none",
    required: [P("key", "string", "循环段资源 key（`$` 变量可用；assets/avg/music）", { default: "" })],
    optional: [
      P("intro", "string", "前奏资源 key", { default: "" }),
      P("volume", "number", "音量 0..1", { default: 1, min: 0, max: 1, strictRange: true }),
      P("crossfade", "number", "交叉淡入秒数（缺省 0.4）", { default: 0.4, min: 0 }),
      P("delay", "number", "延迟秒数", { default: 0, min: 0 }),
      P("block", "bool", "语料 1 行；运行时当前不读", { default: false, corpusOnly: true }),
      P("fadetime", "number", "语料 138 行；运行时当前不读（用 crossfade）", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "stopmusic", canonical: "StopMusic", category: "Music", tier: "A",
    summary: "淡出 BGM（缺 `fadetime` = 立即停）",
    example: "[stopmusic(fadetime=1)]",
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:2784 case "stopmusic"`,
    argless: "clear",
    required: [],
    optional: [
      P("fadetime", "number", "淡出秒数", { default: 0, min: 0 }),
      P("crossfade", "number", "语料 1 行；运行时当前不读", { corpusOnly: true, default: 0 }),
      P("time", "number", "语料 25 行；运行时当前不读", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "playsound", canonical: "PlaySound", category: "SoundEffect", tier: "A",
    summary: "放音效（`channel` 缺省 = `key`）",
    example: '[PlaySound(key="$d_avg_cavewaterdrop", volume=0, loop=true, channel="a")]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:2801 case "playsound"`,
    argless: "none",
    required: [P("key", "string", "音效 key（`$` 变量可用）", { default: "" })],
    optional: [
      P("volume", "number", "音量（语料 0..1，少量 1.5/7；引擎不钳制）", { default: 1, min: 0, max: 7 }),
      P("channel", "string", "通道名（缺省 = key）", { default: "" }),
      P("loop", "bool", "循环", { default: false }),
      P("delay", "number", "延迟秒数", { default: 0, min: 0 }),
      P("block", "bool", "语料 174 行；运行时当前不读", { default: false, corpusOnly: true }),
      P("fadetime", "number", "语料 38 行；运行时当前不读", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "stopsound", canonical: "StopSound", category: "SoundEffect", tier: "A",
    summary: "停指定通道的音效",
    example: '[StopSound(channel="bgs", fadetime=1)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:2827 case "stopsound"`,
    argless: "none",
    required: [P("channel", "string", "要停的通道（省略时回落 `key`）", { default: "a" })],
    optional: [
      P("fadetime", "number", "淡出秒数", { default: 0, min: 0 }),
      P("key", "string", "用 key 作为通道名（channel 的替代）", { default: "" }),
      P("duration", "number", "语料 4 行；运行时当前不读", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "musicvolume", canonical: "musicvolume", category: "Music", tier: "A",
    summary: "调 BGM 音量",
    example: "[musicvolume(volume=0.2, fadetime=1)]",
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:2792 case "musicvolume"`,
    argless: "none",
    required: [P("volume", "number", "音量 0..1", { default: 1, min: 0, max: 1, strictRange: true })],
    optional: [P("fadetime", "number", "过渡秒数（缺省 0）", { default: 0, min: 0 })],
  }),
  C({
    command: "soundvolume", canonical: "SoundVolume", category: "SoundEffect", tier: "A",
    summary: "调音效通道音量",
    example: '[soundvolume(channel="bse",volume=0,fadetime=1)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:2837 case "soundvolume"`,
    argless: "none",
    required: [
      P("channel", "string", "通道名", { default: "a" }),
      P("volume", "number", "音量 0..1", { default: 1, min: 0, max: 1, strictRange: true }),
    ],
    optional: [P("fadetime", "number", "过渡秒数（缺省 0）", { default: 0, min: 0 })],
  }),
  C({
    command: "decision", canonical: "Decision", category: "Choice", tier: "A",
    summary: "弹选项并把选中的值写进状态（**不是跳转**）",
    example: '[Decision(options="跟着她走;先问清楚", values="1;2")]',
    exampleSource: "corpus",
    anchor: `${DOC_BRANCHING}#2-三种规范形状`,
    engineRef: `${ENGINE_RUNTIME}:3363 case "decision"（log/semantics.parseDecision）`,
    argless: "none",
    required: [P("options", "semilist", "`;` 分隔的选项标签", { default: "选项一;选项二" })],
    optional: [
      P("values", "semilist", "`;` 分隔的整数（与 options 下标对应；缺项按 0 = 恒放行）", { default: "1;2" }),
      P("option1", "string", "语料旧写法（options 的拆分）；运行时当前不读", { corpusOnly: true, default: "" }),
      P("value1", "string", "语料旧写法（可见值是 \"1.1\" 这类字符串）", { corpusOnly: true, default: "1.1" }),
      P("option2", "string", "语料旧写法", { corpusOnly: true, default: "" }),
      P("value2", "string", "语料旧写法", { corpusOnly: true, default: "1.2" }),
      P("color", "string", "语料写法；运行时当前不读", { corpusOnly: true, default: "" }),
    ],
    note: "一部脚本 ≤ 8 个 Decision，且 ∏options ≤ 64（LOG ALL 预算）",
  }),
  C({
    command: "predicate", canonical: "Predicate", category: "Branch", tier: "A",
    summary: "分支闸门：`references` 与当前选中值无交集 → 这一行到下一个 Predicate 之间的行全部跳过",
    example: '[Predicate(references="1;2;3")]',
    exampleSource: "corpus",
    anchor: `${DOC_BRANCHING}#1-纯语义必须原样实现`,
    engineRef: `${ENGINE_RUNTIME}:3434 case "predicate"（log/semantics.parsePredicateReferences）`,
    argless: "clear",
    required: [P("references", "semilist", "`;` 分隔的整数；空 = 全放行（结束分支模式）", { default: "1;2" })],
    optional: [
      P("selectableCondition", "string", "语料 119 行；线上引擎不读", { corpusOnly: true, default: "" }),
      P("visibleCondition", "string", "语料 25 行；线上引擎不读", { corpusOnly: true, default: "" }),
    ],
  }),
  C({
    command: "theater", canonical: "theater", category: "VisualEffect", tier: "B",
    summary: "影院模式（黑边沉浸；网页端映射为自动播放）",
    example: "[theater(mode=true)]",
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:3339 case "theater"`,
    argless: "none",
    required: [],
    optional: [P("mode", "bool", "开/关（缺省 true）", { default: true })],
  }),
  C({
    command: "skipnode", canonical: "skipnode", category: "Branch", tier: "B",
    summary: "跳过锚点：`skip` 可跳过，`nofirstskip` 首次不可跳",
    example: '[skipnode(mode="nofirstskip")]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1288 case "skipnode"`,
    argless: "none",
    required: [],
    optional: [P("mode", "enum", "skip / nofirstskip（其余按 skip）", { default: "skip", enums: "skip_mode" })],
  }),
  C({
    command: "skiptothis", canonical: "SkipToThis", category: "Branch", tier: "B",
    summary: "“跳到这里”的落点（预处理指令，无参数）",
    example: "[SkipToThis]",
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1295 case "skiptothis"`,
    argless: "none",
    required: [],
    optional: [],
  }),
  C({
    command: "endtip", canonical: "endtip", category: "Branch", tier: "A",
    summary: "**唯一注册的收尾指令**：等点击 + 显示“剧情结束”",
    example: "[endtip(block=true)]",
    exampleSource: "parser",
    anchor: `${DOC_BRANCHING}#30-收尾-end-vs-endtip`,
    engineRef: `${ENGINE_RUNTIME}:1187 case "endtip"；parser.ts 给非空脚本补隐式实例`,
    argless: "none",
    required: [],
    optional: [P("block", "bool", "是否停顿等点击（隐式实例固定 true）", { default: true })],
    note: "`block=true` 与解析器自动补的隐式 `endtip` 完全一致",
  }),
  C({
    command: "end", canonical: "end", category: "Branch", tier: "A",
    summary: "游戏侧收尾写法；**网页引擎不认**（warn `unknown_command end` → 停在最后一帧）",
    example: "[end]",
    exampleSource: "corpus",
    anchor: `${DOC_BRANCHING}#30-收尾-end-vs-endtip`,
    engineRef: `${ENGINE_RUNTIME}:默认分支 warn("unknown_command")`,
    argless: "none",
    required: [],
    optional: [],
    runtimeRegistered: false,
    note: "推荐改 `[Blocker(a=1, r=0, g=0, b=0, fadetime=1, block=true)]` 或 `[endtip(block=true)]`",
  }),
  C({
    command: "video", canonical: "Video", category: "VisualEffect", tier: "A",
    summary: "播视频（`url` 优先，`res` 走 assets 解析）",
    example: '[Video(res="video/act37side/GO01.mp4")]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#1-a-级二创脚本主力`,
    engineRef: `${ENGINE_RUNTIME}:1258 case "video"`,
    argless: "none",
    required: [P("res", "string", "媒体仓路径（torappu.prts.wiki/assets/<res>）", { default: "", alt: "url" })],
    optional: [P("url", "string", "直链（优先于 res）", { default: "" })],
  }),
  C({
    command: "aside", canonical: "aside", category: "Dialog", tier: "B",
    summary: "无语者旁白（正文取尾随文本；空正文 = 收起对白条）",
    example: "[aside]  他把信折好，放回口袋。",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1227 case "aside"`,
    argless: "hide",
    required: [],
    optional: [],
    note: "官方语料 0 行；与裸行旁白的区别是它会显示对白框（name 为空）",
  }),
  C({
    command: "narration", canonical: "Narration", category: "Dialog", tier: "B",
    summary: "旁白控制器（`[Narration]` + 尾随文本）；裸行旁白不需要它",
    example: "[Narration]合适的心扉之乐已经奏响，查访对象的心绪被触动。",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1053 line.kind === "narration" 分支`,
    argless: "hide",
    required: [],
    optional: [],
    runtimeRegistered: false,
    note: "线上引擎未注册 `[Narration]`/`[Div]` → warn；直接写裸行更稳",
  }),
  C({
    command: "characteraction", canonical: "CharacterAction", category: "Character", tier: "B",
    summary: "立绘局部动作（呼吸/震动/跳跃/缩放/退场）",
    example: '[CharacterAction(name="char_002_amiya_1", type="shake", xpos=0, fadetime=0.5, block=true)]',
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:2463 case "characteraction"`,
    argless: "none",
    required: [
      P("name", "string", "角色引用（同 charslot）", { default: "" }),
      P("type", "enum", "move/jump/shake/zoom/exit", { default: "shake", enums: "char_action" }),
    ],
    optional: [
      P("fadetime", "number", "时长秒数（**字面**，不被缩放；缺省 0.5）", { default: 0.5, min: 0 }),
      P("xpos", "int", "动作位移 X", { default: 0 }),
      P("ypos", "int", "动作位移 Y", { default: 0 }),
      P("direction", "enum", "left / right", { enums: "char_direction" }),
      P("scale", "number", "缩放（xscale/yscale 缺省）", { min: 0 }),
      P("xscale", "number", "X 缩放", { min: 0 }),
      P("yscale", "number", "Y 缩放", { min: 0 }),
      P("power", "number", "强度", { default: 0, min: 0 }),
      P("randomness", "number", "随机度", { default: 90, min: 0, max: 100 }),
      P("start", "number", "旋转起点角度", { default: 0 }),
      P("leftend", "number", "左摆角度", { default: 15 }),
      P("rightend", "number", "右摆角度", { default: 15 }),
      P("times", "int", "次数", { default: 1, min: 0 }),
      P("stop", "bool", "停止动作", { default: false }),
      P("block", "bool", "是否阻塞推进", { default: false }),
      P("isblock", "bool", "旧拼写（block 的替代）", { default: false }),
    ],
  }),
  C({
    command: "charactercutin", canonical: "CharacterCutin", category: "Character", tier: "B",
    summary: "立绘切入（刀光式登场；`widgetID` 必填）",
    example: '[CharacterCutin(widgetID="1", name="avg_npc_356_1#1$1", style="cutin", fadestyle= "horiz_expand_center", fadetime=0.5, offsetx=-300, width=200, block=true)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:2515 case "charactercutin"`,
    argless: "hide",
    required: [P("widgetID", "string", "切入槽 id；空 = warn 并跳过", { default: "1" })],
    optional: [
      P("name", "string", "角色引用", { default: "" }),
      P("fadestyle", "enum", "淡入形状", { default: "horiz_expand_center", enums: "cutin_fadestyle" }),
      P("fadetime", "number", "秒数（缺省 0.4）", { default: 0.4, min: 0 }),
      P("offsetx", "number", "X 偏移", { default: 0 }),
      P("offsety", "number", "Y 偏移", { default: 0 }),
      P("width", "number", "槽宽（缺省 200）", { default: 200, min: 0 }),
      P("povX", "number", "透视 X", { default: 0 }),
      P("povY", "number", "透视 Y", { default: 0 }),
      P("zoom", "number", "缩放（27.61 起取代 scale）", { min: 0 }),
      P("charOffsetX", "number", "角色层 X 偏移", { default: 0 }),
      P("charOffsetY", "number", "角色层 Y 偏移", { default: 0 }),
      P("block", "bool", "是否阻塞推进（这里**真是** block）", { default: false }),
      P("style", "enum", "语料 390 行；运行时当前不读（用 widgetID+fadestyle）", { default: "cutin", enums: "cutin_style", corpusOnly: true }),
    ],
  }),
  C({
    command: "interlude", canonical: "interlude", category: "Character", tier: "B",
    summary: "插画式过场（章节分隔；`type` 决定版式）",
    example: '[interlude(channel = 3, type = 3, slot = "m", switch = false, pfrom = "0,0", pto="0,0", name = "avg_155_tiger_1#7$1", duration = 1)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:2591 case "interlude"`,
    argless: "clear",
    required: [P("channel", "int", "通道号；<0 = warn 跳过", { default: 1, min: 0 })],
    optional: [
      P("type", "enum", "0/1/2/3（1 uichar / 2 bg / 3 char）", { default: 0, enums: "interlude_type" }),
      P("name", "string", "角色引用（type=3 时）", { default: "" }),
      P("slot", "enum", "槽位", { default: "m", enums: "char_slot" }),
      P("style", "int", "样式号", { default: 0 }),
      P("switch", "bool", "开/关（缺省 false）", { default: false }),
      P("clear", "bool", "清除通道", { default: false }),
      P("duration", "number", "时长秒数", { default: 0, min: 0 }),
      P("aduration", "number", "Alpha 时长", { default: 0, min: 0 }),
      P("sduration", "number", "缩放时长", { default: 0, min: 0 }),
      P("tsduration", "number", "模板尺寸时长", { default: 0, min: 0 }),
      P("afrom", "number", "Alpha 起点（-1 = 不动）", { default: -1 }),
      P("ato", "number", "Alpha 终点", { default: -1 }),
      P("pfrom", "vector", "位置起点 `x,y`", { default: "0,0" }),
      P("pto", "vector", "位置终点 `x,y`", { default: "0,0" }),
      P("sfrom", "vector", "缩放起点 `x,y`", { default: "1,1" }),
      P("sto", "vector", "缩放终点 `x,y`", { default: "1,1" }),
      P("tsfrom", "vector", "模板尺寸起点", { default: "0,0" }),
      P("tsto", "vector", "模板尺寸终点", { default: "0,0" }),
      P("offset", "vector", "整体偏移", { default: "0,0" }),
      P("size", "vector", "尺寸 `w,h`", { default: "0,0" }),
      P("maskid", "string", "遮罩模板 id", { default: "" }),
      P("char", "string", "附带角色", { default: "" }),
      P("direction", "string", "方向", { default: "" }),
      P("block", "bool", "是否阻塞推进", { default: false }),
    ],
  }),
  C({
    command: "imagetween", canonical: "ImageTween", category: "Background", tier: "B",
    summary: "图片平移缩放（`duration` 不被演出速度缩放）",
    example: "[ImageTween(xFrom=0, yFrom=0, xTo=0, yTo=-20, xScaleFrom=1, yScaleFrom=1, xScaleTo=1.1, yScaleTo=1.1, duration=15, block=false)]",
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1936 case "imagetween"`,
    argless: "none",
    required: [P("duration", "number", "补间秒数（0 = 瞬完；>0 且 block 才阻塞）", { default: 1, min: 0 })],
    optional: P_TWEEN(),
  }),
  C({
    command: "backgroundtween", canonical: "backgroundTween", category: "Background", tier: "B",
    summary: "背景缓慢推移（1.3 倍图）",
    example: "[backgroundTween(xFrom=100, yFrom=0, xTo=-100, yTo=0, xScaleFrom=1.3, yScaleFrom=1.3, xScaleTo=1.3, yScaleTo=1.3, duration=35, block=false)]",
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1342 case "backgroundtween"`,
    argless: "none",
    required: [P("duration", "number", "补间秒数", { default: 1, min: 0 })],
    optional: P_TWEEN().concat([
      // `image` 已在 P_TWEEN() 里（两个 Tween 家族同源）。
      P("screenadapt", "enum", "适配方式（语料 3%）", { default: "coverall", enums: "screenadapt", corpusOnly: true }),
      P("isblock", "bool", "旧拼写", { default: false, corpusOnly: true }),
    ]),
  }),
  C({
    command: "largebgtween", canonical: "largeBGTween", category: "Background", tier: "B",
    summary: "超宽背景补间（`duration` 必填）",
    example: "[largeBGTween(xScaleFrom=1, xScaleTo=1.2, duration=4, block=true)]",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1996 case "largebgtween"`,
    argless: "none",
    required: [P("duration", "number", "补间秒数", { default: 1, min: 0 })],
    optional: P_TWEEN(),
  }),
  C({
    command: "imagerotate", canonical: "imagerotate", category: "VisualEffect", tier: "B",
    summary: "图片旋转（`fadetime` 走演出速度缩放）",
    example: "[imagerotate(angle=180, fadetime=1, block=true)]",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1981 case "imagerotate"`,
    argless: "none",
    required: [P("angle", "number", "角度（度）", { default: 0 })],
    optional: [
      P("fadetime", "number", "旋转时长秒数", { default: 0.4, min: 0 }),
      P("block", "bool", "是否阻塞推进", { default: false }),
      P("inverse", "bool", "反向", { default: false }),
      P("circles", "int", "额外圈数", { default: 0, min: 0 }),
    ],
  }),
  C({
    command: "showitem", canonical: "ShowItem", category: "VisualEffect", tier: "B",
    summary: "道具展示（`style` 只注册了 photo/cutin）",
    example: '[ShowItem(image="item_key", style="photo", fadetime=0.5, block=true)]',
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1786 case "showitem"`,
    argless: "none",
    required: [P("image", "string", "道具图 key", { default: "" })],
    optional: [
      P("style", "enum", "photo / cutin", { default: "photo", enums: "fd_style" }),
      P("black", "number", "背景压暗 0..1（缺省 0.4）", { default: 0.4, min: 0, max: 1 }),
      P("offsetx", "number", "X 偏移", { default: 0 }),
      P("offsety", "number", "Y 偏移", { default: 0 }),
      P("fadetime", "number", "秒数（缺省 0.5）", { default: 0.5, min: 0 }),
      P("fadestyle", "string", "语料 17 行；运行时当前不读", { corpusOnly: true, default: "" }),
      P("width", "number", "语料 15 行；运行时当前不读", { corpusOnly: true, default: 0 }),
    ],
  }),
  C({
    command: "hideitem", canonical: "HideItem", category: "VisualEffect", tier: "B",
    summary: "收起道具展示",
    example: "[HideItem(fadetime=0.5)]",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1838 case "hideitem"`,
    argless: "clear",
    required: [],
    optional: [
      P("fadetime", "number", "秒数（缺省 0.5）", { default: 0.5, min: 0 }),
      P("block", "bool", "语料 6 行；运行时当前不读", { default: false, corpusOnly: true }),
    ],
  }),
  C({
    command: "cgitem", canonical: "CgItem", category: "VisualEffect", tier: "B",
    summary: "CG 图层（`image`+`id` 组成槽键；`pfrom/pto` 等补间）",
    example: '[CgItem(image="cg_1", id="a", style="cg", pfrom="0,0", pto="0,0", pduration=1, fadetime=0)]',
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1851 case "cgitem"`,
    argless: "none",
    required: [P("image", "string", "CG 图 key", { default: "" })],
    optional: [
      P("id", "string", "槽 id（与 image 组成 key）", { default: "0" }),
      P("style", "enum", "cg（blocker 走原生专属，网页 warn）", { default: "cg", enums: "fd_style" }),
      P("pfrom", "vector", "位置起点", { default: "0,0" }),
      P("pto", "vector", "位置终点", { default: "0,0" }),
      P("pduration", "number", "位置时长", { default: 0, min: 0 }),
      P("pdelay", "number", "位置延迟", { default: 0, min: 0 }),
      P("sfrom", "number", "缩放起点", { default: 1, min: 0 }),
      P("sto", "number", "缩放终点", { default: 1, min: 0 }),
      P("sduration", "number", "缩放时长", { default: 0, min: 0 }),
      P("sdelay", "number", "缩放延迟", { default: 0, min: 0 }),
      P("rfrom", "number", "旋转起点", { default: -1 }),
      P("rto", "number", "旋转终点", { default: 0 }),
      P("rduration", "number", "旋转时长", { default: 0, min: 0 }),
      P("afrom", "number", "Alpha 起点", { default: 1, min: 0, max: 1 }),
      P("ato", "number", "Alpha 终点", { default: 1, min: 0, max: 1 }),
      P("aduration", "number", "Alpha 时长", { default: 0, min: 0 }),
      P("adelay", "number", "Alpha 延迟", { default: 0, min: 0 }),
      P("cfrom", "string", "颜色起点（`#rrggbb` 或 `r,g,b,a`）", { default: "" }),
      P("cto", "string", "颜色终点", { default: "" }),
      P("ease", "enum", "缓动（缺省 Linear）", { default: "Linear", enums: "ease" }),
      P("width", "int", "像素宽（0 = 原生尺寸）", { default: 0, min: 0 }),
      P("height", "int", "像素高", { default: 0, min: 0 }),
      P("block", "bool", "是否阻塞推进", { default: false }),
    ],
  }),
  C({
    command: "hidecgitem", canonical: "HideCgItem", category: "VisualEffect", tier: "B",
    summary: "收起 CG 图层（省略 image/id = 清全部）",
    example: '[HideCgItem(image="cg_1", id="a", fadetime=0.13)]',
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1917 case "hidecgitem"`,
    argless: "clear",
    required: [],
    optional: [
      P("image", "string", "只收这一张", { default: "" }),
      P("id", "string", "槽 id", { default: "" }),
      P("fadetime", "number", "秒数（缺省 0.13）", { default: 0.13, min: 0 }),
      P("ease", "enum", "缓动", { default: "Linear", enums: "ease" }),
      P("block", "bool", "是否阻塞推进", { default: false }),
    ],
  }),
  C({
    command: "stickertween", canonical: "stickertween", category: "Text", tier: "B",
    summary: "贴纸补间（位移/缩放/旋转/Alpha 分段）",
    example: '[stickertween(id="st1", pfrom="0,0", pto="100,0", pduration=1, ato=1)]',
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:3151 case "stickertween"`,
    argless: "none",
    required: [P("id", "string", "贴纸 id", { default: "st1" })],
    optional: [
      P("join", "bool", "与已有补间合并", { default: false }),
      P("isend", "bool", "结束补齐", { default: false }),
      P("block", "bool", "是否阻塞推进", { default: false }),
      P("pfrom", "vector", "位置起点", { default: "0,0" }),
      P("pto", "vector", "位置终点", { default: "0,0" }),
      P("pduration", "number", "位置时长", { default: 0.13, min: 0 }),
      P("rfrom", "number", "旋转起点", { min: 0 }),
      P("rto", "number", "旋转终点", { default: 0 }),
      P("rduration", "number", "旋转时长", { default: 0.13, min: 0 }),
      P("afrom", "number", "Alpha 起点", { default: 0, min: 0, max: 1 }),
      P("ato", "number", "Alpha 终点", { default: 1, min: 0, max: 1 }),
      P("aduration", "number", "Alpha 时长", { default: 0.13, min: 0 }),
    ],
  }),
  C({
    command: "stickerclear", canonical: "stickerclear", category: "Text", tier: "B",
    summary: "清空全部贴纸（连同计时贴纸）",
    example: "[stickerclear]",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:3276 case "stickerclear"`,
    argless: "none",
    required: [],
    optional: [P("block", "bool", "是否等一次点击", { default: false })],
  }),
  C({
    command: "spellsticker", canonical: "spellsticker", category: "Text", tier: "C",
    summary: "法术贴纸（show/hide + 变形）",
    example: '[spellsticker(id="s1", action="show", style="sami", x=640, y=360, block=true)]',
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:3290 case "spellsticker"`,
    argless: "none",
    required: [P("id", "string", "贴纸 id（空 = warn 跳过）", { default: "s1" })],
    optional: [
      P("action", "enum", "show / hide", { default: "show", enums: "playmode" }),
      P("style", "string", "贴图样式（缺省 sami）", { default: "sami" }),
      P("x", "number", "坐标 X", { default: 0 }),
      P("y", "number", "坐标 Y", { default: 0 }),
      P("xScale", "number", "X 缩放", { min: 0 }),
      P("yScale", "number", "Y 缩放", { min: 0 }),
      P("angle", "number", "角度", { default: 0 }),
      P("alpha", "number", "Alpha", { min: 0, max: 1 }),
      P("block", "bool", "是否阻塞推进", { default: false }),
    ],
  }),
  C({
    command: "spellstickerclear", canonical: "spellstickerclear", category: "Text", tier: "C",
    summary: "清空法术贴纸",
    example: "[spellstickerclear(block=true)]",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:3330 case "spellstickerclear"`,
    argless: "none",
    required: [],
    optional: [P("block", "bool", "是否等一次点击", { default: false })],
  }),
  C({
    command: "timersticker", canonical: "timersticker", category: "Text", tier: "C",
    summary: "计时贴纸（倒计时/进度条）",
    example: '[timersticker(id="t1", x=1000, y=60, width=200, size=24, time=10)]',
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:3240 case "timersticker"`,
    argless: "none",
    required: [P("id", "string", "计时器 id", { default: "t1" })],
    optional: [
      P("x", "number", "坐标 X", { default: 0 }),
      P("y", "number", "坐标 Y", { default: 0 }),
      P("width", "number", "宽度", { default: 200, min: 0 }),
      P("size", "number", "字号", { default: 24, min: 1 }),
      P("time", "number", "计时秒数", { min: 0 }),
      P("duration", "number", "显示时长", { default: 1, min: 0 }),
      P("afrom", "number", "Alpha 起点", { default: 0, min: 0, max: 1 }),
      P("ato", "number", "Alpha 终点", { default: 1, min: 0, max: 1 }),
    ],
  }),
  C({
    command: "timerclear", canonical: "timerclear", category: "Text", tier: "C",
    summary: "收起计时贴纸",
    example: "[timerclear(duration=0.13)]",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:3264 case "timerclear"`,
    argless: "none",
    required: [],
    optional: [P("duration", "number", "收起秒数（缺省 0.13）", { default: 0.13, min: 0 })],
  }),
  C({
    command: "bgeffect", canonical: "Bgeffect", category: "VisualEffect", tier: "B",
    summary: "背景特效图层；**运行时标记为 unsupported**（`unsupported_command` warn 后跳过）",
    example: '[BgEffect(name="$eb_rain", duration=2, loop=true)]',
    exampleSource: "corpus",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:unsupportedAd8Commands = new Set(["bgeffect", "effect"])`,
    argless: "none",
    required: [],
    runtimeRegistered: false,
    optional: [
      P("name", "string", "特效 key", { default: "", corpusOnly: true }),
      P("layer", "int", "层序", { default: 0, corpusOnly: true }),
      P("x", "number", "坐标 X", { default: 0, corpusOnly: true }),
      P("y", "number", "坐标 Y", { default: 0, corpusOnly: true }),
      P("xto", "number", "终点 X", { corpusOnly: true }),
      P("yto", "number", "终点 Y", { corpusOnly: true }),
      P("loop", "bool", "循环", { default: false, corpusOnly: true }),
      P("flip", "bool", "翻转", { default: false, corpusOnly: true }),
      P("duration", "number", "时长", { default: 0, corpusOnly: true }),
      P("fade", "number", "淡入", { corpusOnly: true }),
      P("movetime", "number", "移动时长", { corpusOnly: true }),
      P("delay", "number", "延迟", { corpusOnly: true }),
    ],
  }),
  C({
    command: "animtextclean", canonical: "AnimTextClean", category: "Text", tier: "B",
    summary: "清空浮字",
    example: "[AnimTextClean]",
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:（随 animtext 家族分发）`,
    argless: "none",
    required: [],
    optional: [],
    runtimeRegistered: false,
  }),
  C({
    command: "largeimg", canonical: "largeimg", category: "Background", tier: "B",
    summary: "大图画布（与 `[image]` 同族的宽图通道）",
    example: '[largeimg(image="bg_beach_1", x=0)]',
    exampleSource: "docs",
    anchor: `${DOC_COMMANDS}#2-b-级可用但要在-metadata-json-声明`,
    engineRef: `${ENGINE_RUNTIME}:1672 case "largeimg"（arg() 宽松查键）`,
    argless: "clear",
    required: [P("image", "string", "图 key", { default: "" })],
    optional: [
      P("imagegroup", "string", "`/` 分隔图组（宽松查键，大小写不敏感）", { default: "" }),
      P("cggroup", "string", "CG 图组", { default: "" }),
      P("fadetime", "number", "淡入秒数", { default: 0, min: 0 }),
      P("duration", "number", "时长", { default: 0, min: 0 }),
      P("x", "number", "坐标 X", { default: 0 }),
      P("y", "number", "坐标 Y", { default: 0 }),
      P("xScale", "number", "X 缩放", { default: 1 }),
      P("yScale", "number", "Y 缩放", { default: 1 }),
      P("screenadapt", "enum", "适配", { default: "coverall", enums: "screenadapt" }),
      P("blok", "bool", "语料里的拼错键（宽松查键仍能命中 block）", { default: false, aliases: ["block"] }),
      P("block", "bool", "是否阻塞推进", { default: false }),
    ],
  }),
];

/**
 * 补间参数组（ImageTween / backgroundTween / largeBGTween 共用；运行时长这样）。
 * @returns {ValueMeta[]}
 */
function P_TWEEN() {
  return [
    P("image", "string", "先换到这张图再补间（Tween 家族共用）", { default: "" }),
    P("ease", "enum", "缓动曲线", { default: "Linear", enums: "ease" }),
    P("loop", "bool", "无限循环（与 block=true 同用会 warn）", { default: false }),
    P("block", "bool", "是否阻塞推进（duration>0 才生效）", { default: false }),
    P("xFrom", "number", "起点 X", { min: -10000, max: 10000 }),
    P("xTo", "number", "终点 X", { min: -10000, max: 10000 }),
    P("yFrom", "number", "起点 Y", { min: -10000, max: 10000 }),
    P("yTo", "number", "终点 Y", { min: -10000, max: 10000 }),
    P("xScaleFrom", "number", "起点 X 缩放", { min: 0 }),
    P("xScaleTo", "number", "终点 X 缩放", { min: 0 }),
    P("yScaleFrom", "number", "起点 Y 缩放", { min: 0 }),
    P("yScaleTo", "number", "终点 Y 缩放", { min: 0 }),
  ];
}

/** @type {Record<string, ControllerSpec>} */
export const CONTROLLER_INDEX = (() => {
  /** @type {Record<string, ControllerSpec>} */
  const out = {};
  for (const spec of CONTROLLERS) out[spec.command] = spec;
  // 表格以外**只有别名**（大小写/全半角无关）；命名空间指令（`Battle.Pause`）
  // 不进索引，由 NAMESPACE_RE 在 parseLine 里识别。
  return out;
})();

// ── 参数键的宽松/严格查表 + 诊断辅助 ─────────────────────────────────────────

/** @type {Set<string>} 本表覆盖的命令（A/B 主力）。 */
const MODELED = new Set(CONTROLLERS.map((spec) => spec.command));

/**
 * 带命名空间的引擎指令（`battle.pause`、`activity.resettoentry`、
 * `sandboxv2.ensuredungeonstable`…）：上游 parser 的 `[.|\w]*` 认点号，
 * 游戏内 dispatcher 按字面分发；网页端 StoryPlayer 静默忽略该行。
 * 语料 1,663 行 —— 报 warning（0x2003）而不是"未知指令"（0x1002 error）。
 * 首段必须像标识符（排除 `v1.2` 这类纯版本号形态）。
 */
const NAMESPACE_RE = /^[a-z_]\w*(?:\.[a-z0-9_]+)+$/;

/**
 * 语言无关的编辑距离（Levenshtein），用于「你是不是想写 X」提示。
 * @param {string} a @param {string} b @returns {number}
 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  /** @type {number[]} */
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    /** @type {number[]} */
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * 在候选名里找最接近的一个（距离 ≤ 阈值才返回）。
 * @param {string} word @param {string[]} candidates @param {number} [threshold]
 * @returns {string|null}
 */
function nearest(word, candidates, threshold = 2) {
  const lower = word.toLowerCase();
  /** @type {{name: string, d: number}|null} */
  let best = null;
  for (const candidate of candidates) {
    const d = editDistance(lower, candidate.toLowerCase());
    if (best === null || d < best.d) best = { name: candidate, d };
  }
  return best && best.d <= threshold ? best.name : null;
}

/**
 * 按命令名取规格；`canonical` 的大小写写法也能命中（如 "CameraShake"）。
 * @param {unknown} command
 * @returns {ControllerSpec|null}
 */
export function parseControllerSpec(command) {
  const raw = String(command ?? "").trim();
  if (!raw) return null;
  return CONTROLLER_INDEX[raw.toLowerCase()] ?? null;
}

/** @type {Set<ValueType>} */
const VALUE_TYPES = new Set(["string", "text", "number", "int", "bool", "enum", "semilist", "vector"]);

/**
 * 枚举值（补全/校验用）。
 * @param {ValueMeta} meta @returns {string[]}
 */
function enumValues(meta) {
  if (meta.enums && ENUMS[meta.enums]) return ENUMS[meta.enums];
  return [];
}

/**
 * 类型 + 范围检查。
 *
 * `silent` = 引擎**不报错、只悄悄回落缺省**的那类不符（`static` 看不出结果的
 * `$变量`、`toBoolean` 不认的数字 1/0、值尾多出的 `)]`）。这类给 warning，
 * 其余给 error —— 编辑器里"报错"应当是"这行真的会坏"。
 *
 * @param {string} raw 源里的值文本
 * @param {ValueMeta} meta
 * @returns {{typeOk: boolean, rangeOk: boolean, enumOk: boolean, silent?: boolean}}
 */
function checkValue(raw, meta) {
  const text = String(raw ?? "").trim();
  const quoted = text.length >= 2 && /^["']/.test(text) && text.endsWith(text[0]);
  const body = quoted ? text.slice(1, -1) : text;
  // 空值（`fadetime=`）：引擎取缺省，静默。
  if (!body) return { typeOk: true, rangeOk: true, enumOk: true };
  // 非引号 `$变量`：静态看不出结果；对数字/布尔字段来说引擎 toNumber/toBoolean
  // 一律回落缺省 —— warning。
  if (body.startsWith("$")) {
    return (meta.type === "number" || meta.type === "int" || meta.type === "bool")
      ? { typeOk: false, rangeOk: true, enumOk: true, silent: true }
      : { typeOk: true, rangeOk: true, enumOk: true };
  }
  if (meta.type === "number" || meta.type === "int") {
    // 引擎的 toOptionalNumber/Convert.ToInt32 也接受布尔：`random=true` → 1。
    if (/^(true|false)$/i.test(body)) return { typeOk: true, rangeOk: true, enumOk: true };
    const ok = /^[-+]?(\d+\.?\d*|\.\d+)$/.test(body);
    if (!ok) {
      // 值尾多出 `)]` / `)`：语料 `[delay(time=2)]]` 这类多写一个 `]` 的产物。
      return { typeOk: false, rangeOk: true, enumOk: true, silent: /[)\]\s]+$/.test(body) };
    }
    const n = Number(body);
    // `int` 参数收到小数时引擎按 Convert.ToInt32（四舍六入五成双）取整，不算错误。
    if (meta.type === "int" && !Number.isInteger(n)) return { typeOk: true, rangeOk: true, enumOk: true };
    // `min`/`max` 是**软校验**：引擎的 toNumber 会把解析不出的值悄悄换成缺省，
    // 官方语料本身也有大量越界（`Blocker(r=255)`（引擎按原样 tint 并在渲染时
    // 钳制）、`playsound(volume=1.5)`、`camerashake(randomness=180)`…）。
    // 只当元数据显式标了 `strictRange` 才报（warning），不替引擎发明白名单。
    if (meta.strictRange) {
      const min = typeof meta.min === "number" ? meta.min : -Infinity;
      const max = typeof meta.max === "number" ? meta.max : Infinity;
      return { typeOk: true, rangeOk: n >= min && n <= max, enumOk: true };
    }
    return { typeOk: true, rangeOk: true, enumOk: true };
  }
  if (meta.type === "bool") {
    if (/^(true|false)$/i.test(body)) return { typeOk: true, rangeOk: true, enumOk: true };
    // 语料里 `isblock=1` 出现过；引擎 toBoolean 只认 true/false → 取缺省。
    return { typeOk: false, rangeOk: true, enumOk: true, silent: /^[-+]?\d+$/.test(body) };
  }
  if (meta.type === "enum") {
    const list = enumValues(meta);
    if (list.length === 0 || !body) return { typeOk: true, rangeOk: true, enumOk: true };
    if (list.some((value) => value.toLowerCase() === body.toLowerCase())) return { typeOk: true, rangeOk: true, enumOk: true };
    // 枚举是**观察集**而非引擎白名单：`screenadapt="cvoerall"`、`slot="middle"`
    // 引擎自己会归一或回落；只有显式标了 `strictEnum` 的才升级成 warning。
    return { typeOk: true, rangeOk: true, enumOk: !meta.strictEnum };
  }
  return { typeOk: true, rangeOk: true, enumOk: true };
}

// ── 单行解析（UI 的 ParseData） ──────────────────────────────────────────────

/**
 * storyPack.parseLine 的结构性错误 → YSS 风格诊断码。
 * @param {string} malformed
 * @param {number} line
 * @param {string} raw
 * @param {Diagnostic[]} out
 */
function structureDiagnostics(malformed, line, raw, out) {
  if (!malformed) return;
  if (malformed.includes("缺少 ]")) {
    out.push(diag("UnclosedSymbol", line, raw.length - 1, raw.length, "缺少 `]`：整行会被当成旁白", "补上 `]`（参数写在 `]` 之内）"));
    return;
  }
  if (malformed.includes("残留")) {
    // `[name="芳汀"](成了。)` / `[Delay(time=1)](x=1)`：**上游的贪婪正则**把
    // `]` 后的 `(…)` 当成参数表读，于是正文被并进参数值。给可照抄的写法。
    const at = Math.max(0, raw.indexOf("]"));
    const head = raw.slice(1, at);
    const tail = raw.slice(at + 1);
    const body = tail.replace(/^\s*[(（]/, "").replace(/[)）]\s*$/, "").trim();
    const entity = entityOf(raw);
    out.push(diag("UnclosedSymbol", line, at, at + 1,
      `\`]\` 后残留 \`(\`：引擎把 \`(…)\` 当参数表读，这段正文会被并进参数值${entity ? `（这行的 entity 仍是 \`${entity}\`，只是正文位置错了）` : ""}`,
      `把 \`(\` 之后的文字移到 \`]\` 外：\`[${head}]${body ? `  ${body}` : ""}\``));
    return;
  }
  if (malformed.includes("无法解析")) {
    const cased = entityRawOf(raw);
    const entity = cased.toLowerCase();
    if (NAMESPACE_RE.test(entity)) {
      // `[Battle.Pause]` / `[Activity.ResetToEntry]` / `[SandboxV2.EnsureDungeonStable]`：
      // 游戏内命名空间指令。上游 parser 的 `[.|\w]*` 认点号 → 它是**合法**的
      // command，网页端 dispatcher 没有这个 case、静默忽略该行 → warning。
      const at = Math.max(0, raw.indexOf(cased));
      out.push(diag("TierCInstruction", line, at, Math.max(at + 1, at + cased.length),
        `游戏内命名空间指令：${cased}（战斗/活动 UI 动作，网页端忽略该行，其余照播）`,
        "二创里基本用不到；留着不影响播放，删掉更清爽"));
      return;
    }
    const close = raw.indexOf("]");
    // `[Character]]` / `[character(…)] ]`：末尾多一个 `]`（语料 26 行）。引擎按
    // **最后一个** `]` 截断 → 命令名照样认得，多出来的 `]` 会变成正文的第一个字符。
    if (/\]\s*\]\s*$/.test(raw) && /^[A-Za-z_]\w*$/.test(cased)) {
      const at = raw.lastIndexOf("]");
      out.push(diag("UnclosedSymbol", line, at, at + 1,
        `末尾多了一个 \`]\`：引擎按**最后一个** \`]\` 截断，多出的 \`]\` 会进正文${{"character": "（Character 不显示正文，其余指令会看到它）"}[entity] ?? ""}`,
        `写成 \`[${cased}]\`（只保留一个 \`]\`）`));
      return;
    }
    out.push(diag("MissingController", line, 1, Math.max(2, close),
      `\`[]\` 里没有控制器名${cased ? `（这一行的 entity 是 \`${cased}\`）` : ""}`,
      "写 `[Dialog]` 或 `[Delay(time=1)]`"));
    return;
  }
  out.push(diag("UnknownError", line, 0, raw.length, malformed));
}

/**
 * 参数在源里的 span（用 storyPack 的 splitTopLevel，不重写切分）。
 * @param {string} raw
 * @returns {Array<{key: string, valueRaw: string, from: number, to: number, keyFrom: number, valueFrom: number, valueTo: number}>}
 */
function paramSpans(raw) {
  const out = [];
  if (raw[0] !== "[") return out;
  const close = raw.lastIndexOf("]");
  if (close <= 0) return out;
  const head = raw.slice(1, close);
  const open = head.indexOf("(");
  if (open === -1) return out;
  const body = head.slice(open + 1, head.endsWith(")") ? -1 : head.length);
  const base = 1 + open + 1;
  let cursor = 0;
  for (const segment of splitTopLevel(body)) {
    const at = body.indexOf(segment, cursor);
    if (at === -1) continue;
    cursor = at + segment.length;
    const eq = segment.indexOf("=");
    if (eq === -1) {
      out.push({
        key: "",
        valueRaw: segment,
        from: base + at,
        to: base + at + segment.length,
        keyFrom: base + at,
        valueFrom: base + at,
        valueTo: base + at + segment.length,
      });
      continue;
    }
    const key = segment.slice(0, eq).trim();
    const rawValue = segment.slice(eq + 1);
    const lead = rawValue.length - rawValue.trimStart().length;
    const trimmedValue = rawValue.trim();
    out.push({
      key,
      valueRaw: trimmedValue,
      from: base + at,
      to: base + at + segment.length,
      keyFrom: base + at,
      valueFrom: base + at + eq + 1 + lead,
      valueTo: base + at + eq + 1 + lead + trimmedValue.length,
    });
  }
  return out;
}

/**
 * 解析**一行**（对应 YSS 的 `AStoryXControllerParseData`）。
 *
 * 结构/token 化来自 `storyPack.parseLine`；本函数只做「控制器规格 + 参数 + 诊断」。
 * 也接受注释行 / 空行（`kind: "comment" | "blank"`），方便编辑器逐行调用。
 *
 * @param {string} input 单行（不含换行）
 * @param {number} [lineNumber] 1 基行号（缺省 0；诊断原样回填）
 * @returns {ParseResult}
 */
export function parseLine(input, lineNumber = 0) {
  const raw = String(input ?? "");
  const line = Number.isFinite(lineNumber) ? Math.trunc(Number(lineNumber)) : 0;
  /** @type {Diagnostic[]} */
  const diagnostics = [];

  if (!raw.trim()) {
    return {
      ok: true, line, raw, kind: "blank", controller: null, controllerRaw: null, entity: "",
      canonical: null, spec: null, category: null, tier: null, required: [], optional: [], params: [],
      missing: [], text: "", speaker: "", comment: "", malformed: "", diagnostics,
    };
  }
  if (/^\s*\/\//.test(raw)) {
    return {
      ok: true, line, raw, kind: "comment", controller: null, controllerRaw: null, entity: "",
      canonical: null, spec: null, category: null, tier: null, required: [], optional: [], params: [],
      missing: [], text: "", speaker: "", comment: raw.replace(/^\s*\/\/\s?/, ""), malformed: "", diagnostics,
    };
  }

  const dsl = parseDslLine(raw, line);
  structureDiagnostics(dsl.malformed ?? "", line, raw, diagnostics);

  // 裸行 → 旁白；裸 `[key=value]` → dialog（storyPack 的兜底）
  if (dsl.kind !== "command" && dsl.kind !== "dialogue") {
    if (!dsl.malformed && raw.trim()) {
      diagnostics.push(diag("NarrationLine", line, 0, raw.length, "裸文本行：只会作为旁白出现（无说话人、无对白条样式）", '建议写成 [name=""] 或 [Dialog]'));
    }
    if (dsl.malformed) {
      const last = raw.length;
      if (diagnostics.length === 0) diagnostics.push(diag("UnknownError", line, 0, Math.max(1, last), dsl.malformed));
    }
    const narrator = entityOf(raw);
    // 带点号的游戏内指令（`[Battle.Pause]`、`[Activity.ResetToEntry]`）：storyPack
    // 落 narration，但它在引擎里是合法 command（网页端忽略）→ 归 C 级。
    const namespaced = NAMESPACE_RE.test(narrator);
    return {
      ok: !diagnostics.some((d) => d.severity === "error"),
      line, raw, kind: "narration", controller: null, controllerRaw: namespaced ? narrator : null,
      entity: narrator,
      canonical: null, spec: null, category: namespaced ? "Judge" : null, tier: namespaced ? "C" : null,
      required: [], optional: [], params: [], missing: [],
      text: raw, speaker: "", comment: "", malformed: dsl.malformed ?? "", diagnostics,
    };
  }

  const rawCommand = dsl.kind === "dialogue" ? "dialog" : String(dsl.command ?? "dialog");
  const entity = entityOf(raw);
  // `[Battle.Pause]` / `[Battle.LockFunction(mask=…)]` / `[Activity.ResetToEntry]`：
  // 带点号的**游戏内**命令（语料 1,663 行）。storyPack 对它们要么落 narration、
  // 要么（head 含 `=` 时）兜底成 `dialog`；这里认出真名并按"网页端忽略"处理。
  const isNamespaced = NAMESPACE_RE.test(entity) && entity !== "dialog";
  /** @type {ControllerSpec|null} */
  let spec = CONTROLLER_INDEX[rawCommand] ?? null;
  // `[Battle.LockFunction(mask=…)]`：storyPack 的 `[key=value]` 兜底把它读成
  // `dialog`——那不是作者写的命令，所以规格（与参数校验）让位给"游戏内指令"。
  if (spec && isNamespaced && rawCommand !== entity) spec = null;
  const tier = spec ? spec.tier
    : isNamespaced ? "C"
      : TIER_A.has(rawCommand) || TIER_B.has(rawCommand) || rawCommand === "endtip" ? "A"
        : TIER_C.has(rawCommand) ? "C" : null;

  // 未建模的 A/B 指令（本表应已覆盖；兜底仍给出分级）
  if (!spec) {
    if (isNamespaced) {
      // 游戏内指令（战斗/活动/生息演算的 UI 动作）：上游 parser 的 `[.|\w]*`
      // 认点号、按字面 dispatcher；网页端 StoryPlayer 没有这个 case → 静默忽略
      // 该行。所以这里是 warning（0x2003），不是"未知指令"（0x1002 error）。
      const cased = String(dsl.commandRaw ?? entityRawOf(raw)).trim();
      const hit = raw.indexOf(cased) >= 0 ? raw.indexOf(cased) : raw.indexOf(entity);
      const at = Math.max(0, hit);
      diagnostics.push(diag("TierCInstruction", line, at, Math.max(at + 1, at + cased.length),
        `游戏内命名空间指令：${cased}（战斗/活动 UI 动作，网页端忽略该行，其余照播）`,
        "二创里基本用不到；留着不影响播放，删掉更清爽"));
    } else if (tier === "C") {
      const at = raw.indexOf(rawCommand);
      diagnostics.push(diag("TierCInstruction", line, Math.max(0, at), Math.max(1, at + rawCommand.length), `C 级指令（游戏内/依赖运行时信号）：${rawCommand}（网页端多数忽略）`));
    } else if (tier === null) {
      const at = raw.indexOf(rawCommand);
      const fixed = SPELLING_FIX[rawCommand];
      const guess = fixed ?? nearest(rawCommand, CONTROLLERS.map((s) => s.command));
      diagnostics.push(diag("NoSuchController", line, Math.max(0, at), Math.max(1, at + rawCommand.length),
        `未知指令：${rawCommand}（引擎 warn 后跳过该行）`,
        guess ? `是否想写 [${guess}(…)]？` : `可用的 A/B 级指令见 CONTROLLERS（${MODELED.size} 个）`));
    } else if (tier === "A" || tier === "B") {
      if (rawCommand === "end") {
        diagnostics.push(diag("NotReadByEngine", line, 1, Math.max(2, raw.indexOf("]")), "`[End]` 未在运行时注册 → warn `unknown_command end` 后停在最后一帧", "改用 [endtip(block=true)] 或 [Blocker(a=1, r=0, g=0, b=0, fadetime=1, block=true)]"));
      }
    }
  } else {
    if (spec.runtimeRegistered === false) {
      diagnostics.push(diag("NotReadByEngine", line, 1, Math.max(2, raw.indexOf("]")),
        `运行时未注册该指令：${rawCommand}`, spec.note));
    }
    if (spec.tier === "C") {
      diagnostics.push(diag("TierCInstruction", line, 1, Math.max(2, raw.indexOf("]")), `C 级指令：${spec.command}（网页端多数忽略）`));
    }
  }
  if (!spec) {
    const fixed = SPELLING_FIX[rawCommand];
    if (fixed) {
      const at = raw.indexOf(rawCommand);
      diagnostics.push(diag("SpellingDrift", line, Math.max(0, at), Math.max(1, at + rawCommand.length), `拼写漂移：${rawCommand} → ${fixed}（引擎按字面分发，官方语料里也有）`, `改成 [${fixed}(…)]`));
    }
  }

  // ── 参数 ────────────────────────────────────────────────────────────────
  // 兜底形态 `[Delay=2]`（无括号）：storyPack 把 `[...]` 里唯一的 `k=v` 收进
  // args，但没有参数表 span；这里补一条 spans，保证"见到的键都进诊断"。
  const spans = paramSpans(raw);
  if (raw[0] === "[" && spans.length === 0 && Object.keys(dsl.args).length) {
    const closeAt = raw.lastIndexOf("]");
    for (const [key, value] of Object.entries(dsl.args)) {
      const at = raw.indexOf(`${key}=`);
      if (at === -1) continue;
      spans.push({
        key,
        valueRaw: String(value),
        from: at,
        to: closeAt,
        keyFrom: at,
        valueFrom: at + key.length + 1,
        valueTo: closeAt,
      });
    }
  }
  const declaredRequired = spec ? spec.required : [];
  const declaredOptional = spec ? spec.optional : [];
  /** @type {ParseParam[]} */
  const params = [];
  /** @type {Set<string>} */
  const seenKeys = new Set();
  const isDialogueForm = dsl.kind === "dialogue";

  for (const span of spans) {
    if (!span.key) {
      diagnostics.push(diag("UnknownParameter", line, span.from, span.to, `参数缺少 \`key=\`：\`${span.valueRaw}\``, "写成 key=value"));
      continue;
    }
    const key = span.key;
    const declared = declaredRequired.find((m) => m.name === key) ?? declaredOptional.find((m) => m.name === key) ?? null;
    let known = declared !== null;
    if (!known && spec) {
      const ciMatch = declaredRequired.concat(declaredOptional).find((m) => m.name.toLowerCase() === key.toLowerCase());
      if (ciMatch) {
        known = true;
        diagnostics.push(diag("UnknownParameter", line, span.keyFrom, span.valueFrom,
          `参数键大小写敏感：\`${key}\` ≠ \`${ciMatch.name}\`（引擎按 \`${ciMatch.name}\` 查 → 取缺省）`,
          `改成 ${ciMatch.name}=…`));
      }
    }
    if (seenKeys.has(key)) {
      diagnostics.push(diag("InstrumentRedundant", line, span.keyFrom, span.keyFrom + key.length, `参数重复：${key}（引擎取第一个）`, "删掉重复的那个"));
    }
    seenKeys.add(key);

    const value = Object.prototype.hasOwnProperty.call(dsl.args, key) ? dsl.args[key] : span.valueRaw;
    /** @type {ParseParam} */
    const param = {
      name: declared ? declared.name : key,
      key,
      value,
      raw: span.valueRaw,
      type: declared ? declared.type : "string",
      hint: declared ? declared.hint : "未声明（引擎静默忽略）",
      provided: true,
      known,
      corpusOnly: Boolean(declared && declared.corpusOnly),
      from: declared ? span.keyFrom : span.from,
      to: declared ? span.keyFrom + key.length : span.to,
      ...(declared && declared.default !== undefined ? { default: declared.default } : {}),
      ...(declared && declared.enums ? { enums: declared.enums } : {}),
    };

    if (declared) {
      const meta = VALUE_TYPES.has(declared.type) ? declared.type : "string";
      if (!VALUE_TYPES.has(meta)) {
        diagnostics.push(diag("UnknownError", line, span.valueFrom, span.valueTo, `参数 ${key} 的类型元数据非法：${declared.type}`));
      }
      const check = checkValue(span.valueRaw, declared);
      if (!check.typeOk) {
        // `silent`（$变量 / 数字写的布尔 / 值尾多出的 `)]`）引擎只悄悄回落缺省，
        // 所以在编辑器里降级成 warning —— 报 error 的应当是"这行真的会坏"。
        diagnostics.push(diag("ParameterTypeMismatch", line, span.valueFrom, Math.max(span.valueFrom + 1, span.valueTo),
          `参数 ${key}=${span.valueRaw} 的类型不是 ${declared.type}${check.silent ? "（引擎回落缺省值）" : ""}`,
          `改成 ${declared.type === "bool" ? "true / false" : declared.type === "int" ? "整数" : "数字"}`,
          check.silent ? "warning" : undefined));
      } else if (!check.rangeOk) {
        const range = `范围 ${declared.min ?? "-∞"}..${declared.max ?? "+∞"}`;
        diagnostics.push(diag("ParameterOutOfRange", line, span.valueFrom, Math.max(span.valueFrom + 1, span.valueTo), `参数 ${key}=${span.valueRaw} 超出${range}`, `用 ${declared.default !== undefined ? `缺省 ${String(declared.default)}` : "范围内的值"}`));
      } else if (!check.enumOk) {
        diagnostics.push(diag("ParameterOutOfRange", line, span.valueFrom, Math.max(span.valueFrom + 1, span.valueTo),
          `枚举值 ${key}=${span.valueRaw} 不在语料观察集内（引擎回落默认）`, `可选：${enumValues(declared).join(" / ")}`));
      }
      if (declared.corpusOnly) {
        diagnostics.push(diag("NotReadByEngine", line, span.keyFrom, span.keyFrom + key.length, `运行时当前版本不读该参数：${key}`, declared.hint));
      }
    } else if (spec) {
      const candidates = declaredRequired.concat(declaredOptional).map((m) => m.name);
      const guess = nearest(key, candidates);
      diagnostics.push(diag("UnknownParameter", line, span.keyFrom, span.valueTo,
        `未声明的参数键：${key}`, guess ? `是否想写 ${guess}=…？` : "可用键见控制器规格（CONTROLLERS）"));
    }
    params.push(param);
  }

  // 值里的 `$变量` 不发诊断；但如果整行只有 `$` 变量、没有字面数字，运行时的
  // toNumber 会回落缺省（如 `Delay(time="$x")` → 0）——只标在参数上，不重复报。
  /** @type {ParseParam[]} */
  const providedRequired = [];
  /** @type {ParseParam[]} */
  const providedOptional = [];
  /** @type {string[]} */
  const missing = [];
  for (const m of declaredRequired) {
    const found = params.find((p) => p.known && p.name === m.name);
    if (found) providedRequired.push(found);
    else if (m.alt) {
      const alt = params.find((p) => p.known && (p.name === m.alt || p.key === m.alt));
      if (alt) { providedRequired.push(alt); continue; }
      missing.push(m.name);
    } else {
      missing.push(m.name);
      /** @type {ParseParam} */
      const gap = {
        name: m.name, type: m.type, hint: m.hint, value: undefined, raw: "", provided: false,
        known: true, corpusOnly: Boolean(m.corpusOnly),
        from: 1, to: Math.max(2, raw.indexOf("]") > 0 ? raw.indexOf("]") : Math.min(2, raw.length)),
        ...(m.default !== undefined ? { default: m.default } : {}),
        ...(m.enums ? { enums: m.enums } : {}),
      };
      providedRequired.push(gap);
      // `argless: clear|hide` 的指令（`[Character]`/`[subtitle]`…）无参是官方惯用
      // 写法（语料各上万行）→ 只提示；其余指令缺必需参数 = 这行没有效果 → error。
      const soft = Boolean(spec && (spec.argless === "clear" || spec.argless === "hide"));
      diagnostics.push(diag("MissingRequiredParameter", line, gap.from, Math.min(Math.max(gap.to, gap.from + 1), Math.max(1, raw.length)),
        `缺必需参数 ${m.name}（${m.hint}）`,
        soft ? `本指令无参 = ${spec && spec.argless === "clear" ? "清除" : "收起"}；要传值就写 ${m.name}=…` : `补上 ${m.name}=…`,
        soft ? "warning" : undefined));
    }
  }
  const providedNames = new Set(providedRequired.map((p) => p.name));
  for (const p of params) {
    if (!p.known) continue;
    if (providedNames.has(p.name)) continue;
    if (declaredOptional.some((m) => m.name === p.name)) providedOptional.push(p);
  }

  // 对话 / 正文空白惯例（YSS 100B/100C 的 DSL 版）
  const bracketAt = raw.indexOf("]");
  const headEnd = bracketAt === -1 ? raw.length : bracketAt + 1;
  const tabAt = raw.indexOf("\t");
  if (tabAt >= 0) {
    if (tabAt < headEnd) {
      // 语料里 `[...]` 内的 Tab 只出现在超长 Tutorial 的续行里（5 处）；
      // commandRegex 的 `(.*)` 里 Tab 与空格等价，引擎照播 → 提示级。
      diagnostics.push(diag("UseTabInsteadSpace", line, tabAt, tabAt + 1, "参数表内用了 Tab；官方语料惯例是空格", "把 Tab 换成空格", "warning"));
    } else if (tabAt === headEnd) {
      // `[name="X"]<Tab>正文` 是官方主流之一（语料 549 行）；`[Dialog]<Tab>` 也照播。
      diagnostics.push(diag("UseSpaceInsteadTab", line, tabAt, tabAt + 1, "`]` 后用 Tab 分隔正文；二创惯例是两个空格", '`]` 后写两个空格'));
    } else {
      diagnostics.push(diag("UseSpaceInsteadTab", line, tabAt, tabAt + 1, "行内出现了 Tab（正文/缩进）", "正文里改成空格"));
    }
  }
  if (raw.startsWith("\t")) {
    diagnostics.push(diag("UseSpaceInsteadTab", line, 0, 1, "行首缩进用了 Tab；引擎只对 `[` 开头的行做指令解析", "行首改空格（或顶格写）"));
  }
  if (dsl.kind === "dialogue" || (rawCommand === "dialog" && !isDialogueForm && String(dsl.command) === "dialog")) {
    const rest = raw.slice(headEnd);
    // 语料实测：紧贴 `]`（`parser.ts:117` 的 `match[5]` 不吃前导空白）285131 行、
    // 两空格 70060 行、单空格 11997 行、Tab 549 行 —— **都能播**。所以这里只对
    // "带正文却只用一个空格"给一条提示级 warning（二创惯例是两个空格）。
    if (rest.startsWith(" ") && !rest.startsWith("  ") && String(dsl.text ?? "").trim()) {
      diagnostics.push(diag("UseSpaceInsteadTab", line, headEnd, headEnd + 1, "`]` 后只用了 1 个空格；二创惯例是两个空格", '补成两个空格'));
    }
    if (!String(dsl.text ?? "").trim() && dsl.kind === "dialogue") {
      diagnostics.push(diag("EmptyDialogue", line, headEnd, Math.max(headEnd + 1, raw.length), "空对白：引擎隐藏对话框（可当分节拍）"));
    }
  }
  if (/[ \t]+$/.test(raw)) {
    diagnostics.push(diag("TrailingWhitespace", line, raw.replace(/[ \t]+$/, "").length, raw.length, "行尾有空白（日志/对照时会显示差异）", "删掉行尾空白"));
  }
  // storyPack 用 `lastIndexOf("]")` 截断整行，所以正文里再出现 `]` 会把前面
  // 的正文"吃掉"（`[Delay(time=1)]x]y` → `args.time = "1)]x"`，只有 `y` 是正文）。
  // 两种表现各给一条 1009：`dialog/multiline/header` 的尾随文本，和参数值里的 `)]`。
  const tailBracket = rawCommand === "dialog" || rawCommand === "multiline" || rawCommand === "header" || rawCommand === "narration"
    ? String(dsl.tail ?? "").indexOf("]")
    : -1;
  if (tailBracket >= 0) {
    const at = headEnd + tailBracket;
    diagnostics.push(diag("UnclosedSymbol", line, at, at + 1, "正文里出现了 `]`：引擎按**最后一个** `]` 截断整行", "正文里避免裸 `]`（或写成全角）"));
  }
  if (raw[0] === "[" && /^\[\s*name\s*=/.test(raw) && dsl.kind !== "dialogue") {
    // `[name="A"]  他说]然后走了`：head 里多出一个 `]` → NAME_RE 失配，落进
    // `[key=value]` 兜底；引擎的 `args.name` 会是 `"A"]  他说`。
    const at = raw.indexOf("]", 6);
    if (at >= 0) {
      diagnostics.push(diag("UnclosedSymbol", line, at, at + 1,
        "正文里出现了 `]`：引擎按**最后一个** `]` 截断整行，说话人会被读成 `name` 的值",
        "正文里避免裸 `]`（或写成全角）"));
    }
  }
  if (String(dsl.text ?? "").indexOf("]") === -1 && String(dsl.tail ?? "").indexOf("]") === -1) {
    const stray = spans.find((span) => span.valueRaw.includes(")]"));
    if (stray) {
      const at = raw.indexOf(")]", stray.valueFrom);
      if (at >= 0) diagnostics.push(diag("UnclosedSymbol", line, at, at + 1, "参数值里出现了 `]`：引擎按**最后一个** `]` 截断整行", "确认这一行只有一个 `]`"));
    }
  }

  diagnostics.sort((a, b) => (a.from - b.from) || (a.code - b.code));

  return {
    ok: !diagnostics.some((d) => d.severity === "error"),
    line,
    raw,
    kind: dsl.kind === "dialogue" ? "dialogue" : "command",
    controller: rawCommand,
    controllerRaw: dsl.commandRaw ?? (dsl.kind === "dialogue" ? "name" : rawCommand),
    entity: entityOf(raw),
    canonical: spec ? spec.canonical : null,
    spec,
    category: spec ? spec.category : null,
    tier,
    required: providedRequired,
    optional: providedOptional,
    params,
    missing,
    text: String(dsl.text ?? ""),
    // 说话人优先取 tokenizer 的字段；`[name="A"]` 无尾随正文时/tokenizer 未回填时，
    // 从 `args.name` 兜底（值里可能带引号）。
    speaker: dialogueSpeaker(raw, dsl),
    comment: "",
    malformed: dsl.malformed ?? "",
    diagnostics,
  };
}

/**
 * 只取诊断（UI 的「诊断」面板：按行分组时用得上）。
 * @param {string} input @param {number} [lineNumber] @returns {Diagnostic[]}
 */
export function lineDiagnosticsOf(input, lineNumber = 0) {
  return parseLine(input, lineNumber).diagnostics;
}

// ── 文档级：Decision/Predicate 合流 + 文档 lint ──────────────────────────────

/**
 * 源里"看起来想写"的控制器名：`[` 到第一个 `]` 之间的 head，去掉 `(…)`，
 * 小写。带命名空间的引擎指令（`[Battle.Pause]`、`[Activity.ResetToEntry]`）
 * 原样保留 —— 编辑器用它做 fallback 展示/补全，不参与引擎语义。
 * @param {string} raw @returns {string}
 */
function entityOf(raw) {
  return entityRawOf(raw).toLowerCase();
}

/**
 * 同 `entityOf`，但保留源里的大小写（诊断文案里显示作者写的原样）。
 * @param {string} raw @returns {string}
 */
function entityRawOf(raw) {
  const text = String(raw ?? "");
  if (text[0] !== "[") return "";
  const close = text.indexOf("]");
  const head = text.slice(1, close === -1 ? text.length : close);
  return head.split("(")[0].split("=")[0].trim();
}

/** 与 `storyPack.NAME_RE` 同形的对话头（只用于取说话人，不改 token 化）。 */
const DIALOGUE_NAME_RE = /^name\s*=\s*"((?:\\.|[^"])*)"$/;
/** 头里混进 `]`（`[name="A"]  他说]然后走了`）时，取第一段即可。 */
const DIALOGUE_NAME_PREFIX_RE = /^\s*name\s*=\s*"((?:\\.|[^"])*)"/;

/**
 * `[name="X"]` 的说话人。
 *
 * ⚠️ 不能直接用 `storyPack.parseLine` 的 `speaker`：tokenizer 里
 * `speaker: unescapeString(dialogue[1])` 对**已去引号**的捕获组又做了一次
 * `slice(1, -1)`，于是 `[name="阿米娅"]` → `"米"`（每边掉一个字符）。
 * 语义要的是「引号里的字面文本」，所以这里按同一正则从头里取捕获组、只解码
 * 转义（\n \r \t \" \\）——与 `NAME_RE` 严格同形，不算重新实现 tokenizer。
 * `[Dialog(name=…)]` 之类走 `dlux.args.name`。
 *
 * @param {string} raw
 * @param {{kind?: string, speaker?: string, args?: Record<string, unknown>}} dsl
 * @returns {string}
 */
function dialogueSpeaker(raw, dsl) {
  if (dsl.kind === "dialogue" || (raw[0] === "[" && /^\[\s*name\s*=/.test(raw))) {
    const close = raw.lastIndexOf("]");
    const head = raw.slice(1, close === -1 ? raw.length : close);
    const match = head.match(DIALOGUE_NAME_RE) ?? head.match(DIALOGUE_NAME_PREFIX_RE);
    if (match) return decodeEscapes(match[1]).trim();
  }
  const named = dsl.args && typeof dsl.args.name === "string" ? dsl.args.name : "";
  if (named) return String(named).trim();
  return String(dsl.speaker ?? "").trim();
}

/**
 * 解码字符串转义（与 `storyPack.unescapeString` 的替换表一致，但作用于**正文**）。
 * @param {string} body @returns {string}
 */
function decodeEscapes(body) {
  return String(body).replace(/\\(.)/g, (all, ch) => (ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch));
}

/**
 * lintScript 的消息 → 我们的诊断码（保持 lintScript 的 error/warning 归类）。
 * @param {string} message
 * @returns {string}
 */
function classifyBranchMessage(message) {
  if (/Decision 缺少 options|缺少 options/.test(message)) return "DecisionOptionsMissing";
  if (/values 数量/.test(message)) return "DecisionOptionsValuesMismatch";
  if (/结束后没有合流/.test(message)) return "MissingMergePredicate";
  if (/Predicate 前没有/.test(message)) return "OrphanPredicate";
  if (/引用了 Decision 中不存在的值/.test(message)) return "UnknownDecisionValue";
  if (/单选项 Decision 的合流/.test(message)) return "RedundantPredicate";
  if (/^决策数/.test(message)) return "DecisionBudget";
  if (/^分支组合/.test(message)) return "ComboBudget";
  if (/没有收尾/.test(message)) return "MissingEnding";
  return "";
}

/**
 * 把 storyPack.lintScript 的 branch/预算类消息转成 Diagnostic（语义**完全**来自 lintScript）。
 * @param {string} text
 * @returns {Diagnostic[]}
 */
function branchDiagnostics(text) {
  const report = lintScript(text);
  /** @type {Diagnostic[]} */
  const out = [];
  /** @param {Array<{line:number,message:string}>} list @param {"error"|"warning"} severity */
  const take = (list, severity) => {
    for (const item of list) {
      const name = classifyBranchMessage(item.message);
      if (!name) continue;
      const full = name === "DecisionBudget" || name === "ComboBudget" || name === "MissingEnding";
      const span = severity === "error" ? full : false;
      const meta = DIAGNOSTIC_BY_NAME[name] ?? DIAGNOSTIC_BY_NAME.UnknownWarning;
      const offset = span ? 0 : 1;
      out.push(diag(name, item.line, span ? 0 : offset, span ? 999999 : Math.max(2, offset + 1), item.message));
      if (meta.severity !== severity) {
        const last = out[out.length - 1];
        if (last) last.severity = severity;
      }
    }
  };
  take(report.errors, "error");
  take(report.warnings, "warning");
  return out;
}

/**
 * Decision/Predicate 合流检查（复用 `storyPack.lintScript` 的语义，只取分支相关消息）。
 * 支持传入整篇文本，或 parseLine/lintDocument 产出的行数组。
 * @param {string|Array<{raw?: string}>} input
 * @returns {Diagnostic[]}
 */
export function missingMerge(input) {
  const text = typeof input === "string"
    ? input
    : (Array.isArray(input) ? input.map((line) => String(line?.raw ?? "")).join("\n") : "");
  return branchDiagnostics(text).filter((d) => [
    "MissingMergePredicate", "DecisionOptionsValuesMismatch", "DecisionOptionsMissing",
    "OrphanPredicate", "UnknownDecisionValue", "RedundantPredicate",
  ].includes(d.name));
}

/**
 * 整篇 lint（编辑器右侧「诊断」面板 / 离线 selftest 共用）。
 *
 * @param {string} text
 * @returns {DocumentLint}
 */
export function lintDocument(text) {
  const src = String(text ?? "");
  const lines = parseScript(src).map((line) => parseLine(line.raw, line.lineNumber));
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  for (const line of lines) for (const d of line.diagnostics) diagnostics.push(d);

  const branch = branchDiagnostics(src);
  for (const d of branch) diagnostics.push(d);
  // 每篇只应有一个 header
  const headers = lines.filter((line) => line.controller === "header");
  for (let i = 1; i < headers.length; i += 1) {
    const extra = headers[i];
    if (!extra) continue;
    diagnostics.push(diag("InstrumentRedundant", extra.line, 1, Math.max(2, extra.raw.indexOf("]")), "`[header]` 应只出现一次（后续的会被引擎当普通指令）", "删掉多余的行"));
  }
  diagnostics.sort((a, b) => (a.line - b.line) || (a.from - b.from) || (a.code - b.code));

  const report = lintScript(src);
  /** @type {Record<string, number>} */
  const controllers = {};
  for (const line of lines) {
    if (line.kind !== "command" && line.kind !== "dialogue") continue;
    if (!line.controller) continue;
    controllers[line.controller] = (controllers[line.controller] ?? 0) + 1;
  }
  const toc = report.toc.map((item) => ({ line: item.line, text: item.text }));

  return {
    lines,
    diagnostics,
    stats: {
      controllers,
      decisions: report.decisions,
      combos: report.combos,
      lines: lines.length,
      errors: diagnostics.filter((d) => d.severity === "error").length,
      warnings: diagnostics.filter((d) => d.severity === "warning").length,
    },
    toc,
    merge: missingMerge(src),
  };
}

/**
 * 逐行取诊断（按行号索引），供 UI 侧栏直接使用。
 * @param {string} text @returns {Map<number, Diagnostic[]>}
 */
export function diagnosticsByLine(text) {
  /** @type {Map<number, Diagnostic[]>} */
  const map = new Map();
  for (const d of lintDocument(text).diagnostics) {
    const list = map.get(d.line) ?? [];
    list.push(d);
    map.set(d.line, list);
  }
  return map;
}

/** @param {string} text @returns {DocumentLint["stats"]} */
export function documentOf(text) {
  return lintDocument(text).stats;
}

/**
 * 取一段文本里的 `[Cmd(...)]` 行（`blocksOf`）。
 * @param {string} text @returns {ParseResult[]}
 */
export function blocksOf(text) {
  return parseScript(String(text ?? "")).map((line) => parseLine(line.raw, line.lineNumber));
}

// ── 补全 ────────────────────────────────────────────────────────────────────

/**
 * 行首片段补全（空行 / 无 `[` 时）。
 * @type {Completion[]}
 */
const SNIPPETS = [
  { label: '[name=""]  对白', insertText: '[name=""]  ', detail: "对白行：] 后两个空格", kind: "snippet" },
  { label: "[Dialog]", insertText: "[Dialog]", detail: "收起对白条", kind: "snippet" },
  { label: "[Header(...)] 首行", insertText: '[Header(key="fanfic_demo")]  ', detail: "首行元数据；] 后是标题", kind: "snippet" },
  { label: "[Background(...)] 换场", insertText: '[Background(image="", screenadapt="coverall")]', detail: "换背景（配合 Blocker 黑场）", kind: "snippet" },
  { label: "[Character(...)] 立绘", insertText: '[Character(name="", fadetime=0.5)]', detail: "按角色摆放立绘", kind: "snippet" },
  { label: "[Delay(time=…)] 停顿", insertText: "[Delay(time=1)]", detail: "只认 time", kind: "snippet" },
  { label: "[Blocker(...)] 黑场", insertText: "[Blocker(a=1, r=0, g=0, b=0, fadetime=1, block=true)]", detail: "全屏色块", kind: "snippet" },
  { label: "[Decision]+[Predicate] 分支", insertText: '[Decision(options="A;B", values="1;2")]', detail: "写值 + 闸门；结束要合流 Predicate", kind: "snippet" },
  { label: "// 注释", insertText: "// ", detail: "整行丢弃", kind: "snippet" },
];

/**
 * 由值文本造补全（枚举 / 资源 key）。
 * @param {string} value 建议值
 * @param {string} prefix 光标前的值 token（含已写的引号）
 * @param {string} detail
 * @returns {Completion}
 */
function valueCompletion(value, prefix, detail) {
  // `insertText` 是"整段替换 prefix"的语义：prefix 从引号（若已写）到光标，
  // 替换后得到带完整引号的字面量。这样 `screenadapt=co`、`screenadapt="co`、
  // `screenadapt=` 三种光标位置都能直接替换。
  const quote = /^['"]/.test(prefix) ? prefix[0] : '"';
  return {
    label: `${quote}${value}${quote}`,
    insertText: `${quote}${value}${quote}`,
    detail,
    kind: "value",
  };
}

/**
 * 制表补全（YSS 的 AStoryXRule 补全位；editor 用 Tab 或 Ctrl+Space 触发）。
 *
 * context 可以是**整行字符串**，或 `{text|line, cursor, prefix, assets}` ——
 * 编辑页（task-7）用 `{line, cursor, prefix}`。`prefix` 是「正在被替换的
 * token」（缺省从 `text` 光标前推导）。
 *
 * @param {string} [prefix]
 * @param {string|CompletionContext} [context]
 * @returns {Completion[]}
 */
export function completions(prefix, context) {
  /** @type {string} */
  let text = "";
  /** @type {number} */
  let cursor = 0;
  /** @type {string|undefined} */
  let explicitPrefix;
  /** @type {CompletionContext["assets"]} */
  let assets;
  if (typeof context === "string") {
    text = context;
    cursor = context.length;
  } else if (context && typeof context === "object") {
    text = String(context.text ?? context.line ?? "");
    cursor = Math.max(0, Math.min(text.length, Math.trunc(Number(context.cursor ?? text.length))));
    explicitPrefix = context.prefix;
    assets = context.assets;
  }
  const before = text.slice(0, cursor);
  const rawPrefix = explicitPrefix !== undefined
    ? String(explicitPrefix)
    : (/(?:^|[\s,([\]])([^\s,([\]]*)$/.exec(before)?.[1] ?? "");
  const hasBracket = before.lastIndexOf("[") > before.lastIndexOf("]");
  const limit = 60;

  // 1) 控制器名：`[` 之后、`(` 之前
  /** 当前值 token（用于引号风格）：`=` 与光标之间的原文。 */
  /** @param {string} text @returns {string} */
  const prefixFor = (text) => {
    const eq = text.lastIndexOf("=");
    const comma = Math.max(text.lastIndexOf(","), text.lastIndexOf("("));
    return eq > comma ? text.slice(eq + 1) : "";
  };

  if (hasBracket) {
    const openAt = before.lastIndexOf("[");
    const afterBracket = before.slice(openAt + 1);
    const isControllerToken = !afterBracket.includes("(") && !afterBracket.includes(")");
    if (isControllerToken) {
      const token = (explicitPrefix !== undefined ? rawPrefix.replace(/^\[/, "") : afterBracket).trim();
      const lower = token.toLowerCase();
      return CONTROLLERS
        .filter((spec) => spec.tier !== "C")
        .filter((spec) => (lower ? spec.command.startsWith(lower) || spec.canonical.toLowerCase().startsWith(lower) : true))
        .sort((a, b) => (b.tier === "A" ? 1 : 0) - (a.tier === "A" ? 1 : 0))
        .slice(0, limit)
        .map((spec) => {
          const skeleton = formatLine(spec.command, {});
          return {
            label: spec.canonical,
            insertText: skeleton.startsWith("[") ? skeleton.slice(1) : skeleton,
            detail: `${spec.category} · [${spec.canonical}] ${spec.summary}`,
            kind: /** @type {"controller"} */ ("controller"),
            insertTextFull: skeleton,
            documentation: `${spec.engineRef}\n${spec.example}`,
          };
        });
    }

    // 2) 参数名 / 值：定位 `[Cmd(` 之后的当前片段
    const openParen = before.lastIndexOf("(");
    const segment = before.slice(openParen + 1);
    const spec = parseControllerSpec(afterBracket.slice(0, afterBracket.indexOf("(")));
    if (spec) {
      const eq = segment.lastIndexOf("=");
      const lastComma = Math.max(segment.lastIndexOf(","), -1);
      const valueStart = eq > lastComma ? eq : -1;
      // 2a) 值补全（`=` 之后）
      if (valueStart >= 0) {
        const partial = segment.slice(valueStart + 1).replace(/^\s+/, "");
        const keyText = segment.slice(lastComma + 1, valueStart).trim();
        const metas = spec.required.concat(spec.optional);
        const meta = metas.find((m) => m.name === keyText || m.name.toLowerCase() === keyText.toLowerCase()) ?? null;
        const list = meta && meta.enums ? enumValues(meta) : [];
        /** @type {Completion[]} */
        const out = [];
        for (const value of list) {
          if (partial && !value.toLowerCase().startsWith(partial.replace(/^["']/, "").toLowerCase())) continue;
          out.push(valueCompletion(value, prefixFor(before), `${keyText}= ${meta ? meta.hint : ""}`));
        }
        if (meta && meta.type === "string" && assets) {
          const pool = assetPoolFor(meta.name, assets);
          for (const value of pool) {
            if (partial && !value.toLowerCase().startsWith(partial.replace(/^["']/, "").toLowerCase())) continue;
            out.push(valueCompletion(value, prefixFor(before), `${keyText}= 资源表`));
          }
        }
        return out.slice(0, limit);
      }
      // 2b) 参数名补全
      /** @type {Set<string>} */
      const used = new Set();
      for (const chunk of segment.split(",")) {
        const key = chunk.split("=")[0]?.trim();
        if (key) used.add(key.toLowerCase());
      }
      const token = rawPrefix.trim();
      const metas = spec.required.concat(spec.optional);
      const out2 = [];
      for (const meta of metas) {
        if (token && !meta.name.toLowerCase().startsWith(token.toLowerCase())) continue;
        if (!token && used.has(meta.name.toLowerCase())) continue;
        const placeholder = placeholderFor(meta);
        const enums = enumValues(meta);
        const exampleValue = meta.enums && enums.length ? (placeholder || enums[0]) : placeholder;
        out2.push({
          label: meta.name,
          // `insertText` = **整段替换**已输入的键名前缀（`fade` → `fadetime="0"`）。
          insertText: meta.type === "bool" || meta.type === "number" || meta.type === "int"
            ? `${meta.name}=${exampleValue}`
            : `${meta.name}="${exampleValue}"`,
          detail: `${meta.type}${meta.default !== undefined ? ` 缺省 ${String(meta.default)}` : ""} — ${meta.hint}${meta.corpusOnly ? "（运行时当前不读）" : ""}`,
          kind: /** @type {"argument"} */ ("argument"),
          insertTextFull: `[${spec.canonical}(${meta.name}=…)]`,
        });
      }
      return out2.slice(0, limit);
    }
  }

  // 3) 行首：片段 + 命令名（不带 `[` 也允许）
  const token = rawPrefix.trim();
  const out = [];
  for (const snippet of SNIPPETS) {
    if (token && !snippet.label.toLowerCase().includes(token.toLowerCase())) continue;
    out.push(snippet);
  }
  for (const spec of CONTROLLERS) {
    if (spec.tier === "C") continue;
    if (token && !spec.command.startsWith(token.toLowerCase())) continue;
    const skeleton = formatLine(spec.command, {});
    out.push({
      label: `[${spec.command}]`,
      insertText: skeleton.startsWith("[") ? skeleton.slice(1) : skeleton,
      detail: `${spec.category} · ${spec.summary}`,
      kind: /** @type {"snippet"} */ ("snippet"),
      insertTextFull: skeleton,
    });
  }
  return out.slice(0, limit);
}

/**
 * 资源表池（context.assets）。
 * @param {string} name @param {NonNullable<CompletionContext["assets"]>} assets @returns {string[]}
 */
function assetPoolFor(name, assets) {
  const key = name.toLowerCase();
  if (key === "image") return (assets.images ?? []).concat(assets.backgrounds ?? []);
  if (key === "imagegroup" || key === "cggroup") return assets.backgrounds ?? [];
  if (key === "key" || key === "intro") return (assets.music ?? []).concat(assets.sounds ?? []);
  if (key === "channel") return assets.sounds ?? [];
  if (key === "name" && (assets.characters ?? []).length) return assets.characters ?? [];
  if (key === "head") return assets.characters ?? [];
  if (key === "res") return assets.images ?? [];
  return [];
}

/**
 * 缺省占位值（补全骨架 / formatLine 空值）。
 * @param {ValueMeta} meta @returns {string}
 */
function placeholderFor(meta) {
  if (meta.type === "number" || meta.type === "int") return String(typeof meta.default === "number" ? meta.default : 0);
  if (meta.type === "bool") return String(typeof meta.default === "boolean" ? meta.default : false);
  if (meta.type === "enum") {
    const list = enumValues(meta);
    if (meta.default !== undefined) return String(meta.default);
    return list[0] ?? "";
  }
  if (meta.default !== undefined && typeof meta.default !== "string") return String(meta.default);
  return typeof meta.default === "string" ? meta.default : "";
}

// ── 格式化（palette 插入 / 未来的 formatter） ───────────────────────────────

/**
 * 转义双引号字符串。
 * @param {string} value @returns {string}
 */
function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

/**
 * 值 → canonical 文本。
 * @param {unknown} value @param {ValueMeta|null} meta @returns {string}
 */
function formatValue(value, meta) {
  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item)).join(";");
    return quote(joined);
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value ?? "");
  const type = meta ? meta.type : "string";
  if ((type === "number" || type === "int") && /^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)) return text;
  if (type === "bool" && /^(true|false)$/i.test(text)) return text.toLowerCase();
  if (text === "true" || text === "false") return text;
  return quote(text);
}

/**
 * 规范化一行：`formatLine("delay", {time: 0.3})` → `[Delay(time=0.3)]`。
 *
 * - `controller` 可以是命令名（`"camerashake"`）或 ControllerSpec；
 * - `values` 的键按声明名匹配（大小写不敏感）；`text` = `]` 之后的正文；
 * - 值为 `undefined`/`null` 的键跳过；无 required 且 values 为空 → 裸命令（`[Dialog]`）；
 * - dialog：给 `name` → `[name="X"]  正文`，否则 `[Dialog(...)]  正文`。
 *
 * @param {string|ControllerSpec} controller
 * @param {Record<string, unknown>} [values]
 * @returns {string}
 */
export function formatLine(controller, values = {}) {
  const spec = typeof controller === "string" ? parseControllerSpec(controller) : controller;
  const canonical = spec ? spec.canonical : String(controller ?? "");
  const input = values && typeof values === "object" ? values : {};
  /** @type {string|undefined} */
  let trailing;
  if (Object.prototype.hasOwnProperty.call(input, "text")) trailing = String(input.text ?? "");
  const entries = Object.entries(input).filter(([key, value]) => key !== "text" && value !== undefined && value !== null);

  /** @param {string} name @returns {[string, unknown]|null} */
  const pick = (name) => {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found ?? null;
  };

  /** @type {Array<{meta: ValueMeta|null, name: string, value: unknown}>} */
  const ordered = [];
  if (spec) {
    for (const meta of spec.required) {
      const found = pick(meta.name);
      ordered.push({ meta, name: meta.name, value: found ? found[1] : placeholderFor(meta) });
    }
    for (const meta of spec.optional) {
      const found = pick(meta.name);
      if (found) ordered.push({ meta, name: meta.name, value: found[1] });
    }
  }
  for (const [key, value] of entries) {
    if (ordered.some((item) => item.name.toLowerCase() === key.toLowerCase())) continue;
    ordered.push({ meta: null, name: key, value });
  }

  // dialog 的说话人形态：`[name="X"]  正文`
  if (spec && spec.special === "dialog") {
    const speaker = pick("name");
    const rest = ordered.filter((item) => item.name !== "name");
    if (speaker) {
      const head = `[name=${formatValue(speaker[1], { name: "name", type: "string", hint: "" })}]`;
      return trailing ? `${head}  ${trailing}` : head;
    }
    if (rest.length === 0) {
      return trailing ? `[Dialog]  ${trailing}` : "[Dialog]";
    }
  }

  if (ordered.length === 0) {
    const empty = spec ? spec.argless !== "none" || spec.required.length === 0 : true;
    return empty && !trailing ? `[${canonical}]` : `[${canonical}]${trailing ? `  ${trailing}` : ""}`;
  }
  const args = ordered
    .map((item) => `${item.meta ? item.meta.name : item.name}=${formatValue(item.value, item.meta)}`)
    .join(", ");
  const head = `[${canonical}(${args})]`;
  return trailing !== undefined && trailing !== "" ? `${head}  ${trailing}` : head;
}

// ── 悬停 ────────────────────────────────────────────────────────────────────

/**
 * 命令 → 悬停条目。
 * @type {Record<string, HoverEntry>}
 */
export const HOOVER = (() => {
  /** @type {Record<string, HoverEntry>} */
  const out = {};
  for (const spec of CONTROLLERS) {
    out[spec.command] = {
      command: spec.command,
      title: `[${spec.canonical}]`,
      summary: spec.summary,
      anchor: spec.anchor,
      engineRef: spec.engineRef,
      tier: spec.tier,
      category: spec.category,
      example: spec.example,
    };
  }
  return out;
})();

/** `HOOVER` 的别名（大小写手感）。 */
export const HOVER = HOOVER;

/**
 * 给定光标偏移，返回该处命令 / 参数的悬停信息。
 * @param {string} text 单行（完整行）
 * @param {number} offset 0 基字符偏移
 * @returns {HoverInfo|null}
 */
export function hoverFor(text, offset) {
  const raw = String(text ?? "");
  const at = Math.max(0, Math.min(raw.length, Math.trunc(Number(offset) || 0)));
  // 只认**光标所在行**的 `[Cmd(...)]`；`from/to` 是按整篇文本的回溯片段
  // （编辑页直接把它内联渲染），`start/end` 是整篇里的 0 基 span。
  const lineStart = raw.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const lineEndAt = raw.indexOf("\n", at);
  const lineEnd = lineEndAt === -1 ? raw.length : lineEndAt;
  const line = raw.slice(lineStart, lineEnd);
  const caret = at - lineStart;
  const openInLine = line.lastIndexOf("[", caret);
  if (openInLine === -1) return null;
  const closeInLine = line.indexOf("]", openInLine);
  const head = line.slice(openInLine + 1, closeInLine === -1 ? line.length : closeInLine);
  const paren = head.indexOf("(");
  const nameEnd = paren === -1 ? head.length : paren;
  const name = head.slice(0, nameEnd).trim();
  const spec = parseControllerSpec(name) ?? (/^name\s*=/i.test(head) ? parseControllerSpec("dialog") : null);
  if (!spec) return null;
  const open = lineStart + openInLine;

  /** @type {HoverInfo} */
  const base = {
    title: `[${spec.canonical}]`,
    summary: spec.summary,
    anchor: spec.anchor,
    engineRef: spec.engineRef,
    tier: spec.tier,
    category: spec.category,
    from: line.slice(0, openInLine + 1),
    to: line.slice(0, caret),
    start: open,
    end: open + 1 + nameEnd,
    param: null,
    example: spec.example,
  };

  // 光标在参数区（`(` 之后）→ 找参数 key（span 基于**本行**计算，再平移到整篇）
  const parenInLine = line.indexOf("(", openInLine);
  if (parenInLine === -1 || caret <= parenInLine) return base;
  for (const span of paramSpans(line)) {
    if (span.key && caret >= span.from && caret <= span.to) {
      const metas = spec.required.concat(spec.optional);
      const meta = metas.find((m) => m.name === span.key || m.name.toLowerCase() === span.key.toLowerCase()) ?? null;
      base.param = meta
        ? {
          name: meta.name,
          type: meta.type,
          hint: meta.hint,
          ...(meta.default !== undefined ? { default: meta.default } : {}),
          ...(meta.enums ? { enums: meta.enums } : {}),
        }
        : { name: span.key, type: "string", hint: "未声明（引擎静默忽略）" };
      base.start = lineStart + span.from;
      base.end = lineStart + span.to;
      base.from = line.slice(0, span.from);
      base.to = line.slice(0, caret);
      break;
    }
  }
  return base;
}
