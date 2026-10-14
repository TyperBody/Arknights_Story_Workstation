// 前端侧：`stateStore` 是否**真的**把工作台排版写进 `state_db_*`（用一个假 Tauri 桥记录 IPC）。
//   node build/harness/state-db-frontend.mjs        # 需要 dev server:5174
// 断言：
//   ① hydrate 时按 scope 调 `state_db_snapshot`（workspace 至少一次）；
//   ② 拖分隔条 → 出现 `state_db_set_many`，payload 的 value 是合法布局串（含 toolpanel）；
//   ③ 假 DB 里存下后，**重新加载页面** → 不点任何东西也能读到同一串（首屏 hydrate 生效）；
//   ④ 旧 `localStorage` 值会被 `state_db_import` 搬进 DB（只搬 DB 没有的键）。
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

/** 注入假 Tauri：内存 DB + invoke 记录（`retain` 让第二次加载仍看到第一次的写入）。 */
const BRIDGE = () => {
  const g = globalThis;
  // 假 DB 用 sessionStorage 持久化（跨 reload 保留；`addInitScript` 每次都跑）。
  const KEY = "sd-fake-db";
  const db = (g.__fakeDb = g.__fakeDb ?? (() => {
    try { return JSON.parse(sessionStorage.getItem(KEY) ?? "{}"); } catch { return {}; }
  })());
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(db)); } catch { /* ignore */ } };
  const calls = (g.__calls = []);
  g.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args = {}) => {
      calls.push({ cmd, args });
      const scope = args.scope ?? "";
      db[scope] = db[scope] ?? {};
      if (cmd === "state_db_snapshot") return Object.entries(db[scope]).map(([key, value]) => ({ key, value, updatedAt: 0 }));
      if (cmd === "state_db_set") { db[scope][args.key] = args.value; save(); return null; }
      if (cmd === "state_db_set_many") { for (const [k, v] of args.entries ?? []) db[scope][k] = v; save(); return (args.entries ?? []).length; }
      if (cmd === "state_db_del") { delete db[scope][args.key]; save(); return null; }
      if (cmd === "state_db_import") {
        let n = 0;
        for (const [k, v] of args.entries ?? []) if (!(k in db[scope])) { db[scope][k] = v; n += 1; }
        save();
        return n;
      }
      if (cmd === "state_db_info") return { path: "(fake)", scopes: [] };
      if (cmd === "download_settings_get") return { concurrency: 30, rateLimitBps: 0, mirror: "pack", customMirror: null };
      return null;
    },
    transformCallback: (cb) => cb,
    metadata: { currentWebview: { label: "main" }, currentWindow: { label: "main" } },
  };
};

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const ctx = await b.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => {
    const fix = () => { const r = document.head || document.documentElement; if (!r || document.getElementById("sd-hide")) return; const s = document.createElement("style"); s.id = "sd-hide"; s.textContent = ".bookshelf-sync-warning,.dl-bar{display:none!important}"; r.appendChild(s); };
    fix(); setInterval(fix, 300);
  });
  // ⚠️ addInitScript 每次导航都会跑：用 sessionStorage 哨兵**只播种一次**，
  // 否则 reload 会把刚才写进"假 DB"的布局覆盖回初始值（断言就会假过/假失败）。
  await ctx.addInitScript(`if (!sessionStorage.getItem("sd-db-seeded")) { sessionStorage.setItem("sd-db-seeded", "1"); sessionStorage.setItem("sd-fake-db", JSON.stringify({ workspace: { "prts-editor-wb:default": "(toolpanel|{placeholder/stage%62}%64)" } })); }`);
  await ctx.addInitScript(`(${BRIDGE.toString()})()`);
  const page = await ctx.newPage();
  // 预置一条旧 localStorage（验证 import）
  await page.addInitScript(() => { try { if (sessionStorage.getItem("sd-seeded")) return; sessionStorage.setItem("sd-seeded", "1"); localStorage.setItem("prts-player-chrome", "hide"); } catch {} });
  await page.goto(`${DEV}/editor/demo?text=hi`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("[data-wb-gutter]", { timeout: 40_000 });
  await page.waitForTimeout(1600);

  const callList = await page.evaluate(() => globalThis.__calls.map((c) => c.cmd));
  t("hydrate 调了 state_db_snapshot", callList.includes("state_db_snapshot"), `${callList.filter((c) => c.startsWith("state_db")).slice(0, 4).join(",")}`);
  const importCall = await page.evaluate(() => globalThis.__calls.find((c) => c.cmd === "state_db_import"));
  t("旧 localStorage 值被 import 进 DB", Boolean(importCall) && (importCall.args.entries ?? []).some(([k]) => k === "prts-player-chrome"),
    importCall ? JSON.stringify(importCall.args.entries).slice(0, 90) : "无 import 调用");

  // 首屏用的是 DB 里的 64% 布局（不是默认 32%）
  const width0 = await page.evaluate(() => Math.round(document.querySelector('[data-wb-panel="toolpanel"]').getBoundingClientRect().width));
  t("首屏采用 DB 里的布局（≈64%）", width0 / 1500 > 0.5, `toolpanel=${width0}px / 1500`);

  // 拖分隔条 → 应出现 state_db_set_many
  const g = page.locator("[data-wb-gutter]").first();
  const bb = await g.boundingBox();
  await page.mouse.move(bb.x + 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + 160, bb.y + bb.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const setMany = await page.evaluate(() => globalThis.__calls.filter((c) => c.cmd === "state_db_set_many" && c.args.scope === "workspace"));
  const layout = setMany.at(-1)?.args.entries?.find(([k]) => k === "prts-editor-wb:default")?.[1] ?? "";
  t("拖分隔条 → 写 state_db_set_many(workspace)", setMany.length > 0, `${setMany.length} 次`);
  t("写入的是合法布局串", /toolpanel/.test(layout) && /%/.test(layout), layout.slice(0, 60));
  const stored = await page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem("sd-fake-db") ?? "{}").workspace?.["prts-editor-wb:default"]; } catch { return null; } });
  t("假 DB 已存下新布局", stored === layout && /toolpanel/.test(stored ?? ""), String(stored).slice(0, 60));

  // 重新加载（保留同一个假 DB）→ 首屏应直接是刚才那串
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-wb-gutter]", { timeout: 40_000 });
  await page.waitForTimeout(1500);
  const width1 = await page.evaluate(() => Math.round(document.querySelector('[data-wb-panel="toolpanel"]').getBoundingClientRect().width));
  const shares = [...String(stored ?? "").matchAll(/%(\d+)/g)].map((m) => Number(m[1]));
  const wantShare = shares.at(-1) ?? 0;
  t("刷新后仍是 DB 里的布局（记得住）", Math.abs(width1 - Math.round((1500 * wantShare) / 100)) < 40,
    `reload toolpanel=${width1}px，DB 期望 ${wantShare}% → ${Math.round(1500 * wantShare / 100)}px`);
} finally {
  await b.close();
}
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
