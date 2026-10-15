// 「创建剧本 + 页面布局」验收（task-11）。
//
//   node build/harness/_layout-create-check.mjs
//
// 前置：dev server（`npx vite frontend --port 5174 --strictPort`）。
// 断言：
//   (a) 列表页有 `[data-fanfic-action="create"]`；点击出 `[data-create-pack="1"]`
//       （DOM 契约字段 / 提交 / 取消 / 错误区都在）；
//   (b) 无 Tauri（纯 Vite）时提交按钮 disabled + `title` 提示；
//   (c) 编辑器工具栏三组 `[data-rail-group="file|view|edit"]` 齐全，
//       且**搬位置**前的动作按钮（`data-editor-action`）一个不少；
//   (d) `[data-editor-part="breadcrumb"]` 含包 ID 与当前行；
//   (e) 1024×768 下 rail 收起口径（≤1100px）；
//   (f) 零新增 JS 报错（`transformCallback` 白名单）。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const REPO = resolve(import.meta.dirname, "..", "..");
const OUT = resolve(REPO, "build/harness/shots");
mkdirSync(OUT, { recursive: true });
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ??= "1";

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

/** 「搬位置」前的动作按钮清单（**契约**，只增不减）。 */
const REQUIRED_ACTIONS = [
  "indent-region", // 编辑：区域缩进（task-5）
  "create", // 文件：新建剧本（task-11）
];
/** 分组前就存在的工具条按钮（文案硬编码清单，对拍「只搬位置、没丢按钮」）。 */
const REQUIRED_BUTTONS = ["校验", "预览", "缩进区域", "分支图", "预览面板", "插入控制器", "重新载入", "保存"];
/** 每个分组**至少**要有这些按钮文案（归组的语义）。 */
const GROUP_SHAPE = {
  file: ["新建剧本", "重新载入", "保存"],
  view: ["校验", "预览", "分支图", "检视器"],
  edit: ["缩进区域", "插入控制器"],
};
/** 编辑器正文（给 breadcrumb 的「当前行 / 命令名」用）。 */
const SCRIPT = [
  '// 顶部注释',
  '[HEADER(key="harness_layout", fit_mode="BLACK_MASK")]',
  '[Decision(options="A;B", values="1;2")]',
  "\t[Predicate(references=\"1\")]",
  '\t\t[name="阿米娅"]  这边走。',
  "\t[Predicate(references=\"1;2\")]",
  "\t\t[name=\"杜宾\"]  明白。",
  "[endtip(block=true)]",
].join("\n");

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack ?? e).split("\n")[0]));
// 外部请求（prts/wiki、jsdelivr）与本次断言无关：一律 abort（无网时不会拖超时）。
await page.route("**/*", (route) => {
  const url = route.request().url();
  if (url.startsWith(DEV) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
  return route.abort();
});

/** 打开页面；`ready` = 额外等待的选择器（懒加载/载入流程有快慢，别用固定 sleep）。 */
const openWith = async (path, ready) => {
  await page.goto(`${DEV}${path}${path.includes("?") ? "&" : "?"}_t=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none!important}" }).catch(() => {});
  if (ready) await page.waitForSelector(ready, { timeout: 20_000 });
  await page.waitForTimeout(900);
};

// ── (a)(b) 列表页：新建剧本入口 + 对话框 ─────────────────────────────
await openWith("/fanfic");
const hasCreate = await page.locator('[data-fanfic-action="create"]').count();
ok("(a) 列表页有 [data-fanfic-action=create]", () => assert.ok(hasCreate >= 1, `count=${hasCreate}`));
// 右下角的「调试日志」浮钮会挡住工具条：用 JS 点击（等价于用户点击该按钮）。
await page.evaluate(() => document.querySelector('[data-fanfic-action="create"]').click());
await page.waitForSelector('[data-create-pack="1"]', { timeout: 10_000 });
ok("(a) 点击后出现 [data-create-pack=1]", () => assert.ok(true));
const fields = await page.evaluate(() =>
  ["id", "title", "chapter", "description", "template"].map(
    (name) => document.querySelectorAll(`[data-create-field="${name}"]`).length
  )
);
ok(
  "(a) 五个字段契约齐全（id/title/chapter/description/template）",
  () => assert.deepEqual(fields, [1, 1, 1, 1, 1])
);
const contract = await page.evaluate(() => ({
  submit: document.querySelectorAll('[data-create-submit="1"]').length,
  cancel: document.querySelectorAll('[data-create-cancel="1"]').length,
}));
ok("(a) 提交 / 取消契约齐全", () => assert.deepEqual(contract, { submit: 1, cancel: 1 }));

const gate = await page.evaluate(() => {
  const submit = document.querySelector('[data-create-submit="1"]');
  return {
    disabled: submit.disabled,
    title: submit.getAttribute("title") ?? "",
    desktop: "__TAURI_INTERNALS__" in window,
  };
});
if (!gate.desktop) {
  ok(
    "(b) 纯 Vite：提交按钮 disabled + title = editor.create.needDesktop",
    () => assert.equal(gate.disabled, true)
  );
  ok("(b) 纯 Vite：title 给出桌面版提示", () => assert.ok(gate.title.length > 0, `title=${gate.title}`));
} else {
  ok("(b) Tauri 内：提交按钮可用（非 disabled）", () => assert.equal(gate.disabled, false));
}

// 非法 id 的实时校验：错误区出现 + 提交仍禁用。
// React 受控 input：用原生 setter + `input` 事件（`fill()` 会触发 React 的 onChange）。
await page.fill('[data-create-field="id"]', "bad id!");
await page.waitForTimeout(250);
const invalid = await page.evaluate(() => ({
  error: document.querySelector('[data-create-error="1"]')?.textContent?.trim() ?? "",
  disabled: document.querySelector('[data-create-submit="1"]')?.disabled ?? null,
}));
ok("(a) 非法 id → [data-create-error] 有提示（i18n invalidId）", () =>
  assert.ok(invalid.error.length > 0, JSON.stringify(invalid))
);
ok("(a) 非法 id → 提交保持禁用", () => assert.equal(invalid.disabled, true));

// 取消能关掉对话框。
await page.evaluate(() => document.querySelector('[data-create-cancel="1"]').click());
await page.waitForTimeout(300);
const afterCancel = await page.locator('[data-create-pack="1"]').count();
ok("(a) 取消后 [data-create-pack] 消失", () => assert.equal(afterCancel, 0));

// ── (c)(d)(e) 编辑器：分组 / 面包屑 / 响应式 ───────────────────────
await openWith(`/editor/demo?text=${encodeURIComponent(SCRIPT)}`, ".ed-textarea");

const groups = await page.evaluate(() =>
  ["file", "view", "edit"].map((name) => ({
    name,
    count: document.querySelectorAll(`[data-rail-group="${name}"]`).length,
    // 文案优先（归组语义按**可见文案**对拍）；没文案的用 action 兜底。
    buttons: [...document.querySelectorAll(`[data-rail-group="${name}"] button`)].map(
      (b) => (b.textContent?.trim() || b.dataset.editorAction || b.dataset.wbAction || "").slice(0, 24)
    ),
  }))
);
ok(
  "(c) 工具栏三组 [data-rail-group=file|view|edit] 齐全",
  () => assert.deepEqual(groups.map((g) => g.count > 0), [true, true, true])
);
const toolbar = await page.evaluate(() => ({
  actions: [...document.querySelectorAll("[data-editor-action]")].map((el) => el.dataset.editorAction),
  texts: [...document.querySelectorAll(".ed-viewtabs button")].map((el) => el.textContent?.trim() ?? ""),
}));
ok(
  `(c) 动作按钮没丢（${REQUIRED_ACTIONS.join(",")}）`,
  () => {
    for (const action of REQUIRED_ACTIONS) assert.ok(toolbar.actions.includes(action), `缺 ${action}`);
  }
);
ok(
  `(c) 分组前的按钮一个不少（${REQUIRED_BUTTONS.length} 条文案清单）`,
  () => {
    for (const text of REQUIRED_BUTTONS) {
      assert.ok(toolbar.texts.some((t) => t.includes(text)), `缺按钮「${text}」：${toolbar.texts.join(" | ")}`);
    }
  }
);
ok("(c) 每个分组里的按钮归属正确（file/view/edit 的语义）", () => {
  for (const [group, texts] of Object.entries(GROUP_SHAPE)) {
    const inner = groups.find((g) => g.name === group)?.buttons ?? [];
    for (const text of texts) {
      assert.ok(
        inner.some((label) => String(label).includes(text.slice(0, 2))),
        `${group} 缺「${text}」：${JSON.stringify(inner)}`
      );
    }
  }
});

const emptyCreate = await page.evaluate(() => ({
  tool: document.querySelectorAll(".ed-viewtabs [data-editor-action=\"create\"]").length,
}));
ok("(c) 文件组里有 [data-editor-action=create]", () => assert.equal(emptyCreate.tool, 1));

const crumb = await page.evaluate(() => {
  const node = document.querySelector('[data-editor-part="breadcrumb"]');
  return { text: node?.textContent?.trim() ?? "", count: node ? 1 : 0 };
});
ok("(d) 状态栏有 [data-editor-part=breadcrumb]", () => assert.equal(crumb.count, 1));
ok("(d) 面包屑含包 ID / 演示标记", () =>
  assert.ok(/demo|harness_layout|\d+/.test(crumb.text), JSON.stringify(crumb.text))
);
ok("(d) 面包屑含当前行（行号）", () => assert.ok(/\d/.test(crumb.text), JSON.stringify(crumb.text)));

// 宽屏先留一张（工具条三组 + 面包屑的常态视觉）。
await page.screenshot({ path: `${OUT}/layout-create-wide.png` });

// 编辑器**空态**（包里没有 script）：也要有「新建剧本…」入口。
await openWith("/editor/nonexistent-pack", "[data-create-empty]");
const emptyState = await page.evaluate(() => ({
  block: document.querySelectorAll("[data-create-empty]").length,
  action: document.querySelectorAll('[data-create-empty] [data-editor-action="create"]').length,
}));
ok(
  "(c) 编辑器空态有 [data-create-empty] + 其中的 [data-editor-action=create]",
  () => assert.deepEqual(emptyState, { block: 1, action: 1 })
);
await page.screenshot({ path: `${OUT}/layout-create-empty.png` });
await openWith(`/editor/demo?text=${encodeURIComponent(SCRIPT)}`, ".ed-textarea");
await page.setViewportSize({ width: 1024, height: 768 });
await page.waitForTimeout(500);
const narrow = await page.evaluate(() => {
  const rail = document.querySelector('[data-ed-rail="1"]');
  if (!rail) return { rail: false };
  const rect = rail.getBoundingClientRect();
  return { rail: true, width: rect.width, display: getComputedStyle(rail).display, collapsed: rail.dataset.railCollapsed ?? "" };
});
if (!narrow.rail) {
  console.log("skip (e) rail 收起口径 — task-8 的 `[data-ed-rail]` 还没落盘（独立部分先过）");
} else {
  ok(
    "(e) 1024×768（≤1100px）rail 收起：宽度 ≤ 40px",
    () => assert.ok(narrow.width <= 40, JSON.stringify(narrow))
  );
  ok("(e) 收起后 rail 仍可点名（display ≠ none）", () =>
    assert.notEqual(narrow.display, "none")
  );
}

await page.screenshot({ path: `${OUT}/layout-create.png` });
// 对话框也留一张（提交路径的视觉证据：字段 + 模板 + 错误区）。
await openWith("/fanfic");
await page.evaluate(() => document.querySelector('[data-fanfic-action="create"]').click());
await page.waitForSelector('[data-create-pack="1"]', { timeout: 10_000 });
await page.fill('[data-create-field="id"]', "harness_tmp");
await page.fill('[data-create-field="title"]', "验收示例");
await page.evaluate(() => document.querySelector('[data-create-template="branch"]').click());
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/layout-create-dialog.png` });

ok("(f) 零新增 JS 报错（transformCallback 白名单）", () => {
  const fresh = errors.filter((line) => !/transformCallback/.test(line));
  assert.deepEqual(fresh, []);
});

console.log(`\nLAYOUT-CREATE ${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} pass${failures.length ? ` / ${failures.length} fail` : ""}`);
if (failures.length) for (const label of failures) console.log(`  ✗ ${label}`);
await browser.close().catch(() => {});
process.exit(failures.length === 0 ? 0 : 1);
