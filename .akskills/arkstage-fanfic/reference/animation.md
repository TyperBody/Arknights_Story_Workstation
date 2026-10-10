# 动画与演出：引擎**真正**会动的写法

> 本页的每一条都从 `Torappu` 的 StoryPlayer 运行时（`.akresearch/repo/src/widgets/StoryPlayer/engine/runtime.ts`）
> 与官方语料（`.akresearch/akgd/zh_CN/gamedata/story/`）里核对过。
> 结论先行：**参数键大小写敏感，命令名大小写不敏感**；写错键不会报错，只会静默回落默认值，
> 于是"动画好奇怪"。

## 1. 三条铁律

1. **`Delay` 只认 `time`**（`runtime.ts:1243-1256` 的 `exactArg(args,"time")`）。
   `duration` / `TIME` / `times` / `tinme` 一律按 0 处理 → 节奏全塌。
2. **淡入用 `fadetime`（命令）或 `duration`（`charslot`）**，两者不是同义词：
   - `[Background]` `[Image]` `[Blocker]` `[CameraEffect]` `[curtain]` `[focusout]` → `fadetime`
   - `[Character]` → `fadetime`（缺省 0.15s）；`[charslot]` → `duration`（缺省 **0** = 瞬切）
   - `[CameraShake]` `[ImageTween]` `[backgroundTween]` `[Sticker]` `[AnimText]` → `duration`
3. **收尾只有 `endtip`**。允许表（`runtime.ts` 的命令注册串）里是
   `…skipnode.skiptothis.background.…decision.predicate.…endtip`，**没有 `end`**。
   写 `[End]` 会在控制台留一条 `unknown_command end`，然后**停在最后一帧**。

## 2. `fadetime` 会被缩放

```
CalculateFadeMs(x) = animateRatio * x * 1000      // runtime.ts:920 附近的注释与实现
```

`animateRatio` 来自玩家的"演出速度"（播放器底部 1 档/2 档…）。所以：

- `fadetime=0.5` 在 2 档下约等于 0.25s —— 这是**预期行为**；
- `[Delay(time=…)]` 走的是 `waitInterruptible(durationMs)`，**同样被缩放**；
- 想要"绝对时长"的停顿，只能靠 `[Blocker(block=true)]` 等待点击。

## 3. `[Character]` 与 `[charslot]` 怎么选

| | `[Character(name="…", fadetime=…)]` | `[charslot(slot="l|m|r", name="…", duration=…)]` |
|---|---|---|
| 语义 | 按"角色"摆放（自动选槽，中间优先） | 按**槽位**摆放，可精确控制左/中/右 |
| 淡入键 | `fadetime`（默认 0.15） | `duration`（默认 **0**，瞬切）；也读 `fadetime` |
| 清空 | `[Character(name="")]` | 空 `slot` 清**全部**内置槽；空 `name` 只清该槽 |
| 阻塞 | **从不**（读 `isblock` 且恒 false） | `isblock=true` + `end=true` 才阻塞 |
| 差分 | `name="char_002_amiya_1#1"` | 同 |
| 语料用量 | 136 900 行 | 192 438 行 |

**经验法则**：二创脚本用 `[Character]`（简洁、按角色）；要做"三人同框/精确站位/移动"
再用 `[charslot]`。

## 4. 场景切换的标准姿势

来自 `activities/act37side/level_act37side_02_beg.txt:1-10`（活动开场）：

```
[Blocker(a=1, r=0, g=0, b=0, fadetime=0, block=true)]   // 1. 全黑（瞬间）
[Dialog]                                                  // 2. 收起对白条
[StopMusic(fadetime=1)]                                   // 3. 收旧 BGM
[Background(image="…", screenadapt="coverall", block=true)]// 4. 新背景（自带淡入用 fadetime）
[PlayMusic(key="$…_loop", intro="$…_intro", volume=0.4)]   // 5. 新 BGM
[Blocker(a=0, r=0, g=0, b=0, fadetime=2, block=true)]    // 6. 淡出黑场（2 秒）
```

- `screenadapt="coverall"`：贴图**不是** 1280×720 时用它铺满（官方横图/竖图都这么写；
  拼错成 `cvoerall` 语料里也有，引擎会退回默认适配）。
- 黑场 `[Blocker]` 的 `a` 是**不透明度**，`0`=透明、`1`=全黑。
- 想"白闪"就把 `r/g/b` 写成 1。

## 5. 情绪节拍

```
[Delay(time=0.6)]                                  // 停顿
[CameraShake(duration=1, xstrength=30, ystrength=30, vibrato=30, randomness=90, fadeout=true, block=true)]
[CameraEffect(effect="Grayscale", amount=0.8, keep=true)]   // 灰化（情绪冷下来）
[CameraEffect(effect="Grayscale", keep=true, fadetime=0.5)]// 还原：不带 amount
[curtain(direction=0, fillfrom=0.01, fillto=0.15, grad=true, fadetime=1.5)]  // 幕布转场
[focusout(duration=0, type="bg", from=0, to=1, block=true)]                 // 景深/聚焦
```

- `CameraShake` 的 `strength` 单键在运行时被拆读；**只写 `strength` 有效但不如分开写可控**。
- `curtain` 的 `direction`：`0` 自左、`2` 自右、`4` 自上、`6` 自下。

## 6. 对白与推进

```
[name="杜宾"]  这里是……？                       // 说话人（二创唯一写法）
[name="阿米娅"]  这边走，博士。
[multiline(name="维娜")]我会再和她……            // 同一段续写（打字机追加）
[Subtitle(text="“…独立字幕…”, x=300, y=370, alignment="center", size=24, delay=0.04, width=700)]
[Dialog]                                          // 无参 = 收起对白条（清空当前对话）
```

`Dialog` 是运行时 `runtime.ts` 里 `case "dialog"`：**有 `content` 就显示、否则 `hideDialogue()`**。
所以"先说一句再收条"要写两行：`[Dialog]标题句` → `[Dialog]`。

## 7. 选择与合流（不是跳转）

```
[Decision(options="跟着她走;先问清楚", values="1;2")]
[Predicate(references="1")]        // 选中 1 才放行
…分支 A 的台词…
[Predicate(references="2")]        // 选中 2 才放行
…分支 B 的台词…
[Predicate(references="1;2")]      // 合流：所有值都放行
…共同后续…
```

`Decision` 把所选值写进 branch 状态；`Predicate` 是**闸门**：`references` 与当前状态
无交集时，这一行（及其后到下一个 `Predicate` 之间的行）**全部跳过**。最后一行合流
`references` 必须写全所有分支值，否则某条分支会掉进"无输出"。

## 8. 自检清单（写完脚本照着过一遍）

- [ ] 每处停顿都是 `[Delay(time=…)]`，没有 `duration`/`TIME`。
- [ ] 立绘淡入用 `[Character(…, fadetime=…)]`；要精确站位才用 `[charslot(…, duration=…)]`（记得 `isblock=true`）。
- [ ] 场景切换有"黑场 → 换背景/音乐 → 去黑场"，`fadetime` 明写。
- [ ] 结尾是 `[Blocker(a=1, …)]` 或 `[endtip(block=true)]`，**没有 `[End]`**。
- [ ] `Decision` 之后的 `Predicate` 集合覆盖所有分支值，且**最后一行合流**。
- [ ] `node scripts/fanfic/lint.mjs <包目录>` 0 error；`--strict` 也通过。

## 9. 编辑器内核 vs 引擎：已知偏差

编辑器里写字靠 `src/akstage/local/editorModel.js`（诊断 / 补全 / 悬停），播放靠 StoryPlayer
运行时；同一行 `script.txt` 在两边**极少**数写法上解释不同。全语料 **1,074,628** 条 `[` 行
逐行对拍，差异 **1,822** 条 —— **全部**落在下表 6 类，未归类的差异 = **0**：

```bash
npm run test:editor                                  # 快：内核 + 演出文档 + 参数表
node scripts/fanfic/editor-selftest.mjs --parity-full # 全语料对拍（约 1 分钟）
```

| # | 样子 | 语料行数 | 引擎（parser.ts / runtime.ts） | 编辑器内核（editorModel） | 建议 |
|---|---|---|---|---|---|
| 1 | `]` 后紧跟 `(`：`[name="X"](旁白…)`、`[Delay(time=1)](x=1)` | 16 | 贪婪的 `(.*)` 把 `(…)` 当参数表读 → 仍是 dialogue；`name` 的"值"变成 `X"]  旁白…`（**正文错位**） | **1009 error**：`` `]` 后残留 `(` ``，文案点出这行的 `entity` 与"正文位置错了"，`fix` 给出可照抄的整行（**保留 error** —— 它会吞正文） | 把括号里的文字**移到 `]` 之外**，两个空格分隔：`[name="X"]  旁白…` |
| 2 | 多写一个 `]`：`[Character]]`、`[character(…)] ]`、`[delay(time=2)]]` | 27 | 按**最后一个** `]` 截断 → 命令名照样认得，多出的 `]` 进正文（`Character` 不显示正文，看不出来） | 1009（`entity` 保留 `character`）；值里混进 `)]` 时再叠 1005 | 只留一个 `]` |
| 3 | 带命名空间的**游戏内**指令：`[Battle.Pause]`、`[Battle.LockFunction(mask=…)]`、`[Activity.ResetToEntry]`、`[SandboxV2.EnsureDungeonStable]` | **1,663** | `commandRegex` 的 `[.\|\w]*` 认点号 → 是**合法 command**，按字面 dispatcher；网页端 StoryPlayer 没有这个 case → **静默忽略该行**（前后照常播） | **warning `0x2003`**（`TierCInstruction`；行 `ok: true`），`ParseResult.entity` 保留原名（`battle.pause`）——**不是 error**（裁决 2026-10-08） | 网页端演不到；留着不报错，删掉更清爽 |
| 4 | 同一个键写两次：`[PlaySound(key="…", volume=1, loop=true, volume=0.6)]` | 113 | `parseArgs` 是对象 → **后写覆盖前写**（实际 `volume=0.6`） | 两条都留，报 **`1011` `InstrumentRedundant`**（warning），`params` 里两条都在 | 删掉旧的那条，避免"看着是 1、实际是 0.6" |
| 5 | 续行的**物理首行**（以 `\` 结尾）：`[Tutorial(focusX=30, …, \` | 871 | `\` 续行拼接后才 parse；物理首行本身 = narration | 同（`parseScript` 先拼续行；编辑器走 `lintDocument` → 无诊断）。**只**把这一行单独喂给 `parseLine` 时才会看到"缺 `]`"的 1009 | 正常写法，无需改 |
| 6 | `)`/`]` 之间的空格、`=` 后接参数表：`[delay(time=1.5) ]`、`[Delay=(time=1.5)]`、`[Dialog ]` | 4 | 空格被 `\s*\]` 吃掉 → 正常；`[Delay=(…)]` 的命令名成了 `delay=` → 未知指令、整行跳过 | 空格：`[Dialog ]` 正常、`[… ) ]` 值里多带 `)` → 1005（提示）；`=(…)`：认出 `entity=delay`，报 1003 | 写成 `[Delay(time=1.5)]` |

怎么读这张表：**1 / 2 / 4** 是作者该改的写法（error 或 warning，都是一行改好）；
**3** 是游戏内指令（网页端本来就不演，warning 即可）；**5 / 6** 两边其实一致，只差提示。

语料层面的量级（供参考）：第 3 类降级成 warning 后，全语料 error 行从 4,746 降到
**4,332**（≈ 0.403%），其中 `NoSuchController` 1,879（`Effect`、`dealy` 之类的真未知/拼写漂移）、
`UnclosedSymbol` 1,918（正文/值里混 `]`）、`MissingRequiredParameter` 534。
