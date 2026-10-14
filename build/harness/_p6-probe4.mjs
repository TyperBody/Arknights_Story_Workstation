import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0,200)));
await page.goto("http://localhost:5174/play/W2G%2FBEG", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(25000);
const res = await page.evaluate(() => ({
  body: document.body.innerText.slice(0, 400),
  iframes: document.querySelectorAll("iframe").length,
  banner: document.querySelectorAll('[data-asset-banner="1"]').length,
  canvas: [...document.querySelectorAll("iframe")].map(f => Boolean(f.contentDocument?.querySelector("canvas"))),
}));
console.log(JSON.stringify(res, null, 1));
await browser.close();
