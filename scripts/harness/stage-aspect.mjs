#!/usr/bin/env node
/**
 * 薄包装：`scripts/harness/stage-aspect.mjs` —— 真身是 `build/harness/stage-aspect.mjs`
 * （`build/` 是本仓库的中间产物目录；harness 已 `git add -f`）。
 * 直接 `node scripts/harness/stage-aspect.mjs` 即可（从仓库根运行；需 dev server 的会自动提示）。
 * 全套：`npm run test:harness`（见 `docs/dev/harness.md`）。
 */
import "../../build/harness/stage-aspect.mjs";
