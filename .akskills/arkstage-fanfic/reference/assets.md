# 素材借用（PRTS 现成立绘 / 背景 / CG / 音频）

二创**默认借用 PRTS 现成素材**：立绘/差分、背景、CG、音频都不需要作者自备
（本地 art 只是 fallback）。原因是引擎只认 URL：资源路由函数
（`engine/asset.ts`）把「语义键」拼成 `https://torappu.prts.wiki/...`，
**只要 URL 能返回 PNG，引擎不关心素材来自哪个域**。

## 1. 立绘引用 → URL

角色引用的解析顺序（`engine/characterRef.ts`，逐字对应原生
`AVGCharacterSlot._LoadImage` 的三段右→左剥离）：

```
name="<base>[#N][$G][@alias]"           # 从左到右书写，引擎从右往左剥
  ① $G  组号：`$2` → group = 1（0 基）
  ② @alias 别名：存在即短路 index，直接在组的 array 里按 alias 找表情
  ③ #N  组内序号：`#8$2` → group=1, index=7
```

- 基名 `base` 必须命中 `character.json` 的键（键**大小写折叠**为小写后查表）；
- 只有 `base` 时取 `array[0]`；
- **`#N$G` 是最稳的写法**：语料里 `avg_1019_siege2_1#1$2`、`avg_npc_329_1#1$1`
  这种精确坐标占绝对多数；只用 `$G`（如 `avg_npc_329_1$1`）与只用
  `#N`（如 `avg_002_amiya_1#5`）也都合法；
- `@alias` 是**网页版扩展**：原生 `AVGCharacterSpriteHub.SetImage` 按
  ordinal 比对带 `@` 的串，而表里的 alias 不带 `@`，原生必然 miss 并回退
  `array[0]`（`characterRef.ts:183-197` 的注释）；线上引擎按去掉 `@` 后匹配，
  所以 `@alias` 在 arkstage 里**能选中表情**（语料里 0 处使用 `@`）。
  推荐写 `#N$G`，`@alias` 仅在你确定 alias 拼写时使用。
- `-expression` 形式（`base-expression`）也是网页版扩展，`name` 直接是
  array 项的 `name` 时优先命中。

**URL**：`resolveStoryCharacterAssetByKey(name)` →

```
https://torappu.prts.wiki/assets/avg/characters/<name>.png
```

以语料实测条目 `char_002_amiya_1` 为例（`~/.akresearch/tables/character.json`，
上游 `https://torappu.prts.wiki/assets/avg/character.json`）：

```json
"char_002_amiya_1": {
  "pos": { "x": 0, "y": 203 }, "size": { "x": 1090, "y": 1090 },
  "groups": [],
  "array": [
    { "name": "char_002_amiya_1", "alias": "normal", "group": -1, "image": "char_002_amiya_1/char_002_amiya_1" },
    { "name": "char_002_amiya_2", "alias": "open mouth", "group": -1, "image": "char_002_amiya_1/char_002_amiya_2" },
    { "name": "char_002_amiya_3", "alias": "smile", "group": -1, "image": "char_002_amiya_1/char_002_amiya_3" }
  ]
}
```

于是 `[character(name="char_002_amiya_1#3")]` → `array[2]`（`smile`）→
`https://torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_3.png`
（注意 `image` 是**两段路径**，URL 里就是子目录）。

### face_overlay（表情叠加）

855 个条目带 `groups`。形状（上游真实条目 `avg_1019_siege2_1`，逐字）：

```json
"avg_1019_siege2_1": {
  "pos": { "x": -100, "y": 140 }, "size": { "x": 1100, "y": 1100 },
  "groups": [
    { "mode": "face_overlay", "base": "avg_1019_siege2_1/avg_1019_siege2_1$1",
      "faceRect": { "x": 625, "y": 104, "w": 57, "h": 64 } },
    { "mode": "face_overlay", "base": "avg_1019_siege2_1/avg_1019_siege2_1$2",
      "faceRect": { "x": 625, "y": 104, "w": 57, "h": 64 } }
  ],
  "array": [
    { "name": "1$1", "alias": "", "group": 0, "face": "avg_1019_siege2_1/1$1" },
    { "name": "2$1", "alias": "", "group": 0, "face": "avg_1019_siege2_1/2$1" }
  ]
}
```

- 命中的 array 项若带 `"face"`，贴图 = `groups[group].base`（整身）
  **叠加** `face`（表情）在 `faceRect` 指定的像素矩形里
  （`engine/preload.ts` 的 `faceAssets`/`faceRect` 一路带进 Pixi 渲染）；
- 只借用**整身**也可以：`name="avg_1019_siege2_1#1$2"` 会拿 `base`+`face` 两者。

## 2. 选背景

- 背景键 = `background.json` 的键（1041 个，值是该图的 **ppu** 像素比例，
  例如 `"bg_cher_1": 68.24644470214844`；值与上游一致）；
- URL：`https://torappu.prts.wiki/assets/avg/background/<key>.png`（**小写折叠**）；
- 屏幕适配：`screenadapt="coverall"` = 等比拉满 1280×720（首选）；
  `xScale`/`yScale`、`width`/`height`、`tiled` 是「原生矩形 × 系数」；
  省略 `screenadapt` 时按 ppu 推出的原生矩形摆放——**16:9 的图正好铺满**，
  非 16:9 会露出底色（`rendering/PixiStoryRenderer.ts:4816-4870` 的
  `nativeBackgroundRect`）。fanfic 一律用 `screenadapt="coverall"`。
- 选不到近似背景时的顺序：① 换 16:9 的通用键（`bg_black` 语料 1216 次、
  `bg_corridor` 297、`bg_room_2` 245、`bg_forest` 128…）；② 纯色 + `[Blocker]`；
  ③ 自备本地图（见 §5）。
- 大背景家族：`gridbg`/`largebg`/`verticalbg` 的 `imagegroup` 是
  **`/` 分隔的多键列表**，`solidwidth`/`solidheight` 同样用 `/` 分隔逐图给值
  （`activities/act29side/level_act29side_05_end.txt:254`）。

**CG**：`[Image(image="…")]` → `https://torappu.prts.wiki/assets/avg/images/<key>.png`；
键从官方语料里抄（`activities/act37side/level_act37side_03_beg.txt:5`
`[Image(image="55_i17_2", screenadapt="coverall",fadetime=0)]`）。

## 3. 音频

音频键的三种写法（`engine/asset.ts:71-92`）：

| 写法 | 解析 | 例子 |
|---|---|---|
| `$变量` | 查 `story_variables.json`（键小写），值是 `Sound_Beta_2/...` 路径 → `.../assets/audio/...mp3` | `$escape_loop` → `https://torappu.prts.wiki/assets/audio/music/beta2_180603/m_dia_escape_loop.mp3` |
| `@相对路径` | `https://torappu.prts.wiki/assets/<路径>` | `@audio/x.mp3` → `https://torappu.prts.wiki/assets/audio/x.mp3` |
| `https://…` | 直用 | 自备音频 URL |
| 裸键 | `Sound_Beta_2/` → `assets/audio`，其余小写拼到 `/assets/<key>.mp3` | `key="title_test"` 这类（`cmdmap` 里 2139 次）|

- `story_variables.json` 有 2786 个键，其中 2777 个字符串;**音频变量**占绝大多数
  （`escape_intro = "Sound_Beta_2/Music/beta2_180603/m_dia_escape_intro"`）；
  非音频的字符串变量是头像键（`avatar_doberm = "char_130_doberm"`，
  用于 `[Dialog(avatarId=…)]`/`dialogHead`）以及 `nbs`（NBSP）；
  7 个 float（`bg_width = 0.5`、`bg_height = 1.5`）给版式用。
- 引擎对**音效通道**：`PlaySound` 的 `channel` 缺省=key，`StopSound` 的
  缺省=key；`MusicVolume`/`SoundVolume` 按通道调。分支里起的 loop 音效
  要在合流前停掉（见 `branching.md` §4）。
- **借用即可**：`key="$d_avg_clothmovement"` 这种通用音效（语料 1347 次）
  比自备音频更稳。

## 4. 自备素材（fallback）与本地 host

作者自带 PNG/WebP 时：

1. **不要**用 `file://` 或 `data:`（媒体仓 `canonical_key` 会拒；
   `src-tauri/src/media.rs:31-70`）；
2. 用一个**带点的假 host**，项目约定是 `local.arkstage.invalid`，例如
   `[Image(image="…")]` 不够用（`image` 会拼到 torappu 域名），所以自备图
   直接写**完整 URL 形态**的引用（`https://local.arkstage.invalid/art/x.png`）；
   `library.js::localHosts()` 会把脚本/patch 里出现的 `*.invalid` host
   收集起来并进 `assetDomains`，于是它可以离线命中
   `$DATA_ROOT/media/local.arkstage.invalid/art/x.png`；
3. 本地图统一放 `<packDir>/assets/…`；`pack.mjs` 会把它复制/登记，应用**不读**
   `assets/`（它走 URL→缓存），`assets/` 是给离线打包与字体预取用的；
4. 可选：`build/assets.json`（URL 数组）作为清单摘要，供核对。

## 5. OC / 机设角色（`chassis`）的本地条目

上游没有的原创角色：**本地立绘 base + 一条合成的 character.json 条目**，
写进 `patch/characters.json`，`pack.mjs` 负责合成 `pos`/`size`。

合成规则（`library.js::resolvePlan` + `storyPack.js` 的 `base#N$G` 拆分）：

- **一个 base = 一张图**；差分用 `#N` 选（`array` 里一项就是一档）；
- `size`：本地图按 1024×1024 画布几何；`pos` 决定在 1280×720 舞台上的锚点
  （`x`/`y` 是左上角像素偏移，官方值可为负）。
  引擎几何：`rect = 贴图尺寸 / ppu * 100`（默认 ppu=100，见
  `PixiStoryRenderer::nativeBackgroundRect` 的同款换算）；按此换算给出
  `pos`/`size`，再用 `probe.mjs` 复核实际落点。

最小可用条目（把 `my_oc` 换成自己的 base；`image` 指向本地 URL）：

```json
{
  "my_oc_1": {
    "pos": { "x": 40, "y": 190 },
    "size": { "x": 780, "y": 780 },
    "groups": [],
    "array": [
      { "name": "1$1", "alias": "normal", "group": -1, "image": "https://local.arkstage.invalid/art/my_oc_1.png" },
      { "name": "2$1", "alias": "smile", "group": -1, "image": "https://local.arkstage.invalid/art/my_oc_2.png" }
    ]
  }
}
```

用法：`[character(name="my_oc_1#1$1")]`（`my_oc_1$1`、`#2$1` 同样有效）。

patch 合并规则（`library.js::mergeTables`，**契约**）：

- **条目级覆盖**：patch 里的键覆盖上游同名键；上游没有的键新增；
- 条目内 `array` / `groups` / `pos` / `size` **缺省沿用上游**（局部覆盖）；
- 显式写 `null` = **删除**该条目（`"char_x": null`）。

## 6. 素材自检清单

- [ ] 每个 `name=`/`charslot`/`Character` 的 base 能在 character.json 命中
      （`node scripts/fanfic/lint.mjs <packDir>` 会给 warning）；
- [ ] 用到的 `#N$G` 的组号 ≤ 该条目的组数（组号来自 `groups` 的长度）；
- [ ] `Background` 的键要么在 `background.json`，要么是自备 URL；
- [ ] `PlayMusic`/`PlaySound` 的 `$var` 在 `story_variables.json`；
- [ ] 自备 URL 的 host 带点、不是 `file://`/`data:`；
- [ ] 分支片段内的立绘/音频在片段开头重新落地（`branching.md` §4）。
