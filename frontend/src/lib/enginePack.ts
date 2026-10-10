/**
 * 引擎「随包快照」的唯一读取入口 + 加载失败的人话横幅（P6）。
 *
 * 解析顺序（BRIEF §3.4）：**pack（随包 `include_bytes!`）→ 磁盘 cache
 * （`widget-bundle-v7`，最近一次网络校验通过的）→ 网络（PRTS）**。
 * 冷启动 / 离线首启直接由 pack 点亮引擎；网络只负责「升级 + 启动校验」。
 *
 * 本模块只做「读 + 校验 + 换源候选 + 横幅」；网络候选的 iframe 启动校验留在
 * `predownload.ts::refreshBundle`。浏览器探针（dev server，无 `__TAURI_INTERNALS__`）
 * 下用 Vite 直接加载**同一份** `src-tauri/resources/engine/v1/snapshot.json`，
 * 好让 harness 走同一条 pack → cache → network 路径；生产浏览器构建里该分支被
 * `import.meta.env.DEV` 静态剔除（那两行不影响 Tauri 包体）。
 */
import { invoke } from "@tauri-apps/api/core";
import type { WidgetBundle } from "./engineBoot";
import { validateStoryPlayer, type StoryPlayerSnapshot } from "./storyPlayerAdapter";
import { pushLog, pushStatus, resolveStatus, statusEntries } from "./debugLog";

/** 随包快照的元信息（`src-tauri/resources/engine/v1/meta.json`）。 */
export interface EngineSnapshotInfo {
  version: string;
  catalogVersion: string;
  entry: string;
  revision: string;
  bytes: number;
  builtAt: string;
  files: number;
  modules: number;
  styles: number;
  data: number;
  optional: string[];
}

/** §2.6 的 `readEnginePack()` 契约（设置/镜像 UI + 探针）。 */
export interface EnginePackInfo {
  version: string;
  keys: string[];
  files: number;
}

/** 磁盘 cache 的 key：v7 = 引入「随包 pack」回退路径的一代。 */
export const PACK_CACHE_KEY = "widget-bundle-v7";
/** 只读兼容的老 key：老装机第一次升级时仍能命中最后的可用版本。 */
const PREVIOUS_CACHE_KEYS = ["widget-bundle-v6", "widget-bundle-v5", "widget-bundle-v4"] as const;
/** 引擎横幅的 kind（BRIEF §2.7；同 kind 只留一条）。 */
const STATUS_KIND = "engine" as const;
/** 每次 boot 的自动重试退避（2 次）。 */
export const ENGINE_RETRY_DELAYS_MS = [1500, 3000] as const;
/** 网络快照抓取并发（与 `story_player.rs::fetch_bundle`、设置项的 10 路一致）。 */
export const MODULE_FETCH_CONCURRENCY = 10;

/** pack / cache / network / provided（= 调用方直接给的 bundle，来源未知）。 */
export type BundleSource = "pack" | "cache" | "network" | "provided" | "local";

export interface SnapshotCandidate {
  snapshot: StoryPlayerSnapshot;
  source: BundleSource;
  /** 换源候选的追溯说明（横幅/日志用，如 `v1.0.0-fbb167ed`）。 */
  label?: string;
}

/** 浏览器里没有 `__TAURI_INTERNALS__`；invoke 会同步抛。 */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isTauriRuntime(): boolean {
  return inTauri();
}

// ── 随包快照（pack） ───────────────────────────────────────────────────────

let packPromise: Promise<EnginePack | null> | null = null;
let resolvedPack: EnginePack | null | undefined;

export interface EnginePack {
  /** `WidgetBundle` 形状：`engineBoot` 只要带 `story_player` 就走新版引擎。 */
  bundle: WidgetBundle;
  snapshot: StoryPlayerSnapshot;
  /** `bundled:<revision>` —— 与网络 revision 同域，便于比较/展示。 */
  revision: string;
  /** 人话标签（`v1.0.0-fbb167ed`）。 */
  label: string;
  source: "pack";
}

/**
 * 读取并校验随包快照（进程内只做一次）。null = 没有可用 pack
 * （浏览器生产构建、或文件损坏）→ 调用方继续走 cache → network。
 */
export async function loadBundledEngine(): Promise<EnginePack | null> {
  if (resolvedPack !== undefined) return resolvedPack;
  if (!packPromise) packPromise = readPackOnce();
  resolvedPack = await packPromise;
  return resolvedPack;
}

async function readPackOnce(): Promise<EnginePack | null> {
  const meta = await bundledEngineMeta();
  const snapshot = await readBundledSnapshot();
  if (!snapshot) return null;
  const problems = validateStoryPlayer(snapshot);
  if (problems.length) {
    pushLog("warn", `[engine-pack] 随包快照校验失败（继续 cache/network）: ${problems.join("；")}`);
    return null;
  }
  // 标签形态对齐 BRIEF §0.2 的示例：`v1.0.0-fbb167ed`（版本 + revision 前 8 位）。
  const label = meta
    ? `v${String(meta.version || "1").replace(/^v/, "")}${meta.revision ? `-${String(meta.revision).slice(0, 8)}` : ""}`
    : "v1";
  pushLog(
    "info",
    `[engine-pack] 随包快照就绪 ${label}：${Object.keys(snapshot.modules).length} 模块 / `
    + `${Object.keys(snapshot.styles).length} 样式 / ${Object.keys(snapshot.data).length} 数据表`
  );
  const bundle: WidgetBundle = {
    dom_html: "",
    data_blocks_html: "",
    engine_scripts: [],
    story_player: snapshot,
    revision: meta?.revision ? `bundled:${meta.revision}` : "bundled:v1",
  };
  markBundleSource(bundle, "pack");
  return { bundle, snapshot, revision: bundle.revision!, label, source: "pack" };
}

/** 随包快照 JSON（Tauri：`engine_snapshot_read`；浏览器 dev：Vite 直接加载）。 */
async function readBundledSnapshot(): Promise<StoryPlayerSnapshot | null> {
  const raw = await readBundledRaw();
  if (raw) {
    try {
      return JSON.parse(raw) as StoryPlayerSnapshot;
    } catch (error) {
      pushLog("warn", "[engine-pack] 随包快照 JSON 损坏（继续 cache/network）:", error);
    }
  }
  if (!inTauri() && import.meta.env.DEV) {
    try {
      const module = await import("../../../src-tauri/resources/engine/v1/snapshot.json");
      return ((module as { default?: StoryPlayerSnapshot }).default ?? (module as unknown as StoryPlayerSnapshot)) ?? null;
    } catch (error) {
      pushLog("info", "[engine-pack] 浏览器里没有随包快照（走 cache/network）:", error);
    }
  }
  return null;
}

async function readBundledRaw(): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<string>("engine_snapshot_read");
  } catch (error) {
    pushLog("warn", "[engine-pack] 随包快照读取失败（继续 cache/network）:", error);
    return null;
  }
}

let metaPromise: Promise<EngineSnapshotInfo | null> | null = null;

/** meta：Tauri 走命令；浏览器 dev 读打包器里的 meta.json。 */
export function bundledEngineMeta(): Promise<EngineSnapshotInfo | null> {
  if (!metaPromise) metaPromise = readMetaOnce();
  return metaPromise;
}

async function readMetaOnce(): Promise<EngineSnapshotInfo | null> {
  if (inTauri()) {
    try {
      return await invoke<EngineSnapshotInfo>("engine_snapshot_info");
    } catch (error) {
      pushLog("info", "[engine-pack] engine_snapshot_info 不可用:", error);
    }
  }
  if (import.meta.env.DEV) {
    try {
      const module = await import("../../../src-tauri/resources/engine/v1/meta.json");
      return ((module as { default?: EngineSnapshotInfo }).default ?? null) as EngineSnapshotInfo | null;
    } catch {
      /* 无 meta 也能跑：标签退化成 `v1`。 */
    }
  }
  return null;
}

/** §2.6 契约：随包 pack 的 `{version, keys, files}`；失败 null。 */
export async function readEnginePack(): Promise<EnginePackInfo | null> {
  if (inTauri()) {
    try {
      const info = await invoke<EnginePackInfo>("engine_pack_info");
      if (info?.version) return info;
    } catch {
      /* 落到下面的本地推导。 */
    }
  }
  const pack = await loadBundledEngine();
  if (!pack) return null;
  const meta = await bundledEngineMeta();
  const keys = [
    ...Object.keys(pack.snapshot.modules),
    ...Object.keys(pack.snapshot.styles),
    ...Object.keys(pack.snapshot.data),
  ].map((url) => url.split("?")[0].split("/").pop() || url);
  keys.sort();
  return {
    version: meta?.version || "v1",
    keys: [...new Set(keys)],
    files: keys.length,
  };
}

/** 人话标签（横幅里「已回退到内置快照（<label>）」）。 */
export async function bundledLabel(): Promise<string> {
  const pack = await loadBundledEngine();
  return pack?.label ?? "内置快照";
}

// ── 磁盘 cache（上一次网络校验通过） ───────────────────────────────────────

/** 上一次网络校验通过的候选（v7 → v6 → v5 …）。`validate` 由调用方注入。 */
export async function readCachedBundle(validate: (bundle: WidgetBundle) => string[]): Promise<WidgetBundle | null> {
  if (!inTauri()) return null;
  for (const key of [PACK_CACHE_KEY, ...PREVIOUS_CACHE_KEYS]) {
    try {
      const raw = await invoke<string | null>("load_from_cache", { key });
      if (!raw) continue;
      const candidate = JSON.parse(raw) as WidgetBundle;
      // v3 曾把脚本文本经 innerHTML 序列化（`&amp;` 之类），永不当作回退。
      if (validate(candidate).length === 0
        && !candidate.engine_scripts?.some((script) => /&(?:amp|gt|lt|quot);/.test(script))) {
        return candidate;
      }
    } catch {
      // 下一个 key / 交给调用方走网络。
    }
  }
  return null;
}

/** 网络候选落盘：`widget-bundle-v7`（`save_to_cache` 自己还会留 `.previous`）。 */
export async function saveCachedBundle(bundle: WidgetBundle, previous?: WidgetBundle | null): Promise<void> {
  if (!inTauri()) return;
  if (previous && previous.revision && previous.revision !== bundle.revision) {
    await invoke("save_to_cache", { key: `${PACK_CACHE_KEY}-previous`, data: JSON.stringify(previous) }).catch(() => {});
  }
  await invoke("save_to_cache", { key: PACK_CACHE_KEY, data: JSON.stringify(bundle) }).catch(() => {});
}

// ── 来源标注 + 换源阶梯 ──────────────────────────────────────────────────

const markedSources = new WeakMap<object, BundleSource>();

/** 标注 bundle 的来源（boot 据此决定「能不能清横幅 / 还要不要换源」）。 */
export function markBundleSource(bundle: WidgetBundle, source: BundleSource): void {
  if (bundle && typeof bundle === "object") markedSources.set(bundle, source);
}

export function bundleSource(bundle: WidgetBundle | undefined | null): BundleSource {
  if (!bundle || typeof bundle !== "object") return "provided";
  return markedSources.get(bundle) ?? "provided";
}

/**
 * 换源阶梯（boot 用）：**pack → cache**（network 由调用方按需再抓）。
 * 与当前快照同一代（入口 + 模块名集合）的候选会被去重。
 */
export async function fallbackSnapshots(current: StoryPlayerSnapshot): Promise<SnapshotCandidate[]> {
  const candidates: SnapshotCandidate[] = [];
  const pack = await loadBundledEngine();
  if (pack) candidates.push({ snapshot: pack.snapshot, source: "pack", label: pack.label });
  const cached = await readCachedBundle(validateStoryPlayerBundle);
  if (cached?.story_player) candidates.push({ snapshot: cached.story_player, source: "cache" });
  return candidates.filter((candidate) => !sameSnapshot(current, candidate.snapshot));
}

/**
 * 两份快照是不是**同一代**（入口 + 「模块名:字节数」签名），用于换源去重。
 * 只比模块名会把「同一个文件名、不同字节」的两代判成同一代（换源就跳过了），
 * 所以签名里带上长度：字节不同 = 不同代 = 值得换一次。
 */
export function sameSnapshot(a: StoryPlayerSnapshot, b: StoryPlayerSnapshot): boolean {
  if (!a || !b) return false;
  if (a.entry !== b.entry) return false;
  return snapshotSignature(a) === snapshotSignature(b);
}

function snapshotSignature(snapshot: StoryPlayerSnapshot): string {
  return Object.keys(snapshot.modules ?? {})
    .map((url) => `${url.slice(url.lastIndexOf("/") + 1)}:${(snapshot.modules[url] ?? "").length}`)
    .sort()
    .join(",");
}

/** `WidgetBundle.story_player` 的形状校验（复用 adapter 的契约，不另立一套）。 */
export function validateStoryPlayerBundle(bundle: WidgetBundle): string[] {
  if (!bundle?.story_player) return ["快照缺少 story_player"];
  return validateStoryPlayer(bundle.story_player);
}

// ── 横幅（唯一写点；其他人只读 statusEntries()） ────────────────────────

const fileName = (url: string): string => url.split("?")[0].split("/").pop() || url;

/**
 * 引擎加载失败 → **一条**人话横幅（同 kind+message 由 debugLog 去重）。
 * `fallback` 形如 `内置快照（v1.0.0-fbb167ed）`；缺省 = 仍在用已验证的本地字节。
 */
export function announceEngineFailure(
  failure: { url: string; httpStatus?: number | null; reason?: string },
  fallback?: string,
): void {
  const status = failure.httpStatus ? `HTTP ${failure.httpStatus}` : (failure.reason || "网络错误");
  pushStatus(
    STATUS_KIND,
    `引擎模块加载失败：${fileName(failure.url)}（${status}）；`
    + (fallback ? `已回退到${fallback}` : "已改用本地已验证的引擎快照"),
    "点「重试」再试一次；或在 设置 → 资源 → 下载源 换成镜像",
  );
}

/** 当前是否有 engine 横幅（boot 用来避免同一次失败重复刷屏）。 */
export function engineFailureShown(): boolean {
  return statusEntries().some((entry) => entry.kind === STATUS_KIND);
}

/** 通用：写一条 engine 横幅（boot 的「已自动恢复」等场景；同 kind 去重）。 */
export function pushEngineStatus(message: string, hint?: string): void {
  pushStatus(STATUS_KIND, message, hint);
}

/** 横幅已存在 → 补一句「已回退到 X」（同 kind 复用，不刷屏）。 */
export function annotateFallback(
  failure: { url: string; httpStatus?: number | null; reason?: string },
  label: string,
): void {
  announceEngineFailure(failure, label);
}

/** 网络版快照**完整**成功（结构校验 + 启动校验 + 落盘）→ 清掉引擎横幅。 */
export function noteNetworkSuccess(): void {
  resolveStatus(STATUS_KIND);
}

/** 测试 / 热重载用：丢弃进程内 pack/meta 缓存。 */
export function resetEnginePack(): void {
  resolvedPack = undefined;
  packPromise = null;
  metaPromise = null;
}

/** 只读再导出：`storyPlayerBoot` / UI 需要横幅快照，不必各自 import debugLog。 */
export { statusEntries };
