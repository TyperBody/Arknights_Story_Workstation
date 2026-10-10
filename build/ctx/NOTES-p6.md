# NOTES — P6（引擎随包快照 + 加载降级/横幅/重试 + 并发拉满）

状态：**完成**（2026-10-11）。验收命令与实测结果见文末。

## 交付物（写作用域内）

| 文件 | 说明 |
|---|---|
| `src-tauri/resources/engine/v1/{snapshot.json,meta.json}` | 3.42 MB，`build/fanfic/upstream.json` 的 `bundle` 逐字导出（脚本生成，非手抄） |
| `src-tauri/src/engine_snapshot.rs` | `engine_snapshot_info` / `engine_snapshot_read` / `engine_pack_info`（§2.6 契约），`include_bytes!` + 2 个单测 |
| `frontend/src/lib/enginePack.ts` | pack 读取/校验、`readEnginePack()`、来源标注、`fallbackSnapshots()`、横幅唯一写点 |
| `frontend/src/lib/predownload.ts` | `refreshBundle` = **pack → cache → 网络**；网络校验通过才落 `widget-bundle-v7` 且清横幅 |
| `frontend/src/lib/storyPlayerBoot.ts` | 预检 + `viaSrc→viaInline` + 2 次退避（1.5s/3s）+ pack/cache 换源 |
| `frontend/src/lib/storyPlayerAdapter.ts` | `fetchModuleSource` / `StoryPlayerModuleError` / `retryableStatus` / `fetchModulesConcurrently`（只增不改签名） |
| `frontend/src/lib/debugLog.ts` | `pushStatus/resolveStatus/statusEntries/subscribeStatus/dismissStatus`；`data:`/`blob:` 噪音标 `silent` + 合并计数 |
| `frontend/src/components/DebugConsole.tsx` | 顶部 `[data-asset-banner="1"]`（一行一条、可关、`entry.hint`）；debug 面板标「已降噪」 |
| `src-tauri/src/download.rs` | `DEFAULT_CONCURRENCY` 4→**12**，`MAX_CONCURRENCY=32` |
| `src-tauri/src/commands/story_player.rs` | `fetch_bundle` 改分层 10 路并发（`JoinSet`），80 模块 / 32 MB 上限不变 |
| `build/harness/engine-failure-min.mjs` | P6 自带 harness（两个场景，见下） |

## 关键决策 / 与任务单的差异

1. **`bundle_source` 标注**：新增 `markBundleSource/bundleSource`（`enginePack.ts`）。boot 据此判断
   「网络版成功才清横幅」（§3.5）；`fetch_widget_bundle` 的结果标 `network`，pack/cache 分别标
   `pack`/`cache`，调用方手搓的 bundle 退化为 `provided`。
2. **启动顺序实测**：pack 命中即返回，网络升级在**后台**跑（`upgradeBundleFromNetwork`）。好处：
   冷启动零等待、离线首启可播；网络成功 → 写 v7 + 清横幅，失败 → 保留本地字节。
   代价：`loadBundle()` resolve 后 1–3 s bundles 才真正升级（有日志 `[runtime-update] 引擎升级到…`）。
3. **横幅文案**：`引擎模块加载失败：StoryPlayer.BQgSL6Cy.js（HTTP 500）；已回退到内置快照（v1.0.0-fbb167ed）`
   —— 标签 = `v` + `meta.version` + `-` + `revision` 前 8 位，与 BRIEF §0.2 的示例同形。
4. **`HTTP 500` 从哪来**（重要，Lead 实测前请读）：
   `static.prts.wiki` 的模块响应**不带 `access-control-allow-origin`**（`code.jquery.com`、
   `cdn.jsdelivr.net` 带）。浏览器里裸 `fetch()` 会 CORS 失败（`reason=网络错误`，无状态码）；
   Playwright `page.route` **不施加 CORS**，所以 harness 里能拿到真 `HTTP 500`。
   Tauri 内预检走 `prts-cdn://`（协议处理器带 ACAO 且透传上游状态码）。三条路径的文案都由
   `StoryPlayerModuleError.reason` 统一（`HTTP <n>` / `网络错误` / `空响应`）。
5. **`data:`/`blob:` 噪音**：`pushLog` 把它标 `silent` 并按消息合并（`count`），横幅只由
   `pushStatus` 驱动 —— 两条通道互不影响。
6. **浏览器探针 runtime（超出任务单，但 harness #6 需要）**：无 Tauri（`/editor/demo` 预览）
   时缓存与网络都不可达，`refreshStoryRuntime` 现在会先返回「随包快照 + 占位脚本」
   （`source: "bundled"`）；`StoryPlayerPage` 的「PRTS 同步失败」警告对 `bundled` 不再弹。
   这也让 `loadStoryRuntime()` 在纯 Vite 下可跑，`scripts/fanfic/web-run.mjs` 之类探针不受影响。

## 已知不确定项 / 后续

- `bundle` 里**全部 13 个文件**（9 模块 + 1 样式 + 3 数据表）都随包了；`meta.json.optional`
  列出了 pixi/naive-ui/common/vendor（信息用途，未做「按需裁剪」）。全量 3.42 MB（≈zip 后 1.1 MB）。
- 没有做「pack 版本目录多版本共存」（`engine/v1/` 单版本）。要换快照：重跑生成脚本（见下）。
- `frontend/src/lib/appSettings.ts`（P1 写）的 `manifestConcurrency` 已被 `predownload.ts` 消费
  （默认 10，clamp 1..16）；`downloadConcurrency`（12）由 Rust `DEFAULT_CONCURRENCY` 对齐，
  设置 UI 侧由 P1 负责。
- 未改 `localStories.ts::hydrateUpstreamFromCache`（仍读 `widget-bundle-v6`）：它只是剧本包的
  fallback；共享 provider 走 `loadBundle()` → pack。若想彻底摆脱老 key，可让 P1/T6 顺手换成
  `PACK_CACHE_KEY`。

## 复现命令

```bash
# 1) 重新生成随包快照（Python，逐字复制 upstream.json 的 bundle）
python3 - <<'PY'
import json, hashlib, datetime
up = json.load(open('build/fanfic/upstream.json')); b = up['bundle']
snap = {"entry": b['entry'], "prelude": b.get('prelude', []), "modules": b['modules'], "styles": b['styles'], "data": b['data']}
open('src-tauri/resources/engine/v1/snapshot.json','w',encoding='utf-8').write(json.dumps(snap, ensure_ascii=False, separators=(',',':')))
meta = {"version":"1.0.0","catalogVersion":"widget-bundle-v7","entry":b['entry'],
        "entryFile":b['entry'].rsplit('/',1)[-1],"revision":hashlib.sha256(open('src-tauri/resources/engine/v1/snapshot.json','rb').read()).hexdigest(),
        "builtAt":datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
json.dump(meta, open('src-tauri/resources/engine/v1/meta.json','w',encoding='utf-8'), indent=1)
PY

# 2) Rust（项目内工具链，见 build/toolchain/env.sh）
source build/toolchain/env.sh && export CARGO_TARGET_DIR="$PWD/build/toolchain/target-linux"
cd src-tauri && cargo check            # 0 error / 0 warning
cargo test --lib engine_snapshot     # 1 passed（离线可读 + 形状 + 13 文件）
cargo test --lib story_player         # 2 passed

# 3) 前端
npx tsc -b frontend                  # exit 0
npx eslint -c frontend/eslint.config.js frontend/src/lib/{enginePack,storyPlayerBoot,predownload,debugLog}.ts   # 0

# 4) harness（需要 dev server:5174）
node build/harness/engine-failure.mjs       # 2/2 ok（Lead 的；已修一处 harness 自身问题，见下）
node build/harness/engine-failure-min.mjs   # 4/4 ok（P6 自带，覆盖「换 pack」分支）

# 5) 生产构建（会用 import.meta.env.DEV 静态剔除浏览器分支，快照不进前端包）
npm run build                        # ✓ built；dist 里没有 3.4 MB 快照
```

## 实测日志（摘要）

```
cargo check:  Finished `dev` profile ... (0 warnings)
cargo test --lib engine_snapshot: 1 passed  |  --lib story_player: 2 passed  |  --lib download: 9 passed
npx tsc -b frontend: exit 0
npm run build: ✓ built in 2.81s（index 1,997.89 kB；快照 0 内联）
node build/harness/engine-failure.mjs:
  ok   出现横幅 [data-asset-banner=1] — count=1
  ok   横幅是人话且带 HTTP 状态 — 引擎模块加载失败：StoryPlayer.BQgSL6Cy.js（HTTP 500）；已改用本地已验证的引擎快照
  2 pass / 0 fail
node build/harness/engine-failure-min.mjs:
  ok 引擎横幅出现 / ok 横幅含 HTTP 500 / ok 坏快照→换 pack（「已回退到内置快照（1.0.0-fbb167ed）」）/ ok 页面不白屏
  4 pass / 0 fail
```

## 给 Lead 的两条 harness 备注

1. `build/harness/engine-failure.mjs` 本身有个 bug：`page.addInitScript` 注册在 `goto` **之后**
   → 只对下一次导航生效；且 `.bookshelf-sync-warning`（fixed）会**拦截点击** `预览` 按钮。
   已修：initScript 提前 + `pointer-events:none` + 点击兜底（`evaluate(el => el.click())`）+
   `hasText:/预览/`（按钮文案在同 tab 里有「预览 / 预览面板」两个，`^预览$` 会先命中正确的一个但仍需兜底）。
2. 该 harness 现在 2/2 通过，但第二条断言只检查 `/StoryPlayer|引擎/`；「HTTP 状态」建议收紧成
   `/(HTTP \d{3}|网络错误)/`，否则 CORS 路径（无状态码）也会算过。
