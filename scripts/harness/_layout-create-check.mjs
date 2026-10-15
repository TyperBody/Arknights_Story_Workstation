#!/usr/bin/env node
/**
 * 薄包装：`scripts/harness/_layout-create-check.mjs` —— 真身是 `build/harness/_layout-create-check.mjs`
 * （`build/` 是本仓库的中间产物目录；harness 已 `git add -f`）。
 * 验收：新建剧本对话框（DOM 契约 / 纯 Vite 降级）、工具栏三组（`data-rail-group`）、
 * 面包屑（`data-editor-part=breadcrumb`）、1024px 的 rail 收起口径。
 */
import "../../build/harness/_layout-create-check.mjs";
