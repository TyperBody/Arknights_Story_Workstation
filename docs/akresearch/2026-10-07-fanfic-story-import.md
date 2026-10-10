# 二创文章 → 方舟剧场：可行性研究与落地方案

日期：2026-10-07 · 研究范围：只读 + 联网核实，未改动任何产品代码。
结论先行：**目标可达，且不需要改引擎**；工作量集中在「本地剧本包」的注入路径与一个 SKILL.md。

---

## 0. 一句话结论

arkstage 的演出层已经把「剧本字符串 + 数据表」完整地喂给 PRTS 的 StoryPlayer。
只要让同一个入口也接受**本地剧本包**（script + 自备立绘/背景/音频 + 角色表），
二创文章就能以原版演出格式播放；**官方 DSL 自带 `[Decision]` 选项分支**，
支线不需要魔改引擎，只需按官方写法生成。

---

## 1. 现状（已核实，带出处）

### 1.1 播放链路
- 路由 `/play/:pageTitle`，剧情身份就是 `page_title` 字符串；缓存、下载、已读状态全部以它为准
  （`frontend/src/App.tsx:47`、`frontend/src/pages/StoryPlayerPage.tsx:19`、`frontend/src/lib/bookshelf.ts:26`）。
- 播放：`loadStoryRuntime(title)` → Rust `fetch_story_runtime` → `bootEngineInFrame()`
  （`frontend/src/pages/StoryPlayerPage.tsx:75,89`；`frontend/src/lib/predownload.ts:154`、`:166`）。
- 新版引擎（PRTS 2026 起启用，v1.2.0 已迁移）：`frontend/src/lib/storyPlayerBoot.ts`。
  把 `opts.script` 原样写进 iframe 的 `<pre id="datas_txt">`（`:58-61`），并传 `api.loadContext(opts.script)`（`:130`）。
- 旧版 ScenarioSimulator 仍在代码里：`frontend/src/lib/engineBoot.ts:120`，由 `bundle.story_player` 是否存在二选一。

### 1.2 剧本数据契约
- 前端 `StoryRuntime = { story:{script,title}, bundle, revision }`
  （`frontend/src/lib/predownload.ts:70-81`）；Rust `StoryRuntimeData`（`src-tauri/src/models.rs:39-45`）。
- 新版 bundle：`StoryPlayerBundle { entry, prelude, modules, styles, data }`（`models.rs:72-80`）。
  `data` 里固定三个 sidecar：`character.json` / `background.json` / `story_variables.json`
  （`src-tauri/src/commands/story_player.rs:10-14`；前端同列表 `frontend/src/lib/storyPlayerAdapter.ts:13-17`），
  且校验要求每个 ≥10 键、`character.json` ≥100 项（`storyPlayerAdapter.ts:24-26`、`story_player.rs:138-147`）。
- 剧本字符串在**新版**里以 DOM `textContent` 注入（`storyPlayerBoot.ts:61`），
  在**旧版**里经 HTML 转义后注入（`engineBoot.ts:147,930-939`）。
- 缓存键：`story-runtime-v6_<title>`、`stories_<title>`、`manifest_<title>`，`/`→`_`，落在 `$DATA_ROOT/cache/*.json`
  （`predownload.ts:167,308,398`；`src-tauri/src/commands/cache.rs:335`）。

### 1.3 资源解析
- `prts-cdn://` 协议：`{host}/{path}` → `https://{host}/{path}`；先查本地内容寻址仓库 `$DATA_ROOT/media/<host>/<path>`，
  命中即离线返回；未命中且允许联网则带 `Referer` 拉取、按魔数校验、原子落盘
  （`src-tauri/src/lib.rs:91-190`、`src-tauri/src/media.rs:31-70,107-137`）。
- 这个协议**不锁 host 白名单**：`"local.example/x.png"` 这种裸键（host 含点、≥2 段）也能作为键；
  只有 `file://`、`data:`、无点 host（`localhost/a/b`）会被 `canonical_key` 拒掉（`media.rs:37-39,61-68`，含单测）。
- 但**前端改写**用的是 `discoverAssetDomains()` 学到的 host 列表，来源只有 PRTS 的 DOM/数据表/引擎模块
  （`frontend/src/lib/proxy.ts:19-30`；`engineBoot.ts:125-129`；`storyPlayerBoot.ts:45`）。
  也就是说：**剧本里出现的新 host，当前不会被改写到本地协议**——这是本地素材必须补的一环。

### 1.4 目录 / 书架
- 目录运行时从 PRTS「剧情一览」拉取并缓存 `story-index`（`frontend/src/hooks/useStoryIndex.ts:44-92`、`src-tauri/src/parser/story_index.rs`）。
- 之后 `regroupStoryIndex` 按 StoryLine 重排；**未匹配的书目落进「特殊&未分类」，不会丢**
  （`frontend/src/lib/storylines.ts:16-42`）。因此往索引里插一条本地条目即可出现在书架里，类型无需改动。

---

## 2. 剧本格式（二创转换的目标格式）

依据：PRTS 线上引擎模块（2026-10-07 抓取 `static.prts.wiki/widgets/production/StoryPlayer.Cfmaa2Ly.js`）、
其可读源码镜像（本地 `~/.akresearch/repo`，MooncellWiki/prts-widgets）、以及**官方语料全量扫描**
（Kengxxiao/ArknightsGameData，5735 个 `gamedata/story/*.txt`）。

### 2.1 行语法
```
脚本    := 行*
行      := 指令行 | 对白行 | 旁白行
指令行  := "[" 指令名 [ "(" 参数表 ")" ] "]" 尾随文本?
指令名  := 大小写不敏感，分发时转小写
对白行  := "[name=\"说话人\"]" 正文          ← 整行必须严格是这个形状
参数表  := 参数 ("," 参数)*                  ← key=value，key 大小写敏感、顺序自由
值      := 数字 | 裸串 | "双引号串" | '单引号串'（转义 \n \r \t \" \\）
注释    := 行首（可含空白）"//"              ← 整行丢弃
续行    := 行尾 "\" 与下一物理行拼接
```
补充（逐条来自线上引擎，均已核实）：
- 变量展开 `{@nickname}`（取 `mw.config.get("wgUserName")`，缺省「博士」）、`{@nbs}`（NBSP）。
- 富文本：`<color=#rrggbb>…</color>`、`<b>`/`<i>`、`<p=1>`/`<p=2>`（animtext/spellsticker 的行标记）。
- 一行里参数之间允许奇怪空格；`"#3 $1"` 这种写法引擎能容忍（arkstage 还专门做了 `normalizeScenarioScript`，`engineBoot.ts:336-338`）。

### 2.2 指令清单（按可安全使用程度分层）
- **A 级（转换器主力，出现次数以官方语料计）**：
  `header` 3289 / `background` 16809 / `charslot` 192438 / `character` 136900 / `dialog` 435720 /
  `delay` 75166 / `blocker` 72627 / `playmusic` 8716 / `playsound` 40912 / `stopmusic` 10377 /
  `stopsound` 3593 / `decision` 4813 / `predicate` 5972 / `multiline` 1959 / `subtitle` 8132 /
  `camerashake` 14547 / `cameraeffect` 2079 / `curve/curtain` 1489 / `focusout` 631 / `focusparam` 26 /
  `image` 6179 / `gridbg` 219 / `largebg` 123 / `end` 534。
- **B 级（少用或偏演出）**：`sticker`、`animtext`、`spellsticker`、`charactercutin`、`characteraction`、
  `interlude`、`cgitem`/`showitem`、`theater`、`video`（`[video(res="video/xx.mp4")]` → `torappu.prts.wiki/assets/...`）。
- **C 级（依赖游戏关卡/沙盒，网页端多数忽略）**：`tutorial`(1366)、`popupdialog`(1798)、
  `condition`/`setconditionprogress`、`summonenemy`、`gotorpage`、`sandboxv3*`、`startbattle` 等。
  线上引擎对未知指令是 `warn` + 跳过。

命令名共 114 种（含拼写错误如 `daley`、`charslsot`——官方语料里也大量存在，转换器不必模仿）。

### 2.3 分支：**官方原生支持**
真实语料（`zh_CN/gamedata/story/activities/act8d2/...`、`act10d5/level_act10d5_st06.txt:22-38`、
`act13side/level_act13side_09_beg.txt:180-190`）：
```
[Decision(options="选项A;选项B;选项C", values="1;2;3")]
[Predicate(references="1")]
   …只有选了 A 才走的内容…
[Predicate(references="2")]
   Hmm
[Predicate(references="3")]
   …C 支线…
[Predicate(references="1;2;3")]      ← 合流：恢复「全部路线」
```
语义（与线上引擎一致，逐行核实过模块字符串）：
- `[Decision]` **不是跳转**，是把「玩家选中的 value」写进运行时状态；`values` 缺项按 0 处理，0 = 「未选择」（恒放行）；
- 闸门：`selectedValue==0` 或 `references` 为空 → 放行；`predicate` 指令自身永远放行（它负责改 `references`）；
- 渲染：引擎会弹可点击的选项面板并停在 `waiting_decision`，选完后按值放行对应片段；
- 支持**质量**：`[Predicate(selectableCondition=…)]`/`visibleCondition=…` 存在语料中，但线上引擎只读 `references`
  （转换器建议只用 `options`/`values`/`references` 三件套，兼容性最好）。
- 扫描结果：479/5735 个官方文件含 `[Decision(`，415 个含 `[Predicate(`。

**同时注意一个硬约束**（`log/symbolicFlow.ts` 的 `maxStates`，线上同款 1e4）：
分支片段的数量会随 `Decision × Predicate` 组合**相乘**增长，超过上限会「退化」为不分路线的全量文本（只影响 LOG ALL 面板）。
二创的多支线（几百个选项组合）建议**拆成多部剧情 + 少量决策**，而不是一个大脚本里 30 个选项。

### 2.4 角色 / 素材引用
`character.json` 是「角色基名 → 立绘组」表，条目形状（实测）：
```json
"char_002_amiya_1": {
  "pos": {"x": 0, "y": 203}, "size": {"x": 1090, "y": 1090},
  "groups": [],
  "array": [{"name":"char_002_amiya_1","alias":"normal","group":-1,"image":"char_002_amiya_1/char_002_amiya_1"},
            {"name":"char_002_amiya_2","alias":"open mouth","group":-1,"image":"char_002_amiya_1/char_002_amiya_2"}]
}
```
- 贴图 URL 由引擎拼装：`https://torappu.prts.wiki/assets/avg/characters/<name>.png`
  （存在 `face`（表情差分）时叠在 `base` 上，`faceRect` 由 `groups[].mode=="face_overlay"` 给出）；
  角色 key 会**小写折叠**，`array[].name` 后缀 `$G` 表示第 G 组，`#N$G` = 第 G 组第 N 个。
- 背景：`https://torappu.prts.wiki/assets/avg/background/<key>.png`（先用 `background.json` 的像素比例定位，缺失时按贴图尺寸兜底）。
- CG：`/assets/avg/images/<key>.png`；音频：`$变量` → `story_variables.json` 的值 → `…/assets/audio/….mp3`；
  `@相对路径` → `torappu.prts.wiki/assets/<路径>`；`https://…` 直用；裸 key → `/assets/<key>.mp3`。<br>
  （`asset.ts` / `preload.ts` 的路由函数，见本地镜像 `~/.akresearch/repo/src/widgets/StoryPlayer/engine/asset.ts:42-92`。）

**关键判断**：只要自备素材 URL 能返回 PNG，**引擎不关心它来自哪个域**。

---

## 3. 二创落地的插入点（按改动成本排序）

| # | 插入点 | 现状 | 需要做什么 | 风险 |
|---|---|---|---|---|
| 1 | 剧本来源 | `loadStoryRuntime` 必走 `fetch_story_runtime`（`predownload.ts:166-184`），只有 PRTS 缓存兜底 | 加「本地剧本包」分支：读 `$DATA_ROOT/library/<id>/story.json` 组装 `RawStoryRuntime` | 低（数据结构已有 JSON 形态，缓存键就是普通 JSON） |
| 2 | 引擎 bundle | `widget-bundle-v6` 由 PRTS 页拉取（`story_player.rs:25-63`，要求 `widget_base` + 文件名白名单） | 复用已验证的 `widget-bundle-v6`（含三个 sidecar）；或允许把本地 bundle JSON 塞进同一缓存键 | 低-中（`validateStoryPlayer` 要求三个 sidecar ≥10 键 → 需要带一份角色表） |
| 3 | 新 host 的素材改写 | `discoverAssetDomains` 只从 PRTS 文本学习 host（`proxy.ts:19-30`） | 把「本地剧本包声明的 host」并入 `assetDomains`，或用 `asset://`（`convertFileSrc`）直接给本地文件 URL | 低（一行数组拼接） |
| 4 | 剧情目录 | `useStoryIndex` 只读 PRTS 索引 | 合并一份本地索引（`StoryEntry{title,page_title}`），落进「特殊&未分类」或新建「同人」分类 | 低（`storylines.ts:38-40` 天然兜底） |
| 5 | `linkMap ≥ 100` 等闸门 | `storyPlayerBoot.ts:131` 要求角色表 ≥100 组；`validateCandidateBoot` 要求 manifest 非空 | 本地角色表保持 ≥100 条（或按包放宽闸门） | 低 |
| 6 | 角色显示尺寸 | 缺失分组时 `repairScenarioLinks` 用默认布局 `pos{0,160}/size{1024,1024}`（`engineBoot.ts:393-396`），且**只作用于旧引擎**；新版角色尺寸完全来自 `character.json` 的 `pos/size` | 本地角色表直接给出 `pos/size` | 低 |

**推荐形态：`<资源目录>/library/<story-id>/`**
```
story.json        # {id, title, chapter, script, hosts[], assets{...}, characterPatch{...}, cover}
script.txt        # 剧本（上面 2.x 的 DSL）
art/…             # 立绘/背景/CG（可选：png 或 webp）
audio/…           # 音频（可选）
metadata.json     # 作者、简介、分支图（给 UI 用，引擎不需要）
```
`hosts[]` 里的域会被并进 `assetDomains`，于是所有 `https://<host>/art/x.png` 都走 `prts-cdn://`
（命中 `$DATA_ROOT/media/<host>/art/x.png`），断网可播。

---

## 4. AI skill 方案（`arkstage-fanfic`）

### 4.1 skill 的职责
把一篇（或多篇）二创文章 → 一个可播放的剧本包。**LLM 只做语义映射，格式合法性交给脚本校验。**

### 4.2 建议目录
```
.akskills/arkstage-fanfic/
├── SKILL.md                  # 触发条件、流程、硬约束（见下）
├── schema/story.schema.json  # 剧本包 JSON Schema
├── reference/commands.md     # 指令表（2.2 的分级表 + 参数 + 例子）
├── reference/branching.md    # Decision/Predicate 语义 + 合流写法 + 规模上限
├── reference/assets.md       # 素材命名→character.json/URL 规则、差分写法
├── scripts/
│   ├── lint.mjs              # 语法/引用/键名校验（纯离线，退出码非 0 = 失败）
│   ├── build-character-patch.mjs  # 从 art/ 目录清单生成 character.json 增补
│   ├── split-branches.mjs    # 文章结构 → 多章节 + Decision/Predicate 骨架
│   └── package.mjs           # 产出 story.json / script.txt / metadata.json
├── examples/                 # 1 个完整样例 + 1 个带 3 选项支线的样例
└── templates/                # 章节骨架、常用演出片段（入场/回忆/黑屏/战斗）
```

### 4.3 SKILL.md 硬约束（建议原文）
1. 每行只能是 `[Cmd(...)]`、`[name="X"] 文本`、`// 注释` 或续行结尾 `\`；
   说话人**必须**是 `name`（不是 `dialog`、不是 `name2`）。
2. 只用 A 级指令；B 级需在 `metadata.json` 标注；C 级默认禁用。
3. 角色引用一律 `基名#N$G` 或 `基名@alias`；基名必须在角色表里（本地增补或 PRTS 表）。
4. 分支只用一种形状（推荐「官方片段式」）：
   ```
   [Decision(options="A;B;C", values="1;2;3")]
   [Predicate(references="1")]  …A…
   [Predicate(references="2")]  …B…
   [Predicate(references="3")]  …C…
   [Predicate(references="1;2;3")]  ← 必须合流，否则后续内容会被某个 fragment 吃掉
   ```
5. 一部脚本 ≤ 8 个 `Decision`，总组合数（∏ 选项数）≤ 64，超出则拆章。
6. 结尾必须 `[End]`（引擎会自动补 `[endtip]`）。
7. 产出后**必须**跑 `lint.mjs`（校验括号配对、参数键名、角色/素材引用存在性、`Decision/Predicate` 配对），
   校验通过才允许写 `story.json`。

### 4.4 单篇转换流程（skill 内步骤）
1. 读文章 → 切场景（地点/时间/在场角色）与对白/旁白。
2. 场景 → `[Background]`（先在 PRTS `background.json` 里选近似背景；选不到就用本地素材）。
3. 角色出场 → `[charslot]`/`[Character]`（按 `character.json` 的实际组号选表情；演算差分用 `#N$G`）。
4. 情绪节拍 → `[Delay]`/`[CameraShake]`/`[Blocker]`/`[CameraEffect]`，克制使用。
5. 文章里的「选项/分叉」→ 决策形状；线性支线 → 章节拆分（多部剧情）或同一 `[Decision]`。
6. 生成角色/素材补丁 → 写包 → `lint` → 冒烟（可选：无头 bit 位截图）。
7. 输出：包目录 + `metadata.json` + 校验报告。

---

## 5. 端到端验证清单
- [ ] `npm run build` + `cargo test`（Rust 空跑；本机暂无 cargo → CI/有 rust 的机器执行）
- [ ] 用现有 PRTS 剧情做回归：`W2G/BEG` 仍能播（对照 `scripts/test-storyplayer-browser.mjs`）
- [ ] 本地包：`$DATA_ROOT/library/demo/` 放入样例 → 书架出现 → 播放 → 断开网络复播
- [ ] 分支：三选项脚本，逐条选过一遍，确认合流后内容一致
- [ ] 清缓存/删除章节缓存不会误删本地包
- [ ] 安卓：横屏 + 沉浸式 + 返回手势在本地剧情节同样成立

---

## 6. 不确定 / 待实测
1. **`asset://` vs `prts-cdn://`**：本地文件用 `convertFileSrc`（`asset://localhost/…`，CSP 已放行、
   `assetProtocol` 已开）还是伪造 host 走 `prts-cdn://`？两者都能通，前者更直接但**不走媒体仓**（不参与「清缓存/压缩」），
   后者能进入 `media/` 但需要 host 进 `assetDomains`。建议**默认后者**，把「不进缓存」作为备选。
2. **新版引擎 `loadContext` 的容错**：`character.json` 缺条目时是「不显示」还是「抛错」——线上是压缩代码，
   未做实测；建议第一版就让本地角色表保持完整（≥100 条 + `pos/size`）。
3. **`{@nickname}` 之外的占位符**：`story_variables.json` 里的自定义变量（转换器若引用 `{@xxx}`）需要一起打包。
4. **多篇 → 支线的拓扑**：拆章（串行）还是同一脚本内决策（并行）？见第 7 节问题 Q3。
5. 本机没有 `cargo`/`rustc`，Rust 侧改动（若走「写 cache JSON」方案则无需改 Rust）需在 CI 或有工具链的机器验证。

---

## 7. 需要用户拍板的三个问题
- **Q1 素材来源**：二创立绘/背景是「作者自备（AI 生成立绘）」还是「借用 PRTS 现成素材（`encyclopedia` 里的角色差分）」？
  → 决定 skill 是否要带一个「选角/选背景」的检索步骤。
- **Q2 交付形态**：剧本包是「导入到应用后播放」，还是要能**导出成 PRTS 页面可直接粘贴的 wikitext**（社区分享）？
- **Q3 与主线的关系**：多篇文章是各自独立成书（推荐，简单），还是要在同一篇里做「支线选项」分叉？后者受 `maxStates` 限制，建议 ≤8 个决策。
