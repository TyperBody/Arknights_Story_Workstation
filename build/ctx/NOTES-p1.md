# NOTES — p1-assets

- `catalog-data.json` 由 `tools/mirror/fetch-catalog.mjs` 从上游一次性抓取生成
  （`assets/avg/character.json` → 15983 条立绘 key、`background.json` → 1055 条背景、
  `story/story_variables.json` → 2820 个变量名、`prts.wiki/w/EP10/ENTRY` → 引擎代 13 个 widget）。
  运行时**零网络**（engineCatalog.js 只 import JSON）。
- 立绘 variant 的 key 规则按 `library.js`：**`entry.image ?? \`1_${entry.face}\``**。
  `character.json` 里 `avg_*` 系的 `array[].face` 是 `xxx$1` 形式，直接当 image 用会 404。
- 「下载引擎」的 manifest 只收**引擎代**（`static.prts.wiki/**`）+ 库里已有的
  `src/assets/storylines/*.png`——舞台素材（bg/立绘/Audio）体积太大，属于 P2/stageCatalog 的按需下载。
- 环境自查用 `npx tsc --noEmit -p frontend/tsconfig.app.json`；`tsc -b frontend` 留给 Lead 收口。

## 收口状态（p1-assets 最终）
- commits: `617b820`(appSettings) → `8282198`(assetRouting+engineCatalog+selftest) → `2ff582c`(SettingsPage 镜像/并发) → `b260f98`(versions.json/布局/尺寸)。
- `node tools/mirror/mirror-selftest.mjs` → **80/80 全绿**（路由 6 源、设置契约、目录 19886 条、镜像布局、versions.json）。
- `npx tsc --noEmit -p frontend/tsconfig.app.json` 里**我的文件 0 报错**；当时仓库里他人的报错：
  `storyPlayerBoot.ts(701)`、`StoryEditorPage.tsx(2691/2822/2823/2824)`（P6/P5 未完成，与 P1 无关）。
- `tools/mirror/versions.json` = 引擎层 25 条、15,238,246 B（含 NotoSans.ttf 8.9 MB + NotoSansHans-Medium.woff2 6.3 MB）。
- 待 Lead 决定：`.github/workflows/publish-mirror.yml` 与 `scripts/mirror/*` 未写（契约 §1 归 P1，非 task-1 验收项）。

## 收尾补充（lead 追加的两件）
- `.github/workflows/publish-mirror.yml`（commit `95effd0`）：workflow_dispatch（`include_assets` / `dry_run` / `target_repo` / `target_ref`），
  Resolve target（默认取 `assetRouting.js` 的 MIRROR_REPO/MIRROR_REF）→ `build-versions.mjs --check` → `publish-engine.mjs --out /tmp/mirror-out`
  → 用 `MIRROR_TOKEN` clone 目标仓 + rsync + commit（缺 token 只 warning 不红）→ 清单/暂存条数校验 → job summary。
  本地演练：`MIRROR_OFFLINE=1 node tools/mirror/publish-engine.mjs --out /tmp/x`（只落占位），真实抓取 25 条 / 17.6 MB 已验证。
- `assetRouting.js`：`SOURCE_HINTS`(jsd/fastly/ghproxy) + `MIRROR_REPO` 注释 + `mirrorUrl()` jsdoc 三处写明
  **首次使用镜像前必须先跑 publish-mirror**；否则 404 → `buildSourceOrder` 兜底回 `pack`(=官方直链)。
- selftest 增至 **94/94**（新增 A1 组：工作流存在/手动触发/token 可选/URL 形状/兜底回官方/SOURCE_HINTS 文案）。
