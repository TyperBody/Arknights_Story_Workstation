// 「拼接记得住」：拖分隔条 → 刷新页面 → 布局仍是拖过的样子（不用手点）。
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };
const b = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const p = await b.newPage({ viewport: { width: 1680, height: 1000 } });
  // 只在**第一次**导航清布局（reload 也要保留 → 用 sessionStorage 哨兵）。
  await p.addInitScript(() => {
    try {
      if (sessionStorage.getItem("wb-cleared") === "1") return;
      sessionStorage.setItem("wb-cleared", "1");
      Object.keys(localStorage).filter((k) => k.startsWith("prts-editor-wb:")).forEach((k) => localStorage.removeItem(k));
    } catch {}
  });
  await p.goto(`${DEV}/editor/demo?text=hi`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await p.waitForSelector("textarea.ed-textarea", { timeout: 40_000 });
  await p.waitForTimeout(1800);
  const widthOf = () => p.evaluate(() => Math.round(document.querySelector('[data-wb-panel="toolpanel"]').getBoundingClientRect().width));
  const before = await widthOf();
  const g = p.locator("[data-wb-gutter]").first();
  const bb = await g.boundingBox();
  await p.mouse.move(bb.x + 2, bb.y + bb.height / 2);
  await p.mouse.down();
  await p.mouse.move(bb.x + 180, bb.y + bb.height / 2, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(400);
  const dragged = await widthOf();
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector("textarea.ed-textarea", { timeout: 40_000 });
  await p.waitForTimeout(1800);
  const after = await widthOf();
  t("拖分隔条改变宽度", dragged > before + 60, `${before} → ${dragged}`);
  t("刷新后布局保持（拼接记得住）", Math.abs(after - dragged) <= 8, `拖后 ${dragged} → 刷新后 ${after}`);
  // 舞台缩放不写 localStorage（只改视口），刷新回 100% 是预期
  const stage = await p.evaluate(() => document.querySelector('[data-stage-status="zoom"]')?.textContent?.trim() ?? "");
  t("刷新后舞台回到 100%（视口缩放不落盘）", stage.startsWith("100%"), stage);
} finally { await b.close(); }
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
