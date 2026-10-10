# 演出预设（Templates）

> 把这里的花括号块**整段复制**到 `script.txt` 即可。每块都标注了来源（官方语料逐字或
> 引擎运行时），参数名以 `reference/commands.md` §7 的"引擎真正读的键"为准。
> 写完之后跑 `node scripts/fanfic/lint.mjs <包目录> --strict`。

## 目录

| # | 预设 | 用途 |
|---|---|---|
| 1 | [开场：黑场淡入](#1-开场黑场淡入) | 每篇第一屏 |
| 2 | [立绘入场（按角色）](#2-立绘入场按角色) | 单人/双人登场 |
| 3 | [精确站位（charslot）](#3-精确站位charslot) | 三人同框、左右站位 |
| 4 | [差分切换（表情）](#4-差分切换表情) | 同角色换表情/换装 |
| 5 | [情绪节拍](#5-情绪节拍抖动--灰化--停顿) | 抖动 + 灰化 + 停顿 |
| 6 | [氛围：景深与幕布](#6-氛围景深与幕布) | 聚焦、幕布转场 |
| 7 | [场景切换](#7-场景切换黑场包裹) | 换地点 |
| 8 | [插图 / CG 叠层](#8-插图--cg-叠层) | `[Image]` 叠图 |
| 9 | [台词推进](#9-台词推进) | 对白 / 续写 / 字幕 |
| 10 | [选择与合流](#10-选择与合流) | 全部二创的骨架 |
| 11 | [收尾](#11-收尾) | 淡出或 endtip |

---

## 1. 开场：黑场淡入

**用途**：每篇第一屏，避免"半张背景突然出现"。来源：`act37side/level_act37side_02_beg.txt:1-10`。

```
[HEADER(key="你的剧情id", is_skippable=true, fit_mode="BLACK_MASK")]
[Blocker(a=1, r=0, g=0, b=0, fadetime=0, block=true)]
[Dialog]
[Background(image="bg_black", x=0, y=0, fadetime=0, block=true)]
[Delay(time=0.4)]
[Blocker(a=0, r=0, g=0, b=0, fadetime=1.2, block=true)]
```

- `HEADER` 之后的尾随文本才是标题（本模板没写标题行）。
- `fit_mode="BLACK_MASK"` 是官方主线/活动的通用值。

---

## 2. 立绘入场（按角色）

**用途**：最常用的登场。`fadetime` 才是淡入时长（缺省 0.15s）。来源：`act10mini/level_act10mini_st01.txt:21`。

```
[Character(name="char_130_doberm_ex", fadetime=0.8)]
[Delay(time=0.2)]
[name="杜宾"]  这里是……？
```

**两人同框**（第二人用 `slot`/`name2` 由引擎自动选位）：

```
[Character(name="char_130_doberm_ex", fadetime=0.6)]
[Character(name="char_002_amiya_1", fadetime=0.6, slot="r")]
```

> `[Character]` **从不阻塞**：想让演出"等它站好"，后面补 `[Delay(time=…)]`。

---

## 3. 精确站位（charslot）

**用途**：需要精确控制左/中/右，或要把立绘**移出画面**。来源：`act37side/level_act37side_01_beg.txt:19`。

```
[charslot(slot="l", name="avg_npc_243", duration=1, isblock=true)]
[charslot(slot="r", name="char_002_amiya_1", duration=0.8, isblock=true)]
```

**移动/走位**（`from`→`to`，语料里的写法）：

```
[charslot(slot="m", name="char_130_doberm_ex", from="-2.15,0,10,0", to="0,0,10,0", duration=1.5, type="move", isblock=true)]
```

**清空**：

```
[charslot(slot="l")]      // 只清左槽
[charslot()]              // 清全部内置槽
```

> `duration` 缺省 = **0（瞬切）**，这是新手最常见"没有动画"的原因。

---

## 4. 差分切换（表情）

**用途**：同角色换表情/换装，切的是贴图 `#索引`。来源：`act10mini/level_act10mini_st01.txt:21` 的 `#1$1` 写法。

```
[Character(name="char_002_amiya_1#1", fadetime=0.4)]
[name="阿米娅"]  这边走，博士。
[Character(name="char_002_amiya_1#3", fadetime=0.4)]
[name="阿米娅"]  先别急，我把情况说清楚。
```

- `#` 后是**差分索引**；`$` 后是分组（`base#index$group@alias`）。
- 差分**不存在**时引擎会回落基名贴图，所以先跑
  `node scripts/fanfic/prts-index.mjs` 查可用差分（见 `reference/assets.md`）。

---

## 5. 情绪节拍：抖动 + 灰化 + 停顿

**用途**：震撼、心灰、无言的停顿。来源：`act37side/level_act37side_01_beg.txt:46`、`a001/level_a001_06_end.txt:50`。

```
[Delay(time=0.6)]
[CameraShake(duration=1, xstrength=30, ystrength=30, vibrato=30, randomness=90, fadeout=true, block=true)]
[CameraEffect(effect="Grayscale", amount=0.8, keep=true)]
[name="杜宾"]  ……
[CameraEffect(effect="Grayscale", keep=true, fadetime=0.5)]
```

- 还原灰化：**再写一次 `CameraEffect`**（不带 `amount`，或用 `from/to`）。
- `fadeout=true` 让抖动自然衰减；`block=true` 会让脚本等抖动结束。

---

## 6. 氛围：景深与幕布

**用途**：把注意力压到某个说话人 / 做转场。来源：`act16mini/level_act16mini_st01.txt:786`、`act37side/level_act37side_01_end.txt:53`。

```
[focusout(duration=0, type="bg", from=0, to=1, block=true)]
[focusparam(blur=false, effect="Grayscale")]
[curtain(direction=0, fillfrom=0.01, fillto=0.15, grad=true, fadetime=1.5)]
```

- `curtain` 的 `direction` 0/2/4/6 = 左/右/上/下。
- 幕布**推进**是"黑条扫过"，与 `[Blocker]` 的整屏淡出不同；两者可以叠加使用。

---

## 7. 场景切换（黑场包裹）

**用途**：换地点/换时段的标准写法，**六行**。

```
[Blocker(a=1, r=0, g=0, b=0, fadetime=0.5, block=true)]
[Dialog]
[StopMusic(fadetime=1)]
[Background(image="27_g7_subway", screenadapt="coverall", block=true)]
[PlayMusic(intro="$m_bat_game02_intro", key="$m_bat_game02_loop", volume=0.4)]
[Blocker(a=0, r=0, g=0, b=0, fadetime=1.5, block=true)]
```

- `screenadapt="coverall"`：贴图不是 1280×720 时铺满（横图/豎图都该写）。
- 只想换背景、不换音乐，就删掉 `StopMusic`/`PlayMusic` 两行。

---

## 8. 插图 / CG 叠层

**用途**：在背景上叠一张 CG / 道具图。来源：`a001/level_a001_01_beg.txt:11`。

```
[Image(image="ac1_0", x=0, y=0, xScale=1, yScale=1, fadetime=0.6, screenadapt="coverall")]
[Delay(time=1.2)]
[Image()]
```

- `[Image()]`（无参）= **清屏**（清掉所有叠图）。
- 缓慢推进用 Tween 家族（B 级，需在 `metadata.json` 声明）：

```
[ImageTween(xFrom=0, yFrom=0, xTo=0, yTo=-20, xScaleFrom=1, yScaleFrom=1, xScaleTo=1.1, yScaleTo=1.1, duration=15, block=false)]
```

---

## 9. 台词推进

```
[name="？？？"]   ……
[name="杜宾"]  这里是……？
[multiline(name="维娜")]我会再和她……
[Subtitle(text="字幕内容", x=300, y=370, alignment="center", size=24, delay=0.04, width=700)]
```

- `[Dialog]`（无参）= **收起对白条**；带尾随文本 = 显示（`runtime.ts` 的 `case "dialog"`）。
- 旁白：直接写正文（无 `[name=…]` 前缀）。
- `\n` 在正文里换行；长台词**不要**手动断行，交给引擎排版。

---

## 10. 选择与合流

```
[Decision(options="跟着她走;先问清楚", values="1;2")]
[Predicate(references="1")]
[Character(name="char_002_amiya_1#1", fadetime=0.5)]
[name="阿米娅"]  这边走，博士。
[Predicate(references="2")]
[Character(name="char_002_amiya_1#3", fadetime=0.5)]
[name="阿米娅"]  先别急，我把情况说清楚。
[Predicate(references="1;2")]
[Character(name="char_130_doberm_ex", fadetime=0.5)]
[name="杜宾"]  明白了。
```

- **每个分支片段开头都要"落地"**：重新 `[Character]`（或 `[Background]`、`PlayMusic`），
  因为闸门会跳过整段，上一个片段留下的舞台状态不保证。
- 合流那一行的 `references` **必须写全**（这里是 `"1;2"`）。
- 三段以上的选择：`options="A;B;C"` + `values="1;2;3"`；用法同构。

---

## 11. 收尾

```
[Blocker(a=1, r=0, g=0, b=0, fadetime=1.5, block=true)]
```

或者需要"剧情结束"提示：

```
[endtip(block=true)]
```

> **没有 `[End]`**：允许表里只有 `endtip`。写 `[End]` 只会在控制台留一条
> `unknown_command`，然后画面停在最后一帧。
