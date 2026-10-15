#!/usr/bin/env node
/**
 * 薄包装：`scripts/harness/_rail-check.mjs` —— 真身是 `build/harness/_rail-check.mjs`
 * （`build/` 是本仓库的中间产物目录；harness 已 `git add -f`）。
 * 验收：左侧**侧边栏 rail**（收起窗口的托盘：图标 = 收进侧边栏的面板，点一下放回
 * 工作台；整条可收成 22px 窄条并记忆）+ **脱离不留洞**（树里 `drop()` 摘叶 → 邻居
 * 变宽 ≥60px）。
 * 全套：`npm run test:harness`（见 `docs/dev/harness.md`）。
 */
import "../../build/harness/_rail-check.mjs";
