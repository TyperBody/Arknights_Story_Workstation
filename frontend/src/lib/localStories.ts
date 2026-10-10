import { invoke } from "@tauri-apps/api/core";
import {
  clearPackAssetMap,
  ensurePackAssetUrls,
  packAssetCount,
  setPackAssetMap,
  type PackAssetMap,
} from "./packAssets";
import {
  buildHook,
  clearLocalCache,
  hasLocalSource,
  localPacks,
  localUpstream,
  mergeLocalIntoIndex,
  registerLocalSource,
  setUpstreamProvider,
  type PackBundleHook,
} from "../../../src/akstage/local/library.js";

/**
 * 本地二创剧本包（`<资源目录>/assets/library/<packId>/`）的读取入口。
 * 包格式与校验见 `.akskills/arkstage-fanfic/reference/package.md` 与
 * `src/akstage/local/storyPack.js`。
 *
 * - Tauri 运行时：Rust 的 `list_library` / `read_library_file`。
 * - 无头探针（scripts/fanfic/vite-local-library.mjs）：`/__local-library.json`
 *   注水同样的 { id, files } 结构，`--library <dir>` 指定目录。
 */

export type { PackBundleHook };

export interface LocalStoryMeta {
  id: string;
  title: string;
  chapter: string;
  description?: string;
  branchPoints: string[];
}

export interface StoryPlayerSnapshot {
  entry: string;
  prelude?: string[];
  modules: Record<string, string>;
  styles: Record<string, string>;
  data: Record<string, Record<string, unknown>>;
}

interface ProbePayload {
  packs?: Array<{ id: string; files: Record<string, string> }>;
  upstream?: { story?: { script: string; title: string }; bundle?: unknown } | null;
}

let registered = false;
let probeUpstream: { story?: { script: string; title: string }; bundle?: unknown } | null = null;

async function loadProbe(): Promise<ProbePayload | null> {
  try {
    const response = await fetch("/__local-library.json", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as ProbePayload;
  } catch {
    return null;
  }
}

function ensureSource(): void {
  if (registered) return;
  registered = true;
  registerLocalSource({
    async listPacks() {
      if (inTauri()) {
        // Tauri 内也要有「上游快照」：优先用本包自带的 build/runtime.json
        // （buildHook 会自己取）；否则读已验证的 widget-bundle-v6 缓存里的
        // StoryPlayer 快照（模块图 + 三张 sidecar 表）——这样不联网也能播。
        await hydrateUpstreamFromCache();
        // 首选：Rust 一次列目录（无需清单文件）。
        try {
          const packs = await invoke<Array<{ id: string; files: Record<string, string> }>>("list_library");
          if (packs.length) return packs;
        } catch {
          // 落到下面的 index.json 兼容路径。
        }
        // 回退：只用既有的 read_asset_text —— 包放在
        // <资源目录>/assets/library/<packId>/，并由 index.json 列出各包文件。
        return readPacksViaAssetText();
      }
      const probe = await loadProbe();
      probeUpstream = probe?.upstream ?? null;
      return probe?.packs ?? [];
    },
    get upstream() {
      return probeUpstream;
    },
  });
}

/** `<资源目录>/assets/library/` 布局的回退读取（零 Rust 改动）。 */
async function readPacksViaAssetText(): Promise<Array<{ id: string; files: Record<string, string> }>> {
  const read = async (name: string): Promise<string | null> => {
    try {
      return await invoke<string | null>("read_asset_text", { category: "library", filename: name });
    } catch {
      return null;
    }
  };
  const rawIndex = await read("index.json");
  if (!rawIndex) return [];
  let listing: { packs?: Array<{ id: string; files?: string[] }> };
  try {
    listing = JSON.parse(rawIndex) as typeof listing;
  } catch {
    return [];
  }
  const packs: Array<{ id: string; files: Record<string, string> }> = [];
  for (const entry of listing.packs ?? []) {
    if (!entry?.id) continue;
    const files: Record<string, string> = {};
    for (const name of entry.files ?? []) {
      const content = await read(`${entry.id}/${name}`);
      if (content !== null) files[name] = content;
    }
    if (files["script.txt"]) packs.push({ id: entry.id, files });
  }
  return packs;
}

/**
 * 从已验证的 `widget-bundle-v6` 缓存里取 StoryPlayer 快照（启动时 hot-update
 * 写入；校验通过才会落盘，见 predownload.ts::refreshBundle）。失败即静默——包内
 * 自带 `build/runtime.json` 时本就不需要它。
 */
async function hydrateUpstreamFromCache(): Promise<void> {
  if (probeUpstream) return;
  try {
    const raw = await invoke<string | null>("load_from_cache", { key: "widget-bundle-v6" });
    if (!raw) return;
    const bundle = JSON.parse(raw) as { story_player?: StoryPlayerSnapshot };
    if (!bundle.story_player) return;
    probeUpstream = { bundle: bundle.story_player };
  } catch {
    // 保持 null：buildHook 会退回包内 build/runtime.json。
  }
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function localLibraryAvailable(): boolean {
  ensureSource();
  return hasLocalSource();
}

/** 书架/路由查询用：本地包元信息。 */
export async function listLocalStories(): Promise<LocalStoryMeta[]> {
  ensureSource();
  const packs = await localPacks();
  return packs.map((pack) => ({
    id: pack.id,
    title: pack.title,
    chapter: pack.chapter,
    description: pack.description,
    branchPoints: pack.branchPoints,
  }));
}

/**
 * `pageTitle` 命中本地包时返回可直接播放的 runtime 记录；否则 null（走上游链路）。
 * 本地包天然离线：不 touch PRTS，也不参与候选快照的「最新优先」校验。
 */
export interface LocalStoryRuntime {
  story: { script: string; title: string };
  bundle: {
    story_player: StoryPlayerSnapshot;
    dom_html: string;
    data_blocks_html: string;
    engine_scripts: string[];
  };
  revision: string;
}

export async function localStoryOverride(pageTitle: string): Promise<LocalStoryRuntime | null> {
  ensureSource();
  if (!hasLocalSource()) return null;
  const packs = await localPacks();
  const pack = packs.find((candidate) => candidate.id === pageTitle);
  if (!pack) return null;
  // 自带素材：注册 `build/assets.local.json` 并把每个 key 解析成 `asset://` 本地
  // 文件（有则离线可播；没有这条映射的包行为完全不变）。必须在 boot 之前 await，
  // 否则首帧会先按网络 URL 加载。
  installPackAssets(pack.id, pack.assets ?? {});
  await ensurePackAssetUrls();
  const hook = buildHook(pack, (await localUpstream()) as { bundle?: StoryPlayerSnapshot } | null);
  if (!hook) return null;
  // WidgetBundle 的形状：只要带上 story_player，engineBoot 就会走新版引擎，
  // 其余三个 legacy 字段在新版分支里不被读取（见 engineBoot.ts:121、storyPlayerBoot.ts:39）。
  const bundle = { dom_html: "", data_blocks_html: "", engine_scripts: [], story_player: hook.bundle as StoryPlayerSnapshot };
  return { story: hook.story, bundle, revision: hook.revision };
}

/**
 * 把一个本地包的**自带素材表**（`build/assets.local.json`）注册进 `packAssets`。
 * 表不存在/解析失败 → 清空注册（等价于「没有自带素材」，走网络/缓存）。
 * `resolvePlan`/`listLocalStories` 等只读路径不受影响。
 */
export function installPackAssets(
  packId: string,
  files: Record<string, string> | null | undefined,
): boolean {
  const raw = files?.["build/assets.local.json"];
  if (typeof raw !== "string" || !raw.trim()) {
    clearPackAssetMap();
    return false;
  }
  let map: PackAssetMap;
  try {
    map = JSON.parse(raw) as PackAssetMap;
  } catch {
    clearPackAssetMap();
    return false;
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    clearPackAssetMap();
    return false;
  }
  setPackAssetMap(packId, map);
  return true;
}

/**
 * 注册某个本地包的自带素材表并解析成 URL（不启动播放）。播放链路由
 * `localStoryOverride` 调用同一条路径；这里给探针/编辑页预览复用。
 * 返回已注册的 key 数量（0 = 该包不带素材）。
 */
export async function preparePackAssets(pageTitle: string): Promise<number> {
  ensureSource();
  const packs = await localPacks();
  const pack = packs.find((candidate) => candidate.id === pageTitle);
  if (!pack) {
    clearPackAssetMap();
    return 0;
  }
  if (!installPackAssets(pack.id, pack.assets ?? {})) return 0;
  await ensurePackAssetUrls();
  return packAssetCount();
}

export function mergeLocalStories<T>(index: T, metas: LocalStoryMeta[], categoryName = "同人剧场"): T {
  if (!metas.length) return index;
  return mergeLocalIntoIndex(index as never, metas.map((meta) => ({
    id: meta.id,
    title: meta.title,
    chapter: meta.chapter || meta.title,
  })) as never, categoryName) as T;
}

/**
 * 注册「共享上游快照」提供者（应用启动时抓到的 StoryPlayer 快照）。没有自带
 * `build/runtime.json` 的剧本包（例如内置样例）靠它就能播——用户不必自带引擎快照。
 */
export function setBundleProvider(provider: () => Promise<{ bundle?: StoryPlayerSnapshot } | null>): void {
  setUpstreamProvider(provider as unknown as () => Promise<{ bundle?: object } | null>);
}

export function resetLocalStories(): void {
  clearLocalCache();
}
