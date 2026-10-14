import { chromium } from "playwright-core";
const DEV = "http://localhost:5174";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text().slice(0,200)}`));
page.on("pageerror", (e) => logs.push("pageerror: " + String(e).slice(0,200)));
await page.goto(`${DEV}/editor/demo`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  rootHtml: (document.getElementById("root")?.innerHTML ?? "").slice(0, 300),
  textareas: document.querySelectorAll("textarea").length,
  classes: [...document.querySelectorAll("textarea")].map(t => t.className),
  btns: [...document.querySelectorAll("button")].map(b => (b.textContent||"").trim()).filter(Boolean).slice(0, 20),
}));
console.log(JSON.stringify(info, null, 1));
console.log("logs:", JSON.stringify(logs.slice(-15), null, 1));
await page.screenshot({ path: "build/p6-editor-probe.png" });
await browser.close();
