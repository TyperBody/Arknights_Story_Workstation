import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
const logs = [];
page.on("pageerror", (e) => logs.push("pageerror " + String(e).slice(0, 200)));
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
const res = await page.evaluate(async () => {
  try {
    const pack = await import("/src/lib/enginePack.ts");
    const loaded = await pack.loadBundledEngine();
    const meta = await pack.bundledEngineMeta();
    const status = await import("/src/lib/debugLog.ts");
    status.pushStatus("engine", "引擎模块加载失败：StoryPlayer.X.js（HTTP 500）；已回退到内置快照（v1）", "重试");
    return {
      hasPack: Boolean(loaded),
      label: loaded?.label,
      revision: loaded?.revision,
      modules: loaded ? Object.keys(loaded.snapshot.modules).length : 0,
      metaLabel: meta?.version,
      entries: status.statusEntries(),
      fallback: (await pack.fallbackSnapshots(loaded.snapshot)).map((c) => c.source),
    };
  } catch (error) { return { error: String(error && error.stack || error).slice(0, 400) }; }
});
console.log(JSON.stringify(res, null, 1));
console.log("logs", JSON.stringify(logs.slice(0, 5)));
await browser.close();
