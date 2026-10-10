// 严格 CSP 复现：应用（Tauri）把 tauri.conf.json 的 CSP 原样写进响应头，所以
// 这里也用同一份 CSP 服务一个页面，再驱动 `bootEngineInFrame()`。用来定位
// 「StoryPlayer 模块执行失败」这类只在严格 CSP 下出现的启动问题（行内 blob 模块、
// WebGL 探测等）。
//
//   node scripts/fanfic/web-run.mjs --csp            # 带应用同款 CSP
//   node scripts/fanfic/web-run.mjs                  # 不带 CSP（对照）
//
// 依赖 vite + playwright-core；浏览器用 CHROMIUM_PATH（默认 /snap/bin/chromium）。
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const useCsp = argv.includes("--csp");
const strictCsp = argv.includes("--strict-csp");
const inlineOnly = argv.includes("--inline-only");
const widget = arg("--widget", "file");           // "file" = 构建好的前端；"inline" = 行内脚本
const libraryDir = resolve(arg("--library", "example/library"));
const upstreamPath = resolve(arg("--upstream", "build/fanfic/upstream.json"));
const assetsRoot = resolve(arg("--assets", "build/fanfic/assets"));
const outPath = resolve(arg("--out", useCsp ? "build/fanfic/web-csp.json" : "build/fanfic/web-nocsp.json"));
const chromiumPath = arg("--chromium", process.env.CHROMIUM_PATH || "/snap/bin/chromium");

const upstream = existsSync(upstreamPath) ? JSON.parse(readFileSync(upstreamPath, "utf8")) : null;
const types = { ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".ttf": "font/ttf", ".webp": "image/webp", ".css": "text/css" };

function readPack(id) {
  const root = join(libraryDir, id);
  const files = {};
  const list = (base, prefix = "") => {
    for (const name of readdirSync(join(root, base))) {
      const path = join(root, base, name);
      if (statSync(path).isDirectory()) list(join(base, name), `${prefix}${name}/`);
      else if (!/\.(png|jpg|mp3|ttf|webp)$/i.test(name)) files[`${prefix}${name}`] = readFileSync(path, "utf8");
    }
  };
  list(".");
  return { id, files };
}

const packs = existsSync(libraryDir)
  ? readdirSync(libraryDir)
    .filter((name) => statSync(join(libraryDir, name)).isDirectory())
    .map(readPack)
  : [];
const title = JSON.parse(packs[0]?.files["pack.json"] ?? "{}").id ?? packs[0]?.id;
const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const csp = config.app.security.csp;

// 与 Tauri 宿主一致的引导方式（两种都试）：
//  file   —— Tauri 打包后的前端：<script type="module" src="/assets/index-*.js">（有 CSP nonce?）
//  inline —— 手写 <script type="module"> 行内引导（部分 WebView 上会被 CSP 拦）
const html = `<!doctype html><meta charset="utf-8"><title>csp probe</title>
<style>html,body{margin:0;background:#000;color:#0f0;font:12px monospace}#stage{width:1280px;height:720px}</style>
<div id="stage"></div><pre id="report">boot</pre>
<script>window.__log = [];window.onerror=(m)=>window.__log.push("onerror: "+m);</script>
${widget === "inline"
  ? `<script type="module">
const log = window.__log;
try {
  const { loadStoryRuntime } = await import('/src/lib/predownload.ts');
  const { bootEngineInFrame } = await import('/src/lib/engineBoot.ts');
  const runtime = await loadStoryRuntime(${JSON.stringify(title)});
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:1280px;height:720px;border:0;background:#000';
  document.getElementById('stage').appendChild(iframe);
  const boot = await bootEngineInFrame({ iframe, bundle: runtime.bundle, script: runtime.story.script, title: ${JSON.stringify(title)}, mode: 'manifest' });
  log.push("manifest=" + (boot.manifest?.length ?? 0));
} catch (error) { log.push("fatal: " + String(error && error.stack || error)); }
window.__done = true;
</script>`
  : `<script type="module" src="/src/csp-probe.ts"></script>`}
`;

writeFileSync("frontend/src/csp-probe.ts", `import { bootEngineInFrame } from "./lib/engineBoot";
import { loadStoryRuntime } from "./lib/predownload";

declare global { interface Window { __log: string[]; __done?: boolean } }
window.__log = [];
try {
  const runtime = await loadStoryRuntime(window.__spTitle ?? "");
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "width:1280px;height:720px;border:0;background:#000";
  document.getElementById("stage")?.appendChild(iframe);
  if (window.__forceInline) iframe.contentWindow && Object.assign(iframe.contentWindow, { __arkstageForceInline: true });
  const boot = await bootEngineInFrame({ iframe, bundle: runtime.bundle, script: runtime.story.script, title: window.__spTitle ?? "", mode: "manifest" });
  window.__log.push("manifest=" + (boot.manifest?.length ?? 0));
} catch (error) {
  window.__log.push("fatal: " + String((error as Error)?.stack ?? error));
}
window.__done = true;
declare global { interface Window { __spTitle?: string; __forceInline?: boolean } }
`);

const vite = await createServer({
  root: resolve("frontend"),
  configFile: false,
  server: { host: "127.0.0.1", port: 5233, strictPort: true, fs: { allow: [process.cwd()] } },
  plugins: [
    {
      name: "csp-proxy",
      transform(code, id) {
        if (id.endsWith("/lib/proxy.ts")) {
          return code.replaceAll('"http://prts-cdn.localhost"', "`${location.origin}/proxy`").replaceAll('"prts-cdn://localhost"', "`${location.origin}/proxy`");
        }
        return undefined;
      },
    },
    {
      name: "csp-harness",
      configureServer(dev) {
        dev.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const headers = { "Content-Type": "text/html; charset=utf-8" };
          if (useCsp) headers["Content-Security-Policy"] = strictCsp
            ? csp.replace("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://code.jquery.com",
                          "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:")
            : csp;
          if (url.pathname === "/") {
            res.writeHead(200, headers);
            res.end(html.replace("<script type=\"module\" src=\"/src/csp-probe.ts\"></script>",
              `<script>window.__spTitle=${JSON.stringify(title)};window.__forceInline=${inlineOnly};</script><script type="module" src="/src/csp-probe.ts"></script>`));
            return;
          }
          if (url.pathname === "/__local-library.json") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ packs: packs.map(({ id, files }) => ({ id, files })), upstream: upstream ? { story: upstream.story, bundle: upstream.bundle } : null }));
            return;
          }
          if (url.pathname.startsWith("/proxy/")) {
            const target = `https://${url.pathname.slice("/proxy/".length)}`;
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
await vite.listen();

const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let report;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 780 } });
  const console_ = [];
  page.on("console", (message) => console_.push(`[${message.type()}] ${message.text()}`.slice(0, 300)));
  page.on("pageerror", (error) => console_.push(`[pageerror] ${String(error).slice(0, 300)}`));
  await page.goto(`http://127.0.0.1:${vite.config.server.port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__done === true", null, { timeout: 120000 }).catch(() => {});
  report = await page.evaluate(() => ({ log: window.__log, done: window.__done ?? false }));
  report.console = console_.slice(0, 40);
} finally {
  await browser.close();
  await vite.close();
}
mkdirSync(resolve(outPath, ".."), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ csp: useCsp, widget, log: report.log, console: report.console.slice(0, 8) }, null, 1));
