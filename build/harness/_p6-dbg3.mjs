import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const urls = await page.evaluate(() =>
  performance.getEntriesByType("resource")
    .filter((e) => /\/src\/lib\/(debugLog|enginePack|storyPlayerBoot)/.test(e.name))
    .map((e) => ({ n: e.name.replace(location.origin, ""), t: Math.round(e.startTime) }))
);
console.log(JSON.stringify(urls, null, 1));
await browser.close();
