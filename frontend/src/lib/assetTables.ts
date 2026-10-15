/**
 * 引擎目录表（`background.json` / `character.json` / `story_variables.json`）的
 * **浏览器侧读取**（task-9）：素材库面板要用它们做「来源 = 引擎目录」。
 *
 * 优先顺序与播放一致：内置快照（`enginePack.loadBundledEngine()`，dev/离线都在）
 * → 播放 runtime 的 `data`。两者都是 `{ "<url>": table }` 形状；这里只把
 * 需要的三张表挑出来，**不**把 3.4 MB 快照塞进 React state。
 */
import { loadBundledEngine } from "./enginePack";
import { loadStoryRuntime } from "./predownload";

export interface AssetTables {
  backgrounds: Record<string, unknown> | null;
  characters: Record<string, unknown> | null;
  variables: Record<string, unknown> | null;
}

const EMPTY: AssetTables = { backgrounds: null, characters: null, variables: null };

/** 表名 → 我们的字段名（快照/ runtime 的 URL 里都带这些片段）。 */
const WANTED: Array<[keyof AssetTables, string]> = [
  ["backgrounds", "background.json"],
  ["characters", "character.json"],
  ["variables", "story_variables.json"],
];

/** 从 `data`（`Record<url, table>`）里挑出三张表。 */
export function pickAssetTables(data: Record<string, unknown> | null | undefined): AssetTables {
  if (!data) return EMPTY;
  const out: AssetTables = { backgrounds: null, characters: null, variables: null };
  for (const url of Object.keys(data)) {
    for (const [field, needle] of WANTED) {
      if (out[field] === null && url.includes(needle)) {
        const table = data[url];
        if (table && typeof table === "object") out[field] = table as Record<string, unknown>;
      }
    }
  }
  return out;
}

/** 一次性取表：内置快照优先（离线可用），失败再问 runtime。不抛。 */
export async function loadAssetTables(title?: string): Promise<AssetTables> {
  try {
    const pack = await loadBundledEngine();
    const fromPack = pickAssetTables(pack?.snapshot?.data as Record<string, unknown> | undefined);
    if (fromPack.backgrounds || fromPack.characters) return fromPack;
  } catch {
    // 快照缺失/损坏 → 走 runtime。
  }
  try {
    const runtime = (await loadStoryRuntime(title ?? "")) as { bundle?: { data?: Record<string, unknown> } } | null;
    return pickAssetTables(runtime?.bundle?.data);
  } catch {
    return EMPTY;
  }
}
