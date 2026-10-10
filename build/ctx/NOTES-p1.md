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
