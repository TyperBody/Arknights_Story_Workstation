import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
const out = await page.evaluate(async () => {
  const dl = await import("/src/lib/debugLog.ts");
  dl.pushStatus("engine", "hello", "world");
  dl.pushLog("info", "[test] entry");
  const ep = await import("/src/lib/enginePack.ts");
  const boot = await import("/src/lib/storyPlayerBoot.ts");
  const sb = await import("/src/lib/storyPlayerBoot.ts");
  return {
    statuses: dl.statusEntries(),
    entries: dl.getEntries().map((e) => e.msg.slice(0, 60)),
    epHasPush: typeof ep.pushEngineStatus,
    bootSame: boot === sb,
    scripts: [...document.querySelectorAll("script[type=module]")].map((s) => s.src || "inline").slice(0, 6),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
