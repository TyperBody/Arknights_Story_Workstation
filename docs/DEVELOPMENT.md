# 开发与构建（开发者文档）

面向贡献者 / 自行构建的开发者。普通使用说明见仓库根的 [`README.md`](../README.md)。

## 🧩 工作原理（简述）

```
prts.wiki ──HTTP──▶ Rust 后端 ──invoke──▶ React 前端 ──注入 iframe──▶ 原版引擎运行
                       │                                                  │
resources@GitHub ─jsDelivr/GitHub Raw─▶ 书架元数据/封面    图片经 prts-cdn://「先本地后网络」
                       └──────────────── 本地缓存 (APPDATA) ───────────────┘
```

- **Rust 后端**抓取并解析剧情目录与剧本，管理缓存，并提供自定义 `prts-cdn://` 协议：所有上游请求统一经 `net::client()` 发送，使用可识别且含项目联系地址的 `Arkstage/<version>` User-Agent；命中本地的内容寻址仓库（`$APPDATA/media/{host}/{path}`）即离线返回，未命中时（且允许联网）带正确 Referer 拉取并落盘。PRTS 会拒绝伪装成通用浏览器的自动请求，因此不要把共享 User-Agent 改回 Chrome/Firefox 字符串。
- **前端**在隔离的 `<iframe>` realm 中启动原版引擎（每个剧情独立 realm，避免引擎顶层 `const` 冲突），并复用引擎自身的 `fun_sys_preload()` 精确枚举某剧情所需资源用于预下载。
- **书架资源**不进入安装包：`BookshelfMetadataContext` 先读 `cache/bookshelf-metadata.json`，每次启动再以 `cache: no-store` 刷新 jsDelivr；网络或格式失败则自动改走 `raw.githubusercontent.com`。只有通过完整校验的响应才会覆盖内存和缓存；双线路都失败时保留旧缓存并显示可重试提示。封面/横幅同样在首选源加载失败后切换另一源，使用哈希文件名并经 `prts-cdn://` 懒加载到内容寻址缓存，因此离线可复用，更新分类或封面无需发版。
- **PRTS 演出运行时**使用同页原子快照：播放时从同一个响应提取剧情脚本、全部 `datas_*` 表和内联引擎，SHA-256 版本校验后写入 `story-runtime-v3`；外部 JS/CSS 每次应用生命周期热更新，完整性失败保留 last-known-good。引擎启动前会从 `datas_char` 为 `datas_link` 尚未收录的新角色补齐缺失分组，并静态审计立绘/背景/CG 引用。
- **预下载同步校验**先批量查询 MediaWiki oldid；只有页面 oldid、全局表哈希和外部引擎哈希全部匹配的 v2 manifest 才会复用。媒体下载与协议缓存会校验文件魔数并原子写入，HTML 错误页、空文件和中断文件会被删除后重新拉取。

更详细的设计见 [`docs/superpowers/specs`](superpowers/specs) 与 [`docs/superpowers/plans`](superpowers/plans)；架构约定见仓库根 [`CLAUDE.md`](../CLAUDE.md)。

## StoryPlayer 新版引擎（2026-09）

PRTS 当前同时嵌入旧版 ScenarioSimulator 与新版 StoryPlayer。后端优先识别页面的 `StoryPlayer.<hash>.js` 入口，递归抓取完整模块图、页面样式及 Torappu 的 `character.json`、`background.json`、`story_variables.json`；不依赖旧版 DOM 或 `datas_back/datas_link`。同一应用会话只刷新一次相同引擎版本，失败不缓存。完整数据参与 SHA-256，随 v6 运行时快照保存，离线时不请求可变数据表。

前端在独立 iframe 中通过 import map 加载缓存的模块图，保留模块循环依赖、延迟导入和资源 URL 的原始基址。`storyPlayerAdapter.ts` 从源程序结构识别上游的 context、manifest 与 Vue mount 入口，接口变化或模块缺失会阻止快照升级。新版清单使用上游 `collectContextAssetManifest`，另补字体和 UI 纹理；图片 Worker、直接设置 src 的图片 / 音视频以及 fetch 都经过本地媒体代理。可见模式等待预加载完成并实际开始播放后才算启动成功。切换剧情时卸载 Vue 应用、销毁播放器并回收模块 Blob URL。

v5 及更早缓存仍由旧版引擎启动；不把旧资源表数量与新版表比较，也不自动把新版快照降级成源站的旧版引擎。已有剧情媒体保留，但新版采用不同资源 URL，升级后应重新预下载需要离线观看的剧情。

桌面及移动 WebView 使用 WebGL 渲染：适配器只改写上游 Pixi 初始化参数中的 `preference: "webgpu"`，避开当前 WebGPU 批次缓存对已销毁纹理的残留绑定，保留原始资源错误日志。Vue 卸载钩子负责销毁播放器，不再额外重复调用 `player.destroy()`。

原生提示统一使用 `dialogs.ts` 封装的异步插件 API；确认结果必须 `await`，弹窗失败视为取消，避免旧版 `window.confirm` 桥接调用已移除的 `dialog.confirm` 命令。

运行 `npm run test:storyplayer` 验证接口适配、模块依赖与离线资源补全，`npm run test:dialogs` 验证确认、取消和弹窗失败的处理。真实源站和浏览器验证步骤见 [`scripts/README.md`](../scripts/README.md)。原 `verify:prts-sync` 仍审计源站保留的旧版表，不能代替新版的浏览器验证。

## 环境要求

- **Node.js** ≥ 18（推荐 20+）
- **Rust** 稳定版工具链（通过 [rustup](https://rustup.rs) 安装）
- 各平台的 Tauri 2 系统依赖（见下）

## 平台系统依赖

**Linux（Debian / Ubuntu）**

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Windows**：安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 与 WebView2 运行时（Win10/11 一般已自带）。

**macOS**：安装 Xcode Command Line Tools（`xcode-select --install`）。

> 其他发行版与详细说明参见 [Tauri 官方先决条件](https://v2.tauri.app/start/prerequisites/)。

> 注：资源压缩功能依赖 `webp` crate（封装 `libwebp`，由 `cc` 从源码编译 C 代码）。它随 `cargo build` 自动构建，无需额外系统包；交叉编译到 Android 走与 `ring` 相同的 NDK `cc` 路径（已验证 aarch64 可构建）。图片解码用纯 Rust 的 `image` crate。

## 常用命令

```bash
npm install            # 安装前端依赖

# —— 全应用（前端 + Rust 后端一起）——
npm run tauri:dev      # 启动桌面应用（前端热重载 + Rust 后端）
npm run tauri:build    # 构建当前平台安装包到 src-tauri/target/release/bundle/
                       # （内部会先 npm run build 打包前端，再编译 Rust 并打包）

# —— 仅前端 ——
npm run dev            # 仅启动前端（Vite，浏览器调试用；引擎相关功能需在 Tauri 内运行）
npm run build          # 仅构建前端（tsc + vite）
npm run lint           # ESLint
npm run test:metadata  # 书架元数据校验与 jsDelivr → GitHub 回退单测

# —— 仅后端（Rust / Tauri）——
cargo test  --manifest-path src-tauri/Cargo.toml   # 后端单元测试
cargo build --manifest-path src-tauri/Cargo.toml   # 仅编译后端（debug）
```

> `npm run tauri:build` 是**完整构建**：先打包前端（`npm run build`），再编译 Rust 后端并生成安装包。上面的 `cargo` 命令仅用于单独测试 / 编译后端。

> 📱 **Android**：见 [`android-build.md`](android-build.md)。`scripts/build-android.sh` 默认产出可侧载的 **release** APK（`ABI=` / `RELEASE=` 可调；应用私有外部存储 `getExternalFilesDir`，无资源目录选择器，其余功能与桌面对等）。

## 如何验证构建是否正确

按从快到慢、从本地到云端的顺序：

1. **静态检查（最快，离线）**：`scripts/test-static.sh` —— 等价于 CI 的 `check` 任务（cargo test + cargo build + tsc + vite build）。
2. **本地完整打包**：`npm run tauri:build` —— 复现 CI `build` 任务，在 `src-tauri/target/release/bundle/` 下生成**当前操作系统**的安装包。

   只想快速验证某一种格式，可指定打包器（`--` 不能省，否则 npm 会吞掉参数；且只能构建当前系统支持的格式）：

   ```bash
   # Linux（本机）：deb / rpm
   npm run tauri:build -- --bundles deb
   # Windows 上：nsis        macOS 上：dmg / app
   ```

   > `--bundles` 按**宿主系统**校验，本地 `tauri build` 默认只出当前系统的格式。跨平台安装包交给 Release 工作流在各自 runner 上产出；如需在 Linux 上交叉出 Windows 包，见下。
3. **本地跑 Actions（可选）**：用 [`act`](https://github.com/nektos/act) 在本地执行工作流，例如 `act push -j check`。
4. **云端真跑**：推送到分支会触发 `check`；在 GitHub **Actions → CI → Run workflow** 可手动构建任意分支的安装包；验证发布流程可推一个测试标签：

   ```bash
   git tag v0.0.1-test && git push origin v0.0.1-test   # 含连字符 → pre-release，可随后删除
   ```

## 在 Linux 上交叉构建 Windows 包（实验性）

可以在 Linux 上直接产出 Windows 的 **NSIS 安装包（`*-setup.exe`）**，已实测可用：

```bash
scripts/build-windows.sh
# 等价于：
#   sudo apt-get install -y mingw-w64 nsis
#   rustup target add x86_64-pc-windows-gnu
#   npm run tauri:build -- --target x86_64-pc-windows-gnu   # 注意：不要带 --bundles
```

脚本会把成品 `Arkstage_<版本>_x64-setup.exe` 放到 **`build/artifacts/`**，并在构建后清除庞大的交叉编译中间产物（设 `KEEP_TARGET=1` 可保留以加速重复构建）。整个 `build/` 已在 `.gitignore` 中忽略。

要点与限制：

- **不要带 `--bundles`**：该参数按宿主系统校验会报错；省略后 Tauri 依据 `tauri.conf.json` 的 `bundle.targets` 并按**目标平台**选打包器。
- 该二进制是 **GNU ABI**（非 GitHub `windows-latest` 的 MSVC ABI）；能在 Windows 运行，要最「官方」的产物仍建议用 Release 工作流，或改用 [`cargo-xwin`](https://github.com/rust-cross/cargo-xwin) 走 `--target x86_64-pc-windows-msvc`。
- Tauri 将交叉编译标记为**实验性**，安装包**未签名**；首次构建会从 GitHub 下载 `nsis_tauri_utils.dll`（需联网）。

> 想出 macOS 的 `.dmg` 仍需对应系统。`act` 只能跑 Actions 的 **Linux** 任务，无法替代 Windows/macOS runner——最省事的跨平台出包方式是已配置好的 GitHub Actions。

## 项目结构

```
arkstage/
├─ frontend/                 # React 前端（index.html / vite·ts·eslint 配置）
│  └─ src/
│     ├─ pages/              # 首页 / 浏览 / 播放器 / 设置 / 关于 / 使用说明
│     ├─ lib/                # engineBoot(引擎启动) · predownload(清单+预下载) · proxy(CDN 改写) · version(更新检测)
│     └─ hooks/
├─ src-tauri/                # Tauri / Rust 后端
│  └─ src/
│     ├─ commands/           # wiki(抓取) · cache(缓存) · assets(下载)
│     ├─ parser/             # 剧情目录 / 剧情页解析
│     ├─ media.rs            # 内容寻址媒体仓库
│     ├─ android_service.rs  # 横屏 / 沉浸式 / 前台保活
│     └─ lib.rs              # prts-cdn:// 协议 + 命令注册
├─ scripts/                  # 构建 / 测试 / 清理脚本
├─ tools/build-resources/    # 书架分类源 + 独立 resources 分支生成器
├─ docs/                     # 开发者文档、构建指南、设计 spec/plan
├─ build/                    # 构建产物：dist/（前端 bundle）+ artifacts/（安装包/APK）
└─ .github/workflows/        # CI 与 Release 工作流
```

## 测试

```bash
scripts/test-static.sh   # 离线：cargo test + cargo build + tsc + vite build
scripts/test-e2e.sh      # 无头端到端冒烟：Xvfb 启动真实应用，xdotool 驱动并断言副作用
scripts/run-tests.sh     # 以上全部
```

`test-e2e.sh` 需要 `Xvfb`、`xdotool`、ImageMagick，且需联网（prts.wiki）；它会临时清空本地缓存以保证结果确定。详见 [`scripts/README.md`](../scripts/README.md)。

### 验收 harness（`scripts/harness/`）

`npm run test:harness`（= `node scripts/harness/run.mjs`）一条命令跑完整套无头验收；
`--list` 看清单，也可只跑某组（`… run.mjs workbench`）或某项（`… run.mjs branch-shot`）。
每个 harness 也可单独 `node scripts/harness/<name>.mjs`；真身在 `build/harness/*.mjs`。
需求 → harness 的完整映射与「写后即用 / 写坏不崩」规则见 [`docs/dev/harness.md`](dev/harness.md)。

### 下载源 / 镜像（「设置 → 下载源」）

同一份模板表存在两处，**必须逐字符一致**：`src/akstage/assetRouting.js::MIRRORS`
（设置页预览 + 引擎候选 + 离线脚本）与 `src-tauri/src/media.rs`（`MIRROR_TPL_*`
常量，真正取字节：下载引擎 `download.rs::fetch_item` 与 `prts-cdn://`
cache-through）。`node tools/mirror/mirror-selftest.mjs` 的 **A2** 断言组会读
Rust 源码里的常量与 JS 的运行时展开逐字节比对（另有 Rust 单测
`media::tests::mirror_url_matches_asset_routing_templates` 写死同一组期望）。

- 源顺序：`首选源 → custom(有模板) → pack(官方) → 其余镜像 → prts`，首个 2xx 即成功；
  URL 按源拼，**落盘永远按 canonical key**（`media::write_local(root, key, …)`），
  所以换源不产生重复缓存、不改目录结构。
- 选中源存 Rust 进程级 `download::MirrorSettings`（`download_settings_set` 推送），
  下载 worker 每次取字节时现读 —— 换源对**已在跑**的任务也生效。
- 可镜像 host 限 `MIRRORABLE_HOSTS`（`static/torappu/media.prts.wiki` + `code.jquery.com`）；
  其余 host 一律官方直连。
- 探针：`mirror_probe_url` / `mirror_probe_chain` / `system_counts`（含 `jobs[].sources`
  与 `protocolSources` 的每源命中计数），供原生脚本或设置页排查「换了源到底走没走」。
- 日志：命中源会打 `[download] source=jsd key=…`、`[prts-cdn] source=jsd key=…` 与
  `[engine-update] source=jsd url=…`（`RUST_LOG=debug` 看每次尝试，`info` 看最终命中）。
- **引擎层也走同一源链**：`commands/story_player.rs::fetch_text`（模块 / 样式 / 3 张
  sidecar）与 `commands/assets.rs::refresh_engine_asset`（jQuery / PreloadJS / toolbox /
  CSS，返回 `AssetSnapshot.source`）都调用 `media::source_chain`；`from_html` 的
  `WIDGET_BASE` / `SIDECARS` 常量值不变。**边界**：镜像仓只发引擎层 —— `prts.wiki/w/…`
  的 HTML（剧情索引 / 页面 / oldid）保持官方直连（`wiki.rs` 不参与源链）。

> ⚠️ 已知限制：Linux 的 WebKitGTK 可能缺少 mp3/ogg 编解码器导致**音频不出声**，画面正常；Windows / macOS 自带编解码器无此问题。

### 随包素材：起步素材集（P9）

`src-tauri/resources/assets/starter/`（287 个文件 / 14.6 MB）是**策展**过的常用素材：
7 张 UI 小图（PNG）+ 120 张高频背景 + 160 张主要角色立绘（PNG → WebP q78/q85）。
它让自创剧情不再「每次打开都联网拉资料」。

- 生成/校验：`node scripts/fanfic/fetch-starter-assets.mjs`（`--check` 离线、`--budget=25MB`、
  `--only=core|background|portrait`、`--force`）。选择规则**确定性**：按剧情语料的
  `[Background(image=…)]` / `[Character|charslot(name=…)]` 频次降序；语料目录同
  `scripts/fanfic/stage-selftest.mjs`（`AKSTAGE_CORPUS_DIR` 可覆盖）。
- 清单：`curated.json`（key/group/bytes/sha256）+ `bundles.json`（canonical key → 文件名）。
  三者（含 `SOURCES.md` 出处）由脚本一次生成，`build/harness/starter-assets.mjs` 全量回归。
- **随包**：`tauri.conf.json` 的 `bundle.resources` 带上 `resources/assets/starter`（**只加这一条**，
  不给每张图写 `include_bytes!`）。启动时 `seed_starter_sync`（幂等）把文件复制到
  `<资源目录>/assets/starter/`；开发者直接 `cargo build` 时 `bundle.resources` 也把资源放到
  `target/release/resources/`（探针据此模拟打包布局）。
- **命中顺序**：`prts-cdn://` 覆盖层先查 `assets/starter/`、再查 `assets/sample/`
  （`bundled_asset_keys()` 合并两份清单，`packAssets.ts` 自动继承）；两边都没有 → 本地媒体缓存 →
  按「下载源」源链取字节并缓存。
- 设置 →「缓存管理」显示 `随包素材：N 张 / X MB`（`starter_set_info`），资源目录缺文件时可
  「补齐随包素材」（`starter_set_sync`）。


### Windows 产物（交叉编译自 Linux）

| 产物 | 命令 | 说明 |
|---|---|---|
| `Arkstage_1.2.0_x64-setup.exe`（NSIS 安装器，~26 MB） | `bash scripts/desktop-build.sh windows` | `targets: nsis`，`webviewInstallMode: embedBootstrapper`；`build/toolchain/target-win` 缓存，LTO 链接 ~4 min |
| `Arkstage_<ver>_windows_x64-portable.zip`（免安装，~26 MB） | `bash scripts/build-windows-portable.sh` | 自带 `Arkstage.exe` + `WebView2Loader.dll` + **`resources/assets/**`**（随包起步素材，287 张） |

`build-windows-portable.sh` 现在**自己**处理这些（2026-10-12）：`CARGO_TARGET_DIR` 默认
`build/toolchain/target-win`（与 `desktop-build.sh windows` 同一个目录 → 先出 NSIS 再打便携包
**复用**同一份跨编译产物；此前写死 `src-tauri/target/...` 会整个 Windows 依赖图重编，实测 +76 min）、
`rustup` 走 `$CARGO_HOME/bin`（bare 环境下 PATH 里没有）、exe 发布名 `Arkstage.exe`、
并把 `src-tauri/resources/assets` 拷进 `resources/`（`--no-bundle` 不会自动拷 `bundle.resources`）。
预构建清理**只删** `target/...`（除非 `KEEP_TARGET=1`）。

## CI / Release

- **CI**（`.github/workflows/ci.yml`）：每次 push / PR 运行静态检查；push 时额外为各平台构建安装包并作为 Workflow 产物上传（即「CI 版」）。
- **Release**（`.github/workflows/release.yml`）：推送 `v*` 版本标签时，为 Android(arm64-v8a APK) / Windows / macOS(Intel + Apple Silicon) / Linux 构建并发布到对应 GitHub Release 的 Assets。标签含连字符（如 `v1.0.0-beta.1`）发布为 **pre-release**。
- **书架资源**（`.github/workflows/update-storylines.yml`）：手动运行后从 PRTS 重建 StoryLine 分类、从 ArknightsAssets2/PRTS 提取封面和横幅、生成内容哈希清单，并发布到独立 `resources` 分支。客户端下一次启动优先通过 jsDelivr 获取，失败时回退 GitHub Raw。

本地生成同一份资源负载：

```bash
node tools/gen-index/gen-storylines.mjs
node tools/extract-covers/extract-mixstory-kv.mjs
node tools/extract-covers/extract-banner-covers.mjs
node tools/extract-covers/extract-chapter-banners.mjs
node tools/build-resources/build-bookshelf-resources.mjs build/resources
```

新增乐章部署时，先运行 `gen-storylines.mjs --report` 确认新书名及所属 StoryLine，再同步两份人工校验映射：`tools/extract-covers/kv-map.json` 对应 ArknightsAssets2 的 `mixstory/kvs/kv_*.png`，`tools/extract-covers/chapter-banner-map.json` 对应活动页面 `活动信息` 模板中的 `标题图文件名`。生成后必须确认 `metadata.json` 同时包含新书名、`covers[书名]` 和 `banners[书名]`，再发布 `resources` 分支。所有读取 PRTS 的 Node 脚本也必须发送可识别且含项目联系地址的 Arkstage User-Agent；通用 Node/浏览器 UA 会被边缘防护拒绝为 403。

⚠️ **发版铁律**：发版前必须把 `package.json` 的 `version` 一并 bump 到 master 再打标签。应用内「检测更新」的首选源读取的就是 master 上 `package.json` 的 `version`（`cdn.jsdelivr.net/gh/<repo>@master/package.json`），漏 bump 会导致检测不到新版本。

```bash
# 正式版
git tag v1.0.0 && git push origin v1.0.0
# 预发布版
git tag v1.0.0-beta.1 && git push origin v1.0.0-beta.1
```

## 本机状态：`state.db`（SQLite）

编辑器排版、面板开关/浮动窗、语言、播放器底栏、已读……这类**"记忆"**存
`<资源目录>/state.db`（`src-tauri/src/state_db.rs`，表 `kv(scope,key,value,updated_at)`），
**不在** `cache/` + `assets/` + `media/` 里 —— 「清除所有缓存」只删后者（
`commands::cache::all_cache_roots()`），所以清缓存不会丢习惯；换机带上 `state.db` 即带走全部状态。

- Rust 命令：`state_db_get/set/del/snapshot/set_many/import/info`（`src-tauri/src/lib.rs` 注册）；
  启动 `setup` 里打一行 `[state] sqlite ready: <path> (N 条)`（**失败只 warn**，前端回落）。
  `PRTS_DB=<file>` 可换库路径（原生测试/多 profile）。
- 前端唯一入口 `frontend/src/lib/stateStore.ts`：`hydrate()`（每 scope 一次 `state_db_snapshot`
  + 一次性 `state_db_import` 旧 `localStorage`）→ `getItem` 同步读 / `setItem` 合并写（50ms → `state_db_set_many`）。
  降级：无 Tauri / DB 坏 → `localStorage`（`stateBackend()` 可查）→ 纯内存。
- ⚠️ **时序**：`main.tsx` 的 `await hydrate()` 必须在 `ReactDOM.render` 之前；页面里凡是
  "渲染期读持久化"（`workbenchBoot()`）都要**惰性**（`useState(() => …)`），不能在模块顶层跑。
- 回归：`node build/harness/state-db.mjs`（原生三段：cold 写入 / warm 读回 / 清 cache 后仍在；
  `--unit` 纯断言）、`node build/harness/state-db-frontend.mjs`（假 Tauri 桥 + 真 chromium）、
  `cargo test --release --lib state_db`（3：UPSERT/scope 隔离、坏库重建、不落在缓存目录里）。
  ⚠️ `frontendDist`（`build/dist`）是**编译期**嵌进二进制的：改完前端要 `cargo build` 才会进原生包。
