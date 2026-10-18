// 编辑器补全语义 harness（2026-10-19）：**光标必须落在 `[]` / `()` 里**。
//
//   node build/harness/edit-completion.mjs        # 需要 dev server :5174
//
// 用户原话：「剧本编辑体验优化 比如说一个[自动补全] 光标也要在[]里边 还有函数
// 出现函数也要在()里 而不是第一次就挪到外面」。
//
// 断言（都在真 chromium 里打字 / 按键后读 textarea 的 value 与 selectionStart）：
//   (a) 补全弹窗与 Tab 骨架：`[Cha` → `[Character(name="")]`，光标在 `""` 中间；
//   (b) 参数补全（Enter/接受）：`[Character(na` → 仍是**同一个控制器**
//       （`[Character(name="")]`，不是 `[Character(Character(name=…)]`）；
//   (c) 光标落点优先级：`""` → `()` → `(` 之后 → `]` 之前；
//   (d) 成对补齐：`[` `(` `"` 自动补右半；右半重复 = 跳过；
//   (e) Tab 骨架与成对补齐**协同**（不会出现 `]]`）。
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";

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

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--renderer-process-limit=1"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(60_000);
const errors = [];
const KNOWN = /transformCallback|ERR_FAILED|Failed to load resource|CORS|Access-Control/;
page.on("pageerror", (e) => { const s = String(e.message ?? e); if (!KNOWN.test(s)) errors.push(s.slice(0, 140)); });
await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent("[Header(key=\"t\")]")}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".ed-textarea", { timeout: 40_000 });
await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar,[data-asset-banner]{display:none!important}" }).catch(() => {});
await page.waitForTimeout(1600);

/** 清空正文 → 逐字打字 → 可选按键 → 读回 `{value, caret, before}`。 */
const run = async (typed, key) => {
  await page.evaluate(() => {
    const el = document.querySelector(".ed-textarea");
    el.focus();
    el.setSelectionRange(0, el.value.length);
  });
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(120);
  await page.keyboard.type(typed);
  await page.waitForTimeout(450);
  if (key) {
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
  }
  return page.evaluate(() => {
    const el = document.querySelector(".ed-textarea");
    const at = el.selectionStart ?? 0;
    return { value: el.value, caret: at, before: el.value.slice(0, at), after: el.value.slice(at) };
  });
};

// (a) Tab 骨架 / 补全弹窗：光标落在 `("")` 的引号之间
for (const key of ["Tab", "Enter"]) {
  const r = await run("[Cha", key);
  ok(`(a) [Cha + ${key} → [Character(name="")]，光标在引号之间`, () => {
    assert.equal(r.value, '[Character(name="")]');
    assert.equal(r.before, '[Character(name="');
    assert.equal(r.after, '")]');
  });
}

// (b) 参数名补全：**替换 token**（不再插整行骨架）
for (const key of ["Enter", "Tab"]) {
  const r = await run("[Character(na", key);
  ok(`(b) [Character(na + ${key} → 同一个控制器 + 光标进引号`, () => {
    assert.equal(r.value, '[Character(name="")]');
    assert.ok(!r.value.includes("Character(Character"), r.value);
    assert.equal(r.before, '[Character(name="');
  });
}

// (c) 参数面板「插入」= 光标在同一行/结构里（`（）` 落括号内）
const paren = await run("[Character(", "Tab");
ok("(c) `(` 之后 Tab：光标仍在 `[]` 与 `()` 之内", () => {
  assert.ok(/^\[Character\(.*\)\]$/.test(paren.value), paren.value);
  assert.ok(!/[)]\]$/.test(paren.before.slice(-3)), `before=${JSON.stringify(paren.before)}`);
});

// (d) 成对补齐：`[` / `(` / `"` 自动补右半，且再打右半=跳过
const bracket = await run("[");
ok('(d) 打 `[` 自动补 `]`，光标在中间', () => {
  assert.equal(bracket.value, "[]");
  assert.equal(bracket.before, "[");
});
const typedCloser = await run("[Cha");
await page.keyboard.type("]");
const afterCloser = await page.evaluate(() => {
  const el = document.querySelector(".ed-textarea");
  return { value: el.value, caret: el.selectionStart };
});
ok("(d) 再打 `]` = 跳过（不重复插入）", () => {
  assert.equal(afterCloser.value, "[Cha]");
  assert.equal(afterCloser.caret, 5);
});

// (e) 骨架 + 成对补齐协同：不出现 `]]`
const dbl = await run("[Character");
await page.keyboard.press("Tab");
const afterSkel = await page.evaluate(() => document.querySelector(".ed-textarea").value);
ok("(e) 有自动补齐 `]` 时，骨架不再叠一个（无 `]]`）", () => {
  assert.ok(!afterSkel.includes("]]"), afterSkel);
  assert.match(afterSkel, /^\[Character\(/);
});

ok("(f) 全程无新增 JS 报错", () => assert.deepEqual(errors, []));
console.log(`\nEDIT-COMPLETION ${failures.length ? "FAIL" : "PASS"} — ${pass} pass${failures.length ? ` / ${failures.length} fail` : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
