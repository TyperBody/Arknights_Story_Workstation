// 「换源真的生效」端到端（浏览器侧能验的部分）：设置页切换下载源 → 推给 Rust（Tauri 缺席时跳过）。
// 需要 dev server:5174。Rust 侧的源链由 cargo test（`mirror_url_*`）与 tools/mirror 的模板对齐断言覆盖。
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  await p.goto(`${DEV}/settings`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await p.waitForTimeout(1800);
  const options = await p.evaluate(() => {
    const sel = document.querySelector("select");
    return sel ? [...sel.options].map((o) => ({ value: o.value, label: o.textContent?.trim() })) : [];
  });
  t("设置页有「下载源」下拉且含镜像项", options.some((o) => o.value === "jsd") && options.some((o) => o.value === "pack"), JSON.stringify(options));
  // 切换 → localStorage 落盘
  await p.evaluate(() => {
    const sel = document.querySelector("select");
    if (!sel) return;
    sel.value = "jsd";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(600);
  const stored = await p.evaluate(() => JSON.parse(localStorage.getItem("prts-app-settings") ?? "{}"));
  t("切换后写入 prts-app-settings.mirror", stored.mirror === "jsd", JSON.stringify(stored.mirror));
  const preview = await p.evaluate(() => document.body.innerText.match(/样例预览：(\S+)/)?.[1] ?? "");
  t("预览 URL 带镜像前缀 mirror/prts", /mirror\/prts\//.test(preview) && /jsdelivr/.test(preview), preview.slice(0, 110));
  // 还原默认
  await p.evaluate(() => {
    const sel = document.querySelector("select");
    if (!sel) return;
    sel.value = "pack";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
} finally { await b.close(); }
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
