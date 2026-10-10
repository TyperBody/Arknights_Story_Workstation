// 浏览器直跑同一个取景器（无需 Tauri）：把本地剧本包 + 上游快照 + 资源镜像
// 以 HTTP 形式供给 frontend/src/lib/localStories.ts 的探针通道，再用 headless
// Chromium 跑真正的 `bootStoryPlayer()` —— 与应用内完全同一条代码路径。
//
//   node --experimental-strip-types scripts/fanfic/web-run.mjs \
//        --library example/library --upstream build/fanfic/upstream.json \
//        --assets build/fanfic/assets --out build/fanfic/web-run.json [--keep]
//
// 依赖：vite + playwright-core（devDependencies，`npm i` 即可；浏览器用
// CHROMIUM_PATH 或 /snap/bin/chromium）。它**不改动**仓库里的任何源文件。

import { createServer } from "vite";
import { chromium } from "playwright-core";
import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, extname, relative } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const libraryDir = resolve(arg("--library", "example/library"));
const upstreamPath = resolve(arg("--upstream", "build/fanfic/upstream.json"));
const assetsRoot = resolve(arg("--assets", "build/fanfic/assets"));
const outPath = resolve(arg("--out", "build/fanfic/web-run.json"));
const chromiumPath = arg("--chromium", process.env.CHROMIUM_PATH || "/snap/bin/chromium");
const title = arg("--title", "");

const upstream = existsSync(upstreamPath) ? JSON.parse(readFileSync(upstreamPath, "utf8")) : null;
const types = { ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".ttf": "font/ttf", ".webp": "image/webp", ".css": "text/css" };

function readPack(id) {
  const dir = join(libraryDir, id);
  const files = {};
  const walk = (base, prefix = "") => {
    for (const entry of readdirSync(join(dir, base))) {
      const path = join(dir, base, entry);
      if (statSync(path).isDirectory()) walk(join(base, entry), `${prefix}${entry}/`);
      else if (!/\.(png|jpg|mp3|ttf|webp)$/i.test(entry)) files[`${prefix}${entry}`] = readFileSync(path, "utf8");
    }
  };
  walk(".");
  return { id, dir, files };
}

function listPacks() {
  if (!existsSync(libraryDir)) return [];
  return readdirSync(libraryDir)
    .filter((entry) => statSync(join(libraryDir, entry)).isDirectory())
    .filter((entry) => existsSync(join(libraryDir, entry, "script.txt")))
    .map(readPack);
}

function startAssetServer() {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const target = url.searchParams.get("u") ?? "";
    const trimmed = target.replace(/^https:\/\/[^/]+\//, "");
    for (const candidate of [join(assetsRoot, trimmed), join(assetsRoot, decodeURIComponent(trimmed))]) {
      if (candidate.startsWith(assetsRoot) && existsSync(candidate) && statSync(candidate).isFile()) {
        res.writeHead(200, { "Content-Type": types[extname(candidate)] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" });
        res.end(readFileSync(candidate));
        return;
      }
    }
    fetch(target, { headers: { "User-Agent": "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)", Referer: "https://prts.wiki/" } })
      .then(async (upstreamRes) => {
        res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" });
        res.end(Buffer.from(await upstreamRes.arrayBuffer()));
      })
      .catch(() => res.writeHead(502).end("fetch failed"));
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port })));
}

const packs = listPacks();
const firstTitle = title || JSON.parse(packs[0]?.files["pack.json"] ?? "{}").id;
const harnessHtml = `<!doctype html><meta charset="utf-8"><title>arkstage web-run</title>
<style>html,body{margin:0;background:#000}#stage{width:1280px;height:720px}#report{position:fixed;right:0;top:0;color:#0f0;font:11px monospace;background:#000a;padding:4px;white-space:pre-wrap;z-index:9}</style>
<div id="stage"></div><pre id="report">boot</pre>
<pre id="datas_txt" hidden></pre>
<script>
// 浏览器里没有 prts-cdn:// 协议；把它改写成 HTTP 的 /prts/<host>/<path>
// （等价于 Tauri 的协议处理器；Tauri 内运行时不需要这一步）。
(() => {
  const PROXY = /^(prts-cdn:\/\/localhost|http:\/\/prts-cdn\.localhost)\//;
  const map = (url) => PROXY.test(url) ? location.origin + '/prts/' + url.replace(PROXY, '').split('?')[0] : url;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string') return originalFetch(map(input), init);
    if (input && typeof input === 'object' && 'url' in input && PROXY.test(input.url)) {
      return originalFetch(new Request(map(input.url), input), init);
    }
    return originalFetch(input, init);
  };
  const XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends XHR {
    open(method, url, ...rest) { return super.open(method, map(String(url)), ...rest); }
  };
  for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
    if (descriptor?.set) Object.defineProperty(proto, 'src', {
      get: descriptor.get,
      set(value) { descriptor.set.call(this, map(String(value))); },
    });
  }
})();
</script>
<script type="module">
const report = { title: ${JSON.stringify(firstTitle)}, frames: 0, audit: null, manifest: null, errors: [] };
window.__report = report;
try {
  const { loadStoryRuntime } = await import('/src/lib/predownload.ts');
  const { bootEngineInFrame } = await import('/src/lib/engineBoot.ts');
  const runtime = await loadStoryRuntime(report.title);
  report.source = runtime.source;
  report.scriptLines = runtime.story.script.split('\\n').length;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:1280px;height:720px;border:0;display:block;background:#000';
  document.getElementById('stage').appendChild(iframe);
  const mode = new URLSearchParams(location.search).get('mode') === 'manifest' ? 'manifest' : 'play';
  const boot = await bootEngineInFrame({ iframe, bundle: runtime.bundle, script: runtime.story.script, title: report.title, mode });
  report.manifest = boot.manifest?.length ?? 0;
  report.health = boot.health ?? null;
  if (mode === 'play') {
    const doc = iframe.contentDocument;
    const canvas = () => doc.querySelector('canvas');
    const clickCanvas = () => {
      const target = canvas();
      if (!target) return;
      const box = target.getBoundingClientRect();
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: box.width / 2, clientY: box.height / 2 }));
      }
    };
    for (let round = 0; round < 400; round += 1) {
      const labels = [...doc.querySelectorAll('button')].map((el) => (el.textContent || '').trim()).filter(Boolean);
      const options = [...doc.querySelectorAll('button')].filter((el) => /跟着她走|先问清楚/.test(el.textContent || ''));
      if (options.length) {
        report.choicePanel = labels;
        report.choiceRounds = (report.choiceRounds ?? 0) + 1;
        options[(report.choiceRounds - 1) % options.length].click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const mode = [...doc.querySelectorAll('button')].find((el) => /^(继续|跳过剧情)$/.test((el.textContent || '').trim()));
      if (mode) mode.click();
      else clickCanvas();
      report.frames += 1;
      const text = doc.querySelector('.story-player')?.innerText ?? '';
      report.lastText = text.slice(-120);
      if (/明白了/.test(text)) { report.reachedEnd = true; if (round > 12) break; }
      await new Promise((resolve) => setTimeout(resolve, 110));
    }
    report.dialogue = doc.querySelector('.story-player')?.innerText?.slice(-160) ?? null;
  }
} catch (error) {
  report.errors.push(String(error && error.stack || error));
}
window.__done = true;
</script>`;

const { server: vite, port } = await startVite({ html: harnessHtml });
const assets = await startAssetServer();

const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 780 } });
  page.on("pageerror", (error) => console.log("[pageerror]", String(error.stack ?? error).split("\n").slice(0, 2).join(" | ")));
  await page.goto(`http://127.0.0.1:${port}/${argv.includes("--manifest") ? "?mode=manifest" : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__done === true", null, { timeout: 120000 });
  const report = await page.evaluate(() => window.__report);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 1));
  await page.screenshot({ path: resolve(outPath.replace(/\.json$/, ".png")) }).catch(() => {});
  console.log(JSON.stringify(report, null, 1));
} finally {
  await browser.close();
  await assets.server.close();
  await vite.close();
}

/** Vite dev server rooted at frontend/, with the harness + probe channels. */
async function startVite({ html }) {
  const server = await createServer({
    root: resolve("frontend"),
    configFile: false,
    server: { host: "127.0.0.1", port: 5199, strictPort: true, fs: { allow: [process.cwd()] } },
    plugins: [
      {
        name: "fanfic-proxy-transport",
        transform(code, id) {
          if (id.endsWith("/lib/proxy.ts")) {
            return code
              .replaceAll('"http://prts-cdn.localhost"', "`${location.origin}/proxy`")
              .replaceAll('"prts-cdn://localhost"', "`${location.origin}/proxy`");
          }
          return undefined;
        },
      },
      {
        name: "fanfic-harness",
        configureServer(dev) {
          dev.middlewares.use((req, res, next) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (url.pathname === "/") {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(html);
              return;
            }
            if (url.pathname === "/__local-library.json") {
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify({ packs: packs.map(({ id, files }) => ({ id, files })), upstream: upstream ? { story: upstream.story, bundle: upstream.bundle } : null }));
              return;
            }
            if (url.pathname.startsWith("/proxy/")) {
              const target = "https://" + url.pathname.slice("/proxy/".length) + url.search;
              const trimmed = target.replace(/^https:\/\/[^/]+\//, "");
              for (const candidate of [join(assetsRoot, trimmed), join(assetsRoot, decodeURIComponent(trimmed))]) {
                if (existsSync(candidate) && statSync(candidate).isFile()) {
                  res.setHeader("Content-Type", types[extname(candidate)] ?? "application/octet-stream");
                  res.setHeader("Access-Control-Allow-Origin", "*");
                  res.end(readFileSync(candidate));
                  return;
                }
              }
              fetch(target, { headers: { "User-Agent": "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)", Referer: "https://prts.wiki/" } })
                .then(async (upstreamRes) => {
                  res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" });
                  res.end(Buffer.from(await upstreamRes.arrayBuffer()));
                })
                .catch(() => res.writeHead(502).end("failed"));
              return;
            }
            if (url.pathname === "/__asset") {
              const target = url.searchParams.get("u") ?? "";
              const trimmed = target.replace(/^https:\/\/[^/]+\//, "");
              res.setHeader("Access-Control-Allow-Origin", "*");
              for (const candidate of [join(assetsRoot, trimmed), join(assetsRoot, decodeURIComponent(trimmed))]) {
                if (existsSync(candidate) && statSync(candidate).isFile()) {
                  res.setHeader("Content-Type", types[extname(candidate)] ?? "application/octet-stream");
                  res.end(readFileSync(candidate));
                  return;
                }
              }
              fetch(target, { headers: { "User-Agent": "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)", Referer: "https://prts.wiki/" } })
                .then(async (upstreamRes) => {
                  res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" });
                  res.end(Buffer.from(await upstreamRes.arrayBuffer()));
                })
                .catch(() => res.writeHead(502).end("failed"));
              return;
            }
            next();
          });
        },
      },
    ],
  });
  await server.listen();
  return { server, port: server.config.server.port };
}
