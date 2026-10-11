#!/usr/bin/env node
/**
 * Check that every locale keeps exactly the key set of the reference language
 * (`zh-Hans.ts`).
 *
 * Ported from LangBot `web/scripts/check-i18n.mjs`:
 * - line-by-line parser (indentation stack, **no `eval`**), never executes the file;
 * - missing keys (in the reference but absent in the locale) and extra keys
 *   (present in the locale but not in the reference) are both reported;
 * - exits with code 1 on any mismatch.
 *
 * Differences from the LangBot version:
 * - the reference language is `zh-Hans.ts` (arkstage's `FALLBACK_LOCALE`);
 * - namespaces are directories: `<ns>/<lang>.ts` is compared against
 *   `<ns>/<lang>.ts` of the reference, for every namespace directory found under
 *   `locales/` (recursively), in addition to the root locale files.
 *
 * The expected file format (what the parser understands):
 *   const <varName> = {
 *     key: 'value',
 *     firstLineText: "value",
 *     nested: {
 *       subKey: 'value',
 *     },
 *   };
 *   export default <varName>;
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = resolve(__dirname, "../src/i18n/locales");
const REFERENCE_LANG = "zh-Hans";
const LANG_FILE_RE = /^[a-z]{2,3}-(?:[A-Z]{2}|[A-Z][a-z]{3})\.ts$/;

/**
 * Extract all dot-notation leaf keys from a TypeScript locale file.
 * Tracks indentation depth to build dot-separated key paths and never executes
 * the file content.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function extractKeys(filePath) {
  let src = readFileSync(filePath, "utf8");

  // Remove UTF-8 BOM if present
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const keys = [];
  // Stack of { key, indent } pairs representing the current nesting path
  const stack = [];

  // Matches an object key at the start of a line (identifier or quoted string)
  const KEY_RE = /^(\s+)(?:([\w]+)|'([^']+)'|"([^"]+)")\s*:/;
  const OPEN_BRACE_RE = /\{\s*$/;
  const CLOSE_BRACE_RE = /^\s*\},?\s*$/;

  for (const line of src.split("\n")) {
    if (CLOSE_BRACE_RE.test(line)) {
      const lineIndent = line.match(/^(\s*)/)[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= lineIndent) stack.pop();
      continue;
    }

    const m = line.match(KEY_RE);
    if (!m) continue;

    const indent = m[1].length;
    const keyName = m[2] ?? m[3] ?? m[4];

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();

    const prefix = stack.map((e) => e.key).join(".");
    const fullKey = prefix ? `${prefix}.${keyName}` : keyName;

    if (OPEN_BRACE_RE.test(line)) {
      stack.push({ key: keyName, indent }); // parent (nested object), not a leaf
    } else {
      keys.push(fullKey); // leaf
    }
  }

  return keys;
}

/** Locale files directly inside `dir` (root locales) — language-region filenames only. */
function localeFilesIn(dir) {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile() && LANG_FILE_RE.test(name))
    .sort();
}

/** Namespace sub-directories under `dir` (skipping `_`/`.`-prefixed helpers). */
function namespaceDirsIn(dir) {
  return readdirSync(dir)
    .filter((name) => {
      if (name.startsWith("_") || name.startsWith(".")) return false;
      return statSync(join(dir, name)).isDirectory();
    })
    .sort();
}

/**
 * Build the comparison units: every directory that contains at least one locale
 * file, paired with the reference-language file inside it.
 *
 * @returns {{scope: string, refPath: string, files: {file: string, path: string}[]}[]}
 */
function collectScopes(root) {
  const scopes = [];

  const visit = (dir) => {
    const files = localeFilesIn(dir);
    if (files.length > 0) {
      const refFile = `${REFERENCE_LANG}.ts`;
      const scope = relative(root, dir) || ".";
      if (!files.includes(refFile)) {
        scopes.push({ scope, refPath: null, files: files.map((f) => ({ file: f, path: join(dir, f) })) });
      } else {
        scopes.push({
          scope,
          refPath: join(dir, refFile),
          files: files.filter((f) => f !== refFile).map((f) => ({ file: f, path: join(dir, f) })),
        });
      }
    }
    for (const ns of namespaceDirsIn(dir)) visit(join(dir, ns));
  };

  visit(root);
  return scopes;
}

function main() {
  if (!statSync(LOCALES_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Locales directory not found: ${LOCALES_DIR}`);
    process.exit(1);
  }

  const scopes = collectScopes(LOCALES_DIR);
  if (scopes.length === 0) {
    console.error(`No locale files found under ${LOCALES_DIR}`);
    process.exit(1);
  }

  let hasError = false;
  for (const { scope, refPath, files } of scopes) {
    if (!refPath) {
      console.error(`\n[${scope}] ❌ Reference file ${REFERENCE_LANG}.ts not found.`);
      hasError = true;
      continue;
    }

    let refKeys;
    try {
      refKeys = new Set(extractKeys(refPath));
    } catch (e) {
      console.error(`\n[${scope}] ❌ Failed to parse ${REFERENCE_LANG}.ts: ${e.message}`);
      hasError = true;
      continue;
    }

    for (const { file, path } of files) {
      const locale = file.replace(/\.ts$/, "");
      let localeKeys;
      try {
        localeKeys = new Set(extractKeys(path));
      } catch (e) {
        console.error(`[${scope}/${locale}] ❌ Failed to parse file: ${e.message}`);
        hasError = true;
        continue;
      }

      const missing = [...refKeys].filter((k) => !localeKeys.has(k));
      const extra = [...localeKeys].filter((k) => !refKeys.has(k));

      if (missing.length === 0 && extra.length === 0) {
        console.log(`[${scope}/${locale}] ✅ ${refKeys.size} keys match.`);
      } else {
        hasError = true;
        console.log(`\n[${scope}/${locale}] ❌ Key mismatch detected (${refKeys.size} reference keys):`);
        if (missing.length > 0) {
          console.log(`  Missing keys (in ${REFERENCE_LANG} but not in ${locale}):`);
          for (const k of missing) console.log(`    - ${k}`);
        }
        if (extra.length > 0) {
          console.log(`  Extra keys (in ${locale} but not in ${REFERENCE_LANG}):`);
          for (const k of extra) console.log(`    + ${k}`);
        }
      }
    }
  }

  if (hasError) {
    console.log("\n❌ i18n key check failed. Please fix the mismatches above.");
    process.exit(1);
  }
  console.log(`\n✅ All i18n locale files match the ${REFERENCE_LANG} key set.`);
}

main();
