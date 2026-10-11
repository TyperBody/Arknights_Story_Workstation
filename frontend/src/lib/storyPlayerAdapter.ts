import { parse } from "acorn";
import type { Node } from "acorn";
import { init, parse as parseImports } from "es-module-lexer";

export interface StoryPlayerSnapshot {
  entry: string;
  prelude?: string[];
  modules: Record<string, string>;
  styles: Record<string, string>;
  data: Record<string, Record<string, unknown>>;
}

export const STORY_PLAYER_DATA = [
  "https://torappu.prts.wiki/assets/avg/character.json",
  "https://torappu.prts.wiki/assets/avg/background.json",
  "https://torappu.prts.wiki/gamedata/latest/story/story_variables.json",
] as const;

/** 注入到每个 player 模块顶部：把 Vite 的相对 chunk 名解析到 import map（blob）。 */
const RESOLVER_SOURCE = [
  "const __arkstageResolve=(raw)=>{",
  "  try{",
  "    const map=globalThis.__arkstageImports;",
  "    if(map&&typeof raw==='string'&&raw){",
  "      if(map[raw]) return map[raw];",
  "      let abs=raw; try{ abs=new URL(raw,import.meta.url).href; }catch(e){}",
  "      if(map[abs]) return map[abs];",
  "      const bare=abs.split('?')[0].split('#')[0];",
  "      if(map[bare]) return map[bare];",
  "      const name=bare.split('/').pop();",
  "      if(name) for(const k in map) if(k.endsWith('/'+name)) return map[k];",
  "    }",
  "  }catch(e){}",
  "  return raw;",
  "};",
].join("");

export function resolverPrelude(): string {
  return RESOLVER_SOURCE;
}

/**
 * `dataUrl(source)` 的 **UTF-8 前缀**：`data:text/javascript;charset=utf-8;base64,`。
 *
 * 为什么不写裸 `data:text/javascript,`：上游 StoryPlayer 源码里到处是 `#`
 * （哈希文件名、CSS 选择器、`import.meta.url` 的 fragment），而 data URL 中
 * `#` 会**截断整个 payload** —— 模块变成半截脚本。base64 是唯一能把任意字节
 * 塞进 URL 的编码（`btoa` 一次性、无网、无 IO）。这里把它收敛到**唯一一处**，
 * 方便整条 transport 换掉（`blob:` / 自定义协议）时只改这个函数。
 */
export const DATA_URL_PREFIX = "data:text/javascript;charset=utf-8;base64,";

/** UTF-8 安全的 `data:` URL（唯一实现；见 `DATA_URL_PREFIX` 的说明）。 */
export function sourceDataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  // 分块避免超长 spread（V8 的 apply 参数上限）。
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return `${DATA_URL_PREFIX}${btoa(binary)}`;
}

export function validateStoryPlayer(snapshot: StoryPlayerSnapshot): string[] {
  const errors: string[] = [];
  if (!snapshot?.modules?.[snapshot.entry]) errors.push("StoryPlayer 入口模块缺失");
  for (const url of snapshot?.prelude ?? []) if (!snapshot.modules[url]) errors.push(`StoryPlayer polyfill 缺失: ${url}`);
  if (!Object.keys(snapshot?.styles ?? {}).length) errors.push("StoryPlayer 样式缺失");
  for (const url of STORY_PLAYER_DATA) {
    if (Object.keys(snapshot?.data?.[url] ?? {}).length < 10) errors.push(`StoryPlayer 数据表缺失: ${url}`);
  }
  return errors;
}

/** The wiki entry doesn't export an embedding API. Locate its own functions by
 * their context/manifest contracts, not minified identifiers or a fixed hash.
 * Any ambiguous/changed contract rejects promotion to last-known-good.
 */
export function adaptStoryPlayerEntry(source: string): string {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const functions = ast.body.filter((node) => node.type === "FunctionDeclaration");
  const context = functions.filter((node) => {
    const body = source.slice(node.start, node.end);
    return /\bscriptText\s*:/.test(body) && /\baudioVariables\s*:/.test(body) && /\bbackgroundPpuMap\s*:/.test(body);
  });
  const manifest = functions.filter((node) => {
    const body = source.slice(node.start, node.end);
    return /\bfaceAssets\s*:/.test(body) && /\burls\s*:/.test(body) && body.includes("charMap");
  });
  // The script→lines parser (used by loadContext). Its output is what upstream
  // collectManifest actually iterates, so expose it alongside the two APIs.
  const parseFn = functions.filter((node) => {
    const body = source.slice(node.start, node.end);
    return /\.split\(/.test(body) && /replace\(\/\\r/.test(body) && /lineNumber/.test(body);
  });
  if (context.length !== 1 || manifest.length !== 1) throw new Error("StoryPlayer context/manifest 接口发生变化");
  let mount: { start: number; end: number; replacement: string } | undefined;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  // Generic traversal keeps this adapter independent of Acorn's optional walker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function visit(node: any): void {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression"
      && node.callee.property?.name === "init") {
      const options = node.arguments[0];
      if (options?.type === "ObjectExpression") {
        for (const prop of options.properties) {
          if (prop.key?.name === "preference" && /^["'`]webgpu["'`]$/.test(source.slice(prop.value.start, prop.value.end))) {
            // PRTS currently prefers WebGPU. Pixi 8.20's cached texture batch
            // bind groups retain destroyed dialogue/face textures. WebGL avoids
            // that backend's stale bindings without suppressing resource errors.
            edits.push({ start: prop.value.start, end: prop.value.end, replacement: '"webgl"' });
          }
        }
      }
    }
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression"
      && node.callee.property?.name === "mount" && node.callee.object?.type === "CallExpression") {
      const args = node.callee.object.arguments;
      const props = args[1];
      if (props?.type === "ObjectExpression" && props.properties.some((p: { key?: { name?: string } }) => p.key?.name === "script")) {
        if (mount) throw new Error("StoryPlayer 包含多个入口");
        const app = node.callee.object;
        const create = source.slice(app.start, props.end - 1) + ",autoStart:true" + source.slice(props.end - 1, app.end);
        const call = `(window.__arkstageVueApp=${create})` + source.slice(app.end, node.end);
        mount = { start: node.start, end: node.end, replacement: `(window.__arkstageMount=()=>{window.__arkstageApp=${call}})` };
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(ast as Node);
  if (!mount) throw new Error("StoryPlayer mount 接口发生变化");
  edits.push(mount);
  let adapted = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    adapted = adapted.slice(0, edit.start) + edit.replacement + adapted.slice(edit.end);
  const parser = parseFn.length === 1 ? `,parse:${parseFn[0].id!.name}` : "";
  return adapted + `\nwindow.__arkstageAPI={loadContext:${context[0].id!.name},collectManifest:${manifest[0].id!.name}${parser}};\n`
    + (parseFn.length === 1 ? `window.__arkstageParse=${parseFn[0].id!.name};` : "");
}

/** 模块来源：`network`=PRTS 直连；`pack`/`cache`=本地已验证快照。 */
export type ModuleSource = "pack" | "cache" | "network";

/** 一个模块 URL 的抓取结果（成功）；失败抛 `StoryPlayerModuleError`。 */
export interface StoryPlayerModule {
  url: string;
  source: ModuleSource;
  bytes: number;
  source_code: string;
}

/**
 * 模块抓取/校验失败：带 URL + HTTP 状态 + 来源，供横幅显示「人话」。
 * `reason` 是人类可读的短句（`HTTP 404` / `网络错误` / `空响应`）。
 */
export class StoryPlayerModuleError extends Error {
  readonly url: string;
  readonly httpStatus: number | null;
  readonly bytes: number;
  readonly source: ModuleSource;
  readonly reason: string;

  constructor(input: {
    url: string;
    source?: ModuleSource;
    httpStatus?: number | null;
    bytes?: number;
    reason?: string;
    cause?: unknown;
  }) {
    const status = typeof input.httpStatus === "number" && input.httpStatus > 0 ? input.httpStatus : null;
    const reason = status ? `HTTP ${status}` : (input.reason || "网络错误");
    super(`StoryPlayer 模块加载失败: ${input.url} (${reason})`);
    this.name = "StoryPlayerModuleError";
    this.url = input.url;
    this.httpStatus = status;
    this.bytes = input.bytes ?? 0;
    this.source = input.source ?? "network";
    this.reason = reason;
    if (input.cause !== undefined) (this as { cause?: unknown }).cause = input.cause;
  }
}

/** HTTP 语义上「重试还有意义」的状态码（5xx/408/425/429）；
 *  4xx（404/403…）不停在首选上重试，直接换源更划算。 */
export function retryableStatus(status: number | null | undefined): boolean {
  if (status == null) return true; // 网络层错误（含 CORS 失败）：值得重试
  return status >= 500 || status === 408 || status === 409 || status === 425 || status === 429;
}

/**
 * 抓取一个 StoryPlayer 模块源码（fetch 失败 / 非 2xx → 抛 `StoryPlayerModuleError`）。
 * 只**新增**导出，不改动既有函数签名。
 *
 * 注意：`static.prts.wiki`（模块图 CDN）**不带 `access-control-allow-origin`**，
 * 浏览器里 `fetch()` 会以 CORS 失败（`TypeError: Failed to fetch` → `reason=网络错误`，
 * 拿不到 HTTP 状态）；带 ACAO 的镜像（code.jquery.com / cdn.jsdelivr.net）能拿到
 * 状态码，横幅就会显示 `HTTP 500`。引擎真正的加载仍走 `<script type=module src>`
 * 或 import map（data: URL），这里只是「开机前看一眼首选 URL 健不健康 + 拿字节
 * 供 pack 换源用」。
 */
export async function fetchModuleSource(
  url: string,
  options: { source?: ModuleSource; fetchImpl?: typeof fetch; init?: RequestInit } = {}
): Promise<StoryPlayerModule> {
  const source = options.source ?? "network";
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { cache: "no-store", ...(options.init ?? {}) });
  } catch (error) {
    throw new StoryPlayerModuleError({ url, source, reason: "网络错误", cause: error });
  }
  if (!response.ok) {
    throw new StoryPlayerModuleError({ url, source, httpStatus: response.status, bytes: 0 });
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new StoryPlayerModuleError({ url, source, httpStatus: response.status, reason: "读取失败", cause: error });
  }
  if (!text.trim()) {
    throw new StoryPlayerModuleError({ url, source, httpStatus: response.status, bytes: 0, reason: "空响应" });
  }
  return { url, source, bytes: text.length, source_code: text };
}

/** 把一批 URL 按 `limit` 路并发抓完（`manifestConcurrency` 的消费点，默认 10）。
 *  结果按**输入顺序**返回；单个失败不影响其它项。 */
export async function fetchModulesConcurrently(
  urls: readonly string[],
  options: { source?: ModuleSource; limit?: number } = {}
): Promise<Array<{ url: string; bytes: number; error?: unknown }>> {
  const source = options.source ?? "network";
  const limit = Math.max(1, Math.min(32, options.limit ?? 10));
  const results: Array<{ url: string; bytes: number; error?: unknown }> = new Array(urls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= urls.length) return;
      try {
        const fetched = await fetchModuleSource(urls[index], { source });
        results[index] = { url: urls[index], bytes: fetched.bytes };
      } catch (error) {
        results[index] = { url: urls[index], bytes: 0, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
  return results;
}

/** Normalize imports before blob loading; the import map preserves cycles and
 * shared module identity, including Pixi's lazy renderer chunks.
 */
export async function prepareModule(source: string, url: string, modules: Record<string, string>): Promise<string> {
  await init;
  const [imports] = parseImports(source);
  let result = source;
  for (const item of [...imports].reverse()) {
    if (item.type === "import-meta") {
      // Only rewrite the actual syntax node, never strings/comments mentioning it.
      if (source.slice(item.end, item.end + 4) === ".url") {
        result = result.slice(0, item.start) + JSON.stringify(url) + result.slice(item.end + 4);
        continue;
      }
      // `import.meta.resolve(x)`：上游 Vite 的 `__vitePreload` 用它把 chunk 名
      // 变成绝对 URL（pixi 的懒加载 chunk 就在这里）。默认基址是我们改写的
      // `import.meta.url`（https://…），于是它请求**上游**地址：离线失败、且
      // 在 Tauri 的 CSP 下需要 script-src 放行。改走 import map（blob）后
      // 既离线可用，也不再触发 CSP。
      if (source.slice(item.end, item.end + 8) === ".resolve") {
        result = result.slice(0, item.start) + "__arkstageResolve" + result.slice(item.end + 8);
      }
      continue;
    }
    if (!item.specifier || (item.type === "dynamic" && item.glob)) throw new Error(`StoryPlayer 使用了无法缓存的动态模块导入: ${url}`);
    const target = new URL(item.specifier, url).href;
    if (!modules[target]) throw new Error(`StoryPlayer 模块依赖缺失: ${target}`);
    const replacement = item.type === "dynamic" ? JSON.stringify(target) : target;
    result = result.slice(0, item.start) + replacement + result.slice(item.end);
  }
  // 每个模块都注入 `__arkstageResolve`（懒加载 chunk 名 → import map 的 blob）。
  return `${resolverPrelude()}\n${result}`;
}

/** UI textures and the canvas font are runtime dependencies too. They must be
 * present in predownload manifests even though upstream hides them in Export.
 */
export function storyPlayerStaticAssets(snapshot: StoryPlayerSnapshot): string[] {
  const urls = new Set<string>();
  for (const [base, source] of [...Object.entries(snapshot.modules), ...Object.entries(snapshot.styles)]) {
    for (const m of source.matchAll(/https:\/\/[^\s"'`<>\\)]+\.(?:png|webp|woff2?|ttf|mp3)(?:\?[^\s"'`<>\\)]*)?/g)) urls.add(m[0]);
    for (const m of source.matchAll(/new URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g)) {
      const url = new URL(m[1], base).href;
      if (url.startsWith("https:")) urls.add(url);
    }
    for (const m of (base.endsWith(".css") ? source : "").matchAll(/url\(\s*["']?([^\s)"']+)["']?\s*\)/g)) {
      if (!m[1].includes("${")) {
        const url = new URL(m[1], base).href;
        if (url.startsWith("https:")) urls.add(url);
      }
    }
  }
  return [...urls];
}
