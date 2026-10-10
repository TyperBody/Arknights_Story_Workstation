// 无头「取景器」：在 headless Chromium 里跑真正的 StoryPlayer，采集：
//   ① 每条脚本行的**执行顺序**（`Array.prototype.at` 钩子；一行为一个对象）
//   ② `@tag` 控制位对应的**执行时机** → 给「偏移编译」用
//   ③ 决策面板的**选项标签**与出现时机
// 供 `scripts/fanfic/pack.mjs` 把作者脚本（含 `@tag`）编译成引擎可直接播放的最终脚本。
//
//   node scripts/fanfic/probe.mjs --pack example/fanfic/demo \
//        --upstream build/fanfic/upstream.json --out build/fanfic/probe.json
//
// 这里**不修改上游引擎**，只做「取景」：只读钩子 + 在页面里触发行进。
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, resolve, join } from "node:path";
import { chromium } from "playwright-core";
import { adaptStoryPlayerEntry } from "./adapt.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const packDir = resolve(arg("--pack", "example/fanfic/demo"));
const upstreamPath = resolve(arg("--upstream", "build/fanfic/upstream.json"));
const outPath = resolve(arg("--out", "build/fanfic/probe.json"));
const chromiumPath = arg("--chromium", process.env.CHROMIUM_PATH || "/snap/bin/chromium");
const timeoutMs = Number(arg("--timeout", 90000));

const upstream = JSON.parse(readFileSync(upstreamPath, "utf8"));
const assetsRoot = resolve(arg("--assets", "build/fanfic/assets"));
const pack = {
  script: readFileSync(join(packDir, "source", "probe.txt"), "utf8"),
  plan: existsSync(join(packDir, "source", "probe.plan.json"))
    ? JSON.parse(readFileSync(join(packDir, "source", "probe.plan.json"), "utf8"))
    : [],
};

const entryUrl = Object.keys(upstream.bundle.modules).find((url) => /StoryPlayer\.[^/]+\.js$/.test(url));
if (!entryUrl) throw new Error("upstream snapshot has no StoryPlayer entry module");

/** 把相对导入 / import.meta.url 换成绝对 URL：blob 模块只能靠绝对地址互相引。 */
function rewriteSource(source, url, modules) {
  let out = source.replace(/import\.meta\.url/g, JSON.stringify(url));
  for (const target of Object.keys(modules)) {
    const name = target.split("/").pop();
    out = out.split(`"./${name}"`).join(JSON.stringify(target)).split(`'./${name}'`).join(JSON.stringify(target));
  }
  out = out.replace(/(from|import)\s*(["'])(\.\.?\/[^"']+)\2/g, (all, head, quote, spec) => {
    const absolute = new URL(spec, url).href;
    if (!modules[absolute]) throw new Error(`missing module ${absolute}`);
    return `${head} ${JSON.stringify(absolute)}`;
  });
  return out;
}

const rewrittenModules = {};
for (const [url, rawSource] of Object.entries(upstream.bundle.modules)) {
  const source = url === entryUrl ? adaptStoryPlayerEntry(rawSource) : rawSource;
  rewrittenModules[url] = rewriteSource(source, url, upstream.bundle.modules);
}

const CONTENT_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css", ".json": "application/json",
  ".mp3": "audio/mpeg", ".ttf": "font/ttf", ".webp": "image/webp",
};

function serveFromDisk(res, requestUrl) {
  const trimmed = requestUrl
    .replace(/^https:\/\/torappu\.prts\.wiki\/assets\//, "")
    .replace(/^https:\/\/static\.prts\.wiki\//, "")
    .replace(/^\//, "");
  for (const candidate of [join(assetsRoot, trimmed), join(assetsRoot, decodeURIComponent(trimmed))]) {
    if (candidate.startsWith(assetsRoot) && !candidate.endsWith("/") && existsSync(candidate)) {
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" });
      res.end(readFileSync(candidate));
      return true;
    }
  }
  return false;
}

const pageHtml = `<!doctype html><meta charset="utf-8"><title>arkstage probe</title>
<style>html,body{margin:0;background:#111}#root{width:1280px;height:720px}</style>
<div id="root"></div><pre id="datas_txt" hidden></pre><pre id="__opts" hidden></pre>
<script type="module">
const state = window.__probeState;

// ① 只读取景：引擎用 codes.at(-1) / codes.length 迭代脚本行；成员即执行顺序。
const originalAt = Array.prototype.at;
Array.prototype.at = function (index) {
  const value = originalAt.call(this, index);
  if (value && typeof value === 'object' && typeof value.lineNumber === 'number'
      && typeof value.command !== 'undefined' && typeof value.kind === 'string') {
    state.nodes.push({ n: value.lineNumber, c: value.command, k: value.kind });
  }
  return value;
};

// ② 所有 https 资源都走本地镜像 / 回源。
const origFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://')) {
    const local = await origFetch('/__asset?u=' + encodeURIComponent(url), init);
    if (local.ok) return local;
    return origFetch('/__fetch?u=' + encodeURIComponent(url), init);
  }
  return origFetch(input, init);
};
const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
if (imageSrc && imageSrc.set) Object.defineProperty(HTMLImageElement.prototype, 'src', {
  get: imageSrc.get,
  set(value) { imageSrc.set.call(this, String(value).startsWith('https://') ? '/__asset?u=' + encodeURIComponent(value) : value); },
});
window.__ready = true;
</script>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (status, type, body) => { res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" }); res.end(body); };
  if (url.pathname === "/") return send(200, "text/html; charset=utf-8", pageHtml);
  if (url.pathname === "/__probe.txt") return send(200, "text/plain; charset=utf-8", pack.script);
  if (url.pathname === "/__options.json") {
    const options = [];
    for (const line of pack.script.split("\n")) {
      const match = line.match(/\[\s*Decision[^(]*\(([^)]*)\)/i);
      if (!match) continue;
      const label = match[1].match(/options\s*=\s*"([^"]*)"/);
      if (label) options.push(...label[1].split(";"));
    }
    return send(200, "application/json", JSON.stringify(options));
  }
  if (url.pathname === "/__asset") {
    const target = url.searchParams.get("u") ?? "";
    if (serveFromDisk(res, target)) return;
    return send(404, "text/plain", "miss");
  }
  if (url.pathname === "/__fetch") {
    const target = url.searchParams.get("u") ?? "";
    fetch(target, { headers: { "User-Agent": "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)", Referer: "https://prts.wiki/" } })
      .then(async (upstreamRes) => send(upstreamRes.status, upstreamRes.headers.get("content-type") ?? "application/octet-stream", Buffer.from(await upstreamRes.arrayBuffer())))
      .catch(() => send(502, "text/plain", "fetch failed"));
    return;
  }
  return send(404, "text/plain", "not found");
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
let result;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const browserPage = await context.newPage();
  browserPage.on("pageerror", (error) => console.log("[pageerror]", String(error.stack ?? error).split("\n").slice(0, 2).join(" | ")));
  await browserPage.addInitScript(`
    window.__modules = ${JSON.stringify(rewrittenModules)};
    // 只读取景：把脚本行数组「盖章」后，任何按索引取值（at/[]/迭代）都会被记账。
    window.__probeState = { nodes: [], choices: [], samples: [] };
    window.__stamp = (lines) => lines.map((line, index) => (line ? Object.defineProperty(line, '__i', { value: index, enumerable: false, configurable: true }) : line));
    window.__noteLine = (line) => window.__note(line);
    window.__note = (line) => {
      const state = window.__probeState;
      if (!line || typeof line.lineNumber !== 'number') return;
      if (state.seen && state.seen.has(line.lineNumber)) return;
      (state.seen ??= new Set()).add(line.lineNumber);
      const label = line.command ?? line.name ?? null;
      if (!label) return;
      state.nodes.push({ n: line.lineNumber, c: label, k: line.kind ?? null });
      if (state.samples.length < 4) state.samples.push({ raw: String(line.raw ?? '').slice(0, 60), label });
    };
    const originalAt = Array.prototype.at;
    Array.prototype.at = function (index) {
      const value = originalAt.call(this, index);
      window.__note(value);
      return value;
    };
    window.__setup = () => {
      const blobs = new Map();
      for (const [url, source] of Object.entries(window.__modules)) blobs.set(url, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      const imports = {};
      for (const [url, blob] of blobs) imports[url] = blob;
      const element = document.createElement('script');
      element.type = 'importmap';
      element.textContent = JSON.stringify({ imports });
      document.head.appendChild(element);
      return blobs;
    };
  `);
  await browserPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await browserPage.waitForFunction("window.__ready === true", null, { timeout: 15000 });

  const surface = await browserPage.evaluate(async (entry) => {
    const report = {};
    try {
      const blobs = window.__setup();
      report.blobs = blobs.size;
      // 上游 entry 在**模块求值期**就读取 #datas_txt 并挂载，所以先写脚本再 import。
      const script = await (await fetch("/__probe.txt")).text();
      document.getElementById("datas_txt").textContent = script;
      document.getElementById("__opts").textContent = JSON.stringify(await (await fetch("/__options.json")).json());
      const namespace = await import(blobs.get(entry));
      report.exportKeys = Object.keys(namespace);
      report.import = "ok";
      const api = window.__arkstageAPI ?? namespace.default ?? namespace;
      const context = await api.loadContext(script);
      report.apiKeys = Object.keys(api ?? {});
      report.mountGlobal = typeof window.__arkstageMount;
      if (typeof window.__arkstageMount === "function") { try { window.__arkstageMount(); report.mount = "ok"; } catch (error) { report.mount = String(error); } }
      report.loadContext = "ok";
      report.linkMap = Object.keys(context.linkMap ?? {}).length;
      report.scriptLines = Array.isArray(context.script) ? context.script.length : null;
      try {
        window.__opts = (context.script ?? []).map((line, index) => ({ line, index }));
      } catch (error) { report.optionsError = String(error); }
      try { report.manifest = api.collectManifest(context).urls.length; } catch (error) { report.collectManifest = String(error); }
      try { (window.__arkstageMount ?? api.mount)(); report.mount = "ok"; } catch (error) { report.mount = String(error); }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      report.afterMountHtml = document.getElementById("root").innerHTML.slice(0, 200);

      const clickable = () => {
        const found = [...document.querySelectorAll("#root button, #root .n-button")]
          .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 2 && b.height > 2; })
          .map((el) => { const b = el.getBoundingClientRect(); return { el, x: b.x + b.width / 2, y: b.y + b.height / 2, label: (el.textContent || "").trim().slice(0, 20) }; });
        const canvas = document.querySelector("#root canvas");
        if (canvas) { const b = canvas.getBoundingClientRect(); found.push({ el: canvas, x: b.x + b.width / 2, y: b.y + b.height / 2, label: "canvas" }); }
        report.targets = found.map((item) => item.label);
        return found;
      };
      const click = (target) => {
        for (const type of ["mousemove", "mousedown", "mouseup", "click"]) {
          target.el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: target.x, clientY: target.y }));
        }
      };
      // 优先点“选项”（脚本里 Decision 的标签），其次“继续/跳过剧情”，最后点画布。
      const optionLabels = JSON.parse(document.getElementById("__opts").textContent || "[]");
      const findButton = (labels) => [...document.querySelectorAll("#root button, #root .n-button")]
        .find((el) => el.getBoundingClientRect().width > 2 && labels.some((label) => (el.textContent || "").trim() === label));
      for (let round = 0; round < 400; round += 1) {
        const buttons = [...document.querySelectorAll("#root button, #root .n-button")]
          .filter((el) => (el.textContent || "").trim() && el.getBoundingClientRect().width > 2)
          .map((el) => (el.textContent || "").trim().slice(0, 24));
        const visibleOptions = buttons.filter((label) => optionLabels.includes(label));
        if (visibleOptions.length) {
          const at = window.__probeState.nodes.filter((node) => node.c).length;
          const last = window.__probeState.choices.at(-1);
          if (!last || JSON.stringify(last.labels) !== JSON.stringify(visibleOptions)) window.__probeState.choices.push({ labels: visibleOptions, at });
        }
        const optionButton = findButton(optionLabels);
        const advanceButton = findButton(["继续", "跳过剧情", "开始"]);
        if (optionButton) click({ el: optionButton, x: 0, y: 0 });
        else if (advanceButton) click({ el: advanceButton, x: 0, y: 0 });
        else { const items = clickable(); if (items.length) click(items[items.length - 1]); }
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (window.__probeState.nodes.filter((node) => node.c).length > 120) break;
      }
      report.finalHtml = document.getElementById("root").innerHTML.slice(0, 200);
    } catch (error) {
      report.fatal = String((error && error.stack) || error);
    }
    return report;
  }, entryUrl);

  const snapshot = await browserPage.evaluate(() => ({
    samples: window.__probeState.samples,
    nodes: window.__probeState.nodes,
    choices: window.__probeState.choices,
    stage: document.getElementById("probe")?.textContent ?? null,
    html: document.getElementById("root")?.innerHTML?.slice(0, 300) ?? null,
  }));
  result = { surface, nodes: snapshot.nodes, samples: snapshot.samples, choices: snapshot.choices, stage: snapshot.stage, html: snapshot.html };
  const shot = resolve(outPath.replace(/\.json$/, ".png"));
  mkdirSync(resolve(shot, ".."), { recursive: true });
  await browserPage.screenshot({ path: shot }).catch(() => {});
  result.screenshot = shot;
} catch (error) {
  result = { error: String(error?.stack ?? error) };
} finally {
  await browser.close();
  server.close();
}

mkdirSync(resolve(outPath, ".."), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 1));
const nodes = result.nodes ?? [];
console.log(JSON.stringify({
  surface: result.surface ?? null,
  error: result.error ?? null,
  commandCount: nodes.filter((node) => node.c).length,
  commands: nodes.filter((node) => node.c).map((node) => `${node.n}:${node.c}`).slice(0, 48),
  samples: (result.samples ?? []).slice(0, 3),
  choices: (result.choices ?? []).slice(-4),
}, null, 1));
