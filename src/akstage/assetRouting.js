/**
 * assetRouting.js — 素材「规范化 key」与「下载源」之间的**纯函数**路由层。
 *
 * 契约（BRIEF-workbench-v1 §2.6 / §3.3）：应用前端（React）与离线脚本
 * （`tools/mirror/*.mjs`、`scripts/fanfic/*.mjs`）共用本文件，**不得 import
 * Tauri / React / DOM**，只依赖 ESM 与 URL。
 *
 * 三层概念：
 *   1. **canonical key** `{host}/{path}`（例 `torappu.prts.wiki/assets/avg/background/bg_black.png`）
 *      —— 与 Rust `media::canonical_key` 逐字节一致：小写 host、去 query/fragment、逐段百分号编码。
 *   2. **mirror key** `prts:{host}/{path}`（例 `prts:static.prts.wiki/widgets/production/x.js`）
 *      —— 引擎快照的键；`toMirrorKey()` / `fromMirrorUrl()` 与 URL 互转。
 *      也支持 `pack:{relpath}`（随包/磁盘快照内的相对路径，例 `pack:vendor/jquery.min.js`）。
 *   3. **source** —— 从哪个源取。`SOURCE_IDS` 里的 id；模板集中在 `MIRRORS`，
 *      换源/加源只改模板，不再散落字符串。
 *
 * 纪律：
 *   - `mirrorUrl()` 对**不适用**的源返回 `null`（例：非镜像 host 走 jsDelivr）。
 *   - 所有函数对坏输入（null/空串/`data:`/`blob:`）返回 `null` / 空数组，**不抛**。
 */

/** 素材源 id（顺序 = 设置页展示顺序）。 */
export const SOURCE_IDS = Object.freeze(["pack", "prts", "jsd", "fastly", "ghproxy", "custom"]);

/** 源的中文标签（设置页用；改文案只改这里）。 */
export const SOURCE_LABELS = Object.freeze({
  pack: "随包快照 + 官方直连",
  prts: "PRTS 官方直连",
  jsd: "jsDelivr",
  fastly: "Fastly CDN",
  ghproxy: "gh-proxy",
  custom: "自定义源",
});

/** 源的补充说明（设置页副标题）。 */
export const SOURCE_HINTS = Object.freeze({
  pack: "优先用安装包内的引擎快照，缺失时直连官方",
  prts: "始终从 prts.wiki 官方域名拉取",
  jsd: "cdn.jsdelivr.net（大陆访问通常更快）",
  fastly: "fastly.jsdelivr.net（jsDelivr 的 Fastly 线路）",
  ghproxy: "gh-proxy.com 前缀加速 GitHub raw",
  custom: "自己填模板：{url} = 官方直链，{key} = 规范化 key",
});

/**
 * 镜像模板表（**唯一**的 URL 拼装处）。
 * - `{key}` / `{host}` / `{path}`：规范化 key 的分解。
 * - `{url}`：官方直链（`https://{host}/{path}`，逐段编码）。
 */
export const MIRRORS = Object.freeze({
  /** 随包快照 + 官方直连：应用内先查包内/磁盘，缺了才联网（这里给出「联网时的 URL」）。 */
  pack: "https://{host}/{path}",
  /** PRTS 官方直连。 */
  prts: "https://{host}/{path}",
  /** jsDelivr 的 GitHub 线路：镜像仓 `<repo>@<ref>` 下按 `{host}/{path}` 存放。 */
  jsd: "https://cdn.jsdelivr.net/gh/{repo}@{ref}/{host}/{path}",
  /** jsDelivr 的 Fastly 线路。 */
  fastly: "https://fastly.jsdelivr.net/gh/{repo}@{ref}/{host}/{path}",
  /** gh-proxy：给 GitHub raw URL 加前缀。 */
  ghproxy: "https://gh-proxy.com/https://raw.githubusercontent.com/{repo}/{ref}/{host}/{path}",
  /** 自定义：`{tpl}` 由调用方传入（localStorage `prts-app-settings` 的 `customMirror`）。 */
  custom: "{tpl}",
});

/** GitHub 上的镜像仓（`publish-mirror` 工作流把 prts 素材推到这里）。 */
export const MIRROR_REPO = "djkcyl/arkstage-mirror";
/** 镜像仓的分支 / 引用。 */
export const MIRROR_REF = "main";

/** 「引擎键」允许出现的 host（`prts:<host>/<path>` 的合法 host，也是可镜像 host）。 */
export const ENGINE_KEYS = Object.freeze([
  "static.prts.wiki",
  "torappu.prts.wiki",
  "media.prts.wiki",
]);

/** 可镜像 host（能被 publish-mirror 转发到 GitHub 镜像仓的域名）。 */
export const MIRRORABLE_HOSTS = Object.freeze([
  "static.prts.wiki",
  "torappu.prts.wiki",
  "media.prts.wiki",
  "code.jquery.com",
]);

/** `toMirrorKey()` 的默认 host（`prts:widgets/...` 这种省略 host 的写法）。 */
export const DEFAULT_PRTS_HOST = "static.prts.wiki";

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const PRTS_SCHEME = "prts";

function isMirrorableHost(host) {
  return MIRRORABLE_HOSTS.includes(host);
}

/** 逐段百分号编码（与 Rust `media::prts_url` 一致；已编码的 `%xx` 不二次编码）。 */
export function encodePath(path) {
  return String(path)
    .split("/")
    .map((seg) => {
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join("/");
}

function splitHostPath(text) {
  const at = text.indexOf("/");
  if (at <= 0) return null;
  const host = text.slice(0, at).toLowerCase();
  const path = text.slice(at + 1);
  if (!path) return null;
  // host 必须是「真域名」：至少一个点、无空格、无下划线开头的怪东西。
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  return { host, path };
}

/**
 * 任意输入（完整 URL / `host/path` / `prts:host/path` / `pack:relpath`）
 * → `{ scheme, host, path, canonical, mirrorKey }`；坏输入 → `null`。
 *
 * @param {string} key
 * @returns {{scheme: string|null, host: string, path: string, canonical: string, mirrorKey: string, pack: string|null}|null}
 */
export function parseKey(key) {
  if (typeof key !== "string") return null;
  const raw = key.trim();
  if (!raw) return null;
  const m = SCHEME_RE.exec(raw);
  if (m) {
    const scheme = m[1].toLowerCase();
    const rest = raw.slice(m[0].length).replace(/^\/\//, "");
    if (scheme === "http" || scheme === "https") {
      const split = splitHostPath(rest);
      if (!split) return null;
      return build(split.host, split.path, null);
    }
    if (scheme === PRTS_SCHEME) {
      const split = splitHostPath(rest) ?? splitHostPath(`${DEFAULT_PRTS_HOST}/${rest.replace(/^\/+/, "")}`);
      if (!split) return null;
      return build(split.host, split.path, null);
    }
    if (scheme === "pack" || scheme === "asset") {
      const path = rest.replace(/^\/+/, "");
      if (!path) return null;
      return { scheme: "pack", host: "", path, canonical: `pack:${path}`, mirrorKey: `pack:${path}`, pack: path };
    }
    // data: / blob: / asset: / prts-cdn: … 都不是可路由的网络 key。
    return null;
  }
  const split = splitHostPath(raw.replace(/^\/+/, ""));
  if (!split) return null;
  return build(split.host, split.path, null);
}

function build(host, rawPath, _unused) {
  const path = rawPath.replace(/[?#].*$/, "").replace(/^\/+/, "");
  if (!path) return null;
  return {
    scheme: null,
    host,
    path,
    canonical: `${host}/${path}`,
    mirrorKey: `${PRTS_SCHEME}:${host}/${path}`,
    pack: null,
  };
}

/**
 * URL（或 canonical key）→ mirror key。
 * - `https://static.prts.wiki/widgets/production/x.js` → `prts:static.prts.wiki/widgets/production/x.js`
 * - 非 prts host（例 `code.jquery.com`）→ 原样的 `https://host/path`（幂等，可再喂回来）
 * - 坏输入 / `data:` → `null`
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function toMirrorKey(rawUrl) {
  const parsed = parseKey(rawUrl);
  if (!parsed) return null;
  if (parsed.scheme === "pack") return parsed.mirrorKey;
  if (MIRRORABLE_HOSTS.includes(parsed.host)) return parsed.mirrorKey;
  return `https://${parsed.canonical}`;
}

/**
 * mirror key → 官方直链 URL（`prts:`/`pack:` 都能吃）。坏输入 → `null`。
 * `pack:<relpath>` 没有网络 URL，返回 `null`（交给 Rust 从包内取）。
 *
 * @param {string} url
 * @returns {string|null}
 */
export function fromMirrorUrl(url) {
  const parsed = parseKey(url);
  if (!parsed) return null;
  if (parsed.scheme === "pack") return null;
  return `https://${parsed.canonical}`;
}

/** canonical key（`host/path`）—— Rust 磁盘缓存 / 去重用的键。坏输入 → `null`。 */
export function canonicalKey(input) {
  const parsed = parseKey(input);
  return parsed ? parsed.canonical : null;
}

/** 官方直链（等价 `MIRRORS.prts` 的展开）。坏输入 → `null`。 */
export function officialUrl(input) {
  return mirrorUrl("prts", input);
}

function fillTemplate(tpl, part, custom) {
  return String(tpl)
    .replace(/\{tpl\}/g, String(custom ?? ""))
    .replace(/\{repo\}/g, MIRROR_REPO)
    .replace(/\{ref\}/g, MIRROR_REF)
    .replace(/\{host\}/g, part.host)
    .replace(/\{path\}/g, encodePath(part.path))
    .replace(/\{key\}/g, part.canonical)
    .replace(/\{url\}/g, `https://${part.host}/${encodePath(part.path)}`);
}

/**
 * 为**某一个源**拼下载 URL。该源不适用 → `null`。
 *
 * - `pack` / `prts`：官方直链（包内命中与否由 Rust 决定）。
 * - `jsd` / `fastly` / `ghproxy`：仅对 `MIRRORABLE_HOSTS` 生效。
 * - `custom`：需要 `custom` 模板，且模板里必须有 `{url}`/`{key}`/`{host}`/`{path}` 之一。
 *
 * @param {string} source SOURCE_IDS 之一
 * @param {string} key 完整 URL / canonical key / `prts:` / `pack:` key
 * @param {string} [custom] 自定义模板（`custom` 源必填）
 * @returns {string|null}
 */
export function mirrorUrl(source, key, custom) {
  const id = String(source ?? "").toLowerCase();
  const tpl = MIRRORS[id];
  if (!tpl) return null;
  const part = parseKey(key);
  if (!part) return null;
  if (id === "custom") {
    const t = String(custom ?? "").trim();
    if (!t) return null;
    if (!/\{(url|key|host|path)\}/.test(t)) return null;
    const out = fillTemplate(t, part, t);
    return /^https?:\/\/\S+$/.test(out) ? out : null;
  }
  if (part.scheme === "pack" && id !== "pack") return null;
  if (id === "jsd" || id === "fastly" || id === "ghproxy") {
    if (!isMirrorableHost(part.host)) return null;
  }
  return fillTemplate(tpl, part, custom);
}

/**
 * 快照里的**引擎键**前缀：`prts:static.prts.wiki/widgets/production/StoryPlayer.<hash>.js`。
 * （`prts` 之外的 `ui:` 是早期草稿的写法，`parseKey` 不认 —— 当前只用 `prts:`。）
 */
export const MIRROR_KEY_PREFIX = PRTS_SCHEME;

/** 该 key 是否**可镜像**（`pack:` key 不算；不在 `MIRRORABLE_HOSTS` 的 host 不算）。 */
export function isMirrorable(key) {
  const part = parseKey(key);
  return Boolean(part && part.scheme !== "pack" && isMirrorableHost(part.host));
}

/**
 * 试源顺序：首选源 → （自定义）→ 官方 → 各镜像，去掉展开成**同一 URL** 的重复项
 * 与该 key 不适用的源。首选源**永远排第一**（BRIEF §3.3：固定单一源时先按它试）。
 *
 * @param {string} [preferred]
 * @returns {string[]}
 */
export function buildSourceOrder(preferred) {
  const head = SOURCE_IDS.includes(preferred) ? preferred : "pack";
  const order = [head];
  for (const id of ["custom", "pack", "prts", "jsd", "fastly", "ghproxy"]) {
    if (!order.includes(id)) order.push(id);
  }
  // `pack` 与 `prts` 展开后是同一个 URL：只留先出现的那个。
  const packAt = order.indexOf("pack");
  const prtsAt = order.indexOf("prts");
  const dup = packAt >= 0 && prtsAt >= 0 ? (packAt < prtsAt ? "prts" : "pack") : null;
  return order.filter((id) => id !== dup);
}

/**
 * 按**首选源**重排整条链（与 `buildSourceOrder` 同义，参数多一个 key）。
 * 供「固定单一源 / 自动回退」两种模式共用；`sources` 显式给出时不再重排。
 */
export function orderFor(_key, preferred, opts = {}) {
  if (Array.isArray(opts.sources) && opts.sources.length) return [...opts.sources];
  return buildSourceOrder(preferred);
}

/** 兼容别名：`rewriteUrl(raw, source)` = `mirrorUrl(source, raw)`。 */
export function rewriteUrl(a, b, custom) {
  const [source, key] = SOURCE_IDS.includes(a) ? [a, b] : [b, a];
  return mirrorUrl(source, key, custom);
}

/** 兼容别名（BRIEF §2.6 的 `mirrorUrl(source, raw)` 参数序）。 */
export function assetUrl(source, key, custom) {
  return mirrorUrl(source, key, custom);
}

/**
 * 一个 key 的**候选链**（按试源顺序，去掉不适用的源）。
 *
 * @param {string} key
 * @param {string} [preferred] 首选源（默认 `pack`）
 * @param {{custom?: string, sources?: string[]}} [opts]
 * @returns {Array<{source: string, label: string, url: string}>}
 */
export function routeFor(key, preferred, opts = {}) {
  const chain = Array.isArray(opts.sources) && opts.sources.length ? opts.sources : buildSourceOrder(preferred);
  const out = [];
  for (const source of chain) {
    const url = mirrorUrl(source, key, opts.custom);
    if (url) out.push({ source, label: SOURCE_LABELS[source] ?? source, url });
  }
  return out;
}

/** 该 key 的**首选**可用源（`routeFor` 的第一项）；没有 → `null`。 */
export function pickRoute(key, preferred, opts = {}) {
  return routeFor(key, preferred, opts)[0] ?? null;
}

/**
 * 一个 key 的结构摘要（调试面板 / 设置页预览用）。坏输入 → `null`。
 *
 * @param {string} key
 * @returns {{key: string, host: string, path: string, name: string, ext: string, mirrorable: boolean, sources: string[]}|null}
 */
export function describe(key) {
  const part = parseKey(key);
  if (!part) return null;
  const name = part.path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const sources = SOURCE_IDS.filter((id) => mirrorUrl(id, key, "https://example.com/{url}") !== null);
  return {
    key: part.canonical,
    host: part.host,
    path: part.path,
    name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    mirrorable: part.scheme !== "pack" && isMirrorableHost(part.host),
    sources,
  };
}

/** 默认导出（给 `import routing from "..."` 的调用方一个整包视图）。 */
export default {
  SOURCE_IDS,
  SOURCE_LABELS,
  SOURCE_HINTS,
  MIRRORS,
  MIRROR_REPO,
  MIRROR_REF,
  ENGINE_KEYS,
  MIRRORABLE_HOSTS,
  DEFAULT_PRTS_HOST,
  parseKey,
  toMirrorKey,
  fromMirrorUrl,
  canonicalKey,
  officialUrl,
  mirrorUrl,
  buildSourceOrder,
  routeFor,
  pickRoute,
  describe,
  encodePath,
};
