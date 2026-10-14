// 「区域缩进」UI 验收（task-5）：编辑器页把内核接到 textarea / 工具条 / 状态栏。
//
//   node build/harness/_indent-ui-check.mjs
//
// 断言：
//   (a) textarea 里选中 `[Decision]` 区域 → 点「缩进区域」（`[data-editor-action="indent-region"]`）
//       → 文本按 `regionIndentPlan` 变成层级缩进版；一次动作 = 一次撤销栈条目；
//   (b) 状态栏出现 `[data-indent-hint]` 的 `role="status"` 提示；
//   (c) 跨行选区 + Tab / Shift+Tab = 缩进 / 反缩进（往返幂等）；
//   (d) Ctrl/Cmd+Alt+I = 同「缩进区域」；
//   (e) 送引擎前会去行首空白（`stripIndentForEngine` 与顶格版逐字节相等）；
//   (f) 全流程零 JS 报错。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const OUT = resolve("build/harness/shots");
mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; console.log(`ok   ${label}`); }
  catch (error) { fail += 1; failures.push({ label, error: String(error?.message ?? error) }); console.log(`FAIL ${label} — ${error?.message ?? error}`); }
};

const SCRIPT = [
  '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
  '[Background(image="bg_black", x=0, y=0, fadetime=0, block=true)]',
  '[Decision(options="跟着她走;先问清楚", values="1;2")]',
  '[Predicate(references="1")]',
  '[charslot(slot="m", name="char_1001_amiya2", duration=0.5)]',
  '[name="阿米娅"]  这边走，博士。',
  '[Predicate(references="2")]',
  '[charslot(slot="m", name="avg_npc_001", duration=0.5)]',
  '[name="杜宾"]  明白了。',
  '[Predicate(references="1;2")]',
  '[name="阿米娅"]  我们出发吧。',
  '[endtip(block=true)]',
].join("\n");

// 期望值**不写死 unit**：`INDENT_UNIT` 从两空格改成 `\t`（task-6 的 VSCode
// 语义）后，这里仍用**内核自己**算（`regionIndentPlan` 幂等 = 期望），
// 只把「落后一级」的动态量（unit）从内核 import 出来拼 Tab/选出行的断言。
const kernel = await import(`file://${resolve("src/akstage/local/editorModel.js")}`);
const { INDENT_UNIT, regionIndentPlan } = kernel;

const EXPECTED = regionIndentPlan(SCRIPT).text;

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack ?? e).split("\n")[0]));

await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent(SCRIPT)}`, { waitUntil: "networkidle" });
await page.addStyleTag({ content: ".bookshelf-sync-warning{display:none!important}" }).catch(() => {});
await page.waitForTimeout(3500); // 等编辑器模型（editorModel.js）载入
await page.screenshot({ path: `${OUT}/indent-region.png` });

const value = () => page.locator(".ed-textarea").inputValue();
const setSelection = (from, to) => page.evaluate(([f, t]) => {
  const el = document.querySelector(".ed-textarea");
  el.focus();
  el.setSelectionRange(f, t);
  el.dispatchEvent(new Event("select", { bubbles: true }));
}, [from, to]);

const original = await value();
ok("页面载入时正文 = 传入的脚本", () => assert.equal(original, SCRIPT));
const degraded = await page.evaluate(() => document.body.innerText.includes("编辑器模型尚未加载"));
ok("模型加载完成（非降级）", () => assert.equal(degraded, false));

// (a) 选区 + 点「缩进区域」
const start = original.indexOf("[Decision");
const end = original.indexOf("\n[endtip");
await setSelection(start, end);
const hasButton = await page.locator('[data-editor-action="indent-region"]').count();
ok("工具条有 [data-editor-action=indent-region]", () => assert.equal(hasButton, 1));
await page.evaluate(() => document.querySelector('[data-editor-action="indent-region"]').click());
await page.waitForTimeout(300);
const afterClick = await value();
ok("(a) 选区 + 缩进区域 = regionIndentPlan 的结果（逐字节）", () => assert.equal(afterClick, EXPECTED));
const hint = await page.locator("[data-indent-hint]").innerText().catch(() => "");
ok("(b) 提示文案含「已缩进」", () => assert.ok(hint.includes("已缩进"), `hint=${JSON.stringify(hint)}`));
await page.screenshot({ path: `${OUT}/indent-region-after.png` });

// (c) 撤销一次应回到原文（一次动作 = 一条历史）
await page.evaluate(() => document.querySelector(".ed-status-btn")?.click());
await page.waitForTimeout(250);
const afterUndo = await value();
ok("(c) 一次撤销回到原文（整段 = 一条历史）", () => assert.equal(afterUndo, SCRIPT));

// (d) Ctrl+Alt+I 等价
await setSelection(start, end);
await page.locator(".ed-textarea").press("Control+Alt+i");
await page.waitForTimeout(300);
const afterHotkey = await value();
ok("(d) 结果与按钮一致", () => assert.equal(afterHotkey, EXPECTED));
await page.evaluate(() => document.querySelector(".ed-status-btn")?.click());
await page.waitForTimeout(200);

// (e) Tab / Shift+Tab 的选区语义（两行选区缩进 → 再反缩进 = 原文）。
// 期望值按内核的 `indentLines` 算（**不写死 unit / 空格数**）：Tab 一次 = 该行
// 行首补**一个 unit**（对齐 tab stop），Shift+Tab 再撤销 = 逐字节回到原文。
const { indentLines } = kernel;
const tabStart = original.indexOf('[name="阿米娅"]  这边走');
const tabEnd = original.indexOf("\n", original.indexOf('[name="杜宾"]'));
await setSelection(tabStart, tabEnd);
await page.locator(".ed-textarea").press("Tab");
await page.waitForTimeout(200);
const afterTab = await value();
const wantTab = indentLines(original, tabStart, tabEnd, "indent").text;
ok(
  `(e) Tab 缩进选中行（+1 个 unit = ${JSON.stringify(INDENT_UNIT)}）`,
  () => assert.equal(afterTab, wantTab)
);
await page.locator(".ed-textarea").press("Shift+Tab");
await page.waitForTimeout(200);
const afterShiftTab = await value();
ok("(e) Shift+Tab 反缩进（往返幂等 = 原文）", () => assert.equal(afterShiftTab, original));
await page.locator(".ed-textarea").press("Control+z");
await page.waitForTimeout(200);

// (f) 送引擎前归一化：indented 版与顶格版逐字节相等
const normalized = await page.evaluate(async ([expr, flat]) => {
  const m = await import("/src/akstage/local/storyPack.js").catch(() => import("/@fs" + "/home/typer/桌面/galArkn/arkstage/src/akstage/local/storyPack.js"));
  return { strip: m.stripIndentForEngine(expr), flat };
}, [EXPECTED, EXPECTED.split("\n").map((l) => l.replace(/^[ \t]+/, "")).join("\n")]);
ok("(f) stripIndentForEngine(缩进版) = 顶格版", () => assert.equal(normalized.strip, normalized.flat));
// 页面里另有一条**既有**的引擎/Tauri 桩噪音（`transformCallback`，与缩进无关，
// 编辑器页在 dev server 上一直有）；按前缀白名单过滤后断言「零新报错」。
const KNOWN = /transformCallback/;
const fresh = errors.filter((line) => !KNOWN.test(line));
ok("(g) 无新增 JS 报错（既有 transformCallback 噪音已排除）", () => assert.deepEqual(fresh, []));

console.log(`\nINDENT-UI ${fail === 0 ? "PASS" : "FAIL"} — ${pass} pass${fail ? ` / ${fail} fail` : ""}`);
if (failures.length) for (const f of failures) console.log(`  ✗ ${f.label}: ${f.error}`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
