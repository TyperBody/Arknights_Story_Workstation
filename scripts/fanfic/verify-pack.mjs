// 端到端「点击 + 截图」复核：把本地剧本包喂给应用的播放链路
// （loadStoryRuntime → bootStoryPlayer，"play" 模式），在 headless Chromium 里
// 点过每一帧、抓下每一帧的 `#dialog_output` 文本，并把选到的分支与截图落盘。
//
//   node scripts/fanfic/verify-pack.mjs --library example/library --assets build/fanfic/assets \
//        --upstream build/fanfic/upstream.json --out build/fanfic/verify [--player-bar hide|auto|show]
//
// `--player-bar` 预置 localStorage 的 `prts-player-chrome`（custom 模式：本
// 探针里 localStorage 常不可用，走 `page.addInitScript` 前先 setItem 的注入）。
// `--pack-assets`（默认开）把包内 `<pack>/assets/**` 通过 `/pack-asset/<pack>/<name>`
// 供给 `setSyntheticResolver`——与应用里 `pack_asset_path` → `asset://` 等价；
// 报告里给出 `packLocal hits` / `missing`（自带素材覆盖率）。
//
// 输出：verify/<packId>/{report.json,frames.json(旧),shots/*.png}；退出码非 0 = 没跑通。
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const argv = process.argv.slice(2);
/** `--flag value`：末尾的裸开关（`--assets`）返回 fallback，不吞掉下一个开关。 */
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
};
const libraryDir = resolve(arg("--library", "example/library"));
const assetsRoot = resolve(arg("--assets", "build/fanfic/assets"));
const upstreamPath = resolve(arg("--upstream", "build/fanfic/upstream.json"));
const outDir = resolve(arg("--out", "build/fanfic/verify"));
const chromiumPath = arg("--chromium", process.env.CHROMIUM_PATH || "/snap/bin/chromium");
const maxFrames = Number(arg("--frames", 120));
const choicePick = Number(arg("--choice", "0")); // 选第 N 个选项（0/1…）
const playerBar = arg("--player-bar", ""); // show | auto | hide（默认不动设置）
const servePackAssets = !argv.includes("--no-pack-assets"); // 包内 assets/ → synthetic resolver
/** `--no-overlay`：把 Rust 覆盖层名单当空（验证 `asset://` 回落路径仍可用）。 */
const useOverlay = !argv.includes("--no-overlay");
/** `--local-broken`：包内素材「取不到」（/overlay 与 /pack-asset 都 404）→
 *  引擎只能走网络。负例：门禁的「自带素材走了网络 = FAIL」必须因此触发。 */
const localBroken = argv.includes("--local-broken");

const types = { ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".ttf": "font/ttf", ".webp": "image/webp" };
const upstream = existsSync(upstreamPath) ? JSON.parse(readFileSync(upstreamPath, "utf8")) : null;
/** 所有 /proxy 与 /pack-asset 请求路径（顺序保留，报告里给出前 60 条）。 */
const require$routeLog = [];
/** 自带素材路由的命中/未命中（`--assets` 之外的另一条通路）。 */
const packHits = new Set();
const packMisses = new Set();
/** `--assets` 镜像命中（PRTS 贴图仍可走镜像，用于对比）。 */
let mirrorHits = 0;
/** 覆盖层（prts-cdn 协议第 1 步的等价物）命中/未命中。 */
const overlayHits = [];
const overlayMisses = [];
/** packId → 该包自带素材的 canonical key 集合（`build/assets.local.json`）。 */
const packLocalAssets = new Map();
/** 网络（/proxy 且非镜像）取走的 pack-local key —— 自带素材**不该**走这里。 */
const networkFetch = [];

function readPack(id) {
  const root = join(libraryDir, id);
  const files = {};
  const binaries = [];
  const walk = (base, prefix = "") => {
    for (const entry of readdirSync(join(root, base))) {
      const path = join(root, base, entry);
      if (statSync(path).isDirectory()) walk(join(base, entry), `${prefix}${entry}/`);
      else if (/\.(png|jpg|mp3|ttf|webp)$/i.test(entry)) binaries.push(`${prefix}${entry}`);
      else files[`${prefix}${entry}`] = readFileSync(path, "utf8");
    }
  };
  walk(".");
  const local = new Map();
  try {
    const table = JSON.parse(files["build/assets.local.json"] ?? "{}");
    for (const key of Object.keys(table)) local.set(canonicalKeyOf(key), table[key]);
  } catch {
    // 没有映射表 = 这个包不带素材
  }
  packLocalAssets.set(id, local);
  return { id, root, files, binaries, local };
}

/** 覆盖层清单：`<resources>/assets/sample/bundles.json`（与 Rust seed 的是同一份）。
 *  期望它与「已装包的自带素材表」一致；不一致时按包内相对路径回退。 */
const bundlesPath = resolve("src-tauri/resources/assets/sample/bundles.json");
const bundledFiles = existsSync(bundlesPath)
  ? JSON.parse(readFileSync(bundlesPath, "utf8"))
  : {};
/** 这个 canonical URL 是不是某个已装包**自带**的 key（自带却走网络 = 门禁 FAIL）。 */
function packLocalKey(targetUrl) {
  for (const pack of packs) {
    const local = packLocalAssets.get(pack.id);
    if (local?.has(canonicalKeyOf(targetUrl))) return `${pack.id}:${canonicalKeyOf(targetUrl)}`;
  }
  return null;
}
/** `host/path`（去 scheme/query），与 Rust `media::canonical_key` 一致。 */
function canonicalKeyOf(raw) {
  let value = String(raw ?? "").trim();
  for (const scheme of ["https://", "http://"]) if (value.startsWith(scheme)) value = value.slice(scheme.length);
  const path = value.split("?")[0].split("#")[0];
  const slash = path.indexOf("/");
  if (slash === -1) return "";
  return `${path.slice(0, slash).toLowerCase()}${path.slice(slash)}`;
}
/** 覆盖层命中 → 包内相对路径（优先 bundles.json 的文件名，其次 assets.local.json）。 */
function overlayFileFor(pack, key) {
  const fromBundles = bundledFiles[key];
  if (typeof fromBundles === "string" && !fromBundles.includes("/")) {
    for (const rel of [`assets/${fromBundles}`, fromBundles]) {
      if (existsSync(join(pack.root, rel))) return rel;
    }
  }
  try {
    const map = JSON.parse(pack.files["build/assets.local.json"] ?? "{}");
    if (typeof map[key] === "string") return map[key];
  } catch { /* 忽略 */ }
  return null;
}

const packs = existsSync(libraryDir)
  ? readdirSync(libraryDir)
    .filter((entry) => statSync(join(libraryDir, entry)).isDirectory())
    .filter((entry) => existsSync(join(libraryDir, entry, "script.txt")))
    .map(readPack)
  : [];
if (!packs.length) {
  console.error(`no packs in ${libraryDir}`);
  process.exit(2);
}

/** 覆盖层名单（= Rust `bundled_asset_keys()`）：bundles.json 里的 canonical key。 */
const overlayKeys = useOverlay ? Object.keys(bundledFiles) : [];
const harness = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}#stage{width:1280px;height:720px}iframe{width:1280px;height:720px;border:0;background:#000;display:block}</style>
<div id="stage"></div><pre id="report" style="position:fixed;right:0;top:0;color:#0f0;font:10px monospace;background:#000a;padding:3px"></pre>
<script type="module">
const frames = [];
window.__frames = frames;
window.__run = async (title) => {
  const { loadStoryRuntime } = await import('/src/lib/predownload.ts');
  const { bootEngineInFrame } = await import('/src/lib/engineBoot.ts');
  if (window.__playerBar) localStorage.setItem('prts-player-chrome', window.__playerBar);
  const packAssets = await window.__installPackAssets();
  const runtime = await loadStoryRuntime(title);
  document.getElementById('stage').dataset.title = title;
  const iframe = document.createElement('iframe');
  document.getElementById('stage').appendChild(iframe);
  window.__iframe = iframe;
  window.__trace.push({ step: 'before-boot', id: (await import('/src/lib/packAssets.ts')).activePackId(), resolved: (await import('/src/lib/packAssets.ts')).packAssetResolvedCount() });
  window.__trace.push({ step: 'runtime-source', source: runtime.source });
  await bootEngineInFrame({ iframe, bundle: runtime.bundle, script: runtime.story.script, title, mode: 'play' });
  return { source: runtime.source, packAssets };
};
/** 覆盖层命中的 key：解析结果必须**逐字符等于** proxy 重写结果（即「没重写」）。 */
window.__resolveProbe = async () => {
  const { resolvePackAsset, overlayUrlFor } = await import('/src/lib/packAssets.ts');
  const out = { resolved: 0, rewrote: [], overlayMismatch: [] };
  for (const key of window.__overlayKeys ?? []) {
    const canonical = 'https://' + key;
    const resolved = resolvePackAsset(canonical);
    if (resolved) out.resolved += 1;
    if (resolved && resolved.indexOf('/pack-asset/') !== -1) out.rewrote.push(key);
    if (resolved && resolved !== overlayUrlFor(key)) out.overlayMismatch.push({ key, resolved });
  }
  return out;
};
window.__choice = ${choicePick};
window.__playerBar = ${JSON.stringify(playerBar)};
/** 自带素材（pack-local）表 -> packAssets.setSyntheticResolver（等价 Tauri 的
 * pack_asset_path -> asset://，这里用 dev server 的 /pack-asset/ route）。 */
window.__installPackAssets = async () => {
  const { preparePackAssets } = await import('/src/lib/localStories.ts');
  const { activePackId, setSyntheticResolver, setOverlayKeys, setOverlayBase, overlayUrlFor, packAssetCount, packAssetResolvedCount } =
    await import('/src/lib/packAssets.ts');
  // 等价 Rust 命令 bundled_asset_keys：本 dev server 的 /overlay/<canonical key>
  // 直接给包内字节（应用里由 \`prts-cdn://\` 协议做同一件事）。
  const overlay = ${JSON.stringify(overlayKeys)};
  window.__overlayKeys = overlay;
  setOverlayBase(overlay.length ? location.origin + '/overlay' : null);
  setOverlayKeys(overlay.length ? overlay : null);
  const title = document.getElementById('stage')?.dataset.title ?? '';
  const registered = await preparePackAssets(title);
  window.__trace = [{ step: 'prepared', registered, resolved: packAssetResolvedCount() }];
  // 绝对 URL：Pixi 的图片 Worker 有自己的 realm，相对路径在 WorkerGlobalScope 里
  // 无法解析（asset: 协议在应用内本来就是绝对的）。
  setSyntheticResolver((packId, name) => location.origin + '/pack-asset/' + encodeURIComponent(packId) + '/' + name.split('/').map(encodeURIComponent).join('/'));
  // 覆盖层命中时应当**没有**被重写成别的 URL（worker 也能取 prts-cdn://）。
  window.__overlayUrls = overlay.map((key) => overlayUrlFor(key));
  window.__trace.push({ step: 'resolver', id: activePackId(), resolved: packAssetResolvedCount() });
  return { ok: registered > 0, id: activePackId(), registered, resolved: packAssetResolvedCount() };
};
window.__packAssetStats = async () => {
  const mod = await import('/src/lib/packAssets.ts');
  return { registered: mod.packAssetCount(), resolved: mod.packAssetResolvedCount(), local: mod.packAssetLocalCount(), misses: mod.packAssetMissCount(), urls: mod.packAssetUrlTable() };
};
/** iframe 内带 pack key 的 fetch 实际落到了哪里（local = shim 命中）。 */
window.__iframeNetwork = () => {
  try {
    const w = window.__iframe.contentWindow;
    return {
      hasShim: typeof w.__arkstagePackAsset === "function",
      tableSize: w.__arkstagePackTableSize ?? 0,
      tableKeys: Object.keys(w.__arkstagePackAssets ?? {}).length,
    };
  } catch (error) { return { error: String(error) }; }
};
/** 直接验证 iframe realm 里的自带素材替换链（不用等引擎跑到某一帧）。 */
window.__packAssetProbe = async () => {
  try {
    const w = window.__iframe.contentWindow;
    const url = "https://torappu.prts.wiki/assets/avg/background/bg_black.png";
    const out = { shim: typeof w.__arkstagePackAsset === "function" ? w.__arkstagePackAsset(url) : null, srcAfter: null, fetchUrl: null, fetchError: null };
    const img = new w.Image();
    img.src = url;
    out.srcAfter = img.src;
    try {
      const response = await w.fetch(url);
      out.fetchUrl = response.url ?? null;
      out.fetchOk = response.ok;
    } catch (error) { out.fetchError = String(error); }
    return out;
  } catch (error) { return { error: String(error) }; }
};
window.__playerChromeState = () => {
  try {
    const doc = window.__iframe.contentDocument;
    const cards = [...doc.querySelectorAll('.story-player > .n-card')];
    const bar = cards.find((el) => el.getAttribute('aria-label') === '播放控制') ?? cards.at(-1) ?? null;
    const style = bar ? getComputedStyle(bar) : null;
    return { bars: cards.length, label: bar?.getAttribute('aria-label') ?? null, display: style?.display ?? null, opacity: style?.opacity ?? null, hiddenClass: bar?.classList.contains('ark-chrome-hidden') ?? null, htmlClass: doc.documentElement.className };
  } catch (error) { return { error: String(error) }; }
};
window.__probeDecisionOffer = () => {
  try {
    const raw = window.__iframe.contentWindow.document.getElementById("datas_txt")?.textContent ?? "";
    const match = raw.match(/\[\s*Decision[^(]*\(([^)]*)\)/i);
    const label = match && match[1].match(/options\s*=\s*"([^"]*)"/);
    if (label) return label[1].split(";").map((item) => item.trim());
  } catch (error) { /* fall through */ }
  return [];
};
const TOOLBAR = new Set(["继续", "跳过剧情", "手动", "自动", "快速", "全屏", "文本", "导出", "反馈", "播放速度", "返回"]);
window.__options = () => {
  const doc = window.__iframe.contentDocument;
  const panel = doc.querySelector(".story-player");
  return [...(panel ? panel.querySelectorAll("button, .n-button") : doc.querySelectorAll("button, .n-button"))]
    .filter((el) => {
      const box = el.getBoundingClientRect();
      const label = (el.textContent || "").trim();
      return box.width > 4 && box.height > 4 && label;
    });
};
window.__choices = () => {
  const decision = window.__decisionButtons().map((el) => (el.textContent || "").trim()).filter(Boolean);
  if (decision.length >= 2) return decision;
  return window.__options()
    .map((el) => (el.textContent || "").trim())
    .filter((label) => !TOOLBAR.has(label) && !/^\d+\s*档$/.test(label));
};
window.__advance = () => {
  const doc = window.__iframe.contentDocument;
  const button = window.__options().find((el) => /^(继续|跳过剧情)$/.test((el.textContent || "").trim()));
  if (button) { button.click(); return "button"; }
  const canvas = doc.querySelector("canvas");
  if (canvas) {
    const box = canvas.getBoundingClientRect();
    const x = box.width / 2;
    const y = box.height / 2;
    for (const type of ["pointerdown", "pointerup", "click"]) {
      try { canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, isPrimary: true, pointerId: 1, pointerType: "mouse" })); }
      catch { canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })); }
    }
    return "canvas";
  }
  return null;
};
window.__player = () => window.__iframe.contentWindow?.__arkstageApp?.getPlayer?.() ?? null;
/** 找到上游的「决策面板」：可见 + 至少 2 个同级可点按钮。 */
window.__decisionButtons = () => {
  const doc = window.__iframe.contentDocument;
  const panel = doc.querySelector(".story-player") ?? doc;
  const groups = new Map();
  for (const el of panel.querySelectorAll("button, .n-button")) {
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    const key = Math.round(box.left) + ":" + Math.round(box.width);
    groups.set(key, [...(groups.get(key) ?? []), el]);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  return best.length >= 2 ? best : [];
};
window.__clickCanvas = () => {
  const canvas = window.__iframe.contentDocument.querySelector("canvas");
  if (!canvas) return false;
  const box = canvas.getBoundingClientRect();
  for (const type of ["pointerdown", "pointerup", "click"]) {
    try { canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: box.width / 2, clientY: box.height / 2, isPrimary: true, pointerId: 1, pointerType: "mouse" })); }
    catch { canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: box.width / 2, clientY: box.height / 2 })); }
  }
  return true;
};
// 预置「决策策略」：引擎在 decision 指令处直接取用，等价于玩家点了第 N 项
// （应用自身也用这个 API 做 seek 回放，reference/branching.md §3）。
window.__arm = () => {
  const player = window.__player();
  if (!player || typeof player.setDecisionPolicy !== "function" || window.__armed) return;
  window.__armed = true;
  player.setDecisionPolicy(() => window.__choice);
};
window.__step = async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 130));
  await settle();
  window.__arm();
  const record = { text: "", dialogue: "", selections: [], state: null, line: null };
  const player = window.__player();
  try {
    record.state = player?.getState?.() ?? null;
    record.line = player?.getDisplayedLineIndex?.() ?? null;
    record.selections = player?.getLogPosition?.()?.selections ?? [];
  } catch (error) { record.playerError = String(error); }
  record.dialogue = (window.__iframe.contentDocument.querySelector("#dialog_output")?.textContent ?? "").slice(-70);
  window.__advance();
  await settle();
  frames.push(record);
  return record;
};
</script>`;

const vite = await createServer({
  root: resolve("frontend"),
  configFile: false,
  // `watch: null`：探针不需要 HMR，而每个 inotify 实例都吃 `fs.inotify.
  // max_user_instances`（本机 128；跑几趟原生测试后会 EMFILE）。
  server: { host: "127.0.0.1", port: 5201, strictPort: true, fs: { allow: [process.cwd()] }, watch: null },
  plugins: [
    {
      name: "fanfic-proxy",
      transform(code, id) {
        if (id.endsWith("/lib/proxy.ts")) {
          return code.replaceAll('"http://prts-cdn.localhost"', "`${location.origin}/proxy`").replaceAll('"prts-cdn://localhost"', "`${location.origin}/proxy`");
        }
        return undefined;
      },
    },
    {
      name: "fanfic-harness",
      configureServer(dev) {
        dev.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(harness); return; }
          if (url.pathname === "/__local-library.json") {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ packs: packs.map(({ id, files }) => ({ id, files })), upstream: upstream ? { story: upstream.story, bundle: upstream.bundle } : null }));
            return;
          }
          // 包内自带素材：/pack-asset/<packId>/<相对路径>（等价 Tauri 的
          // pack_asset_path -> asset://<abs>）。
          if (url.pathname.startsWith("/pack-asset/") || url.pathname.startsWith("/proxy/") || url.pathname.startsWith("/overlay/")) {
            try { require$routeLog.push(url.pathname); } catch { /* ignore */ }
          }
          // 覆盖层：prts-cdn:// 协议的「第 1 步」（Rust 侧读
          // <资源目录>/assets/sample/bundles.json）——canonical key → 包内同名文件。
          if (url.pathname.startsWith("/overlay/")) {
            const key = decodeURIComponent(url.pathname.slice("/overlay/".length));
            for (const pack of packs) {
              const file = Object.entries(pack.files).find(([, text]) => typeof text === "string" && text.includes(key));
              const rel = overlayFileFor(pack, key);
              const candidate = rel && !localBroken ? join(pack.root, rel) : null;
              if (candidate && candidate.startsWith(pack.root) && existsSync(candidate) && statSync(candidate).isFile()) {
                overlayHits.push(key);
                res.setHeader("Content-Type", types[extname(candidate)] ?? "application/octet-stream");
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Cache-Control", "no-store");
                res.end(readFileSync(candidate));
                return;
              }
              void file;
            }
            overlayMisses.push(key);
            // 应用里 `prts-cdn://` 覆盖层落空后会**继续在线取**（协议的第 3 步）。
            // 探针照抄这条链路：pack-local 的 key 落到网络即记 `networkFetch`
            // ——门禁据此判定「自带素材走了网络」。
            if (packLocalKey(`https://${key}`)) networkFetch.push(`https://${key}`);
            res.writeHead(404).end(localBroken ? "broken overlay (negative test)" : "not in the overlay");
            return;
          }
          if (url.pathname.startsWith("/pack-asset/")) {
            const rest = decodeURIComponent(url.pathname.slice("/pack-asset/".length));
            const slash = rest.indexOf("/");
            const id = rest.slice(0, slash);
            const name = rest.slice(slash + 1);
            const pack = packs.find((candidate) => candidate.id === id || candidate.files["pack.json"]?.includes(`"id": "${id}"`));
            const candidate = pack ? join(pack.root, name) : null;
            if (servePackAssets && !localBroken && candidate?.startsWith(pack.root) && existsSync(candidate) && statSync(candidate).isFile()) {
              packHits.add(`${id}/${name}`);
              res.setHeader("Content-Type", types[extname(candidate)] ?? "application/octet-stream");
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.setHeader("Cache-Control", "no-store");
              res.end(readFileSync(candidate));
              return;
            }
            packMisses.add(`${id}/${name}`);
            res.writeHead(404).end("not a pack-local asset");
            return;
          }
          if (url.pathname.startsWith("/proxy/")) {
            const target = `https://${url.pathname.slice("/proxy/".length)}`;
            const trimmed = target.replace(/^https:\/\/[^/]+\//, "");
            if (packLocalKey(target)) networkFetch.push(target);
            res.setHeader("Access-Control-Allow-Origin", "*");
            for (const candidate of [join(assetsRoot, trimmed), join(assetsRoot, decodeURIComponent(trimmed))]) {
              if (existsSync(candidate) && statSync(candidate).isFile()) {
                mirrorHits += 1;
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

const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
mkdirSync(outDir, { recursive: true });
let failures = 0;
try {
  for (const pack of packs) {
    const meta = JSON.parse(pack.files["pack.json"] ?? "{}");
    const id = meta.id ?? pack.id;
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error.message ?? error)));
    await page.goto(`http://127.0.0.1:${vite.config.server.port}/`, { waitUntil: "domcontentloaded" });
    const boot = await page.evaluate((title) => window.__run(title), id).catch((error) => ({ error: String(error) }));
    // 首帧后 3.5s 再取一次底栏状态（`auto` 模式需要 3 秒空闲才淡出）。
    await page.waitForTimeout(playerBar === "auto" ? 3600 : 300);
    const chromeEarly = await page.evaluate(() => window.__playerChromeState()).catch(() => null);
    const shots = join(outDir, id, "shots");
    mkdirSync(shots, { recursive: true });
    const frames = [];
    // 首帧先等玩家面板就绪
    await page.waitForTimeout(1200);
    for (let index = 0; index < maxFrames; index += 1) {
      const frame = await page.evaluate(() => window.__step()).catch(() => null);
      if (!frame) break;
      frames.push(frame);
      const changed = index === 0 || frame.dialogue !== frames.at(-2)?.dialogue || frame.state !== frames.at(-2)?.state;
      if (changed) await page.screenshot({ path: join(shots, `${String(index).padStart(3, "0")}_${frame.state ?? "x"}.png`), clip: { x: 0, y: 0, width: 1280, height: 720 } }).catch(() => {});
      if (/明白了/.test(frames.map((item) => item.dialogue).join("")) && index > 8) break;
    }
    const offered = frames.filter((frame) => frame.offered?.length).map((frame, index) => ({ at: index, labels: frame.offered }));
    const picked = frames.map((frame) => frame.picked).filter(Boolean);
    void picked;
    const packStats = await page.evaluate(() => window.__packAssetStats()).catch(() => null);
    const trace = await page.evaluate(() => window.__trace ?? []).catch(() => []);
    const iframeNetwork = await page.evaluate(() => window.__iframeNetwork()).catch(() => []);
    const packProbe = await page.evaluate(() => window.__packAssetProbe()).catch(() => null);
    // 覆盖层命中的 key：解析结果必须逐字符等于「未重写」（= `prts-cdn://<key>`）。
    const resolveProbe = overlayKeys.length
      ? await page.evaluate(() => window.__resolveProbe()).catch(() => null)
      : null;
    const chrome = await page.evaluate(() => window.__playerChromeState()).catch(() => null);
    // 写一张工具栏截图（`--player-bar hide` 时证明白条消失）。
    await page.screenshot({ path: join(outDir, id, `player-bar-${playerBar || "unset"}.png`), clip: { x: 0, y: 620, width: 1280, height: 100 } }).catch(() => {});
    const result = {
      pack: pack.id,
      packAssets: packStats ? { registered: packStats.registered, resolved: packStats.resolved, local: packStats.local, misses: packStats.misses } : null,
      packAssetRoute: { hits: [...packHits], missing: [...packMisses] },
      overlay: { keys: overlayKeys.length, hits: [...new Set(overlayHits)], missing: [...new Set(overlayMisses)] },
      networkFetch: [...new Set(networkFetch)],
      mirrorHits,
      playerBar: playerBar || "unset",
      chrome: chrome ?? chromeEarly,
      trace,
      iframeNetwork,
      packProbe,
      resolveProbe,
      routeLog: require$routeLog.slice(0, 60),
      title: id,
      boot,
      frames: frames.length,
      offered,
      picked,
      errors,
      states: [...new Set(frames.map((frame) => frame.state).filter(Boolean))],
      dialogues: [...new Set(frames.map((frame) => frame.dialogue).filter(Boolean))],
      lines: [...new Set(frames.map((frame) => frame.line).filter((line) => line !== null))].sort((a, b) => a - b),
      maxLine: frames.reduce((max, frame) => Math.max(max, frame.line ?? -1), -1),
      selections: [...new Map(frames.flatMap((frame) => frame.selections ?? []).map((item) => [JSON.stringify(item), item])).values()],
      lastText: frames.at(-1)?.text ?? "",
    };
    writeFileSync(join(outDir, id, "report.json"), JSON.stringify({ result, frames }, null, 1));
    console.log(JSON.stringify({
      pack: result.pack,
      source: boot?.source ?? null,
      frames: frames.length,
      dialogues: result.dialogues,
      lines: result.lines,
      selections: result.selections,
      picked: result.picked,
      states: result.states,
      maxLine: result.maxLine,
      selections: result.selections,
      errors: result.errors,
      packAssets: result.packAssets,
      packAssetRoute: { hits: result.packAssetRoute.hits.length, missing: result.packAssetRoute.missing.length },
      // 自带素材的**本地命中**（`/overlay` = Rust prts-cdn 覆盖层，`/pack-asset`
      // = `asset://` 回落）+ 走网络的数量（必须为 0）。
      packLocal: {
        hits: result.packAssetRoute.hits.length + result.overlay.hits.length,
        missing: result.packAssetRoute.missing.length + result.overlay.missing.length,
        overlay: result.overlay.hits.length,
        asset: result.packAssetRoute.hits.length,
        network: result.networkFetch.length,
      },
      overlay: { keys: result.overlay.keys, hits: result.overlay.hits.length, missing: result.overlay.missing },
      networkFetch: result.networkFetch.length,
      playerBar: result.playerBar,
      chrome: result.chrome,
    }, null, 1));
    if (boot?.error || errors.length) failures += 1;
    // 自带素材声称覆盖时：① 每个 key 都要被真的取到（包内路由或 Rust 覆盖层），
    // ② **一个都不许走网络**（`/proxy` 兜底 fetch 到 pack-local key = FAIL）。
    if (result.packAssets && result.packAssets.registered > 0) {
      const served = new Set([...result.packAssetRoute.hits, ...result.overlay.hits]);
      if (result.packAssetRoute.missing.length) { console.error(`pack-local missing: ${result.packAssetRoute.missing.join(", ")}`); failures += 1; }
      if (!served.size) { console.error("pack-local assets were never requested"); failures += 1; }
      if (result.overlay.keys && !result.overlay.hits.length && result.packAssetRoute.hits.length) {
        console.error("overlay (prts-cdn) served nothing — the transport fell back to asset://");
        failures += 1;
      }
      if (result.overlay.missing.length) {
        console.error(`overlay missing: ${result.overlay.missing.slice(0, 8).join(", ")}`);
        failures += 1;
      }
      if (result.overlay.keys && result.networkFetch.length) {
        console.error("pack-local key reached the network (gate)");
      }
      // 负例自证：`--local-broken` 必须让上面两条中的至少一条报错。
      if (localBroken && !failures) {
        console.error("--local-broken produced no failure — the network gate is asleep");
        failures += 1;
      }
      if (result.networkFetch.length) {
        console.error(`pack-local keys fetched over the network: ${result.networkFetch.slice(0, 8).join(", ")}`);
        failures += 1;
      }
      if (!result.overlay.keys && !result.packAssetRoute.hits.length) {
        console.error("--no-overlay: asset:// fallback served nothing");
        failures += 1;
      }
      if (result.overlay.keys) {
        // 覆盖层命中 = 「保留 prts-cdn:// 原样」（不重写成 asset://），
        // 这正是 Worker 能取到、原生 WebKit 不再 Load failed 的充要条件。
        const probe = result.resolveProbe;
        if (!probe || probe.overlayMismatch.length || probe.resolved !== result.overlay.keys || probe.rewrote.length) {
          console.error(`overlay rewrite mismatch: ${JSON.stringify(probe)}`);
          failures += 1;
        }
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
process.exit(failures ? 1 : 0);
