#!/usr/bin/env node
/**
 * 薄包装：`scripts/harness/edit-completion.mjs` —— 真身 `build/harness/edit-completion.mjs`。
 * 验收：补全后的**光标落点**（`[]` / `()` 之内）+ 参数补全的替换语义 + 成对补齐协同。
 */
import "../../build/harness/edit-completion.mjs";
