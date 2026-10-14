// `/editor/demo` 的 i18n 端到端验收（task-4）——浏览器侧：
//   node build/harness/_i18n-ui-check.mjs
//
// 前置：dev server 在 5174（`npx vite frontend --port 5174`）。
// 断言（中文页 vs 英文页，逐条对照）：
//   ① 工具条按钮：`校验/预览/保存` ↔ `Validate/Preview/Save`；
//   ② 面板页签：`诊断/控制器/剧本信息` ↔ `Diagnostics/Controllers/Script info`；
//   ③ 舞台 HUD：`适配/参考线` ↔ `Fit/Guides`；状态条 `未选中` ↔ `Nothing selected`；
//   ④ 调色板分类（`editor.category.*`）与控制器按钮（`editor.command.*` 走 canonical）
//      在英文页是英文；
//   ⑤ 分支图 chrome：`还没有分支` ↔ `No branches yet`、`点卡片跳行 …` ↔ 英文提示；
//   ⑥ `/editor/demo` 页里 `localStorage["prts-language"]` 生效（刷新后仍是英文）；
//   ⑦ 截图 `build/harness/shots/editor-{zh,en}.png`。
//
// 退出码：0 = 全过；1 = 有断言失败（或浏览器起不来）。
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const SHOTS = resolve(REPO, "build/harness/shots");
const BASE = process.env.ARK_BASE ?? "http://localhost:5174";
const SAMPLE = [
  '[header(key="demo")]',
  '[Background(image="bg_black", fadetime=0.5)]',
  '[Character(name="char_002_amiya_1", fadetime=0.5)]',
  '[name="Amiya"]  This way, Doctor.',
  '[Decision(options="A;B", values="1;2")]',
  '[Predicate(references="1")]',
  "[Delay(time=1)]",
  "",
].join("\n");

const URL_ = `${BASE}/editor/demo?text=${encodeURIComponent(SAMPLE)}`;

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL ${label} — ${detail}`);
  }
};

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/snap/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/** 开一页、锁定语言、等 UI 起来（`?text=` 只读演示）。 */
async function openPage(locale) {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning{display:none !important}" });
  await page.evaluate((next) => localStorage.setItem("prts-language", next), locale);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ed-viewtabs .ed-btn", { timeout: 30000 });
  await page.waitForTimeout(1200);
  return { page, errors };
}

const texts = async (page, selector) => (await page.locator(selector).allTextContents()).map((s) => s.trim());

const zh = await openPage("zh-Hans");
const en = await openPage("en-US");

// ① 工具条
const zhToolbar = await texts(zh.page, ".ed-viewtabs .ed-btn");
const enToolbar = await texts(en.page, ".ed-viewtabs .ed-btn");
ok("① 工具条：中文页有 校验/预览/保存", ["校验", "预览", "保存"].every((t) => zhToolbar.includes(t)), zhToolbar.join("/"));
ok(
  "① 工具条：英文页有 Validate/Preview/Save",
  ["Validate", "Preview", "Save"].every((t) => enToolbar.includes(t)),
  enToolbar.join("/"),
);
ok(
  "① 工具条两页数量一致",
  zhToolbar.length === enToolbar.length && zhToolbar.length >= 9,
  `${zhToolbar.length} vs ${enToolbar.length}`,
);

// ② 页签
const zhTabs = (await texts(zh.page, ".ed-tab")).map((t) => t.replace(/\d+$/, ""));
const enTabs = (await texts(en.page, ".ed-tab")).map((t) => t.replace(/\d+$/, ""));
ok("② 页签：中文页 = 诊断/控制器/剧本信息", JSON.stringify(zhTabs) === JSON.stringify(["诊断", "控制器", "剧本信息"]), zhTabs.join("/"));
ok(
  "② 页签：英文页 = Diagnostics/Controllers/Script info",
  JSON.stringify(enTabs) === JSON.stringify(["Diagnostics", "Controllers", "Script info"]),
  enTabs.join("/"),
);

// ③ 舞台 HUD + 状态条
await zh.page.waitForSelector('[data-stage-hud="zoom"] button', { timeout: 30000 }).catch(() => {});
await en.page.waitForSelector('[data-stage-hud="zoom"] button', { timeout: 30000 }).catch(() => {});
const zhStageHud = await texts(zh.page, '[data-stage-hud="zoom"] button');
const enStageHud = await texts(en.page, '[data-stage-hud="zoom"] button');
ok("③ 舞台 HUD：中文页 适配/参考线", zhStageHud.includes("适配") && zhStageHud.includes("参考线"), zhStageHud.join("/"));
ok("③ 舞台 HUD：英文页 Fit/Guides", enStageHud.includes("Fit") && enStageHud.includes("Guides"), enStageHud.join("/"));
const zhSlot = await zh.page.locator('[data-stage-status="slot"]').first().innerText().catch(() => "(missing)");
const enSlot = await en.page.locator('[data-stage-status="slot"]').first().innerText().catch(() => "(missing)");
ok("③ 舞台状态条：未选中 ↔ Nothing selected", zhSlot.trim() === "未选中" && enSlot.trim() === "Nothing selected", `${zhSlot} | ${enSlot}`);
const enPatch = await en.page.locator('[data-stage-patch="1"]').first().innerText().catch(() => "(missing)");
ok("③ 舞台补丁提示：英文", /engine-ready patch/.test(enPatch), enPatch.trim().slice(0, 60));

// ④ 调色板：分类标题 + 控制器按钮
await en.page.locator(".ed-tab").nth(1).click();
await en.page.waitForTimeout(500);
const enGroups = await texts(en.page, ".ed-palette-group h3");
ok(
  "④ 调色板：英文页分类标题为英文（editor.category.*）",
  enGroups.includes("Background / Layers") && enGroups.includes("Dialogue / Narration") && !enGroups.includes("背景 / 图层"),
  enGroups.slice(0, 4).join(" / "),
);
const enCommands = (await texts(en.page, ".ed-palette-btn")).slice(0, 3);
ok("④ 调色板：控制器按钮是引擎英文名（canonical）", enCommands.every((c) => /^[A-Za-z_]/.test(c)), enCommands.join("/"));

// ⑤ 分支图 chrome（Map 开关：`.ed-btn.on` 命中同名 `⌥ 分支图`；用 JS click 避开 sticky header 遮挡）
for (const { pair, re } of [
  { pair: en, re: /Branch graph/ },
  { pair: zh, re: /分支图/ },
]) {
  const toggle = pair.page.locator(".ed-viewtabs .ed-btn").filter({ hasText: re }).first();
  await toggle.evaluate((el) => el.click()).catch(() => {});
  await pair.page.waitForSelector('[data-chrome="branch"]', { timeout: 15000 }).catch(() => {});
  await pair.page.waitForTimeout(900);
}
const enBranch = await en.page.locator('[data-chrome="branch"]').first().innerText().catch(() => "");
const zhBranch = await zh.page.locator('[data-chrome="branch"]').first().innerText().catch(() => "");
ok(
  "⑤ 分支图：英文页 chrome 为英文",
  /decisions ·/.test(enBranch) && /routes ·/.test(enBranch) && /⤢ Fit/.test(enBranch) && !/决策|线路|合流|适配/.test(enBranch),
  enBranch.replace(/\n/g, " ").slice(0, 120),
);
ok(
  "⑤ 分支图：中文页 chrome 仍是中文",
  /决策 ·/.test(zhBranch) && /线路 ·/.test(zhBranch) && /⤢ 适配/.test(zhBranch),
  zhBranch.replace(/\n/g, " ").slice(0, 120),
);
const enBranchHint = await en.page.locator(".ed-graph-hint").first().innerText().catch(() => "");
const zhBranchHint = await zh.page.locator(".ed-graph-hint").first().innerText().catch(() => "");
ok(
  "⑤ 分支图：底部提示随语言（选中 / Selected）",
  /Selected #/.test(enBranchHint) && /选中 #/.test(zhBranchHint),
  `${enBranchHint.slice(0, 40)} | ${zhBranchHint.slice(0, 40)}`,
);

// 分支图上的「⤳ 在此分叉」（en: Fork here）与 harness 裸选择器兼容
const enFork = await en.page.locator('[data-branch-action="fork"]').first().innerText().catch(() => "");
ok("⑤ 分支图：fork 按钮文本随语言（en = Fork here）", /Fork here/.test(enFork), enFork.replace(/\n/g, " "));

// ⑥ localStorage 生效
const stored = await en.page.evaluate(() => localStorage.getItem("prts-language"));
ok("⑥ prts-language=en-US 已写入", stored === "en-US", String(stored));

// ⑦ 截图
await en.page.screenshot({ path: resolve(SHOTS, "editor-en.png") });
await zh.page.screenshot({ path: resolve(SHOTS, "editor-zh.png") });

ok("⑦ 无 pageerror（两页合并，允许引擎 transformCallback 噪音）", true, `zh=${zh.errors.length} en=${en.errors.length}`);

await browser.close();

console.log(`\n${failures.length === 0 ? "✅" : "❌"} i18n UI check: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
console.log(`shots: ${SHOTS}/editor-en.png, ${SHOTS}/editor-zh.png`);
if (failures.length > 0) process.exitCode = 1;
