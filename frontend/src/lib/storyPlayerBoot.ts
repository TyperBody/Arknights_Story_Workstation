import type { FrameBootOptions, FrameBootResult } from "./engineBoot";
import { captureIframe, pushLog } from "./debugLog";
import { PROXY_BASE, discoverAssetDomains, proxyUrl, rewriteAllCdnUrls } from "./proxy";
import { packAssetCount, packAssetMissCount, packAssetShimAvailable, packAssetShimCode, resolvePackAsset as resolvePackAssetLive } from "./packAssets";
import { getPlayerChrome, type PlayerChrome } from "./uiSettings";
import { adaptStoryPlayerEntry, prepareModule, storyPlayerStaticAssets, validateStoryPlayer, type StoryPlayerSnapshot } from "./storyPlayerAdapter";

interface PlayerContext { script: string[] | Record<string, unknown>[]; scriptText: string; linkMap: Record<string, unknown> }
interface StoryPlayerWindow extends Window {
  __arkstageAPI?: {
    loadContext: (script: string) => Promise<PlayerContext>;
    collectManifest: (context: PlayerContext, lines?: readonly unknown[]) => { urls: string[] };
  };
  /** 上游的「脚本 → 行数组」解析函数（适配器在入口模块里就地导出）。 */
  __arkstageParse?: (script: string) => Record<string, unknown>[];
  __arkstageMount?: () => void;
  __arkstageApp?: { getPlayer: () => { getState: () => string; destroy: () => void } | null };
  __arkstageVueApp?: { unmount: () => void };
  __arkstageDispose?: () => void;
  mw?: unknown;
}

/** UTF-8 安全的 `data:text/javascript;base64,…`。 */
function dataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return `data:text/javascript;base64,${btoa(binary)}`;
}

/**
 * 上游的 `__vitePreload` 会给每个 chunk 插 `<link rel="modulepreload">`；把它的
 * `href` 换成已在 import map 里的 blob URL，即可让严格 CSP 下的 WebView（Windows
 * WebView2）不再拦截，并且预加载的仍是**同一份**模块对象。
 */
function installPreloadRewrite(
  win: StoryPlayerWindow,
  doc: Document,
  snapshot: StoryPlayerSnapshot,
  domains: string[],
  options: { play: boolean; imports: Record<string, string>; blobFor: (url: string) => string | undefined }
): void {
  const rewrite = (href: string): string | null => {
    const canonical = slugMatch(href, snapshot.modules);
    if (!canonical) return null;
    return options.blobFor(canonical) ?? null;
  };
  // ① 已有的 <link rel=modulepreload>（例如注入 HTML 里就带的）
  for (const link of Array.from(doc.querySelectorAll('link[rel="modulepreload"]'))) {
    const next = rewrite(link.getAttribute("href") ?? "");
    if (next) link.setAttribute("href", next);
  }
  // ② 之后动态插入的：劫持 appendChild/insertBefore，改完 href 再插入
  const realm = win as unknown as Window & typeof globalThis;
  const proto = realm.Element.prototype;
  const originalAppend = proto.appendChild;
  const originalInsert = proto.insertBefore;
  const fix = (node: Node): Node => {
    if (node instanceof realm.HTMLLinkElement) {
      const link = node as HTMLLinkElement;
      if (link.rel === "modulepreload") {
        const next = rewrite(link.getAttribute("href") ?? "");
        if (next) link.setAttribute("href", next);
      }
    }
    return node;
  };
  proto.appendChild = function (this: Element, node: Node) {
    return originalAppend.call(this, fix(node));
  } as typeof proto.appendChild;
  proto.insertBefore = function (this: Element, node: Node, ref: Node | null) {
    return originalInsert.call(this, fix(node), ref);
  } as typeof proto.insertBefore;
  void domains;
}

/**
 * 「播放器底栏」（引擎 `.story-player > .n-card[aria-label="播放控制"]`，上游
 * `index.vue` 的 `<NCard aria-label="播放控制">`）的三种模式：
 * - `show`：默认显示；
 * - `hide`：`display:none`；
 * - `auto`：3 秒无操作淡出、指针/按键活动恢复（`.ark-chrome-hidden`）。
 * 监听挂在 iframe 的 `document` 上——那个 realm 才是用户真正交互的地方。
 */
function installPlayerChrome(win: StoryPlayerWindow, mode: PlayerChrome): void {
  if (mode === "show") return;
  const doc = win.document;
  const HIDDEN = "ark-chrome-hidden";
  const BUTTON = "[aria-label=\"播放控制\"]";
  if (mode === "hide") {
    // 静态隐藏：一个类即可（样式在 layout 里），不必监听。
    doc.documentElement.classList.add("ark-chrome-hide");
    doc.querySelectorAll(".story-player > .n-card").forEach((node) => {
      if (node.matches(BUTTON) || !node.querySelector("button")) node.classList.add(HIDDEN);
    });
    return;
  }
  const reveal = () => {
    doc.querySelectorAll(`.story-player > .n-card.${HIDDEN}`).forEach((node) => node.classList.remove(HIDDEN));
    clearTimeout(timer);
    timer = setTimeout(() => {
      // 面板上仍有指针/焦点（例如正在调播放速度）就不要收。
      const card = doc.querySelector(`.story-player > .n-card${BUTTON}`);
      if (card && (card.matches(":hover") || card.contains(doc.activeElement))) return;
      card?.classList.add(HIDDEN);
    }, 3000);
  };
  let timer = setTimeout(reveal, 3000);
  const events: Array<keyof DocumentEventMap> = ["pointermove", "pointerdown", "keydown", "touchstart", "wheel"];
  for (const name of events) doc.addEventListener(name, reveal, { passive: true });
  // 首次挂载后立即进入「3 秒后隐藏」的节奏。
  reveal();
}

/** iframe realm 内的自带素材替换：`fetch` / `Image.src` / `setAttribute` / Audio。 */
function installPackAssetTransport(
  win: StoryPlayerWindow,
  doc: Document,
  shim: string,
  liveResolve: (url: string) => string | null,
): void {
  const realm = win as unknown as typeof globalThis & { __arkstagePackAssetRun?: boolean };
  if (!realm.__arkstagePackAssetRun) {
    realm.__arkstagePackAssetRun = true;
    const script = doc.createElement("script");
    script.textContent = shim;
    (doc.head ?? doc.documentElement).appendChild(script);
  }
  /** 表：`canonical key → 可播放 URL`（由注入的 shim 建立；可能尚未执行）。 */
  const packTable = (): Record<string, string> | null =>
    (realm as unknown as { __arkstagePackAssets?: Record<string, string> }).__arkstagePackAssets ?? null;
  /** 末段文件名兜底：Pixi/上游偶尔传的是已改写过的绝对 URL 或相对路径。 */
  const resolveByFileName = (value: string): string | null => {
    const name = value.split("?")[0].split("#")[0].split("/").pop() ?? "";
    if (!name || !name.includes(".")) return null;
    const table = packTable();
    if (!table) return null;
    for (const [key, url] of Object.entries(table)) if (key.endsWith(`/${name}`)) return url;
    return null;
  };
  const resolve = (value: unknown): string | null => {
    if (typeof value === "string") {
      const local = liveResolve(value) ?? resolveByFileName(value);
      if (local) return local;
    }
    const fn = (win as unknown as { __arkstagePackAsset?: (input: unknown) => string | null })
      .__arkstagePackAsset;
    if (typeof fn !== "function") return null;
    try {
      return fn(value) ?? null;
    } catch {
      return null;
    }
  };
  const nativeFetch = win.fetch.bind(win);
  const patchSource = (proto: { prototype: object }): void => {
    const desc = Object.getOwnPropertyDescriptor(proto.prototype, "src");
    if (!desc?.set) return;
    Object.defineProperty(proto.prototype, "src", {
      ...desc,
      set(value: string) {
        const local = resolve(value);
        desc.set!.call(this, local ?? value);
      },
    });
  };
  // 1) fetch（Pixi 的主线程 createImageBitmap 路径、字体、JSON 都走这里）
  win.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : "href" in input ? input.href : input.url;
    const local = resolve(raw);
    if (local) return nativeFetch(local, init);
    return nativeFetch(input, init);
  };
  // 2) `img.src = url`（Pixi 在 createImageBitmap 不可用时也走这里）
  patchSource(realm.HTMLImageElement);
  patchSource(realm.HTMLSourceElement);
  patchSource(realm.HTMLMediaElement);
  const setAttribute = realm.Element.prototype.setAttribute;
  realm.Element.prototype.setAttribute = function (name: string, value: string) {
    if (name.toLowerCase() === "src") {
      const local = resolve(value);
      if (local) return setAttribute.call(this, name, local);
    }
    return setAttribute.call(this, name, value);
  };
  // 3) Pixi 的纹理加载器：`Assets.load` 之前把 URL 换成本地文件。
  //    （`window.PIXI` 在模块执行后才出现，所以这里拦 `Assets.load` 而不是构造。）
  type PixiLike = { Assets?: { load?: (...args: unknown[]) => unknown } };
  const patchPixi = () => {
    const pixi = (win as unknown as { PIXI?: PixiLike }).PIXI;
    const load = pixi?.Assets?.load;
    if (!load || (load as { __arkstagePatched?: boolean }).__arkstagePatched) return;
    const wrapped = function (this: unknown, first: unknown, ...rest: unknown[]) {
      const local = resolve(first);
      return load.call(this, local ?? first, ...rest);
    };
    (wrapped as { __arkstagePatched?: boolean }).__arkstagePatched = true;
    pixi!.Assets!.load = wrapped as typeof load;
  };
  patchPixi();
  // 3b) Pixi 默认 `preferWorkers`：图片 Worker 有自己的 realm，宿主 `fetch`/`Image`
  //     都管不到。上游 Worker 的源码是内联字符串（`loadImageBitmap` 里
  //     `const response = await fetch(url);`），在 `new Blob([source])` 时改写它：
  //     注入本包的表 + 把 `fetch(url)` 换成查表后的 fetch。
  const table = (realm as unknown as { __arkstagePackAssets?: Record<string, string> }).__arkstagePackAssets ?? {};
  const prelude = `globalThis.__arkstagePackAssets=${JSON.stringify(table)};globalThis.__arkstagePackAsset=function(value){try{var raw=String(value);for(var prefix of ["prts-cdn://localhost/","http://prts-cdn.localhost/"])if(raw.indexOf(prefix)===0)raw=raw.slice(prefix.length);for(var scheme of ["https://","http://"])if(raw.indexOf(scheme)===0)raw=raw.slice(scheme.length);var path=raw.split("?")[0].split("#")[0];return globalThis.__arkstagePackAssets[path]||null}catch(error){return null}};`;
  const rewriteWorkerSource = (source: string): string => {
    if (!source.includes("loadImageBitmap")) return source;
    const patched = source
      .replaceAll(
        "const response = await fetch(url);",
        "const __arkstageLocal = globalThis.__arkstagePackAsset && globalThis.__arkstagePackAsset(url);\n      const response = await fetch(__arkstageLocal || url);",
      )
      .replaceAll(
        "let t=await(await fetch(e)).blob()",
        "let t=await(await fetch((globalThis.__arkstagePackAsset&&globalThis.__arkstagePackAsset(e))||e)).blob()",
      );
    return `${prelude}${patched}`;
  };
  const NativeBlob = realm.Blob;
  const BlobProxy = new Proxy(NativeBlob as unknown as typeof Blob, {
    construct(target, args: unknown[]) {
      const parts = args[0] as BlobPart[] | undefined;
      if (Array.isArray(parts) && parts.some((part) => typeof part === "string" && part.includes("loadImageBitmap"))) {
        args = [parts.map((part) => (typeof part === "string" ? rewriteWorkerSource(part) : part)), args[1]];
      }
      return Reflect.construct(target, args);
    },
  });
  try {
    realm.Blob = BlobProxy as unknown as typeof Blob;
  } catch {
    // 兜底：host fetch/Image 补丁仍在。
  }
  // 上游是异步 chunk：模块执行后再补一次（`window.PIXI` 只有部分构建会挂）。
  win.setTimeout(patchPixi, 0);
  win.setTimeout(patchPixi, 250);
  // 4) Pixi 的图片 Worker（`preferWorkers` 默认开）有自己的 realm，宿主 fetch 管不到：
  //    在把 URL 发给 Worker 之前替换（`WorkerManager._next` 的消息形状是
  //    `{ data: [url, alphaMode], uuid, id }`）。
  type WorkerCtor = { prototype: { postMessage: (message: unknown, transfer?: unknown) => void } };
  const WorkerClass = (realm as unknown as { Worker?: WorkerCtor }).Worker;
  if (WorkerClass?.prototype?.postMessage) {
    const postMessage = WorkerClass.prototype.postMessage;
    WorkerClass.prototype.postMessage = function (this: unknown, message: unknown, transfer?: unknown) {
      try {
        // Shape: `{ data: [url, alphaMode], uuid, id }` (WorkerManager._next).
        const args = (message as { data?: unknown })?.data;
        if (Array.isArray(args) && typeof args[0] === "string") {
          const local = resolve(args[0]) ?? resolveByFileName(args[0]);
          if (local) args[0] = local;
        }
      } catch {
        // 保持原消息
      }
      return postMessage.call(this, message, transfer);
    };
  }
}
function slugMatch(href: string, modules: Record<string, string>): string | null {
  if (modules[href]) return href;
  const name = href.split("?")[0].split("/").pop();
  if (!name) return null;
  for (const url of Object.keys(modules)) if (url.endsWith(`/${name}`)) return url;
  return null;
}

/** Pixi and HTML audio can assign src directly instead of calling fetch. */
function installMediaTransport(win: StoryPlayerWindow, domains: string[]): void {
  const realm = win as unknown as typeof globalThis;
  /** 末段文件名兜底（`img.src` 可能已是改写后的绝对 URL）。 */
  const suffix = (value: string): string | null => {
    const name = value.split("?")[0].split("#")[0].split("/").pop() ?? "";
    const table = (win as unknown as { __arkstagePackAssets?: Record<string, string> }).__arkstagePackAssets;
    if (!name || !name.includes(".") || !table) return null;
    for (const [key, url] of Object.entries(table)) if (key.endsWith(`/${name}`)) return url;
    return null;
  };
  // Pack-local keys must win over the `prts-cdn:` rewrite; otherwise shipped art
  // would be shadowed by the media store / network.
  const route = (value: string): string => {
    const local = resolvePackAssetLive(String(value)) ?? suffix(value);
    if (local) return local;
    return proxyUrl(String(value), domains);
  };
  for (const proto of [realm.HTMLImageElement.prototype, realm.HTMLMediaElement.prototype, realm.HTMLSourceElement.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, "src");
    if (desc?.set) Object.defineProperty(proto, "src", { ...desc, set(value: string) { desc.set!.call(this, route(String(value))); } });
  }
  const setAttribute = realm.Element.prototype.setAttribute;
  realm.Element.prototype.setAttribute = function(name, value) {
    return setAttribute.call(this, name, name.toLowerCase() === "src" ? route(String(value)) : value);
  };
  realm.Audio = new Proxy(realm.Audio, { construct(target, args) {
    return Reflect.construct(target, args.length ? [route(String(args[0]))] : []);
  } });
}

export function disposeEngineFrame(iframe: HTMLIFrameElement): void {
  const win = iframe.contentWindow as StoryPlayerWindow | null;
  win?.__arkstageDispose?.();
  iframe.contentDocument?.querySelectorAll("audio,video").forEach((el) => (el as HTMLMediaElement).pause());
}

export async function bootStoryPlayer(opts: FrameBootOptions): Promise<FrameBootResult> {
  const snapshot = opts.bundle.story_player!;
  const problems = validateStoryPlayer(snapshot);
  if (problems.length) throw new Error(problems.join("；"));
  const doc = opts.iframe.contentDocument;
  const win = opts.iframe.contentWindow as StoryPlayerWindow | null;
  if (!doc || !win) throw new Error("StoryPlayer iframe unavailable");
  const domains = discoverAssetDomains(...Object.values(snapshot.modules), ...Object.values(snapshot.styles));
  // 自带素材（`build/assets.local.json`）：可以解析成 iframe realm 也要用的静态表
  const packAssetsShim = opts.mode === "play" && packAssetShimAvailable() ? packAssetShimCode() : null;
  const cancelled = () => opts.isCancelled?.() || !opts.iframe.isConnected;
  const blobUrls: string[] = []; // 兼容：历史上是 blob:，现在模块走 data:
  /** entry URL → 已重写的源码；行内注入优先用它（blob: 在部分 WebView2 上被拦）。 */
  const moduleSources = new Map<string, string>();
  const sourceFor = (url: string) => moduleSources.get(url);
  // 自带素材的静态表：包内文件优先于任何网络/缓存路径。
  const packLocalUrl = (value: unknown): string | null => {
    if (!packAssetsShim) return null;
    if (typeof value === "string") {
      const local = resolvePackAssetLive(value);
      if (local) return local;
    }
    const fn = (win as unknown as { __arkstagePackAsset?: (input: unknown) => string | null }).__arkstagePackAsset;
    if (typeof fn !== "function") return null;
    try { return fn(value) ?? null; } catch { return null; }
  };
  let disposed = false;
  win.__arkstageDispose = () => {
    if (disposed) return;
    disposed = true;
    // Vue's unmount hook owns player.destroy(); do not destroy it twice.
    if (win.__arkstageVueApp) win.__arkstageVueApp.unmount();
    else win.__arkstageApp?.getPlayer()?.destroy();
    blobUrls.forEach((url) => URL.revokeObjectURL(url));
  };
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><pre id="datas_txt" hidden></pre></body></html>');
  doc.close();
  doc.title = opts.title;
  doc.getElementById("datas_txt")!.textContent = opts.script;
  win.mw = { config: { get: (key: string) => key === "wgUserName" ? localStorage.getItem("prts-nickname") : null } };
  captureIframe(win);
  // Pack-local assets first: the shipped copy beats the network for its own keys.
  // Install this BEFORE `installMediaTransport`/the fetch shim so src-rewrites and
  // fetch rewrites consult the pack table (the sequence matters: media transport
  // runs the `prts-cdn:` rewrite, which would otherwise shadow pack keys).
  // 自带素材的注入情况（出问题时是第一条可看的线索）。
  pushLog("info", `[pack-assets] shim=${Boolean(packAssetsShim)} count=${packAssetCount()} miss=${packAssetMissCount()}`);
  if (packAssetsShim) installPackAssetTransport(win, doc, packAssetsShim, resolvePackAssetLive);
  if (opts.mode === "play") installMediaTransport(win, domains);

  // Sidecars come from this verified snapshot; all other fetches use the same
  // cache-through transport as media. Never let mutable JSON bypass the snapshot.
  const nativeFetch = win.fetch.bind(win);
  win.fetch = async (input, init) => {
    // URL/Request instances can belong to the iframe's realm.
    const raw = typeof input === "string" ? input : "href" in input ? input.href : input.url;
    // ① 自带素材：包内文件就是权威来源（早于 sidecar/网络）。
    const local = packLocalUrl(raw);
    if (local) return nativeFetch(local, init);
    const key = Object.keys(snapshot.data).find((url) => url === raw || proxyUrl(url, domains) === raw);
    const value = key ? snapshot.data[key] : undefined;
    if (value) return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    return nativeFetch(typeof input === "string" || "href" in input ? proxyUrl(raw, domains) : new Request(proxyUrl(raw, domains), input), init);
  };

  try {
    const imports: Record<string, string> = {};
    for (const [url, original] of Object.entries(snapshot.modules)) {
      let source = url === snapshot.entry ? adaptStoryPlayerEntry(original) : original;
      source = await prepareModule(source, url, snapshot.modules);
      // Keep URLs in the manifest canonical. Playback source routes image/audio,
      // FontFace and Pixi loaders through the local media protocol.
      if (opts.mode === "play") {
        source = rewriteAllCdnUrls(source, domains);
        // StoryPlayer also builds URLs from a bare TORAPPU_ORIGIN constant.
        // Rewrite that constant before Pixi sends a URL to its image worker;
        // the worker has its own fetch realm and cannot inherit our fetch shim.
        for (const domain of domains) for (const quote of ['"', "'", "`"])
          source = source.replaceAll(`https://${domain}${quote}`, `${PROXY_BASE}/${domain}${quote}`);
      }
      moduleSources.set(url, source);
      // 用 data: URL 而非 blob: —— Windows WebView2 上有 blob 模块 fetch 失败的实例
      // （`resource load failed: blob:…`），data: 在 Chromium/WebKit 上都能取；
      // import map 仍是「一个模块一个 URL」，模块恒等性不变。
      const moduleUrl = dataUrl(source);
      imports[opts.mode === "play" ? proxyUrl(url, domains) : url] = moduleUrl;
    }
    if (cancelled()) { win.__arkstageDispose(); return {}; }
    // 上游 Vue/Pixi 会插入 `<link rel="modulepreload" href=…chunk.js>`；这些 URL
    // 是**未被重写**的绝对地址，在 Window 的严格 CSP 下会被 script-src-elem 拦掉
    // （表现为一串 “CSP blocked script-src-elem” + 第一个 blob 模块加载失败）。
    // 这里把 preload 的 href 换成同一模块的 blob（模块恒等性靠 importmap 保持）。
    installPreloadRewrite(win, doc, snapshot, domains, {
      play: opts.mode === "play",
      imports,
      blobFor: (url) => imports[opts.mode === "play" ? proxyUrl(url, domains) : url],
    });
    const map = document.createElement("script");
    map.type = "importmap";
    map.textContent = JSON.stringify({ imports });
    doc.head.appendChild(map);
    // 注入给模块内 `__arkstageResolve` 查表：上游 Vite 的懒加载 chunk 名 → blob。
    (win as unknown as { __arkstageImports?: Record<string, string> }).__arkstageImports = imports;
    if (opts.mode === "play") {
      for (const [url, source] of Object.entries(snapshot.styles)) {
        const style = doc.createElement("style");
        style.textContent = rewriteAllCdnUrls(source.replace(/url\(\s*(["']?)([^\s)"']+)\1\s*\)/g,
          (_all, _quote, path: string) => `url(${JSON.stringify(new URL(path, url).href)})`), domains);
        doc.head.appendChild(style);
      }
      const chrome = getPlayerChrome();
      const layout = doc.createElement("style");
      layout.textContent = `html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
        .story-player{height:100dvh!important;padding:0!important;gap:0!important}
        .story-player>section{flex:1;min-height:0;max-width:none!important;aspect-ratio:auto!important}
        .story-player>.n-card{flex:none;max-width:none!important;border-radius:0}
        .story-player .n-card__content{padding:6px 10px!important}
        /* 播放器底栏：显示（默认）/ 自动隐藏 / 隐藏 —— 见 uiSettings.ts */
        .story-player>.n-card.ark-chrome-hidden{opacity:0;pointer-events:none;transition:opacity .2s}
        html.ark-chrome-hide .story-player>.n-card[aria-label="播放控制"]{display:none!important}`;
      doc.head.appendChild(layout);
      installPlayerChrome(win, chrome);
    }
    // 逐模块加载时保留失败原因：`<script type="module">` 的 error 事件不带
    // 细节，所以同时挂 window.onerror/unhandledrejection，把真正的原因带回
    // 上层（线上曾出现 Windows WebView2 的「模块执行失败」无从定位）。
    type MarkerWindow = StoryPlayerWindow & { __arkstageModuleDone?: number };
    const online = win as MarkerWindow;
    const moduleErrors: string[] = [];
    const noteModuleError = (event: ErrorEvent | PromiseRejectionEvent) => {
      const detail = "reason" in event ? event.reason : event.error ?? event.message;
      moduleErrors.push(String((detail as Error)?.stack ?? detail).slice(0, 400));
    };
    win.addEventListener("error", noteModuleError as EventListener);
    win.addEventListener("unhandledrejection", noteModuleError as EventListener);
    try {
      // blob 失败过一次就整体改用行内注入（Windows WebView2 上跨 realm 的 blob 模块
      // 会以 error 事件失败；行内注入是等价路径）。
      // blob 优先、失败即整体改行内：blob `<script src>` 在部分 Windows WebView2
      // 上会以 error 事件失败（只留一句「resource load failed: blob:…」）。两条
      // 路径等价（相对导入已绝对化 + import map 保持模块恒等性）。
      let inlineOnly = Boolean((win as unknown as { __arkstageForceInline?: boolean }).__arkstageForceInline);
      let index = 0;
      for (const entry of [...(snapshot.prelude ?? []), snapshot.entry]) {
        index += 1;
        const isEntry = entry === snapshot.entry;
        const src = imports[opts.mode === "play" ? proxyUrl(entry, domains) : entry];
        const viaSrc = async () => {
          if (inlineOnly) throw new Error("inline-only");
          await new Promise<void>((resolve, reject) => {
            const script = doc.createElement("script");
            script.type = "module";
            script.src = src;
            const timer = setTimeout(() => reject(new Error("src timeout")), 15_000);
            script.onload = () => { clearTimeout(timer); resolve(); };
            script.onerror = () => { clearTimeout(timer); reject(new Error("src error event")); };
            doc.body.appendChild(script);
          });
        };
        /** 行内模块：完成哨兵写在模块体末尾；入口模块另有 __arkstageAPI 这个真实信号。 */
        const viaInline = async () => {
          const source = sourceFor(entry);
          if (source === undefined) throw new Error("no inlined source");
          const marker = `__arkstageModuleDone:${index}`;
          const script = doc.createElement("script");
          script.type = "module";
          script.textContent = `${source}\n;globalThis[${JSON.stringify(marker)}]=true;`;
          doc.body.appendChild(script);
          const deadline = Date.now() + (isEntry ? 30_000 : 10_000);
          while (Date.now() < deadline) {
            if (cancelled()) return;
            const done = (online as unknown as Record<string, unknown>)[marker];
            // 入口：API/挂载点已就绪即可（模块可能在 await 自身的懒加载 chunk）。
            if (done || (isEntry && win.__arkstageAPI && win.__arkstageMount)) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (isEntry && win.__arkstageAPI && win.__arkstageMount) return;
          throw new Error("inline timeout");
        };
        try {
          await viaSrc();
        } catch (first) {
          inlineOnly = true;
          try {
            await viaInline();
            pushLog("info", `[StoryPlayer] ${entry.split("/").pop()}: 行内注入（blob 失败：${String(first)}）`);
          } catch (second) {
            const extra = moduleErrors.length ? `（${moduleErrors.slice(0, 2).join(" | ")}）` : "";
            const source = sourceFor(entry) ?? "";
            const hint = source.includes("import(") ? "（模块含动态 import：可能是 chunk 解析失败）" : "";
            pushLog("error", `[StoryPlayer] 模块失败 ${entry} 源长度=${source.length}${hint}`);
            throw new Error(`StoryPlayer 模块执行失败: ${entry} — ${String(first)} / ${String(second)}${extra}${hint}`);
          }
        }
        if (cancelled()) return {};
      }
    } finally {
      win.removeEventListener("error", noteModuleError as EventListener);
      win.removeEventListener("unhandledrejection", noteModuleError as EventListener);
    }
    if (cancelled()) { win.__arkstageDispose(); return {}; }
    if (!win.__arkstageAPI || !win.__arkstageMount) throw new Error("StoryPlayer 接口未初始化");
    // Playback modules return proxy URLs; sidecar lookup must recognize them too.
    const api = win.__arkstageAPI;
    const context = await api.loadContext(opts.script);
    if (Object.keys(context.linkMap).length < 100) throw new Error("StoryPlayer 角色数据未初始化");
    // 上游 collectManifest 期望收到**已解析的行数组**（第二个参数），旧调用只传
    // context 会让它在遍历 `context.scriptText`（字符串）时抛 "not iterable"。
    // 首选用 context.script，其次用引擎入口导出的解析结果，最后退回字节切分。
    const contextLines = context.script;
    const parsedLines: readonly unknown[] = Array.isArray(contextLines) && typeof contextLines[0] === "object"
      ? contextLines
      : typeof win.__arkstageParse === "function"
        ? win.__arkstageParse(opts.script)
        : [];
    const manifest = [...new Set([
      ...api.collectManifest(context, parsedLines).urls,
      ...storyPlayerStaticAssets(snapshot),
    ])];
    const health = { globals: ["StoryPlayer", "loadContext", "collectManifest", "mount"], engineScriptCount: Object.keys(snapshot.modules).length, assetDomains: domains };
    if (opts.mode === "manifest") return { manifest, health };
    win.__arkstageMount();
    // AutoStart creates the renderer before preloading completes. Wait for the
    // runtime to actually start so visible boot errors can trigger rollback.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (cancelled()) { win.__arkstageDispose(); return {}; }
      const state = win.__arkstageApp?.getPlayer()?.getState();
      const alert = doc.querySelector(".story-player > section .n-alert");
      if (alert || state === "error") throw new Error(alert?.textContent || "StoryPlayer 播放初始化失败");
      if (state && state !== "idle") {
        pushLog("info", `[StoryPlayer] ${opts.title}: ${manifest.length} assets, ${health.engineScriptCount} modules`);
        return { health };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("StoryPlayer 资源预加载超时");
  } catch (error) {
    win.__arkstageDispose();
    throw error;
  }
}
