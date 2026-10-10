# 剧本包契约（fanfic story pack）

一个包 = 一个目录：**`<资源目录>/assets/library/<packId>/`**。`packId` 同时是路由
`page_title`（进 URL 时 `encodeURIComponent`）、缓存键后缀与 wikitext 的
`文本路径`。

「资源目录」= arkstage 的 data-root（`src-tauri/src/data_root.rs`）：
优先 `PRTS_DATA_DIR` 环境变量 → `config.json` 里的用户覆盖 → 可执行文件同级目录
→ OS app-data 目录。目录里同时住着 `cache/`、`assets/`、`media/`。

契约由 `src/akstage/local/storyPack.js` + `src/akstage/local/library.js` 实现，
应用侧入口是 `frontend/src/lib/localStories.ts`（首选 Rust `list_library`，
回退 `read_asset_text(category="library")` + `assets/library/index.json`；
浏览器探针用 `/__local-library.json` 注水同一 `{id, files}` 结构）。
JSON 形状的**唯一真相**是这两个 `.js`；本文件是它们的说明。

## 1. 磁盘布局

```
$DATA_ROOT/assets/library/<packId>/
├── pack.json                    # 必填元信息（见 §2）
├── script.txt                   # 必填：编译产物（引擎直接播的文本）
├── source/                      # 作者脚本（带 @tag 控制位；见 §5）
│   ├── script.txt
│   └── probe.txt                # 取景器自检脚本（可选；probe.mjs 读它）
├── patch/                       # 全部可选：对上游数据表的增量
│   ├── characters.json          # character.json 的增量
│   ├── resolutionRules.json     # background.json 的增量
│   └── story_variables.json     # story_variables.json 的增量
├── build/                       # 全部可选：构建产物/摘要
│   ├── runtime.json             # hook＝可自带上游快照（见 §4）
│   ├── assets.json              # { urls:[…], localKeys:[…] }（见 §4.3）
│   ├── inspection.json          # pack.mjs 的取景/控制位摘要
│   ├── chapters.json            # 仅当 source/chapters/*.txt ≥2 时产出
│   └── page.wikitext           # PRTS 可粘贴页面（见 §6）
├── assets/…                     # 可选：本地图片/字体副本（应用不读盘，只按 URL 走缓存）
└── metadata.json                # 可选：PRTS 模板参数（= wikitext 的七个参数，见 §6）
```

- **`script.txt` 是唯一的「必填 + 有内容」文件**；`pack.json` 必填但可以只有
  `id`（缺省标题=id）。
- **没有 `story.json`**：research 报告 §3 里的 `story.json` 只是当时的示意，
  现行契约里元信息在 `pack.json`、剧本在 `script.txt`。
- **包内 `manifest.json` 只作摘要**（`example/` 里有，是 assets.json 里
  URL 的扁平数组版本），两个 `.js` 都不读它；规范摘要 = `build/assets.json`。
  缓存层的 `manifest_<title>` 见 §7（形状又不同，别混）。
- `packId` == 目录名：`list_library` 用目录名报 `id`，`pack.json.id` 应一致
  （不一致时 `lint.mjs` 给 warning，装载按目录/包 id）。

## 2. `pack.json`

```json
{
  "id": "fanfic-demo",
  "title": "同人样例：初次见面",
  "chapter": "同人剧场",
  "author": "demo",
  "description": "取景器自检用的两分支小脚本",
  "branchPoints": ["pick"]
}
```

| 字段 | 必填 | 语义 |
|---|---|---|
| `id` | 是 | 包 id = `page_title` = 缓存键后缀；`[A-Za-z0-9._-]+`，建议 kebab-case |
| `title` | 否 | 书架显示名；缺省 = `id` |
| `chapter` | 否 | 书架里的章节（分组）名；缺省 = `title` → `id` |
| `author` / `description` | 否 | 书架元信息 |
| `branchPoints` | 否 | 分支点 tag 列表（给 UI/工具；引擎不读） |

真实样例：`example/fanfic/demo/pack.json`。

## 3. `patch/*.json`

三个 patch 都是**同形增量**：顶层键 = 上游表的键。

| 文件 | 合并进（`data` 的键） | 典型内容 |
|---|---|---|
| `patch/characters.json` | `https://torappu.prts.wiki/assets/avg/character.json` | OC/机设条目的 `pos`/`size`/`array`；或修正上游条目 |
| `patch/resolutionRules.json` | `https://torappu.prts.wiki/assets/avg/background.json` | 自备背景的 ppu 值 |
| `patch/story_variables.json` | `https://torappu.prts.wiki/gamedata/latest/story/story_variables.json` | 自备音频/头像变量 |

合并规则（`library.js::mergeTables`，**契约**）：

- **条目级覆盖**：同名键覆盖，新键新增；
- 条目内 `array` / `groups` / `pos` / `size` **缺省沿用上游**，只覆盖写出的字段；
- 值显式写 `null` → **删除**该条目（`"char_old": null`）。

## 4. `build/`

### 4.1 `build/runtime.json`

```json
{
  "story": { "script": "…（编译后的脚本全文）…", "title": "fanfic-demo" },
  "bundle": {
    "entry": "https://static.prts.wiki/widgets/production/StoryPlayer.<hash>.js",
    "prelude": ["https://static.prts.wiki/widgets/production/polyfills.<hash>.js"],
    "modules": { "<url>": "<源码>" },
    "styles": { "<url>": "<css>" },
    "data": {
      "https://torappu.prts.wiki/assets/avg/character.json": { "char_130_doberm_ex": { "…": "…" } },
      "https://torappu.prts.wiki/assets/avg/background.json": { "bg_black": 100 },
      "https://torappu.prts.wiki/gamedata/latest/story/story_variables.json": { "escape_loop": "Sound_Beta_2/Music/AVG/m_avg_…" }
    }
  },
  "revision": "fan:fanfic-demo:1a2b3c4d"
}
```

- 形状 = `StoryRuntime = { story:{script,title}, bundle, revision }`
  （`src-tauri/src/models.rs` 的 `StoryRuntimeData`；前端 `predownload.ts:70-81`）。
- `bundle` = **上游 StoryPlayerBundle 快照**，`pack.mjs` 从
  `scripts/fanfic/fetch-upstream.mjs` 的输出里搬过来（字段名 `entry` / `prelude` /
  `modules` / `styles` / `data`）。
- **`data` 可以在加载时被 patch 覆盖**：`library.js::buildPackBundle` 用
  `mergeTables` 把 §3 的三个 patch 合并进 `data`（缺 patch 时原样用 `bundle.data`）。
  所以 `build/runtime.json` 里存**上游原表**即可，patch 单独放 `patch/`。
- `revision`：本地包用 `fan:<packId>:<hash>`（`library.js::buildHook`，hash 是
  djb2 的 32 位十六进制）；真实产物见 `example/library/fanfic-demo/build/runtime.json`
  （`"revision": "fan:fanfic-demo:29b5f6d2"`）。
- 校验兜底：`data` 里三个 sidecar 必须各 ≥10 键、`character.json` ≥100 项、
  `modules[entry]` 必须存在、`styles` 非空（`storyPlayerAdapter.ts::validateStoryPlayer`，
  `storyPlayerBoot.ts:131` 另有 `linkMap ≥ 100` 的启动闸门）。

### 4.2 `build/chapters.json`

**仅当 `source/chapters/*.txt` ≥2 个时**由 `pack.mjs` 产出（否则不写该文件）。
形状（`pack.mjs::buildChapters` 逐字）——章节数组，每项：

```json
[{ "id": "ch1", "title": "ch1", "script": "…（含 @tag 的原文）…",
   "cleanScript": "…（stripControls 后＝可播文本）…" }]
```

`library.js` 读它放进 `Pack.chapters`（缺省 `null`）；**同一 pack 的正文以
`script.txt` 为准**，`chapters.json` 只影响导出 wikitext 时拆成几页。

### 4.2b `build/inspection.json`

`pack.mjs` 的取景摘要，形状 `{source, tags:[{command,tag,line}], probe}`；
`probe.mjs` 的产出另存 `build/fanfic/probe.json`
（`{surface, nodes, samples, choices, stage, html, screenshot}`）。
两者都只给工具/核对用，引擎不读。

### 4.3 `build/assets.json`

资源摘要（可选，供核对/预下载），由 `pack.mjs` 写出，形状**固定**：

```json
{
 "urls": ["https://torappu.prts.wiki/assets/avg/background/bg_black.png",
          "https://torappu.prts.wiki/assets/avg/characters/char_130_doberm_ex/char_130_doberm_ex.png"],
 "localKeys": ["local.arkstage.invalid/art/my_oc_1.png"]
}
```

（真实产物：`example/library/fanfic-demo/build/assets.json`，`urls` 3 条、
`localKeys` 0 条。）

- `urls`：`https://host/...`，按 URL 排序去重（`host` 必须带点）；
- `localKeys`：**裸键形态**的非 https 引用（约定的自备素材 host：
  `local.arkstage.invalid/art/x.png`）；
- 媒体仓 `canonical_key` 两种都收（`src-tauri/src/media.rs:31-70`）；
  只有 `file://` / `data:` / 无点 host 会被拒；
- **下载器只吃 `http(s)` 条目**（`download.rs` 过滤），`localKeys` 只用于摘要。
- `pack.mjs` 还会在 stdout 报 `missingCharacters` / `unresolvedAudio`
  （引用了但解析不到的角色/音频键）——有输出就去补 patch 或换键。

## 5. `source/` 与编译（`@tag` → `script.txt`）

`source/` 只保存**作者脚本**，控制位写成 `@tag`：

```
[charslot@arrive(slot="m", name="char_130_doberm_ex", duration=0.5)]
[Decision@pick(options="跟着她走;先问清楚", values="1;2")]
[charslot@branchA(slot="m", name="char_002_amiya_1#1", duration=0.5)]
[Predicate(references="1;2")]
[charslot@resolve(slot="m", name="char_130_doberm_ex", duration=0.5)]
```

（真实样例：`example/fanfic/demo/source/probe.txt` + `source/probe.plan.json`，
tag 与分支片段的对应关系写在 `probe.plan.json`。）

编译（`node scripts/fanfic/pack.mjs <packDir>`）：

1. **取景**：`probe.mjs` 在 headless Chromium 里跑真正的 StoryPlayer，
   按 `probe.plan.json` 记录控制位的**执行时机**，产出
   `build/fanfic/probe.json`（`{surface, nodes, samples, choices, stage, html}`
   + 同目录截图）；`--pack` 指定包目录（固定读 `source/probe.{txt,plan.json}`）；
2. **偏移编译**：`pack.mjs` 读 `probe.json` 的 `plan`/`nodes`
   （`{tag, command, offset|line}`）→ `(command@tag) → 上游行号`，
   在原控制位行前插入**注释** `// [probe] @tag → 上游控制位 #N`
   （注释在引擎里整行丢弃），并写出引擎直接可播的 **`script.txt`** ——
   关键动作是**去掉 `@tag`**
   （`storyPack.js::stripControls` / `library.js::stripControls`：
   `[Cmd@tag(...)]` → `[Cmd(...)]`）；
3. **`build/runtime.json`**：把上游快照 + 编译脚本 + `revision` 组装成 §4.1。

**一条播放里每个决策片段只保留一份对白**：`@tag` 编译后每个片段内的
`[name="…"]` 只出现一次，取景器用这个信号判断「片段已播完」并决定
何时写入分支偏置；重复对白会让自动播放的逐行进度错位。

## 6. `metadata.json` 与 `build/page.wikitext`

`metadata.json` = PRTS 模板参数（键名与模板一致，逐字对照
`docs`/`~/.akresearch/prts/Template_剧情模拟器.txt`）：

```json
{
  "文本路径": "fanfic-demo",
  "剧情类型": "同人",
  "剧情分组": "同人剧场",
  "图片数据": "{{Widget:Data_Image}}",
  "角色数据": "{{Widget:Data_Char}}",
  "音频数据": "{{Widget:Data_Audio}}"
}
```

`build/page.wikitext` = 可**直接粘贴到 PRTS 页面**的完整 wikitext：

```
{{剧情模拟器|图片数据={{Widget:Data_Image}}|角色数据={{Widget:Data_Char}}|音频数据={{Widget:Data_Audio}}|文本路径=fanfic-demo|剧情类型=同人|剧情分组=同人剧场|文本数据=
[HEADER(key="fanfic_sample", is_skippable=true, fit_mode="BLACK_MASK")]
…
[Blocker(a=1, r=0, g=0, b=0, fadetime=1.5, block=true)]
}}
```

- 七个参数即模板文档里列出的：`文本数据` / `图片数据` / `角色数据` /
  `音频数据` / `文本路径` / `剧情类型` / `剧情分组`
  （`~/.akresearch/prts/Template_剧情模拟器__doc.txt`）；其中前四个进
  `{{#Widget:ScenarioSimulator}}` / `{{#Widget:StoryPlayer}}`，
  后三个只在主名字空间写 Cargo 表 `story`
  （`Template_剧情模拟器.txt` 的 `#cargo_store`）——**非主名字空间页面
  可省略后三个**。
- 上游素材时三个数据参数用 `{{Widget:Data_Image}}` / `{{Widget:Data_Char}}` /
  `{{Widget:Data_Audio}}`（官方页面就是这三个，见
  `~/.akresearch/prts/page_0-1_坍塌_BEG.txt:1`）；自备素材时换成自己的
  Widget/内联表。
- 官方页面里 `文本数据` 之后是**匿名参数**（第 8 个位置参数）承载脚本正文，
  直到模板收尾 `}}`。
- 脚本正文里若出现 `|`，在匿名参数位置**可能**被 MediaWiki 解释器当作参数
  分隔（仅 `[Sticker]` 之类含 `|` 的少数行；语料里
  `activities/act29side/mark/mark7.txt` 等有 `|`）——导出前用 lint 报告提示，
  必要时把该行改写（拆成两条 `Subtitle`/`Sticker`）。
- 导出的行 **不含** `@tag`（wikitext 是编译产物，与 `script.txt` 同源）。

## 7. 缓存键导入（与上游剧情同构）

除了 `assets/library/` 目录，包也可以「装作」PRTS 剧情写进缓存；两条路都通，缓存键
用于断网/预下载与和上游一致的播放路径。缓存文件名
（`src-tauri/src/commands/cache.rs`）：把 `title` 里的
`/ \ : * ? " < > |` 换成 `_`，再加 `.json`，落在 `$DATA_ROOT/cache/`。

| 缓存键（`load_from_cache` 的 key） | 形状（逐字） | 谁读 |
|---|---|---|
| `stories_<title>` | `{ "script": "…", "title": "…", "pageRevision": "…", "scriptHash": "…" }`（后两项可选）| `ensureScriptRecord` 兜底 |
| `story-runtime-v6_<title>` | `{ "story": {"script","title"}, "bundle": {…}, "revision": "…" }` | `loadStoryRuntime`（优先） |
| `story-runtime-v6_<title>-previous` | 同上 | 候选校验失败时的回滚代 |
| `manifest_<title>` | `[ "https://…", … ]` **或** `{ "schemaVersion": 2, "runtimeRevision": "…", "pageRevision": "…", "scriptHash": "…", "urls": [ … ] }` | Rust 下载器（两种都接受，`cache.rs::parse_manifest_urls`）|

`runtimeRevision` 的构造：`"<bundle.revision \|\| legacy>\|<engineAssetsRevision \|\| unknown>"`；
`manifest_` 只在 `schemaVersion===2 && runtimeRevision` 与 `pageRevision` 都
匹配时才复用，否则重抓。

## 8. 应用怎么找到它（player discovery）

1. Rust `list_library()` → `Array<{ id, files: Record<string,string> }>`
   （`files` 的键是包内相对路径，值是该文件全文；应用**只读**
   `pack.json`/`script.txt`/`patch/**`/`build/**`，
   `assets/…` 仅供离线打包/字体预取）；
   `read_library_file(pack, name)`（可选）读单文件 ——
   `frontend/src/lib/localStories.ts` 目前只用 `list`；
2. `library.js::localPacks()` → 过滤（缺 `script.txt` 或 `id` 的包丢弃）并按
   `id` 排序、缓存；
3. 书架：`mergeLocalStories(index)` 把包合并成 **「同人剧场」分类**
   （`name`/`chapters[].name`=`pack.chapter`，`stories[].page_title`=`pack.id`），
   不动上游索引；
4. 播放：路由 `/play/<encodeURIComponent(packId)>` → `localStoryOverride(pageTitle)`
   命中即返回 `{story:{script,title}, bundle, revision, source:"local"}`，
   交给同一个 `bootStoryPlayer()`；本地包**不校验、不覆盖**上游候选快照，
   天然离线；
5. 素材：`library.js::collectAssetHosts()` 把脚本/patch 里出现的
   `*.invalid` host 并进 `assetDomains`，于是自备 URL 走
   `prts-cdn://`（命中 `$DATA_ROOT/media/…`，断网可播）。

## 9. 离线命令（skill 三步）

| 步骤 | 命令 | 说明 |
|---|---|---|
| 1 校验 | `node scripts/fanfic/lint.mjs <packDir>`（`--json <out.json>` 出报告、`--strict` 让 warning 也算失败）| 包级检查 + 纯函数 `lintScript()`（`storyPack.js`）：语法/指令分级/拼写漂移/`Decision`-`Predicate` 配对/合流/决策数≤8/∏选项≤64/收尾。报告形状（逐字）：`{ ok, errors:[{file,line,message}], warnings:[…], info:[…], toc:[…], counts:{commands,decisions,combos,lines}, pack }`；退出码 0=通过 / 1=有 error（或 `--strict` 下有 warning）/ 2=用法错误。`script.txt` 缺失时按 `source/script.txt → source/probe.txt → source/*.txt` 兜底并先 `stripControls` |
| 2 打包 | `node scripts/fanfic/pack.mjs <packDir> [--upstream <snapshot.json>] [--out <path>\|"-"] [--force] [--dry-run] [--json <report.json>]`（别名 `build.mjs`；旧名 `build-pack.mjs`）| 编译 `script.txt`（去 `@tag` + 取景偏移注释）→ `build/runtime.json`（hook）+ `build/assets.json` + `build/inspection.json`；`source/chapters/*.txt ≥2` 时另出 `build/chapters.json`。退出码 0=成功 / 1=lint 有 error（`--force` 除外）/ 2=用法错误 |
| 2′ 取景 | `node scripts/fanfic/probe.mjs --pack <packDir> --upstream build/fanfic/upstream.json --out build/fanfic/probe.json` | 可选；量控制位执行时机与选项标签（`build/probe.json` = `{surface,nodes,samples,choices,stage,html}`）|
| 2″ 端到端 | `node scripts/fanfic/verify-pack.mjs --library <libraryDir> --assets build/fanfic/assets --upstream build/fanfic/upstream.json --out build/fanfic/verify --choice 0\|1` | 用**应用自身的** `loadStoryRuntime` + `bootStoryPlayer` 在 headless Chromium 里点完一遍，落 `verify/<packId>/{frames.json,shots/*.png}`；退出码非 0 = 没跑通 |
| 3 上游快照 | `node scripts/fanfic/fetch-upstream.mjs [out.json] [sourceTitle]` | 默认 `W2G/BEG`；产出 `{source, story, bundle}`（`pack.mjs` 从它取 `bundle`）|
| 3′ 装包 | `node scripts/fanfic/install-library.mjs <packDir\|libraryDir> [--data-root <dir>] [--dry-run]` | 镜像成 `<dataRoot>/assets/library/`（+`index.json` 清单）；不带 `--data-root` 写 `build/fanfic/assets-library/` |
| 3″ 目录/章节名 | `node scripts/fanfic/prts-index.mjs` | 产出 `build/fanfic/story-index.json`（导出 wikitext 用的 `剧情类型`/`剧情分组` 参考）|

`npm run build` / `node --test` 只覆盖应用侧；包的正确性由 1 的退出码 + §10 的
验收项保证。

## 10. 最小验收（一个包做完要能过）

- [ ] `node scripts/fanfic/lint.mjs <packDir>`：`errors` 为空（warning 可解释）；
- [ ] `script.txt` 里无 `@tag` 残留、有**收尾**（推荐 `[endtip(block=true)]`
      或 `[Blocker(a=1, …)]`；`[End]` 会有 `unknown_command end`）、
      每个 `Decision` 都有覆盖全部 values 的合流 `Predicate`；
- [ ] 三个 sidecar 路径与 §4.1 一致（大小写敏感）；
- [ ] `patch/*.json` 的条目能被 `mergeTables` 合并（无 `null` 误删）；
- [ ] `pack.json` 的 `id` 与目录名一致（`$DATA_ROOT/assets/library/<id>/`）；
- [ ] 书架出现「同人剧场」→ 点进去能播 → 断网复播；
- [ ] `build/page.wikitext` 粘到 PRTS 沙盒页面能渲染、LOG ALL 可开；
- [ ] 多分支脚本逐条选一遍，合流后内容一致（`branching.md` §6）；机器上跑
      `verify-pack.mjs --choice 0|1` 复核（它用应用自身的播放链路）。
