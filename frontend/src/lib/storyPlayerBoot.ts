import type { FrameBootOptions, FrameBootResult, WidgetBundle } from "./engineBoot";
import { captureIframe, pushLog } from "./debugLog";
import { getItem } from "./stateStore";
import { PROXY_BASE, discoverAssetDomains, proxyUrl, rewriteAllCdnUrls } from "./proxy";
import { packAssetCount, packAssetMissCount, packAssetShimAvailable, packAssetShimCode, resolvePackAsset as resolvePackAssetLive } from "./packAssets";
import { getPlayerChrome, isPlayerChromeHover, type PlayerChrome } from "./uiSettings";
import {
  announceEngineFailure,
  annotateFallback,
  bundleSource,
  ENGINE_RETRY_DELAYS_MS,
  fallbackSnapshots,
  noteNetworkSuccess,
  pushEngineStatus,
} from "./enginePack";
import {
  adaptStoryPlayerEntry,
  fetchModuleSource,
  prepareModule,
  sourceDataUrl,
  storyPlayerStaticAssets,
  validateStoryPlayer,
  StoryPlayerModuleError,
  type StoryPlayerSnapshot,
} from "./storyPlayerAdapter";

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
 * - `show`：始终显示；
 * - `hide`：`display:none`；
 * - `auto`（默认）：**纯隐藏** —— 初始即收起，指针**移入底栏**才显示、
 *   指针**移出**立即收起；没有「N 秒无操作」定时器。
 * 监听挂在 iframe 的 `document` 上——那个 realm 才是用户真正交互的地方。
 */
/** `auto` 档的根类（CSS 见 `bootOnce` 注入的 layout：`html.ark-chrome-auto…`）。 */
const CHROME_AUTO = "ark-chrome-auto";
/** 「当前展开」根类（`auto` 档）。 */
const CHROME_OPEN = "ark-chrome-open";
/** 收起（隐藏）类：卡片自己带一份，隐藏态的 `pointer-events:none` 也在 CSS 里。 */
const CHROME_HIDDEN = "ark-chrome-hidden";
/** `auto` 且"悬停显示"打开时的根类（`ark-chrome-auto` 之上再加一层）。 */
const CHROME_HOVER = "ark-chrome-hover";

/** 舞台基准分辨率（引擎 `mount()` 就是 `width:1280,height:720`）。 */
const STAGE_W = 1280;
const STAGE_H = 720;

/**
 * **舞台比例（cover）**：铺满容器、按比例放大、多余裁掉 —— 绝不拉伸。
 *
 * 引擎 `mount()` 固定按 1280×720 建帧缓冲（`renderer.resize(1280,720,dpr)`），再把
 * canvas 设成 `width:100%;height:100%` —— **比例完全由父容器决定**。21:9 的预览槽位
 * 里 16:9 的画面就被横向拉长（用户："预览的舞台会扭曲"）。
 *
 * 做法：量 `section` 的可用盒子，算 **cover 盒**
 * （`scale = max(w/1280, h/720)` → `1280·scale × 720·scale`），写进 CSS 变量
 * `--ark-stage-w/h`；canvas/video 的居中定位与尺寸在注入的 CSS 里（`!important`
 * 压过引擎内联值），`overflow:hidden` 裁掉多余部分。`ResizeObserver` +
 * `window.resize` 跟随；引擎异步挂载 → 再用 `MutationObserver` 触发一次重测。
 */
export function installStageFit(win: StoryPlayerWindow, doc: Document): void {
  try {
    const sectionOf = (): HTMLElement | null => doc.querySelector<HTMLElement>(".story-player > section");
    /**
     * ⚠️ canvas/video **不是** `section` 的直接子节点。引擎的 DOM 是
     * ```
     * .story-player > section > div.bg-black(absolute inset-0) > div[hostRef].h-full.w-full > canvas
     * ```
     * （`mount(host)` 把 canvas `append` 进 `hostRef`）。所以必须用**后代**选择器
     * （`section canvas`），并且把盒模型**内联 + `!important`** 写到元素上：引擎自己会写
     * `canvas.style.width='100%'`，`syncDisplayResolution()` 在 dpr 变化时还会再写一次，
     * 只靠 stylesheet 的优先级不够稳。
     */
    const targetsOf = (): HTMLElement[] =>
      Array.from(doc.querySelectorAll<HTMLElement>(".story-player > section canvas, .story-player > section video"));
    const apply = (): void => {
      try {
        const section = sectionOf();
        if (!section) return;
        const w = section.clientWidth;
        const h = section.clientHeight;
        if (!w || !h) return;
        // cover：取大 → 铺满（多余裁掉；若要留黑边则改成 min = contain）
        const scale = Math.max(w / STAGE_W, h / STAGE_H);
        const cw = Math.round(STAGE_W * scale);
        const ch = Math.round(STAGE_H * scale);
        section.style.setProperty("--ark-stage-w", `${cw}px`);
        section.style.setProperty("--ark-stage-h", `${ch}px`);
        for (const node of targetsOf()) {
          const style = node.style;
          style.setProperty("position", "absolute", "important");
          style.setProperty("left", "50%", "important");
          style.setProperty("top", "50%", "important");
          style.setProperty("transform", "translate(-50%, -50%)", "important");
          style.setProperty("width", `${cw}px`, "important");
          style.setProperty("height", `${ch}px`, "important");
          style.setProperty("display", "block", "important");
        }
      } catch {
        // 量不到就保持 100%（旧行为），不影响播放
      }
    };
    const realm = win as unknown as {
      ResizeObserver?: typeof ResizeObserver;
      MutationObserver?: typeof MutationObserver;
    };
    let observer: ResizeObserver | null = null;
    const observe = (): void => {
      const section = sectionOf();
      if (!section || observer || !realm.ResizeObserver) return;
      observer = new realm.ResizeObserver(apply);
      observer.observe(section);
    };
    const tick = (): void => {
      observe();
      apply();
    };
    tick();
    // 引擎异步挂载、全屏切换、dpr 变化都会改 DOM/内联样式 → 每次变动后重新压一遍。
    if (realm.MutationObserver) {
      const mo = new realm.MutationObserver(() => tick());
      mo.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }
    (doc.defaultView ?? win).addEventListener("resize", apply);
    (doc.defaultView ?? win).addEventListener("orientationchange", apply);
  } catch {
    // 舞台比例是"锦上添花"：失败也不该影响播放。
  }
}

function installPlayerChrome(win: StoryPlayerWindow, mode: PlayerChrome): void {
  if (mode === "show") return;
  const doc = win.document;
  const BUTTON = "[aria-label=\"播放控制\"]";
  const CARD = `.story-player > .n-card${BUTTON}`;
  const cardOf = (): Element | null => doc.querySelector(CARD);
  if (mode === "hide") {
    // 静态隐藏：一个类即可（样式在 layout 里），不必监听。
    doc.documentElement.classList.add("ark-chrome-hide");
    doc.querySelectorAll(".story-player > .n-card").forEach((node) => {
      if (node.matches(BUTTON) || !node.querySelector("button")) node.classList.add(CHROME_HIDDEN);
    });
    return;
  }
  // 纯隐藏（无定时器）：
  // - 收起态由**根类**兜底（`html.ark-chrome-auto:not(.ark-chrome-open)`）——引擎是
  //   异步挂载的，底栏出现时可能还没有任何类，根类保证它一出现就是收起的；
  // - 卡片上同时带 `.ark-chrome-hidden`，便于选择器/证据直接断言；
  // - 收起态 `pointer-events:none`，卡片收不到 `pointerenter`，所以显示走
  //   `pointermove` 的**几何**命中（指针落在底栏矩形内）；隐藏走 `pointerout`
  //   离开卡片（含指针移出 iframe → `pointerleave`）。
  /** 底栏当前是不是「收起」——以**根类**为准。 */
  const isHidden = (): boolean => !doc.documentElement.classList.contains(CHROME_OPEN);
  /** 把卡片类同步到当前状态（卡片是引擎异步挂载的：出现时才补上）。 */
  const paint = (): void => {
    const hidden = isHidden();
    doc.querySelectorAll(CARD).forEach((node) => node.classList.toggle(CHROME_HIDDEN, hidden));
  };
  const setHidden = (hidden: boolean): void => {
    doc.documentElement.classList.add(CHROME_AUTO);
    doc.documentElement.classList.toggle(CHROME_OPEN, !hidden);
    paint();
  };
  /** 跨 realm（引擎 iframe）判定：`instanceof Node` 会恒 false，按 `nodeType` 鸭子类型。 */
  const inCard = (target: EventTarget | null): boolean => {
    const card = cardOf();
    const node = target as Node | null;
    if (!card || !node || typeof node.nodeType !== "number") return false;
    return card === node || card.contains(node);
  };
  const onMove = (event: Event): void => {
    const card = cardOf();
    if (!card || !isHidden()) return;
    const { clientX, clientY } = event as PointerEvent;
    const rect = card.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      setHidden(false);
    }
  };
  const onOver = (event: Event): void => {
    if (inCard(event.target)) setHidden(false);
  };
  const onOut = (event: Event): void => {
    // `relatedTarget` 仍在底栏内（卡片子元素之间移动）就不收。
    if (inCard(event.target) && !inCard((event as PointerEvent).relatedTarget)) setHidden(true);
  };
  // 悬停开关：`off`（默认）→ 只加 `ark-chrome-auto`（CSS 直接 `opacity:0`，指针
  // 命中也不亮）；`on` → 再加 `ark-chrome-hover`，由 `ark-chrome-open` 决定显示。
  if (!isPlayerChromeHover()) {
    doc.documentElement.classList.remove(CHROME_HOVER);
    // 永久隐藏：不装监听（`paint` 也省了），并且清掉可能残留的展开态。
    doc.documentElement.classList.add(CHROME_AUTO);
    setHidden(true);
    return;
  }
  doc.documentElement.classList.add(CHROME_HOVER);
  doc.addEventListener("pointermove", onMove, { passive: true });
  doc.addEventListener("pointermove", paint, { passive: true });
  doc.addEventListener("pointerover", onOver, { passive: true });
  doc.addEventListener("pointerout", onOut, { passive: true });
  doc.addEventListener("pointerleave", () => setHidden(true), { passive: true });
  // 键盘用户（Tab 到播放速度等）：焦点在底栏内保持显示，焦点离开即收起。
  doc.addEventListener("focusin", onOver, { passive: true });
  doc.addEventListener("focusout", onOut);
  setHidden(true);
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

/** `FrameBootOptions.bundle` 的替换（boot 内部换源用；`dom_html` 等原样保留）。 */
function withSnapshot(bundle: WidgetBundle, snapshot: StoryPlayerSnapshot): WidgetBundle {
  return { ...bundle, story_player: snapshot };
}

/** Tauri 运行时（`window.__TAURI_INTERNALS__` 由壳注入）。 */
function inTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 首选候选的**预检**：抓一次入口 URL，拿到 HTTP 状态 / 网络错误。
 *
 * 目标 URL：
 * - Tauri 内：`prts-cdn://`（协议处理器自动带 ACAO、并把上游状态原样带回）；
 * - 浏览器（dev harness）：原始 https URL（`static.prts.wiki` 不带 ACAO →
 *   CORS 失败记为「网络错误」；harness 用 `page.route` 能给出真 `HTTP 500`）。
 */
async function probeEntry(url: string, domains: string[]): Promise<
  { ok: true } | { ok: false; error: StoryPlayerModuleError }
> {
  const target = inTauriShell() && url.startsWith("https://") ? proxyUrl(url, domains) : url;
  try {
    await fetchModuleSource(target, { source: "network" });
    return { ok: true };
  } catch (error) {
    const typed = error as { httpStatus?: number | null; reason?: string };
    return {
      ok: false,
      error: new StoryPlayerModuleError({
        // 横幅里显示**原始** URL 的文件名，而不是代理地址。
        url,
        httpStatus: typed?.httpStatus ?? null,
        reason: typed?.reason ?? "网络错误",
        cause: error,
      }),
    };
  }
}

/**
 * 起一次「某个候选快照」的引擎。换源复用同一个 iframe：`doc.open()/write()`
 * 会把文档重置回干净 realm（与原实现一致）。
 *
 * 一个候选的加载阶梯（BRIEF §0.5）：`viaSrc()` → `viaInline()` →
 * 退避重试 1.5s / 3s（共 2 次）→ 抛错给上层换源。全程**静默**。
 */
async function bootOnce(opts: FrameBootOptions, snapshot: StoryPlayerSnapshot): Promise<FrameBootResult> {
  const doc = opts.iframe.contentDocument;
  const win = opts.iframe.contentWindow as StoryPlayerWindow | null;
  if (!doc || !win) throw new Error("StoryPlayer iframe unavailable");
  const issues = validateStoryPlayer(snapshot);
  if (issues.length) throw new Error(issues.join("；"));
  // 自带素材（`build/assets.local.json`）：可以解析成 iframe realm 也要用的静态表
  const packAssetsShim = opts.mode === "play" && packAssetShimAvailable() ? packAssetShimCode() : null;
  const cancelled = () => opts.isCancelled?.() || !opts.iframe.isConnected;
  const blobUrls: string[] = []; // 兼容：历史上是 blob:，现在模块走 data:
  /** entry URL → 已重写的源码；行内注入优先用它（blob: 在部分 WebView2 上被拦）。 */
  const moduleSources = new Map<string, string>();
  const sourceFor = (url: string) => moduleSources.get(url);
  const domains = discoverAssetDomains(...Object.values(snapshot.modules), ...Object.values(snapshot.styles));
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
  const bootState = "play";
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><pre id="datas_txt" hidden></pre></body></html>');
  doc.close();
  // harness 用它区分「白屏」与「已在跑（含降级）」——写在 doc.write 重置之后。
  doc.documentElement.setAttribute("data-arkstage-boot", bootState);
  doc.title = opts.title;
  doc.getElementById("datas_txt")!.textContent = opts.script;
  win.mw = { config: { get: (key: string) => key === "wgUserName" ? getItem("ui", "prts-nickname") : null } };
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
      const moduleUrl = sourceDataUrl(source);
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
      // ⚠️ 舞台比例：**铺满容器 + 按比例裁切（cover）**，绝不拉伸。
      //    引擎 `mount()` 固定 `renderer.resize(1280,720,dpr)` 并把 canvas 设成
      //    `width:100%;height:100%` —— 画面比例完全由**父元素**决定。原先把
      //    `section` 写成 `flex:1;aspect-ratio:auto`（任意宽高比）→ 21:9 的槽位里
      //    16:9 的画面被横向拉长（"预览的舞台会扭曲"）。现在由 `.ark-stage-fit`
      //    包装层给出 16:9 盒子：`cover` 时按容器**取大**一维铺满（多余裁掉），
      //    `contain` 时取小（留黑边）。
      layout.textContent = `html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
        .story-player{height:100dvh!important;padding:0!important;gap:0!important}
        .story-player>section{flex:1;min-height:0;max-width:none!important;aspect-ratio:auto!important;position:relative;overflow:hidden}
        /* 画面盒：CSS 变量 --ark-stage-w/h 由 installStageFit 按 cover 算出（1280:720）；
           用**后代**选择器（canvas 在 hostRef div 里，不是 section 的直接子节点）。
           !important 用来压过引擎内联的 canvas.style.width=100%。 */
        .story-player>section canvas,.story-player>section video{position:absolute!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;width:var(--ark-stage-w,100%)!important;height:var(--ark-stage-h,100%)!important;display:block}
        .story-player>.n-card{flex:none;max-width:none!important;border-radius:0}
        .story-player .n-card__content{padding:6px 10px!important}
        /* 播放器底栏：显示 / 自动隐藏（默认，纯隐藏：指针移上去才显示）/ 隐藏
           —— 见 uiSettings.ts。auto 档：收起时卡片 .ark-chrome-hidden（透明度 +
           不接收指针）；显示由 html.ark-chrome-open 决定（指针命中底栏矩形即加）。 */
        /* auto = 底栏常藏。默认（无 .ark-chrome-hover）= **永久隐藏**：指针命中也不亮。
           打开设置里的「悬停显示」（html.ark-chrome-hover）后，才由 .ark-chrome-open 决定。 */
        html.ark-chrome-auto .story-player>.n-card.ark-chrome-hidden{opacity:0;pointer-events:none;transition:opacity .2s}
        html.ark-chrome-auto.ark-chrome-hover.ark-chrome-open .story-player>.n-card[aria-label="播放控制"]{opacity:1!important;pointer-events:auto!important}
        html.ark-chrome-hide .story-player>.n-card[aria-label="播放控制"]{display:none!important}`;
      doc.head.appendChild(layout);
      installPlayerChrome(win, chrome);
      installStageFit(win, doc);
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
      /** 单个模块的加载阶梯：`viaSrc` → `viaInline`；两级都挂 → 退避 1.5s/3s
       *  再走一遍（共 2 次重试）。总次数有界，横幅/日志只在最终失败时汇总。 */
      const indexed = new Map<string, number>();
      const loadModule = async (entry: string, isEntry: boolean): Promise<void> => {
        const src = imports[opts.mode === "play" ? proxyUrl(entry, domains) : entry];
        const viaSrc = async (): Promise<void> => {
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
        const viaInline = async (): Promise<void> => {
          const code = sourceFor(entry);
          if (code === undefined) throw new Error("no inlined source");
          const marker = `__arkstageModuleDone:${indexed.get(entry) ?? 0}`;
          const script = doc.createElement("script");
          script.type = "module";
          script.textContent = `${code}\n;globalThis[${JSON.stringify(marker)}]=true;`;
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
        let attempt = 0;
        for (;;) {
          attempt += 1;
          try {
            await viaSrc();
            if (attempt > 1) pushLog("info", `[StoryPlayer] ${entry.split("/").pop()}: 第 ${attempt} 次尝试成功`);
            return;
          } catch (first) {
            inlineOnly = true;
            try {
              await viaInline();
              if (attempt > 1) pushLog("info", `[StoryPlayer] ${entry.split("/").pop()}: 第 ${attempt} 次尝试（行内）成功`);
              return;
            } catch (second) {
              if (cancelled()) return;
              if (attempt <= ENGINE_RETRY_DELAYS_MS.length) {
                const wait = ENGINE_RETRY_DELAYS_MS[attempt - 1];
                pushLog("warn", `[StoryPlayer] 模块 ${entry.split("/").pop()} 加载失败（第 ${attempt} 次）：${String(second)}；${wait / 1000}s 后重试`);
                await new Promise((resolve) => setTimeout(resolve, wait));
                continue;
              }
              const extra = moduleErrors.length ? `（${moduleErrors.slice(0, 2).join(" | ")}）` : "";
              const code = sourceFor(entry) ?? "";
              const hint = code.includes("import(") ? "（模块含动态 import：可能是 chunk 解析失败）" : "";
              pushLog("error", `[StoryPlayer] 模块失败 ${entry} 源长度=${code.length} 尝试=${attempt}${hint}`);
              throw new Error(`StoryPlayer 模块执行失败: ${entry} — ${String(first)} / ${String(second)}${extra}${hint}`);
            }
          }
        }
      };
      for (const entry of [...(snapshot.prelude ?? []), snapshot.entry]) {
        const isEntry = entry === snapshot.entry;
        indexed.set(entry, (indexed.size ?? 0) + 1);
        await loadModule(entry, isEntry);
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

/**
 * 加载策略（BRIEF §0.5「失败静默降级 + 一条人话横幅 + 自动重试 2 次」）：
 *
 * 1. 候选 A = `bundle.story_player`（网络/本地由 `enginePack` 的来源标注区分）；
 * 2. 候选 A：`fetchModuleSource` 预检入口 URL（带 ACAO 的镜像 → `HTTP 500`；
 *    `static.prts.wiki` 裸 fetch → 网络错误），随后 `bootOnce` 走
 *    `viaSrc → viaInline → 退避重试 1.5s / 3s`；
 * 3. A 失败 → 横幅**一条**（URL + HTTP 状态 + 来源）→ 换 pack → cache
 *    （同一 iframe 重置再起）；
 * 4. **只有网络版**完整成功（预检通过 + boot 成功）才 `noteNetworkSuccess()`
 *    清横幅；pack/cache 成功时横幅保留，提示「网络版还没好」。
 *
 * 页面不白屏：失败会抛给页面 catch（编辑器/播放器都有 fallback UI），而横幅在
 * 抛错前已经推过（harness #6 断言 `[data-asset-banner="1"]` + 文案含 HTTP 500）。
 */
export async function bootStoryPlayer(opts: FrameBootOptions): Promise<FrameBootResult> {
  const source = bundleSource(opts.bundle);
  const snapshot = opts.bundle.story_player!;
  const issues = validateStoryPlayer(snapshot);
  if (issues.length) {
    // 首选快照本身残缺：网络版直接换 pack；本地版如实报错。
    if (source === "network") {
      const candidates = await fallbackSnapshots(snapshot);
      const pack = candidates.find((candidate) => candidate.source === "pack");
      if (pack) {
        const label = pack.label ? `内置快照（${pack.label}）` : "内置快照";
        pushLog("warn", `[StoryPlayer] 首选快照不完整，改用${label}`);
        announceEngineFailure({ url: snapshot.entry, reason: issues[0] }, label);
        return bootStoryPlayer({ ...opts, bundle: withSnapshot(opts.bundle, pack.snapshot) });
      }
    }
    throw new Error(issues.join("；"));
  }
  const domains = discoverAssetDomains(...Object.values(snapshot.modules), ...Object.values(snapshot.styles));
  const probe = await probeEntry(snapshot.entry, domains);
  const failure = probe.ok ? null : probe.error;
  /** 横幅文案只认**本条首选**（快照残缺/预检失败/加载失败三种，最先出现的赢）。 */
  let failureNote: { url: string; httpStatus?: number | null; reason?: string } | null =
    failure ? { url: failure.url, httpStatus: failure.httpStatus, reason: failure.reason } : null;
  const noteOnce = (note: { url: string; httpStatus?: number | null; reason?: string }): void => {
    if (!failureNote) failureNote = note;
  };
  const report = (fallbackLabel?: string): void => announceEngineFailure(
    failureNote ?? { url: snapshot.entry, reason: "加载超时" },
    fallbackLabel,
  );
  const failureText = (): string => failureNote?.reason || (failureNote?.httpStatus ? `HTTP ${failureNote.httpStatus}` : "加载超时");

  // 首选 URL 的**预检**失败（harness 的 500 就命中这里）→ 立刻给出一条人话横幅；
  // 引擎若仍能从 import map 起来，横幅降级为「已自动恢复」。
  if (failure) report();

  // A) 首选候选：`bootOnce` 内部 = viaSrc → viaInline → 1.5s/3s 退避重试。
  try {
    const result = await bootOnce(opts, snapshot);
    if (!failure) noteNetworkSuccess();
    else if (source === "network") {
      // 只影响「预检」，但引擎真的起来了：更新为「已自动恢复」。
      pushEngineStatus(
        `引擎模块预检失败：${snapshot.entry.split("/").pop()}（${failureText()}）；已自动恢复（重试成功）`,
        "点「重试」可再验证一次；或在 设置 → 资源 → 下载源 换成镜像",
      );
    }
    return result;
  } catch (error) {
    pushLog("warn", `[StoryPlayer] 首选快照启动失败（${source}）：`, error);
    // 保证页面 catch 之前**已有**一条人话横幅（失败可能没有可换源）。
    noteOnce({ url: snapshot.entry, reason: error instanceof Error ? error.message.slice(0, 120) : "加载失败" });
    report();
    // B) 换源：pack → disk cache（各一次）。与首选同代（字节签名相同）的跳过。
    const candidates = await fallbackSnapshots(snapshot);
    for (const candidate of candidates) {
      const label = candidate.source === "pack" ? `内置快照（${candidate.label ?? "内置"}）` : "本地缓存快照";
      if (failure) annotateFallback(failure, label);
      else report(label);
      try {
        const result = await bootOnce(opts, candidate.snapshot);
        // pack/cache 成功 ≠ 网络版成功 → 横幅保留（BRIEF §3.5）。
        pushLog("info", `[StoryPlayer] ${label} 启动成功（网络版仍不可用）`);
        return result;
      } catch (fallbackError) {
        pushLog("warn", `[StoryPlayer] ${label} 启动失败：`, fallbackError);
      }
    }
    throw error;
  }
}
