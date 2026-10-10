import { chromium } from "playwright-core";
import { createServer } from "vite";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
const libraryDir = resolve("example/library"), assetsRoot = resolve("build/fanfic/assets");
const upstream = JSON.parse(readFileSync("build/fanfic/upstream.json", "utf8"));
const types = { ".png": "image/png", ".mp3": "audio/mpeg", ".ttf": "font/ttf" };
const files = (root) => { const out = {}; const walk = (b, p = "") => { for (const n of readdirSync(join(root, b))) { const f = join(root, b, n); if (statSync(f).isDirectory()) walk(join(b, n), `${p}${n}/`); else if (!/\.(png|jpg|mp3|ttf|webp)$/i.test(n)) out[`${p}${n}`] = readFileSync(f, "utf8"); } }; walk("."); return out; };
const packs = [{ id: "fanfic-demo", files: files(join(libraryDir, "fanfic-demo")) }];
const vite = await createServer({ root: resolve("frontend"), configFile: false, server: { host: "127.0.0.1", port: 5241, strictPort: true, fs: { allow: [process.cwd()] } }, plugins: [
  { name: "px", transform(code, id) { if (id.endsWith("/lib/proxy.ts")) return code.replaceAll('"http://prts-cdn.localhost"', "`${location.origin}/proxy`").replaceAll('"prts-cdn://localhost"', "`${location.origin}/proxy`"); } },
  { name: "h", configureServer(d) { d.middlewares.use((req, res, next) => { const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/") { res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html><div id=stage></div><pre id=out style="color:#0f0"></pre><script type=module>
      const lines = [];
      const push = (s) => { lines.push(s); document.getElementById('out').textContent = lines.join("\\n").slice(-3000); };
      window.addEventListener('error', (e) => push("WINDOW-ERROR: " + (e.message||'') + " @ " + (e.filename||'') + ":" + (e.lineno||'')), true);
      window.addEventListener('unhandledrejection', (e) => push("REJECTION: " + String(e.reason && e.reason.stack || e.reason)), true);
      const { loadStoryRuntime } = await import('/src/lib/predownload.ts');
      const { bootEngineInFrame } = await import('/src/lib/engineBoot.ts');
      const rt = await loadStoryRuntime('fanfic-demo');
      const f = document.createElement('iframe'); document.getElementById('stage').appendChild(f); window.__f = f;
      // 记录 iframe 的 console
      try { const { pushLog } = await import('/src/lib/debugLog.ts'); } catch {}
      try { await bootEngineInFrame({ iframe: f, bundle: rt.bundle, script: rt.story.script, title: 'fanfic-demo', mode: 'play' }); push("BOOT OK"); }
      catch (e) { push("BOOT FAIL: " + String(e && e.message)); }
      // 把 iframe 的报错也抓出来
      try { f.contentWindow.addEventListener('error', (e) => push("IFRAME-ERROR: " + (e.message||'') + " @ " + (e.filename||'') + ":" + (e.lineno||'')), true); } catch {}
      window.__lines = lines; window.__done = true;</script>`); return; }
    if (u.pathname === "/__local-library.json") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ packs, upstream: { story: upstream.story, bundle: upstream.bundle } })); return; }
    if (u.pathname.startsWith("/proxy/")) { const t = "https://" + u.pathname.slice(7); const tr = t.replace(/^https:\/\/[^/]+\//, "");
      for (const c of [join(assetsRoot, tr), join(assetsRoot, decodeURIComponent(tr))]) if (existsSync(c) && statSync(c).isFile()) { res.setHeader("Content-Type", types[extname(c)] ?? "application/octet-stream"); res.end(readFileSync(c)); return; }
      fetch(t, { headers: { "User-Agent": "Arkstage/1.2.0", "Referer": "https://prts.wiki/" } }).then(async r => { res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/octet-stream" }); res.end(Buffer.from(await r.arrayBuffer())); }).catch(() => res.writeHead(502).end()); return; }
    next(); }); } } ]});
await vite.listen();
const b = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 200)));
await p.goto("http://127.0.0.1:5241/", { waitUntil: "domcontentloaded" });
await p.waitForFunction("window.__done === true", null, { timeout: 120000 }).catch(() => {});
const lines = await p.evaluate(() => window.__lines);
console.log(lines.join("\n"));
mkdirSync("build/fanfic", { recursive: true });
writeFileSync("build/fanfic/blobdbg.json", JSON.stringify(lines, null, 1));
await b.close(); await vite.close();
