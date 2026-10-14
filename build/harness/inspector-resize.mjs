// 「检视器可调大小」（用户原话「检视器大小固定了 太难用」）。
//   node build/harness/inspector-resize.mjs        # 需要 dev server:5174
//
// 断言：
//   ① 默认高度 ≥ 200（旧实现写死 190，太小）：`[data-inspector-grip]` 上方那块
//      `[data-editor-part="inspector-body"]` 的实际高度；
//   ② 拖 `[data-inspector-grip]` 向下 160px → 高度变大（≥ +100）；
//   ③ 刷新后**仍是**拖过的高度（`prts-editor-wb:view` → `inspector.height`）；
//   ④ 双击 grip → 回到默认高度。
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const bodyHeight = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-editor-part="inspector-body"]');
  return el ? Math.round(el.getBoundingClientRect().height) : -1;
});

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const p = await b.newPage({ viewport: { width: 1680, height: 1080 } });
  await p.addInitScript(() => {
    try {
      if (sessionStorage.getItem("ins-cleared") === "1") return;
      sessionStorage.setItem("ins-cleared", "1");
      Object.keys(localStorage).filter((k) => k.startsWith("prts-editor-wb:")).forEach((k) => localStorage.removeItem(k));
    } catch {}
    const fix = () => { const r = document.head || document.documentElement; if (!r || document.getElementById("ins-hide")) return; const s = document.createElement("style"); s.id = "ins-hide"; s.textContent = ".bookshelf-sync-warning,.dl-bar{display:none!important}"; r.appendChild(s); };
    fix(); setInterval(fix, 200);
  });
  // 光标行给一条真实控制器 → 检视器渲染完整表单（有内容才能量高度）。
  const text = encodeURIComponent('[HEADER(key="ins")]\n[Character(name="char_130_doberm_ex", fadetime=0.6)]\n[name="杜宾"] 你好。');
  await p.goto(`${DEV}/editor/ins?text=${text}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await p.waitForSelector('[data-inspector-grip="1"]', { timeout: 45_000 });
  await p.waitForTimeout(1800);

  t("工具栏有 [data-inspector-grip]", true);
  const start = await bodyHeight(p);
  t("默认高度 ≥ 200（比旧的 190 更可用）", start >= 200, `实得 ${start}`);

  // 把光标点到第二行（Character 行），确保检视器里是表单而非提示
  await p.evaluate(() => {
    const area = document.querySelector("textarea.ed-textarea");
    if (!area) return;
    const idx = area.value.indexOf("[Character");
    area.focus();
    area.setSelectionRange(idx, idx);
    area.dispatchEvent(new Event("select", { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
  });
  await p.waitForTimeout(600);

  const grip = p.locator('[data-inspector-grip="1"]').first();
  const bb = await grip.boundingBox();
  await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await p.mouse.down();
  await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2 + 170, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  const grown = await bodyHeight(p);
  t("拖 grip 向下 → 变高（≥ +100）", grown >= start + 100, `${start} → ${grown}`);

  // ③ 刷新后保持
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-inspector-grip="1"]', { timeout: 45_000 });
  await p.waitForTimeout(1800);
  const afterReload = await bodyHeight(p);
  t("刷新后仍是拖过的高度（落库）", Math.abs(afterReload - grown) <= 12, `拖后 ${grown} → 刷新后 ${afterReload}`);

  // ④ 双击回默认
  const grip2 = p.locator('[data-inspector-grip="1"]').first();
  await grip2.dblclick();
  await p.waitForTimeout(500);
  const reset = await bodyHeight(p);
  t("双击 grip → 回默认高度", Math.abs(reset - start) <= 20, `${afterReload} → ${reset}（默认 ${start}）`);

  const view = await p.evaluate(() => localStorage.getItem("prts-editor-wb:view"));
  t("view 里存了 inspector.height", Boolean(view && /"inspector"/.test(view)), String(view).slice(0, 90));
} finally { await b.close(); }
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
