import { chromium } from "playwright-core";
const DEV = "http://localhost:5174";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
let hits = 0;
await page.route(/StoryPlayer\.[A-Za-z0-9_-]+\.js/, async (route) => {
  hits += 1;
  if (hits <= 2) return route.fulfill({ status: 500, contentType: "application/javascript", body: "throw 1" });
  return route.continue();
});
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 160)));
await page.goto(`${DEV}/`, { waitUntil: "domcontentloaded" });
const out = await page.evaluate(async () => {
  const ep = await import("/src/lib/enginePack.ts");
  const dl = await import("/src/lib/debugLog.ts");
  const boot = await import("/src/lib/storyPlayerBoot.ts");
  const pack = await ep.loadBundledEngine();
  ep.markBundleSource(pack.bundle, "network");
  const tauri = "__TAURI_INTERNALS__" in window;
  let probe = null;
  try {
    const m = await import("/src/lib/storyPlayerAdapter.ts");
    const r = await m.fetchModuleSource(pack.snapshot.entry, { source: "network" });
    probe = { ok: true, bytes: r.bytes };
  } catch (e) { probe = { ok: false, name: e?.name, status: e?.httpStatus, reason: e?.reason }; }
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:0;top:0;width:800px;height:450px";
  document.body.appendChild(iframe);
  let error = null, booted = false;
  try {
    await boot.bootStoryPlayer({ iframe, bundle: pack.bundle, script: '[HEADER(key="p6")]\n[name="x"]  hi', title: "p6", mode: "play" });
    booted = true;
  } catch (e) { error = String(e?.message ?? e).slice(0, 300); }
  return {
    tauri, probe, booted, error,
    source: ep.bundleSource(pack.bundle),
    statuses: dl.statusEntries(),
    dataBanner: document.querySelectorAll('[data-asset-banner="1"]').length,
    entries: dl.getEntries().slice(-8).map((e) => `${e.level}${e.silent ? "(s)" : ""}: ${e.msg.slice(0, 160)}`),
    bootAttr: iframe.contentDocument?.documentElement?.getAttribute("data-arkstage-boot") ?? null,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
