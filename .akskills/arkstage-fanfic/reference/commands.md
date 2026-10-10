# 指令参考（arkstage-fanfic）

行语法与全部分级以 PRTS 线上 StoryPlayer（2026-10 抓取）及其本地镜像
`~/.akresearch/repo/src/widgets/StoryPlayer/engine/` 为准；出现次数与参数键名
来自官方语料全量扫描：`~/.akresearch/akgd/zh_CN/gamedata/story/`（5735 个 `.txt`）。
表中「次数」= 该指令行在语料中的出现行数。

## 0. 行语法（转换器只需产出这四种行）

```
[指令名(参数表)]尾随文本      # 指令
[name="说话人"]正文           # 对白；整行必须严格是这个形状
正文                          # 裸行 = 旁白（无 speaker，engine 走 narration 分支）
// 注释                       # 行首（可含空白）"//" → 整行丢弃；空行同样跳过
```

- 指令名**大小写不敏感**（分发时转小写）；**参数键大小写敏感**（`parseLine`
  保留源大小写，`runtime.ts` 用 `exactArg` 精确查键）。写 `[Delay(TIME=1)]`
  时引擎按 `time` 查，查不到 → 0（见 §3）。
- 参数表：顶层逗号分隔，`key=value`，值可为 `123` / `1.5` / `true` / `false` /
  `"双引号串"` / `'单引号串'` / 裸串；字符串转义 `\n \r \t \" \\`。
- 续行：行尾 `\` 与下一物理行拼接（`logicalLines`，`parser.ts:176-194`）。
- 值里可以出现 `/`、`;`、`|`、`#`、`$`、`$N`、全角标点——**不要**对它们转义。
- 富文本：`<color=#rrggbb>…</color>`、`<b>`/`<i>`、`<p=1>`/`<p=2>`；
  占位符 `{@nickname}`（取 `wgUserName`，缺省「博士」）与 `{@nbs}`（NBSP）。
- 换行/空白：`]` 后的前导空白**不会被吃掉**——`content` = `match[5]`（`parser.ts:117`），
  所以对白正文与 `]` 之间的空格会原样进文本。语料里 367746 条对白行中
  285140 条紧贴 `]`、55702 条用两个空格、11992 条用一个空格，**都能播**；
  二创统一写「`]` 后两个空格」，并且**行尾不留空格**
  （`trailingText` 原样渲染，2205 条官方行尾带空白——是官方的小瑕疵，别学）。
- 空对白 `[name="X"]`（`]` 后什么都没有）= 隐藏对话框（`cancelTyping + hideDialogue`），
  语料里 14 条，可当分节拍用。

## 1. A 级：二创脚本主力（出现次数为该指令在语料中的行数）

| 指令 | 参数（实际语料观察到的键名） | 作用 | 官网/语料示例（逐字） |
|---|---|---|---|
| `[header(...)]` | `key`, `is_skippable`, `is_autoable`, `is_tutorial`, `is_video_only`, `fit_mode`, `char_sort_type`, `npcId`, `actId`, `withdrawWithoutAnim`, `deny_auto_switch_scene`, `dont_clear_gameobjectpool_onstart` | 首行元数据；`key` 是剧情 id，`]` 后尾随文本=标题（`is_video_only` 时 `[endtip]` 不阻塞）。3289 | `activities/act43side/training/training_act43side_01_a.txt:1`<br>`[header(is_skippable=false, is_tutorial=true)]` |
| `[Background(...)]` | `image`, `fadetime`, `screenadapt`, `block`/`isblock`, `x`, `y`, `xScale`, `yScale`, `width`, `height`, `tiled`, `duration`, `xFrom`/`yFrom`/`xTo`/`yTo`, `xScaleFrom`/`xScaleTo` | 切背景（`screenadapt="coverall"` = 拉满 1280×720）。16809 | `activities/act37side/level_act37side_01_beg.txt:5`<br>`[Background(image="27_g7_subway",screenadapt="coverall", block=true)]` |
| `[Image(...)]` | `image`, `fadetime`, `screenadapt`, `x`, `y`, `xScale`, `yScale`, `width`, `height`, `tiled`, `layer`, `time`, `xFrom`/`xTo`, `yFrom`/`yTo`, `xScaleFrom`/`xScaleTo`, `xpos`, `ypos`, `ease` | 叠图/CG 层；`image` 走 `assets/avg/images/<key>.png`；`[Image]`（无参数）清屏。6179 | `activities/a001/level_a001_01_beg.txt:11`<br>`[Image(image="ac1_0",x=0, y=0, xScale=1, yScale=1, fadetime=0, screenadapt="cvoerall")]` |
| `[charslot(...)]` | `slot`, `name`, `duration`, `focus`, `direction`, `from`/`to`(`pfrom`/`pto`、`afrom`/`ato`、`posfrom`/`posto`)、`type`, `end`, `isblock`, `action`, `random`, `power`, `scale`, `layer`, `fadetime`, `time` | 按槽位（`l`/`m`/`r`）放/移/淡出立绘；`name` 空=清槽。192438 | `activities/act37side/level_act37side_01_beg.txt:19`<br>`[charslot(slot="m",name="avg_npc_243",duration=1)]` |
| `[Character(...)]` | `name`, `fadetime`, `focus`, `slot`(只读部分槽), `name2`, `blackstart`/`blackend`, `enter`, `transType`, `offsetX`/`offsetY`, `time` | 立绘进出（`slot` 省略=中间；`focus` 高亮档）。136900 | `activities/act10mini/level_act10mini_st01.txt:21`<br>`[character(name="avg_377_gdglow_1#1$1",fadetime=1.5)]` |
| `[name="X"]` | 只有 `name` 一个键（正则 `^name\s*=\s*"((?:\\.|[^"])*)"$`） | 对话行；**二创里唯一的说话人写法**。435720 条 dialog 行 / 367746 条 `[name=…]` | `activities/a001/level_a001_01_beg.txt:6`<br>`[name="？？？"]   ……` |
| `[Dialog]` / `[dialog(...)]` | 无参=隐藏对话框；带参 `delay`, `style`（`Dialog` 同时是「无命令的 `[key=value]` 行」的兜底命令）| 隐藏/收起对白条；`[Dialog]`（无尾随文本）清空对话（`content` 为空 → `hideDialogue`）。435720 | `activities/act37side/level_act37side_01_beg.txt:4`<br>`[Dialog]` |
| `[Delay(...)]` | `time`（**规范拼写**；变体 `TIME`、`times`、`tinme`），另有 `black`, `t`, `tim`, `fadetime`, `title_test` | 停顿 N 秒（`time` 查不到 → 0）。75166 | `activities/act1arcade/training/training_act1arcade_m1_01_a.txt:36`<br>`[Delay(time=0.3)]` |
| `[Blocker(...)]` | `a`, `r`, `g`, `b`, `fadetime`, `block`, `from` 系（`afrom`/`bfrom`/`gfrom`/`rfrom`）、`style`, `duration`, `inverse`, `ease`, `image` | 全屏色块（黑场/白闪）。72627 | `activities/act37side/level_act37side_01_beg.txt:2`<br>`[Blocker(a=1, r=0, g=0, b=0, fadetime=0, block=true)]` |
| `[PlayMusic(...)]` | `key`, `intro`, `volume`, `crossfade`, `crosstime`, `delay`, `block` | 放 BGM；`key`/`intro` 取 `$变量` | `activities/a001/level_a001_01_beg.txt:3`<br>`[PlayMusic(intro="$darkness01_intro", key="$darkness01_loop", volume=0.6, crossfade=1.5)]` |
| `[PlaySound(...)]` | `key`, `volume`, `loop`, `channel`, `crossfade`, `crosstime`, `delay`, `block` | 放音效；`channel` 缺省=key | `activities/act37side/level_act37side_03_beg.txt:88`<br>`[PlaySound(key="$d_avg_cavewaterdrop", volume=0, loop=true, channel="a")]` |
| `[StopMusic(...)]` | `fadetime`, `time`, `block`, `crossfade`（拼写漂移 `faddetime`/`fadeetime`/`fdetime`）| 淡出 BGM。10377 | `activities/a001/level_a001_01_beg.txt:61`<br>`[stopmusic(fadetime=1)]` |
| `[StopSound(...)]` | `channel`, `key`, `fadetime`, `duration`, `volume`, `isblock` | 停某通道音效。3593 | `activities/act10mini/level_act10mini_st01.txt:1128`<br>`[StopSound(channel="bgs", fadetime=1)]` |
| `[MusicVolume(...)]` | `volume`, `fadetime`, `channel` | 调 BGM 音量。1833 | `activities/act10mini/level_act10mini_st02.txt:534`<br>`[musicvolume(volume=0.2, fadetime=1)]` |
| `[SoundVolume(...)]` | `volume`, `channel`, `fadetime` | 调音效通道音量。1579 | `activities/act11mini/level_act11mini_st01.txt:603`<br>`[soundvolume(channel="bse",volume=0,fadetime=1)]` |
| `[Decision(...)]` | `options`（`;` 分隔标签）、`values`（`;` 分隔整数），语料另有 `option1..4`/`value1..4`/`color` | 弹选项、写选中值；**不是跳转**。4813 | `activities/act37side/level_act37side_02_beg.txt:60`<br>`[Decision(options="“责任”是一个很奇妙的东西。;对罗德岛的大家，我也做不到轻易放手。;我们都一样。", values="1;2;3")]` |
| `[Predicate(...)]` | `references`（`;` 分隔整数；`selectableCondition`/`visibleCondition` 线上只读 `references`）| 分支闸门；空 `references`=结束分支模式（全放行）。5972 | `activities/act37side/level_act37side_02_beg.txt:61`<br>`[Predicate(references="1;2;3")]` |
| `[Subtitle(...)]` | `text`, `x`, `y`, `alignment`, `size`, `delay`, `width`, `duration`, `color`, `multi`, `hidelog`, `afrom`/`ato`, `block` | 屏幕上独立字幕（不占对白条）。8132 | `activities/act37side/level_act37side_02_beg.txt:515`<br>`[Subtitle(text="“工厂在欢迎我们？”", x=300, y=370, alignment="center", size=24, delay=0.04, width=700)]` |
| `[multiline(...)]` | `name`, `delay`, `end`；正文取**尾随文本** | 逐段追加同一段对白（打字机续写）。1959 | `activities/act37side/level_act37side_01_beg.txt:214`<br>`[multiline(name="维娜")]我会再和她……` |
| `[CameraShake(...)]` | `duration`, `xstrength`, `ystrength`, `strengthX`/`strengthY`/`strengthZ`, `strength`, `vibrato`, `randomness`, `fadeout`, `block`, `stop`, `focus`, `delay` | 镜头抖动。14547 | `activities/act37side/level_act37side_01_beg.txt:46`<br>`[CameraShake(duration=1, xstrength=30, ystrength=30, vibrato=30, randomness=90, fadeout=true, block=false)]` |
| `[CameraEffect(...)]` | `effect`（`Grayscale` 等）, `amount`, `keep`, `fadetime`, `initamount`, `from`/`to`, `block` | 全屏后处理（灰化等）。2079 | `activities/a001/level_a001_06_end.txt:50`<br>`[CameraEffect(effect="Grayscale", amount=0.8, keep=true)]` |
| `[curtain(...)]` | `direction`, `fillfrom`, `fillto`, `grad`, `fadetime`, `a`/`afrom`/`ato`, `duration`, `block`, `isblock` | 幕布推进（转场）；`direction` 0/2/4/6 四向。1489（`curve` 同族） | `activities/act37side/level_act37side_01_end.txt:53`<br>`[curtain(direction = 0,fillfrom = 0.01,fillto = 0.11,grad = true, fadetime=1.5)]` |
| `[focusout(...)]` | `type`（如 `"bg"`）, `from`, `to`, `duration`, `fadetime`, `id`, `block` | 背景/角色聚焦淡出（景深）。631 | `activities/act16mini/level_act16mini_st01.txt:786`<br>`[focusout(duration=0, type="bg", from=0, to=1, block=true)]` |
| `[focusparam(...)]` | `effect`（如 `"Grayscale"`）, `blur` | 设置聚焦效果参数（配合 `focusout`）。26 | `activities/act43side/level_act43side_08_end.txt:36`<br>`[focusparam(blur=false, effect="Grayscale")]` |
| `[gridbg(...)]` | `imagegroup`（`/` 分隔）, `solidwidth`/`solidheight`（`/` 分隔）, `x`, `y`, `xScale`, `yScale`, `fadetime`；`[gridbg]` 无参=清除 | 网格拼贴背景。219 | `activities/act29side/level_act29side_05_end.txt:254`<br>`[gridbg(imagegroup="44_g13_afterglow_L1/44_g13_afterglow_R1/44_g13_afterglow_L2/44_g13_afterglow_R2", solidwidth="1280/1280/1280/1280", solidheight="720/720/720/720",x=0,fadetime=0)]` |
| `[largebg(...)]` | `imagegroup`, `solidwidth`/`solidheight`, `cggroup`, `x`, `y`, `xScale`, `yScale`, `block` | 超宽背景（横向卷轴）。123 | `activities/act11d7/level_act11d7_st01.txt:6`<br>`[largebg(imagegroup="bg_beach_1/bg_beach_2", solidwidth="920/920", solidheight=720,x=-180)]` |
| `[verticalbg(...)]` | `imagegroup`, `solidwidth`/`solidheight`, `cggroup`, `x`, `y`, `xScale`, `yScale`, `fadetime` | 纵向长背景（上下卷轴）。32 | `activities/act25side/level_act25side_10_end.txt:779`<br>`[verticalbg(imagegroup="38_g17_2/38_g17_1", solidwidth=1280, solidheight="1116.25/1117.5",x=0,y=920)]` |
| `[Video(...)]` | `res`（如 `"video/xx/IW01.mp4"`） | 播视频（`torappu.prts.wiki/assets/<res>`）。28 | `activities/act15side/level_act15side_entry.txt:5`（新版路径见 `act37side`）`[Video(res="video/act37side/GO01.mp4")]` |
| `[endtip(block=true)]` | `block`（解析器补的隐式实例固定 `block=true`） | **引擎唯一注册的收尾指令**；等点击并显示"剧情结束"提示。语料 0 处（由解析器隐式追加），要显式写就用它 | 解析器产物：`parser.ts::parseScript` 给非空脚本补 `[endtip(block=true)]` |
| `[End]`（`end`） | 无参数 | 游戏侧脚本的收尾写法；**网页引擎不认**（允许表里只有 `endtip`），命中 `unknown_command` 后跳过 → 观感是"最后一帧卡住"。534 | `activities/act1dp/training/training_act1dp_tr01_beg.txt:75`<br>`[end]` |

## 2. B 级：可用，但要在 `metadata.json` 声明

B 级只影响「播放稳定性」而非合法性：参数语义未被 fanfic 包契约固定，换引擎版本
可能走样。转换器默认不用；用了就在 `metadata.json` 里列出来。

| 指令 | 参数 | 作用 | 语料示例（逐字） |
|---|---|---|---|
| `[CameraShake(...)]` 的姊妹 `[CameraEffect]` | 见 A 级 | — | 同上 |
| `[ImageTween(...)]` | `image`, `duration`, `xFrom`/`yFrom`/`xTo`/`yTo`, `xScaleFrom`/`xScaleTo`, `yScaleFrom`/`yScaleTo`, `block`, `ease` | 图片平移缩放。1362 | `activities/a001/level_a001_01_beg.txt:13`<br>`[ImageTween(xFrom=0, yFrom=0, xTo=0, yTo=-20, xScaleFrom=1, yScaleFrom=1, xScaleTo=1.1, yScaleTo=1.1, duration=15, block=false)]` |
| `[backgroundTween(...)]` | 同 `ImageTween`（`screenadapt`, `isblock`, `else`）| 背景缓慢推移（1.3 倍图）。599 | `activities/act37side/level_act37side_02_beg.txt:7`<br>`[backgroundTween(xFrom=100, yFrom=0, xTo=-100, yTo=0, xScaleFrom=1.3, yScaleFrom=1.3, xScaleTo=1.3, yScaleTo=1.3, duration=35, block=false)]` |
| `[CharacterAction(...)]` | `name`, `type`, `direction`, `loop`, `scale`, `power`, `duration`, `time`/`times`, `delay`, `fadetime`, `block`, `xpos`, `y`/`ypos` | 立绘局部动作（呼吸/震动等）。4942 | `activities/` 常见；`name` 同 `charslot` |
| `[Sticker(...)]` | `id`, `text`, `multi`, `x`/`y`, `alignment`, `size`, `delay`, `width`, `color`, `duration`, `block`, `hidelog` | 气泡/歌词/板书贴纸（`multi=true` 可续写同 id）。5815 | `activities/act37side/level_act37side_02_beg.txt:15`<br>`[Sticker(id="st1", multi = true, text="愿广阔的大地保佑吾王♪", x=300,y=200, alignment="center", size=24, delay=0.04, width=700,block = true)]` |
| `[Interlude(...)]` | `name`, `type`, `style`, `slot`, `channel`, `direction`, `switch`, `clear`, `offset`, `size`, `duration`/`sduration`, `fadetime`, `block` | 插画式过场（章节分隔）。1127 | `activities/` 活动篇头（`type` 决定版式） |
| `[CharacterCutin(...)]` | `name`, `style`, `povX`, `online`/`offsetx`, `width`, `fadestyle`, `fadetime`, `block` | 立绘切入（刀光式登场）。654 | `activities/` 战斗演出 |
| `[ShowItem(...)]` / `[HideItem(...)]` / `[CgItem(...)]` / `[HideCgItem(...)]` | `image`, `style`, `width`, `offsetx`, `fadetime`, `duration`, `pfrom`/`pto`, `aFrom`/`aTo`, `layer`, `ease`, `block` | 道具/CG 展示（`960×540→1280×720` 自适应）。918 | `activities/` CG 段落 |
| `[Theater(...)]` | `mode` | 影院模式（黑边沉浸）。41 | `activities/act37side/*` |
| `[AnimText(...)]` / `[AnimTextClean]` | `id`, `name`, `style`, `pos`, `block`；正文含 `<p=1>`/`<p=2>` | 地名/时间浮字。249 | `activities/act37side/level_act37side_02_beg.txt:29`<br>`[animtext(id = "at1", name = "group_location_stamp", style="avg_both", pos = "-400,-200", block = false)]<p=1>圣王会西部大堂王座厅</><p=2>1098年10月8日 9:45 P.M.</>` |
| `[AvgDisplay(...)]` | `name`, `style`, `slot`, `id`, `layer`, `scalex`/`scalexto`, `x`/`xto`, `y`/`yto`, `duration`, `block` | 通用显示（`style=bg`/`character` 时走对应家族贴图）。129 | `activities/` 特殊演出 |
| `[BgEffect(...)]` | `name`, `layer`, `x`/`xto`, `y`/`yto`, `loop`, `flip`, `duration`, `fade`, `movetime`, `delay` | 背景特效图层。1688 | `activities/` 活动演出 |
| `[imagerotate(...)]` / `[Bgeffect]` 系 Tween | `image`, `angle`, `ease`, `fadetime`, `inverse`, `block` | 旋转/微动。`imagerotate` 20 / `largebgtween` 147 / `imagetween` 1362 | 官方语料同族 |
| `[skipnode(...)]` / `[skiptothis]` | `mode` | 跳转锚点。12 | `activities/` 长活动篇 |
| 裸行旁白 / `[Narration]` | 无 | 无说话人正文；`[Narration]` 常配 `[Div]` 做版式。470 | `activities/act29side/chat_15.txt:27`<br>`合适的心扉之乐已经奏响，查访对象的心绪被触动，回忆涌现。` |

## 3. Delay 的坑：`time` 是唯一能生效的键

`runtime.ts:1243-1256` 只读 `time`（`exactArg(args, "time")`，查不到/非法 → 0），
因此**必须写 `[Delay(time=1)]`**。

| 写法 | 语料行数 | 位置（逐字） | 引擎行为 |
|---|---|---|---|
| `Delay(time=…)` | 36581 | `activities/act1arcade/training/training_act1arcade_m1_01_a.txt:36` `[Delay(time=0.3)]` | 正常等待 |
| `Delay(TIME=…)` | 4 | `activities/act10mini/level_act10mini_st02.txt:138` `[Delay(TIME=1)]` | `time` 缺键 → **0**（不等） |
| `Delay(times=…)` | 2 | `activities/act16d5/level_act16d5_02_end.txt:181` `[Delay(times=0.7)]` | 同上 → 0 |
| `Delay(tinme=…)` | 1 | `activities/act19side/level_act19side_02_end.txt:296` `[Delay(tinme=2)]` | 同上 → 0 |
| 指令名漂移 `delat/dealy/daley/delau/delya/delayt/dalay` | 各 1–3 | `activities/act17side/level_act17side_10_end.txt:801` `[delat(time=0.51)]` | 大小写不敏感的**名字**能分发到 delay；参数名照旧按 `time` |

> 结论：**参数键大小写敏感、指令名大小写不敏感**。写 `Delay`，键写 `time`。

## 4. C 级：引擎认识、但依赖游戏关卡/沙盒（网页端多数忽略）

C 级命令在**线上 StoryPlayer** 里要么被显式忽略（`runtime.ts` 的
`unsupportedAd8Commands`），要么只对游戏内运行时（关卡信号、成就、沙盒变量）有意义。
用在二创里最多是「不报错但没效果」；**默认禁用**，用了在 `metadata.json` 标注。

出现次数靠前的 C 级指令：`popupdialog`(1798)、`tutorial`(1366)、
`condition`(167)/`setconditionprogress`(144)、`inputblocker`(549)、
`withdraw`(350)/`withdrawsource`(33)、`summonenemy`(113)/`summontrap`(110)/
`setposition`(6)/`move`(64)、`playanim`(249)、`createeffect`(63)/
`finisheffect`(17)、`theater`(41)、`gotorpage`(48)/`gotostage`(1)/`gotocharinfo`(2)、
`sandboxv3*`（`openshop` 4 / `summontrap` 3 / `activepredefine` 2）、
`startbattle`(3)、`additem`(244)/`deliveritem`(34)/`obtain`(12)/`orderrift`(19)、
`foginview`/`fognotinview`(20/23)、`warp`(7)、`uioperation`(34)、`emoji`(77)、
`voicewithin`(78)、`executeactionarray`(27)、`save`(80)、
以及 `getenum`/`consumeguideonstoryend`/`addfavor` 等一次性指令（各 1–4）。

线上引擎对**未知**指令是 `warn` + 跳过（`runtime.ts` default 分支，
`warn("unsupported_command", …)`），所以 C 级与拼错的命令都不会让播放中断。

## 5. 常见拼写漂移（照抄官方语料可以，但建议写规范名）

| 漂移 | 规范 | 语料首现（逐字） |
|---|---|---|
| `charslsot` | `charslot` | `activities/`（`cmdmap` 计 1） |
| `palysound` | `playsound` | 3 |
| `stopmucis` | `stopmusic` | `activities/`（1） |
| `dialo` / `dialogs` | `dialog` | 各 1 |
| `musicvolune` | `musicvolume` | 1 |
| `duration`（当命令用） | `delay` | 1 |
| `curve` | `curtain` | 1489（`cmdmap` 归入 curtain 同族） |
| `Screeadapt` 等参数拼写 | `screenadapt` | 见 `cmdmap` 的 `screenadapt` 变体 |

## 6. 与 `lintScript()` 的分级一致性

`src/akstage/local/storyPack.js` 的 `TIER_A`/`TIER_B`/`TIER_C`/`SPELLING_FIX`
是上表**机器可读**的版本；lint 会对未知指令、C 级、拼写漂移各出一条 warning，
对行尾空白、空对白、裸文本行也各出一条（见 `reference/package.md` §6）。
两张表以本文件为准；改分级时**两处一起改**。

### A 级的最小可用集（二创模板）

```
[header(...)]                    # 1 行
[Background(...)]                # 每个场景（换场：Blocker → Background → Character → Blocker）
[Character(name=…, fadetime=…)]  # 首选；多角色站位才用 [charslot(slot=…)]
[name="…"] / [Dialog]
[Delay(...)]
[Blocker(...)] / [curtain(...)]
[PlayMusic(...)] / [StopMusic(...)] / [PlaySound(...)]
[Decision(...)] / [Predicate(...)]
[endtip(block=true)]             # 或 [Blocker(a=1, …, block=true)] 淡黑收束
```

收尾**二选一**：`[endtip(block=true)]`（显示"剧情结束"）或
`[Blocker(a=1, …, block=true)]`（黑场淡出）。**`[End]` 不是引擎指令**——
允许表里只有 `endtip`，写了只会在控制台留一条 `unknown_command end` 然后
停在最后一帧。细则见 `reference/animation.md` §1/§4 与 `branching.md` §3.0。

## 7. 实时校对：引擎实际读的参数名（`reference/animation.md` 的摘要）

不要凭"看起来合理"写参数——`runtime.ts` 只读它认的键，**键名大小写敏感**
（命令名大小写不敏感）。下表由 `runtime.ts` 的 `case "…"` 分支逐个抽取：

| 命令 | 引擎**真正**读的键（其余忽略/回落默认） | 常见误写 → 观感 |
|---|---|---|
| `Delay` | `time` | `duration`/`TIME`/`times` → **不等**（0 秒） |
| `Blocker` | `a`,`r`,`g`,`b`,`fadetime`,`block`,`style`,`afrom`/`bfrom`/`gfrom`/`rfrom` | — |
| `Background` | `image`,`fadetime`,`block`,`x`,`y`,`xScale`,`yScale`,`height`,`screenadapt`,`tiled`,`duration` | `duration` 只对 Tween 家族有效，`Background` 的淡入是 `fadetime` |
| `Character` | `name`,`name2`,`fadetime`,`focus`,`slot`,`transtype`,`isblock`,`offsetx`/`offsety`,`blackstart`/`blackend` | `duration` → 用默认 0.15s；`block` → Character **从不阻塞**（读的是 `isblock`，且恒 false） |
| `charslot` | `slot`,`name`,`duration`,`end`,`isblock`,`focus`,`direction`,`action`,`layer`,`scale`,`power`,`random` | `fadetime` 次之；`duration=0`（缺省）=**瞬切**；蛋白石用 `end=false` 保持序列 |
| `CameraShake` | `duration`,`xstrength`,`ystrength`,`vibrato`,`randomness`,`fadeout`,`block`,`stop`,`delay` | `strength` 单键 → 默认强度 |
| `CameraEffect` | `effect`,`fadetime`,`keep`,`block`（`amount` 视实现） | 只写 `effect="Grayscale"` 也能全灰 |
| `curtain` | `direction`,`fillfrom`,`fillto`,`grad`,`fadetime`,`a`/`afrom`/`ato`,`duration`,`block`,`isblock` | `direction` 0/2/4/6；写 1/3/5 会落到就近向 |
| `Sticker` | `id`,`text`,`multi`,`x`/`y`,`alignment`,`size`,`delay`,`width`,`color`,`duration`,`block`,`hidelog` | 逐字打字；`duration` 是**停留**时长 |
| `AnimText` | `id`,`name`,`style`,`pos`,`fade`,`duration`,`block` | 正文用 `<p=1>…<>` 分段 |

> **淡入时长会被 `animateRatio` 缩放**：`calculateFadeMs(x) = animateRatio * x * 1000`。
> 玩家把"播放速度/演出速度"调快时，`fadetime`/`duration` 会**同比变短**，
> 这是引擎的既定行为，不是你的脚本写错。

> **收尾**：允许表里只有 `endtip`，**没有 `end`/`[End]`**（写了只在控制台留一条
> `unknown_command` 然后被跳过，画面停在最后一帧）。推荐用
> `[Blocker(a=1, …, fadetime=1.5, block=true)]` 淡出，或显式 `[endtip(block=true)]`。
