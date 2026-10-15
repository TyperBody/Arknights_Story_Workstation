#!/usr/bin/env node
/**
 * 薄包装：`scripts/harness/_asset-lib-check.mjs` —— 真身是 `build/harness/_asset-lib-check.mjs`
 * （`build/` 是本仓库的中间产物目录；harness 已 `git add -f`）。
 * 验收：素材库面板（rail 放出 / 搜索 / 拖到正文=Cmd+Z 可撤 / 拖到舞台=当前场景 /
 * 音频试听 / 无 Tauri 导入降级）。
 */
import "../../build/harness/_asset-lib-check.mjs";
