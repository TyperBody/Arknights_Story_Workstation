import { chromium } from "playwright-core";
import { createServer } from "vite";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve, extname } from "node:path";
const assetsRoot = resolve("build/fanfic/assets");
const upstream = JSON.parse(readFileSync("build/fanfic/upstream.json", "utf8"));
const types = { ".png": "image/png", ".mp3": "audio/mpeg", ".ttf": "font/ttf" };
// 只放“自带流程”的最小目录：样例包（无 build/runtime.json）
const libDir = resolve("build/fanfic/.libprobe");
rmSync(libDir, { recursive: true, force: true });
mkdirSync(join(libDir, "sample-fanfic"), { recursive: true });
cpSync(resolve("src-tauri/resources/library/sample-fanfic/pack.json"), join(libDir, "sample-fanfic/pack.json"));
cpSync(resolve("src-tauri/resources/library/sample-fanfic/script.txt"), join(libDir, "sample-fanfic/script.txt"));
const files = () => ({ "pack.json": readFileSync(join(libDir, "sample-fanfic/pack.json"), "utf8"), "script.txt": readFileSync(join(libDir, "sample-fanfic/script.txt"), "utf8") });
const vite = await createServer({ root: resolve("frontend"), configFile: false, server: { host: "127.0.0.1", port: 5251, strictPort: true, fs: { allow: [process.cwd()] } }, plugins: [
  { name: "px", transform(code, id) { if (id.endsWith("/lib/proxy.ts")) return code.replaceAll('"http://prts-cdn.localhost"', "`${location.origin}/proxy`").replaceAll('"prts-cdn://localhost"', "`${location.origin}/proxy`"); } },
  { name: "h", configureServer(d) { d.middlewares.use((req, res, next) => { const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/") { res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html><div id=stage></div><pre id=out style="color:#0f0"></pre><script type=module>
      const log = []; const P = (s) => { log.push(s); document.getElementById('out').textContent = log.join("\\n").slice(-2000); };
      const { loadBundle } = await import('/src/lib/predownload.ts');
      try { const b = await loadBundle(); P("loadBundle ok, story_player=" + Boolean(b.story_player) + " modules=" + (b.story_player ? Object.keys(b.story_player.modules).length : 0)); }
      catch (e) { P("loadBundle FAIL: " + (e && e.message)); }
      const { loadStoryRuntime } = await import('/src/lib/predownload.ts');
      try { const rt = await loadStoryRuntime('sample-fanfic'); P("runtime ok: source=" + rt.source + " lines=" + rt.story.script.split("\\n").length); }
      catch (e) { P("runtime FAIL: " + (e && e.message)); }
      window.__log = log; window.__done = true;</script>`); return; }
    if (u.pathname === "/__local-library.json") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ packs: [{ id: "sample-fanfic", files: files() }], upstream: { story: upstream.story, bundle: upstream.bundle } })); return; }
    if (u.pathname.startsWith("/proxy/")) { const t = "https://" + u.pathname.slice(7); const tr = t.replace(/^https:\/\/[^/]+\//, "");
      for (const c of [join(assetsRoot, tr), join(assetsRoot, decodeURIComponent(tr))]) if (existsSync(c) && statSync(c).isFile()) { res.setHeader("Content-Type", types[extname(c)] ?? "application/octet-stream"); res.end(readFileSync(c)); return; }
      fetch(t, { headers: { "User-Agent": "Arkstage/1.2.0", "Referer": "https://prts.wiki/" } }).then(async r => { res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/octet-stream" }); res.end(Buffer.from(await r.arrayBuffer())); }).catch(() => res.writeHead(502).end()); return; }
    next(); }); } } ]});
await vite.listen();
const b = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 160)));
await p.goto("http://127.0.0.1:5251/", { waitUntil: "domcontentloaded" });
await p.waitForFunction("window.__done === true", null, { timeout: 180000 }).catch(() => console.log("(timeout)"));
console.log((await p.evaluate(() => window.__log))?.join("\n"));
await b.close(); await vite.close();
