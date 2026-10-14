import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const up = JSON.parse(readFileSync("build/fanfic/upstream.json", "utf8"));
const b = up.bundle;
const snap = { entry: b.entry, prelude: b.prelude, modules: b.modules, styles: b.styles, data: b.data };
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("http://localhost:5174/", { waitUntil: "domcontentloaded" });
const res = await page.evaluate(async (snapshot) => {
  const mod = await import("/src/lib/storyPlayerAdapter.ts");
  const t0 = Date.now();
  const problems = mod.validateStoryPlayer(snapshot);
  const entryOk = /^\{/.test(snapshot.modules[snapshot.entry].slice(0, 5)) === false;
  return { problems, ms: Date.now() - t0, modules: Object.keys(snapshot.modules).length, entryHead: snapshot.modules[snapshot.entry].slice(0, 40) };
}, snap);
console.log(JSON.stringify(res, null, 1));
await browser.close();
