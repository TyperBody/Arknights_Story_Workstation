// 真引擎预览 + 真实指针：用 /_t1-preview/* 的探针（结构照抄 build/ed-preview-check.mjs）。
import { createServer } from "vite";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
const require = createRequire("/home/typer/桌面/galArkn/arkstage/");
const { chromium } = require("playwright-core");

const ROOT = "/home/typer/桌面/galArkn/arkstage";
process.chdir(ROOT);
const libraryDir = resolve("example/library");
const upstream = JSON.parse(readFileSync("build/fanfic/upstream.json", "utf8"));
function readPack(id) {
  const files = {};
  const walk = (base, prefix = "") => {
    for (const entry of readdirSync(join(libraryDir, id, base))) {
      const path = join(libraryDir, id, base, entry);
      if (statSync(path).isDirectory()) walk(join(base, entry), `${prefix}${entry}/`);
      else if (!/\.(png|jpg|mp3|ttf|webp)$/i.test(entry)) files[`${prefix}${entry}`] = readFileSync(path, "utf8");
    }
  };
  walk(".");
  return { id, files };
}
const packs = readdirSync(libraryDir).filter((e) => statSync(join(libraryDir, e)).isDirectory()).map(readPack);
const probeBody = JSON.stringify({ packs, upstream: { story: upstream.story, bundle: upstream.bundle } });

const server = await createServer({
  root: resolve("frontend"),
  configFile: resolve("frontend/vite.config.ts"),
  server: { host: "127.0.0.1", port: 5191, strictPort: true },
  plugins: [
    { name: "probe", configureServer(dev) { dev.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/__local-library.json") {
        res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(probeBody); return;
      }
      if (url.pathname.startsWith("/proxy/")) {
        const target = "https://" + url.pathname.slice("/proxy/".length) + url.search;
        fetch(target, { headers: { Referer: "https://prts.wiki/" } })
          .then(async (up) => { res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" }); res.end(Buffer.from(await up.arrayBuffer())); })
          .catch(() => res.writeHead(502).end("fetch failed"));
        return;
      }
      next();
    }); } },
    { name: "proxy-transport", transform(code, id) {
      if (id.endsWith("/lib/proxy.ts")) return code.replaceAll('"http://prts-cdn.localhost"', "`${location.origin}/proxy`").replaceAll('"prts-cdn://localhost"', "`${location.origin}/proxy`");
      return undefined; } },
  ],
});
await server.listen();

const text = readFileSync("example/library/fanfic-demo/script.txt", "utf8").split("\n").slice(0, 12).join("\n");
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  await page.goto(`http://127.0.0.1:5191/editor/fanfic-demo?text=${encodeURIComponent(text)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ed-textarea");
  await page.waitForTimeout(2000);
  // 先把 preview Map 打开（点工具栏「预览」= Map 开关），再点「开演」按钮
  const openMap = page.locator('button[title^="预览 = Map"]').first();
  if (await openMap.count()) await openMap.click().catch(() => {});
  await page.waitForTimeout(500);
  const runBtn = page.locator('button[title^="用当前编辑内容直接开演整篇"]').first();
  console.log("buttons:", await runBtn.count());
  await runBtn.evaluate((el) => el.click()).catch((e) => console.log("clickErr", String(e).slice(0, 80)));
  let state = null;
  for (let i = 0; i < 60; i += 1) {
    state = await page.evaluate(() => {
      const frame = document.querySelector('iframe[title="剧本预览"]');
      const inner = frame && frame.contentDocument;
      const bottom = inner && inner.querySelector('.story-player > .n-card[aria-label="播放控制"]');
      const r = bottom ? bottom.getBoundingClientRect() : null;
      return {
        status: document.querySelector(".ed-preview-bar .grow")?.textContent ?? document.querySelector("[class*=preview]")?.textContent?.slice(0, 40) ?? "",
        hasFrame: Boolean(frame),
        hasBottom: Boolean(bottom),
        cards: inner ? Array.from(inner.querySelectorAll(".story-player > .n-card")).map((n) => ({ label: n.getAttribute("aria-label"), cls: n.className })) : [],
        rootCls: inner ? inner.documentElement.className : null,
        bottomCls: bottom?.className ?? null,
        opacity: bottom ? getComputedStyle(bottom).opacity : null,
        rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      };
    });
    if (state.hasBottom) break;
    await page.waitForTimeout(1000);
  }
  console.log("FIRST:", JSON.stringify(state));
  const frameBox = await page.locator('iframe[title="剧本预览"]').boundingBox();
  console.log("frameBox:", JSON.stringify(frameBox));
  const read = () => page.evaluate(() => {
    const frame = document.querySelector('iframe[title="剧本预览"]');
    const inner = frame && frame.contentDocument;
    const bottom = inner && inner.querySelector('.story-player > .n-card[aria-label="播放控制"]');
    return { cls: bottom?.className ?? null, opacity: bottom ? getComputedStyle(bottom).opacity : null, root: inner?.documentElement.className ?? null };
  });
  // 记录 iframe 里的指针事件序列，便于解释「移出后是否收起」。
  await page.evaluate(() => {
    const frame = document.querySelector('iframe[title="剧本预览"]');
    const inner = frame && frame.contentDocument;
    if (!inner) return;
    window.__trace = [];
    for (const type of ["pointermove", "pointerover", "pointerout", "pointerleave"]) {
      inner.addEventListener(type, (event) => {
        window.__trace.push({
          type, y: Math.round(event.clientY), tx: Math.round(event.clientX),
          target: (event.target?.className || event.target?.tagName || "").toString().slice(0, 28),
          related: (event.relatedTarget?.className || event.relatedTarget?.tagName || "").toString().slice(0, 28),
          open: inner.documentElement.classList.contains("ark-chrome-open"),
        });
      }, true);
    }
  });
  if (state.rect && frameBox) {
    const cx = frameBox.x + state.rect.x + state.rect.w / 2;
    const cy = frameBox.y + state.rect.y + state.rect.h / 2;
    const topY = frameBox.y + 15;
    await page.mouse.move(cx, topY); await page.waitForTimeout(500);
    const above = await read();
    await page.mouse.move(cx, cy, { steps: 5 }); await page.waitForTimeout(500);
    const over = await read();
    await page.mouse.move(cx, frameBox.y + state.rect.y - 20, { steps: 3 }); await page.waitForTimeout(300);
    const justAboveEdge = await read();
    await page.mouse.move(cx, topY, { steps: 3 }); await page.waitForTimeout(600);
    const after = await read();
    console.log("REAL:", JSON.stringify({ above, over, justAboveEdge, after }, null, 1));
    const trace = (await page.evaluate(() => window.__trace ?? [])).slice(-24);
    console.log("TRACE:", trace.map((r) => `${r.type} y=${r.y} t=${r.target} rel=${r.related} open=${r.open}`).join("\n  "));
  }
  await page.screenshot({ path: "/tmp/_t1-real-preview.png" });
} finally {
  await browser.close();
  await server.close();
}
