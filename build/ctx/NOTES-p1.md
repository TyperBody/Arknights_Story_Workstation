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
