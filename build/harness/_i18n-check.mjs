/**
 * i18n 接线自检（task-4）——**topic 解析语义**的纯逻辑回归（零浏览器零依赖）。
 *
 *   node build/harness/_i18n-check.mjs
 *
 * 断言（全部对着 `frontend/src/i18n/lib.ts` 的真实实现，不复制逻辑）：
 *   (a) `LOCALES` / `LOCALE_LABELS` / `FALLBACK_LOCALE` / `DEFAULT_LOCALE`、
 *       `localStorage` 键 = `prts-language`；
 *   (b) `editor.*` 真实文案：zh-Hans 与 en-US 都取得到、且**不相等**（有真翻译）；
 *   (c) 插值：`{{count}}` / `{{line}}` 替换、缺变量原样保留；
 *   (d) 回退链：当前语言缺键 → fallback(zh-Hans) → `defaultValue` 原文 → 键末段；
 *   (e) `resources` 汇总形状：两个语言**同键集**（含命名空间子目录展开后的
 *       `editor.category.*` / `editor.command.*` / `editor.indent.*`）；
 *   (f) `setLocale` 写入 `prts-language` 并广播；`getLocale` 读回（用内存 storage 打桩）。
 *
 * 退出码：0 = 全过；1 = 有断言失败。
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";

let pass = 0;
const failures = [];
const ok = (label, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL ${label} — ${error?.message ?? error}`);
  }
};

const REPO = resolve(import.meta.dirname, "..", "..");
const LIB = `file://${resolve(REPO, "frontend/src/i18n/lib.ts")}`;
const MOD = `file://${resolve(REPO, "frontend/src/i18n/index.ts")}`;

/** 内存 localStorage 打桩（`lib.ts` 走 `globalThis.localStorage`）。 */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    _dump: () => Object.fromEntries(map),
  };
}

const lib = await import(LIB);
const i18nIndex = await import(MOD);

ok("常量：LOCALES / 标签 / 回退 / 存储键", () => {
  assert.deepEqual([...lib.LOCALES], ["zh-Hans", "en-US"]);
  assert.equal(lib.FALLBACK_LOCALE, "zh-Hans");
  assert.equal(lib.DEFAULT_LOCALE, "zh-Hans");
  assert.equal(lib.LOCALE_STORAGE_KEY, "prts-language");
  assert.deepEqual(lib.LOCALE_LABELS, { "zh-Hans": "简体中文", "en-US": "English" });
});

ok("resources：两个语言、命名空间已展开（editor.* 在根下）", () => {
  assert.deepEqual(Object.keys(i18nIndex.resources).sort(), ["en-US", "zh-Hans"]);
  for (const locale of lib.LOCALES) {
    const root = i18nIndex.resources[locale];
    assert.equal(typeof root.common, "object");
    assert.equal(typeof root.editor, "object");
    assert.equal(typeof root.editor.category, "object");
    assert.equal(typeof root.editor.command, "object");
    assert.equal(typeof root.editor.indent, "object");
  }
});

ok("真实文案：zh-Hans 与 en-US 都取得到且不同（有真翻译）", () => {
  const keys = [
    "editor.toolbar.lint",
    "editor.tabs.controllers",
    "editor.palette.hint",
    "editor.indent.button",
    "editor.status.dirty",
  ];
  for (const key of keys) {
    const zh = i18nIndex.translate("zh-Hans", key);
    const en = i18nIndex.translate("en-US", key);
    assert.ok(zh && !zh.includes(key), `${key} zh 拿不到`);
    assert.ok(en && !en.includes(key), `${key} en 拿不到`);
    assert.notEqual(zh, en, `${key} 两个语言一样`);
  }
});

ok("插值：{{var}} 替换 + 缺失变量原样保留", () => {
  assert.equal(
    i18nIndex.translate("zh-Hans", "editor.indent.done", { count: 7 }),
    "已缩进 7 行（播放不受影响）",
  );
  assert.equal(
    i18nIndex.translate("en-US", "editor.scrub.cutNotice", { line: 42 }),
    "Preview cut at line 42",
  );
  assert.ok(i18nIndex.translate("zh-Hans", "editor.indent.done").includes("{{count}}"));
});

ok("回退链：当前语言缺键 → zh-Hans → defaultValue 原文 → 键末段", () => {
  // (1) en-US 有、zh-Hans 也有：正常命中。
  assert.equal(i18nIndex.translate("zh-Hans", "editor.toolbar.save"), "保存");
  // (2) 交给只装了 en-US 语义的实例：zh-Hans 缺键 → fallback 也缺 → defaultValue。
  const partial = lib.createI18n({ "en-US": { editor: { onlyEn: "Only EN" } }, "zh-Hans": {} }, "prts-language-test");
  assert.equal(partial.translate("zh-Hans", "editor.onlyEn", undefined, "原文兜底"), "原文兜底");
  // (3) 当前语言命中：不落到 defaultValue。
  assert.equal(partial.translate("en-US", "editor.onlyEn", undefined, "原文兜底"), "Only EN");
  // (4) 谁都没有 → 键末段。
  assert.equal(partial.translate("en-US", "editor.ghost.key", undefined, undefined), "key");
});

ok("setLocale/getLocale：写 prts-language、读回、广播、非法值回落", () => {
  const storage = makeStorage();
  globalThis.localStorage = storage;
  try {
    const instance = lib.createI18n(i18nIndex.resources, "prts-language");
    let notified = 0;
    const off = instance.subscribe(() => {
      notified += 1;
    });
    instance.setLocale("en-US");
    assert.equal(instance.getLocale(), "en-US");
    assert.equal(storage._dump()["prts-language"], "en-US");
    assert.equal(notified, 1);
    assert.equal(i18nIndex.getLocale(), "zh-Hans"); // 模块级实例用自己的 storage 快照
    i18nIndex.setLocale("en-US");
    assert.equal(i18nIndex.getLocale(), "en-US");
    assert.equal(storage._dump()["prts-language"], "en-US");
    assert.equal(i18nIndex.t("editor.toolbar.save"), "Save");
    i18nIndex.setLocale("zh-Hans");
    assert.equal(i18nIndex.t("editor.toolbar.save"), "保存");
    assert.equal(i18nIndex.setLocale.length, 1);
    // 非法值：不抛、按默认语言存。
    lib.createI18n(i18nIndex.resources, "prts-language").setLocale("xx-YY");
    assert.equal(storage._dump()["prts-language"], "zh-Hans");
    off();
    instance.setLocale("zh-Hans");
    assert.equal(notified, 1, "退订后不应再收到回调");
  } finally {
    delete globalThis.localStorage;
  }
});

ok("命令查表：57 个控制器在 editor.command.* 都有键（en-US 不掉 key）", async () => {
  const model = await import(`file://${resolve(REPO, "src/akstage/local/editorModel.js")}`);
  assert.equal(model.CONTROLLERS.length, 57);
  for (const spec of model.CONTROLLERS) {
    const key = `editor.command.${spec.command}`;
    const zh = i18nIndex.resources["zh-Hans"].editor.command[spec.command];
    const en = i18nIndex.resources["en-US"].editor.command[spec.command];
    assert.ok(typeof zh === "string" && zh.length > 0, `${key} 缺中文名`);
    assert.ok(typeof en === "string" && en.length > 0, `${key} 缺英文名`);
  }
  for (const category of model.CATEGORIES) {
    assert.ok(i18nIndex.resources["zh-Hans"].editor.category[category], `分类 ${category} 缺中文`);
    assert.ok(i18nIndex.resources["en-US"].editor.category[category], `分类 ${category} 缺英文`);
  }
});

console.log(`\n${failures.length === 0 ? "✅" : "❌"} i18n check: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exitCode = 1;
}
