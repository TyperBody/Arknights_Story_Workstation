import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
const res = await page.evaluate(async () => {
  const { runBootAttempts } = await import("/src/lib/storyPlayerBoot.ts");
  return { has: typeof runBootAttempts, exports: Object.keys(await import("/src/lib/storyPlayerBoot.ts")).slice(0,20) };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
