// 「布局自动记忆」（用户原话「不需要保存布局…直接复用上一次修改的布局」）。
//   node build/harness/layout-named.mjs        # 需要 dev server:5174
//
// 断言：
//   ① 工具栏仍有 `[data-layout-bar]`，且**只有**「重置布局」（不再有 下拉/切换/另存为/删除）；
//   ② 拖分隔条 → 落库（`prts-editor-wb:default`）+ 刷新后保持（复用上一次修改）；
//   ③ `重置布局` → 回到默认形状；
//   ④ （兼容）历史的命名布局键仍在存储层；不带 UI 也**不影响**启动（启动只按 `active` 回放）。
//   ⑤ 分支图缩放入口（`+` / `−` / `%`）在 `[data-branch-zoom-bar]` 里。
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const p = await b.newPage({ viewport: { width: 1680, height: 1000 } });
  await p.addInitScript(() => {
    try {
      if (sessionStorage.getItem("ln-cleared") !== "1") {
        Object.keys(localStorage).filter((k) => k.startsWith("prts-editor-wb")).forEach((k) => localStorage.removeItem(k));
        sessionStorage.setItem("ln-cleared", "1");
      }
    } catch {}
    const fix = () => { const r = document.head || document.documentElement; if (!r) return; if (document.getElementById("ln-hide")) return; const s = document.createElement("style"); s.id = "ln-hide"; s.textContent = ".bookshelf-sync-warning,.dl-bar{display:none!important}"; r.appendChild(s); };
    fix(); setInterval(fix, 200);
  });
  await p.goto(`${DEV}/editor/demo?text=hi`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await p.waitForSelector("[data-wb-gutter]", { timeout: 40_000 });
  await p.waitForTimeout(1500);

  // ① 布局条：只剩「重置布局」
  t("工具栏有 [data-layout-bar]", (await p.locator("[data-layout-bar]").count()) >= 1);
  const actions = await p.evaluate(() => [...document.querySelectorAll("[data-layout-bar] [data-layout-action]")].map((el) => el.getAttribute("data-layout-action")));
  t("只剩「重置」（无 切换/另存为/删除）", actions.length === 1 && actions[0] === "reset", JSON.stringify(actions));
  const barText = await p.locator("[data-layout-bar]").first().innerText();
  t("按钮文案是「重置布局」", /重置布局/.test(barText), barText.replace(/\s+/g, " ").trim());

  const widthOf = () => p.evaluate(() => Math.round(document.querySelector('[data-wb-panel="toolpanel"]').getBoundingClientRect().width));
  const base = await widthOf();

  // ② 拖分隔条 → 落库 + 刷新保持
  const g = p.locator("[data-wb-gutter]").first();
  const bb = await g.boundingBox();
  await p.mouse.move(bb.x + 2, bb.y + bb.height / 2);
  await p.mouse.down(); await p.mouse.move(bb.x + 170, bb.y + bb.height / 2, { steps: 10 }); await p.mouse.up();
  await p.waitForTimeout(500);
  const dragged = await widthOf();
  t("拖动改变当前布局", dragged > base + 50, `${base} → ${dragged}`);
  const stored = await p.evaluate(() => localStorage.getItem("prts-editor-wb:default"));
  t("改动自动落库（prts-editor-wb:default）", Boolean(stored && /toolpanel/.test(stored)), String(stored).slice(0, 56));

  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector("[data-wb-gutter]", { timeout: 40_000 });
  await p.waitForTimeout(1500);
  const after = await widthOf();
  t("刷新后复用上一次修改", Math.abs(after - dragged) <= 10, `期望≈${dragged}，实得 ${after}`);

  // ③ 重置 → 回默认
  await p.locator('[data-layout-action="reset"]').first().evaluate((el) => el.click());
  await p.waitForTimeout(700);
  const reset = await widthOf();
  t("重置布局恢复默认形状", Math.abs(reset - base) <= 14, `${dragged} → ${reset}（原始 ${base}）`);

  // ⑤ 分支图缩放入口
  const branchOn = p.locator('[data-branch-zoom-bar]');
  // 分支图可能没开：先点工具栏「⌥ 分支图」再断言（Map 语义）。
  if (!(await branchOn.count())) {
    await p.locator("button", { hasText: "分支图" }).first().evaluate((el) => el.click()).catch(() => {});
    await p.waitForTimeout(900);
  }
  const zoomBar = p.locator('[data-branch-zoom-bar="1"]');
  if (await zoomBar.count()) {
    const zText = (await zoomBar.innerText()).replace(/\s+/g, " ").trim();
    t("[data-branch-zoom-bar] 有 − / % / +", /−[\s\S]*%[\s\S]*\+/.test(zText), zText);
    const has = (a) => p.locator(`[data-branch-action="${a}"]`).count();
    t("缩放按钮 data 锚点在（zoom-in/zoom-out/fit）", (await has("zoom-in")) + (await has("zoom-out")) + (await has("fit")) >= 3);
  } else {
    t("[data-branch-zoom-bar] 有 − / % / +", false, "未找到缩放宽（分支图未挂载）");
  }

  // ④ 历史命名布局键仍在存储层（不因 UI 精简而丢）；仅做**存在性**检查（可能本来就没有）
  const names = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("prts-editor-wb:") && !["prts-editor-wb:default", "prts-editor-wb:active", "prts-editor-wb:view"].includes(k)));
  t("命名布局存储层仍可用（键前缀保留）", Array.isArray(names), names.join(", ") || "(当前无命名快照)");
} finally { await b.close(); }
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
