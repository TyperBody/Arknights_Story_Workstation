// 「布局可命名保存」（BRIEF §2.4 / 目标 ③）：切换、另存为、重置、删除，并跨刷新保持。
//   node build/harness/layout-named.mjs        # 需要 dev server:5174
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const p = await b.newPage({ viewport: { width: 1680, height: 1000 } });
  p.on("dialog", (d) => d.accept("我的布局"));
  await p.addInitScript(() => {
    try { if (sessionStorage.getItem("ln-cleared") !== "1") { Object.keys(localStorage).filter((k) => k.startsWith("prts-editor-wb:")).forEach((k) => localStorage.removeItem(k)); sessionStorage.setItem("ln-cleared", "1"); } } catch {}
    const fix = () => { const r = document.head || document.documentElement; if (!r) return; if (document.getElementById("ln-hide")) return; const s = document.createElement("style"); s.id = "ln-hide"; s.textContent = ".bookshelf-sync-warning,.dl-bar{display:none!important}"; r.appendChild(s); };
    fix(); setInterval(fix, 200);
  });
  await p.goto(`${DEV}/editor/demo?text=hi`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await p.waitForSelector("[data-wb-gutter]", { timeout: 40_000 });
  await p.waitForTimeout(1200);

  t("工具栏有 [data-layout-bar]", (await p.locator("[data-layout-bar]").count()) >= 1);
  const widthOf = () => p.evaluate(() => Math.round(document.querySelector('[data-wb-panel="toolpanel"]').getBoundingClientRect().width));
  // ① 拖动分隔条 → 当前布局（default）变化
  const base = await widthOf();
  const g = p.locator("[data-wb-gutter]").first();
  const bb = await g.boundingBox();
  await p.mouse.move(bb.x + 2, bb.y + bb.height / 2);
  await p.mouse.down(); await p.mouse.move(bb.x + 170, bb.y + bb.height / 2, { steps: 10 }); await p.mouse.up();
  await p.waitForTimeout(400);
  const dragged = await widthOf();
  t("拖动改变当前布局", dragged > base + 50, `${base} → ${dragged}`);

  // ② 另存为「我的布局」
  await p.locator('[data-layout-action="save-as"]').first().evaluate((el) => el.click());
  await p.waitForTimeout(600);
  const names1 = await p.evaluate(() => [...document.querySelectorAll("[data-layout-bar] option")].map((o) => o.value));
  t("另存为写入命名布局", names1.includes("我的布局"), JSON.stringify(names1));
  const saved = await p.evaluate(() => localStorage.getItem("prts-editor-wb:我的布局"));
  t("命名布局已落盘", Boolean(saved && saved.includes("toolpanel")), String(saved).slice(0, 48));

  // ③ 重置 → 宽度回默认（命名快照**不动**：重置只覆盖 `default`）
  await p.locator('[data-layout-action="reset"]').first().evaluate((el) => el.click());
  await p.waitForTimeout(500);
  const reset = await widthOf();
  t("重置恢复默认布局", Math.abs(reset - base) <= 12, `${dragged} → ${reset}（原始 ${base}）`);
  const savedStill = await p.evaluate(() => localStorage.getItem("prts-editor-wb:我的布局"));
  t("重置不改命名快照", Boolean(savedStill && savedStill === saved), String(savedStill).slice(0, 40));

  // ④ 切回命名布局 → 回到拖动后的形状
  await p.selectOption("[data-layout-bar] select", "我的布局");
  await p.locator('[data-layout-action="load"]').first().evaluate((el) => el.click());
  await p.waitForTimeout(600);
  const back = await widthOf();
  t("切换回命名布局恢复形状", Math.abs(back - dragged) <= 14, `期望≈${dragged}，实得 ${back}`);

  // ⑤ 刷新后仍在「我的布局」
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector("[data-wb-gutter]", { timeout: 40_000 });
  await p.waitForTimeout(1200);
  const after = await widthOf();
  t("刷新后仍是命名布局", Math.abs(after - dragged) <= 14, `期望≈${dragged}，实得 ${after}`);

  // ⑥ 删除命名布局 → 回 default
  await p.selectOption("[data-layout-bar] select", "我的布局").catch(() => {});
  await p.locator('[data-layout-action="delete"]').first().evaluate((el) => el.click()).catch(() => {});
  await p.waitForTimeout(500);
  const names2 = await p.evaluate(() => [...document.querySelectorAll("[data-layout-bar] option")].map((o) => o.value));
  t("删除命名布局", !names2.includes("我的布局"), JSON.stringify(names2));
} finally { await b.close(); }
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
