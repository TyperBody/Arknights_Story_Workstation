# 分叉契约（Decision / Predicate）

一句话：`[Decision]` **不是跳转**，它把「玩家选中的值」写进运行时状态；
`[Predicate]` 是**闸门**，只负责决定「从现在起，哪些后续片段还能被渲染」。
合流靠一条覆盖全部 values 的 `[Predicate]`，不是靠 goto。

语义来源（已逐行核实）：`engine/runtime.ts:3363-3439`、
`engine/log/semantics.ts`（`passesGate` / `parseDecision` / `parsePredicateReferences`，
runtime 与 LOG ALL 共用同一份，不会两边漂移）。

## 1. 纯语义（必须原样实现）

**闸门 `passesGate(state, line)`** —— 只有四条规则：

1. `line.command === "predicate"` → **永远放行**（它要能更新 references，不能被旧闸门挡住）；
2. `state.selectedValue === 0` → 放行（0 = 「未选择」，是初始态）；
3. `state.references === null || references.length === 0` → 放行（无约束 = 全放行）；
4. 否则：`references.includes(selectedValue)` → 放行，否则该行**被静默跳过**
   （跳过的是这**一行**，不是一段区间；片段的边界由后续 `Predicate` 改写）。

**`decision`**（`runtime.ts:3363`，原生 `DecisionPanel._ExecuteDecision`）：
- **先重置**：`selectedValue = 0; references = null`（在校验 options **之前**就重置）；
- 解析 `options`（`;` 分隔）与 `values`（`;` 分隔整数）；
  **`values` 缺项按 0 处理** → 0 恒放行。真实例子（4 选项 / 3 values）：
  `obt/memory/story_ghost_2_1.txt:643`
  ```
  [Decision(options="幽灵鲨。;……;好。;相信我吧，幽灵鲨。", values="1;2;3")]
  ```
  全语料共 10 处 options 与 values 数量不一致，都能照常播下去；
- `options` 缺失 = **无效 decision**：状态照样被清空（回到全放行），
  但**不弹面板、不产生选择**，只 warn（`invalid_parameter: decision options parameter is missing`）；
- 有选择时：面板阻塞在 `waiting_decision`，点击后把该 option 的 `value` 写入
  `selectedValue` 并记入 `choiceHistory`（`value` 可以跨 option 重复，
  历史按下标记录）。`values` 里的值**不必**是 1..N——闸门只比对数值。

**`predicate`**（`runtime.ts:3434`，原生 `DecisionPanel._ExecutePredicate`）：
- `references` 缺省 → `null` = 结束分支模式（全放行）；
- 否则按 `;` 拆分，非数字片段落到 0。
- 只读 `references`：`selectableCondition`/`visibleCondition` 在语料里存在
  （`cmdmap`：5972 条 predicate 中出现这两个键），但线上引擎**不读**——
  二创只用 `options` / `values` / `references` 三件套。

## 2. 三种规范形状

### 形状 A：单选项「语气选择」（不真正分叉）

```
[Decision(options="……米娅", values="1")]
[Predicate(references="1")]
```
`activities/act10d5/level_act10d5_st06.txt:9-10` 逐字如此；后面直奔合流后的正文。
渲染上仍会弹一次面板（给玩家一个「我在做选择」的拍子），路由只有一条。
`activities/act10d5/level_act10d5_st06.txt` 通篇用这个形状串了 4 个拍子。

### 形状 B：N 路 + 强制合流（**二创推荐**）

真实 3 路样例（`activities/act13side/level_act13side_09_beg.txt:180-190`，逐字）：

```
[Decision(options="(替夜莺买一个玩偶。);(询问定金是多少。);(反问对方耀骑士用过的盾牌能不能当做镇店之宝。)", values="1;2;3")]
[Predicate(references="1;2;3")]
[Predicate(references="1")]
[name="店主"]  谢谢惠顾！
[Predicate(references="2")]
[name="店主"]  是——啊，您是用外币结算的吗？龙门币？那您可能还得先去一趟银行。
[name="店主"]  我帮你换算一下，大概一百三十万龙门币左右吧？
[Predicate(references="3")]
[name="店主"]  盾牌？耀骑士什么时候用过盾牌？
[name="店主"]  不过，我们这里有战锤、双刃剑和最新的剑枪模型。您要不看看？
[Predicate(references="1;2;3")]
```

读法（与规则一一对应）：
- `[Decision]` 写选中值，随后 `references=null` → 全放行；
- 紧随的 `[Predicate(references="1;2;3")]` 是**官方惯用的「重开闸门」**：
  它把 references 设为全集（三种选择都能过）。没有它、又存在一个
  `references="3"` 的片段时，A/B 选择的玩家会掉出后续内容；
- 每个分支片段以 `names`/`charslot` 重新落地本片段的立绘与会话状态
  （见 §4），以一条只含本支 values 的 `Predicate` 开头；
- 结尾 `[Predicate(references="1;2;3")]` = **合流**：三条路都恢复全放行。
  **这条必须写**：否则合流点之后的内容只属于最后一条 fragment
  （A/B 玩家会被最后一条 `Predicate(references="3")` 挡掉）。

同一形状的另一处（更紧凑，2 路 + 嵌套 1 路）：
`activities/act37side/level_act37side_02_beg.txt:59-67`：

```
[charslot(slot="m",name="avg_1019_siege2_1#1$2",focus="n")]
[Decision(options="“责任”是一个很奇妙的东西。;对罗德岛的大家，我也做不到轻易放手。;我们都一样。", values="1;2;3")]
[Predicate(references="1;2;3")]
[Decision(options="那些公爵也正是吃准了你放不下那些需要你的人。",values="1")]
[Predicate(references="1")]
[charslot(slot="m",name="avg_1019_siege2_1#8$2",focus="m")]
[name="维娜"]我不也吃准了那些公爵想要维持自己势力的心思吗？
```

### 形状 C：嵌套（分支里再决策）

`Decision → Predicate(1;2;3) → Decision → Predicate(…) → 合流`。
嵌套的**每一层**都要各自合流；外层合流点用外层的 values 集合。
`act37side/level_act37side_02_beg.txt` 就是这种：外层 3 路 → 重开闸门 →
内层 1 路 → 内层合流（单选项的合流可省，但语义上等价）。

## 3. `maxStates=1e4` 与放大规则

### 3.0 收尾：`[End]` vs `[endtip]`（与分支无关，但最常踩）

线上 StoryPlayer 的指令允许表里
**只有 `endtip`，没有 `end`**。脚本写 `[End]` 会命中 `executeCommand` 的
`unknown_command` 分支——`warn` 后跳过，于是最后一帧停在画面上（观感就是
「卡住/黑屏」）。收尾**二选一**（`[End]` 只是"能留但会 warn"的兼容写法）：

| 写法 | 引擎行为 | 建议 |
|---|---|---|
| `[endtip(block=true)]` | 唯一注册的收尾指令；阻塞等点击并显示 endtip。`block=true` 与解析器自动补的隐式 `endtip` 完全一致 | **推荐**（显式、零 warn） |
| `[Blocker(a=1, r=0, g=0, b=0, fadetime=1, block=true)]` | `Blocker` 是已注册指令；画面淡黑收束，之后由隐式 `endtip` 收尾 | 推荐（内置样例即此写法） |
| `[End]` | ASCII 里大量存在（534 次），但网页引擎**不认**：warn `unknown_command end` | 可留（兼容游戏侧脚本），但会有 warn |

`lintScript()` 的判定：`endtip` / `end` / `Blocker(a=1)` 任一个都算「有收尾」；
三者都没有才 warning。**新脚本建议只用前两种**：`[End]` 在网页引擎里会有 warn
（游戏侧 ASCII 里确实大量存在，兼容保留）。`lint.mjs` 的严格模式下 `[End]` 不单独告警——
但日志里会有 `unknown_command end`。

### 3.1 分支放大与退化

LOG ALL 的符号分析（`engine/log/symbolicFlow.ts`）把每条「选择组合」记成一个
状态：`analyzeStoryFlow` 的 `MAX_STATES = 10_000`；条件乘积另有一道
`MAX_PRODUCTS = 256`（`log/condition.ts`）。超限**不报错**：

> `states.length > maxStates` → 先把各路径的累积文本按各自条件结算，再**塌缩成
> 一个初始状态**（value=0、references=null，闸门全开），`degraded = true`；
> 剩余脚本按**无条件全量文本**继续收集。玩家照样能播完，只是 LOG ALL 面板
> 失去「这行属于哪条支线」的标注。

放大是**乘法**：k 个 `Decision`、选项数 `n₁…n_k` → 组合数 `n₁×…×n_k`
（实际状态还受 `Predicate` 收窄影响，但上界是这个乘积）。因此：

- **一部脚本 ≤ 8 个 `Decision`，且 `∏ options ≤ 64`**（skill 硬约束，
  `lintScript(script, {maxDecisions = 8, maxCombos = 64})`）；
- 官方语料里 197/479 个含 Decision 的文件超过 8 个决策
  （最多 66 个：`activities/act8mini/level_act8mini_st01.txt`），
  它们靠大量「单选项决策」（形状 A，倍率 1）把乘积压住——
  形状 A 不计入放大，可以放心多写；
- 超出预算 → **拆章**：`build/chapters.json` + `build/page.wikitext` 每章一篇，
  而不是在一个脚本里堆 30 个选项（research §2.3 的结论）。

## 4. 分支片段的「落地」要求（POST）

引擎的闸门是**逐行**的：被跳过的分支片段里也可能夹着 `[charslot]`、
`[Character]`、`[PlayMusic]`、`[Subtitle]`。合流之后，**立绘与音频不会
自动恢复成另一条支线期望的状态**——因为那些命令压根没执行过。

规则（skill 硬约束）：

1. 每个分支片段**开头**用一个**引擎真正会动**的写法把本片段的立绘/会话
   状态重新落地一遍，不要依赖「进入 decision 之前」的状态：

   ```
   [Character(name="char_130_doberm_ex", fadetime=0.6)]     # 首选：官方换场惯例
   [charslot(slot="m", name="char_130_doberm_ex", duration=0.5, isblock=true)]
   ```

   - `[Character(name=…, fadetime=…)]` 是官方最常用的「谁在场」写法
     （`fadetime` 秒渐入；缺省 0.15）；`[Character]`（无 name）清该槽；
   - `[charslot]` 只有当**槽位**语义必要（多角色同时站位）时才用；它的
     `duration` 是 0 基、会被 `animateRatio` 缩放，`duration<=0` 直接跳变；
     要等它演完就加 `isblock=true`（且 `end` 非 `false`），否则命令立刻返回；
   - 「淡入一个场景/换场」的正确惯例是**三条一起**：
     `[Blocker(a=1, r=0, g=0, b=0, fadetime=…, block=true)]`（遮黑）→
     `[Background(image=…, fadetime=…, block=true)]`（换背景）→
     `[Character(name=…, fadetime=…)]`（立绘入场），再
     `[Blocker(a=0, …, fadetime=…, block=true)]` 淡出黑场。
     只写 `[charslot(duration=…)]` 会在画面上表现为「立绘瞬移/不动」。
2. 合流点（`[Predicate(references="全部 values")]`）之后，如果几条支线
   的舞台状态不同，**再落地一次合流后的状态**；
3. 音频用 `loop`/`channel` 收尾：分支里起的 `PlaySound(loop=true)` 要在
   合流前 `[StopSound(channel=…)]`，否则会串台（`PlaySound` 的 channel
   缺省 = key，`StopSound` 的 channel 缺省 = key，对得上才停得掉）。

## 5. 短分支的确定性跳转（编译期）

`source/` 里保存的是**带 `@tag` 控制位**的作者脚本（`[Cmd@tag(...)]`，
`@tag` 只给取景器用，引擎按字面分发——所以**编译产物必须去掉 `@tag`**，
见 `storyPack.js::stripControls` 与 `library.js::stripControls`）。

- **< 8 段**：用可寻址 chunk，每加上 `[Subtitle(text="@chunk:N")]` 作锚点，
  取景器/自动播放可精确跳到第 N 段；
- **≥ 8 段**：在 `source/facts.md`（带日期）用文本搜索定位，而不是堆 chunk id。

这条是**工具链约定**，不影响引擎语义：引擎只看到去掉 `@tag` 后的产物。

## 5.5 缩进（可读性约定，不影响语义）

`[Decision]` 区域可以排成层级：`[Decision]` 顶格、它的每个 `[Predicate]`
（含合流）缩进 **1 级 = 两个空格**、线路体再缩进 **1 级**：

```
[Decision(options="A;B", values="1;2")]
  [Predicate(references="1")]
    [name="阿米娅"]  走这边。
  [Predicate(references="2")]
    [name="杜宾"]  明白了。
  [Predicate(references="1;2")]
    [name="阿米娅"]  出发吧。
[endtip(block=true)]
```

- **引擎不 trim**：`parser.ts` 的 `commandRegex = /^\[\s*…/` 没有 `m` 标志、跑在
  整行上，所以**行首有空白 = 该行落 `narration`**（整行当旁白文本显示）。
- 因此打包/送引擎前要归一化：`storyPack.stripIndentForEngine`（`library.stripControls`
  会调它）只对**去缩进后以 `[` 开头**的行去掉行首空白；纯旁白行与 `\` 续行的物理行
  原样保留。归一化后与顶格版**逐字节相等**，`revision` 也一致。
- 编辑器（`/editor/:packId`）里：工具条「缩进区域」= 整段 `regionIndentPlan`
  （幂等，与选区无关）；跨行选区 + `Tab` / `Shift+Tab` = `indentLines` 一格；
  `Ctrl/Cmd+Alt+I` = 缩进区域，`Ctrl/Cmd+[` / `]` = 反缩进 / 缩进。
  一次动作为一条撤销条目；行首 **Tab** 与「宽度非 2 的整数倍」各有提示级诊断
  （`UseSpaceInsteadTab` / `BadIndentation`）。

## 6. 分支 lint 清单

`node scripts/fanfic/lint.mjs <packDir>`（纯函数 `lintScript()`，
`src/akstage/local/storyPack.js`）逐条检查；下表是它覆盖的**全部**分支规则：

| # | 检查 | 级别 | 通过条件 |
|---|---|---|---|
| 1 | `Decision` 有 `options` | error | `arg(args,"options") !== undefined` |
| 2 | `Decision` 的 `values` 数量与 `options` 一致 | error（多选项时）| 单选项可省略 `values`；4/3 这类不一致是 warning 级 |
| 3 | 每个 `Predicate` 有 `references` | error | `references` 未写 = 结束分支模式（合法但少见），lint 报 error 提示显式写 |
| 4 | `Predicate` 引用的值 ∈ 该 `Decision` 的 values | warning | 引用不存在的值 = 该片段永不执行 |
| 5 | `Decision` 有**合流** `Predicate`（references 覆盖全部 values） | error | 没有合流 = 后续内容只属于最后一条 fragment |
| 6 | 决策数 ≤ 8 | warning | 超过 → 建议拆章 |
| 7 | `∏ options ≤ 64` | warning | 超过 → `maxStates=1e4` 退化（只影响 LOG ALL） |
| 8 | 收尾：结尾是 `[endtip]`、`[end]` 或 `[Blocker(a=1, …)]` | warning | 三者都没有 → 内容会停在最后一帧。`[End]` 合法但引擎会 warn `unknown_command end`；**推荐 `[endtip(block=true)]`** 或用 `[Blocker(a=1)]` 淡黑收束 |

另有三条**与分支无关但同批检查**的行级规则：行尾空白、空对白（`[name="X"]` 后
无正文）、裸文本行（引擎当旁白，建议写成 `[Dialog]` 或 `[Narration]`）——
都只报 warning，不影响播放。

自动化对拍建议：三选项脚本**逐条选过一遍**，确认合流后内容一致
（research §5 的验收项）；机器上可直接用 `node scripts/fanfic/lint.mjs --json`
把 8 条检查的结论喂给 CI。
