#!/usr/bin/env node
/**
 * 薄包装：`scripts/harness/_editor-tab-hl-check.mjs` —— 真身是 `build/harness/_editor-tab-hl-check.mjs`
 * （`build/` 是本仓库的中间产物目录；harness 已 `git add -f`）。
 * 验收：`tab-size: 8` / 着色层与 textarea 逐像素对齐 / Tab·Enter·Backspace 的 VSCode
 * 语义 / DOM span 与内核 `tokenizeLine` 逐 span 对拍。
 * 全套：`npm run test:harness`（见 `docs/dev/harness.md`）。
 */
import "../../build/harness/_editor-tab-hl-check.mjs";
