#!/usr/bin/env node
/**
 * 薄包装：`scripts/harness/float-window.mjs` —— 真身是 `build/harness/float-window.mjs`
 * （`build/` 是本仓库的中间产物目录；harness 已 `git add -f`）。
 * 覆盖「工作台划区 / 浮动窗」7 条冻结契约（分隔条命中区、四面板可分离、浮动层/占位、
 * 不裁剪、双击回树、刷新记忆）。
 * 直接 `node scripts/harness/float-window.mjs`（需 dev server:5174，会自动提示）。
 */
import "../../build/harness/float-window.mjs";
