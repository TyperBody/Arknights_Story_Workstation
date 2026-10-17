#!/usr/bin/env node
/**
 * 薄包装：`scripts/harness/ui-skin.mjs` —— 真身是 `build/harness/ui-skin.mjs`
 * （`build/` 是本仓库的中间产物目录；harness 已 `git add -f`）。
 * 验收：**明日方舟风**主题层（`frontend/src/styles/theme-arknights*.css`）——
 * token 生效（`--ak-accent`/旧名重绑/底色/字族）、五页截图、DOM 契约不被改动、
 * `prefers-reduced-motion` 生效、零新增 JS 报错。
 */
import "../../build/harness/ui-skin.mjs";
