import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { resolveStageUrl } from "../../lib/stageCatalog";
import { getItem, setItem } from "../../lib/stateStore";
import {
  ASSET_KIND_IDS,
  ASSET_KIND_KEY,
  assetEntries,
  assetKindCounts,
  filterAssetEntries,
  groupAssetEntries,
  parseScriptAssetKeys,
  type AssetEntry,
  type AssetFilter,
  type AssetSort,
} from "../../lib/assetLibrary";

/**
 * 素材库面板（task-9）：**看**（缩略图 / 大图预览条）、**听**（音频试听）、
 * **拖**（到正文插 key、到舞台应用当前场景）、**导**（Tauri 下复制进包）、
 * **整**（收藏 + 只看随包 + 分组 + 搜索）。
 *
 * 数据源来自引擎目录表 + 当前脚本 + 包自带（`assetEntries` 在
 * `frontend/src/lib/assetLibrary.ts`，纯函数、裸 Node 有 50 条 selftest）。
 * 本组件只管**渲染与交互**：任何"插/应用"都回调给页面（页面走 `applyEdit` →
 * 撤销栈；面板自己不碰正文）。
 *
 * DOM 契约（harness `_asset-lib-check.mjs` 断言，**只增不改**）：
 * `[data-asset-lib="1"]` / `[data-asset-kind="<kind>"]`（= 当前类型栏选中项）
 * / `[data-asset-key="<key>"]`（每个格子）/ `[data-asset-thumb="1"]`
 * / `[data-asset-search="1"]`（输入框）/ `[data-asset-import="1"]`
 * / `[data-asset-preview="1"]`（预览条）。
 */

/** 引擎目录里的两张表（页面从 runtime 的 `data` 取来）。 */
export type AssetTable = Record<string, unknown> | null;

export interface AssetLibraryProps {
  /** `background.json`（`{key: ppu}`）。 */
  backgrounds?: AssetTable;
  /** `character.json`（`{base: {array: [{image}]}}`）。 */
  characters?: AssetTable;
  /** `story_variables.json`（`$name → Sound_…/x.mp3`，音频试听用）。 */
  variables?: Record<string, unknown> | null;
  /** 当前正文（抽 `[PlayMusic]/[PlaySound]/[Background]/[Character]` 的 key）。 */
  script: string;
  /** 包自带素材（`canonicalKey → 包内相对路径`）。 */
  packKeys?: Record<string, string> | null;
  /** 随包覆盖层能直接取到的 key。 */
  bundledKeys?: Iterable<string> | null;
  /** 当前包 id（导入用；缺省/空 = 不能导入）。 */
  packId?: string;
  /** 统一的图片来源（`resolveStageUrl` 的第二参；缺省 = 设置里的源）。 */
  source?: string;
  /** 插到正文光标处（页面 `applyEdit`，可撤销）。 */
  onInsertKey: (key: string) => void;
  /** 应用到当前场景（页面按 `kind` 决定改 `image=`/`name=`/`key=`）。 */
  onApplyToStage: (asset: AssetEntry) => void;
  /** 导入完成后刷新包自带清单。 */
  onImported?: (key: string) => void;
}

interface OrganizedState {
  favorites: string[];
  onlyBundled: boolean;
  favoritesOnly: boolean;
  sort: AssetSort;
  groupByKind: boolean;
}

const STORE_SCOPE = "workspace";
const STORE_KEY = "prts-asset-lib";

const EMPTY_STATE: OrganizedState = {
  favorites: [],
  onlyBundled: false,
  favoritesOnly: false,
  sort: "uses",
  groupByKind: false,
};

/** 读整理状态（坏 JSON → 默认，不抛）。 */
function readOrganized(): OrganizedState {
  try {
    const raw = getItem(STORE_SCOPE, STORE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<OrganizedState>;
    return {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter((v) => typeof v === "string") : [],
      onlyBundled: parsed.onlyBundled === true,
      favoritesOnly: parsed.favoritesOnly === true,
      sort: parsed.sort === "name" ? "name" : "uses",
      groupByKind: parsed.groupByKind === true,
    };
  } catch {
    return EMPTY_STATE;
  }
}

function writeOrganized(state: OrganizedState): void {
  try {
    setItem(STORE_SCOPE, STORE_KEY, JSON.stringify(state));
  } catch {
    // 无 storage（SSR / 隐私模式）：只影响"记得住"，不影响面板可用性。
  }
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 缩略图 URL：包自带优先（`asset://` 再回落到源），否则走 `resolveStageUrl`。
 *  `resolveStageUrl` 依赖 appSettings/react（浏览器里没问题；面板永远是浏览器侧）。 */
function thumbOf(entry: AssetEntry, source?: string): string {
  if (entry.file) return `asset://localhost/${encodeURI(entry.file)}`;
  try {
    return resolveStageUrl(entry.key, source);
  } catch {
    return "";
  }
}

/** 拖拽载荷：`text/plain`（给任何文本框）+ 私有 MIME（给舞台/正文判别）。 */
export const ASSET_MIME = "application/x-arkstage-asset";

export default function AssetLibrary({
  backgrounds = null,
  characters = null,
  variables = null,
  script,
  packKeys = null,
  bundledKeys = null,
  packId = "",
  source,
  onInsertKey,
  onApplyToStage,
  onImported,
}: AssetLibraryProps) {
  const tr = useT();
  const [organized, setOrganized] = useState<OrganizedState>(() => readOrganized());
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<AssetEntry["kind"] | "all">("all");
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [packMap, setPackMap] = useState<Record<string, string> | null>(packKeys ?? null);
  const refreshRef = useRef(onImported);
  refreshRef.current = onImported;

  useEffect(() => {
    writeOrganized(organized);
  }, [organized]);

  useEffect(() => {
    setPackMap(packKeys ?? null);
  }, [packKeys]);

  const scriptKeys = useMemo(() => parseScriptAssetKeys(script ?? ""), [script]);
  const entries = useMemo(
    () =>
      assetEntries({
        backgrounds,
        characters,
        variables,
        scriptKeys,
        packKeys: packMap,
        bundledKeys,
      }),
    [backgrounds, characters, variables, scriptKeys, packMap, bundledKeys]
  );

  const counts = useMemo(() => assetKindCounts(entries), [entries]);
  const shown = useMemo(() => {
    const filter: AssetFilter = {
      kind,
      query,
      onlyBundled: organized.onlyBundled,
      onlyFavorites: organized.favoritesOnly,
      favorites: organized.favorites,
      sort: organized.sort,
    };
    return filterAssetEntries(entries, filter);
  }, [entries, kind, query, organized]);
  const groups = useMemo(
    () => (organized.groupByKind ? groupAssetEntries(shown, "kind") : null),
    [organized.groupByKind, shown]
  );

  const active = useMemo(() => entries.find((entry) => entry.key === selected) ?? null, [entries, selected]);

  const toggleFavorite = useCallback((key: string) => {
    setOrganized((prev) => ({
      ...prev,
      favorites: prev.favorites.includes(key)
        ? prev.favorites.filter((value) => value !== key)
        : [...prev.favorites, key],
    }));
  }, []);

  const pick = useCallback(
    (event: React.DragEvent | React.MouseEvent, entry: AssetEntry) => {
      if (!event || !("dataTransfer" in event) || !event.dataTransfer) return;
      const payload = JSON.stringify({ kind: entry.kind, key: entry.key });
      try {
        event.dataTransfer.setData("text/plain", entry.key);
        event.dataTransfer.setData(ASSET_MIME, payload);
        event.dataTransfer.effectAllowed = "copy";
      } catch {
        // 某些 WebView 只允许 text/plain；正文/舞台都兜底读 text/plain。
      }
    },
    []
  );

  /** 导入：选文件 → 复制进包 → 合并 `build/assets.local.json` → 刷新清单。 */
  const importFiles = useCallback(async () => {
    if (!inTauri() || !packId) return;
    setBusy(true);
    setNotice("");
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const picked = await open({ multiple: true, title: tr("editor.assets.import", undefined, "导入…") });
      const files = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(
        (value): value is string => typeof value === "string"
      );
      if (!files.length) return;
      const merged: Record<string, string> = { ...(packMap ?? {}) };
      for (const file of files) {
        try {
          const result = await invoke<{ key: string; file: string }>("import_pack_asset", {
            id: packId,
            source: file,
            canonicalKey: null,
          });
          const name = String(result?.file ?? "").split(/[\\/]/).pop() ?? "";
          if (result?.key) merged[result.key] = `assets/${name}`;
          setNotice(tr("editor.assets.imported", { name }, `已导入 ${name}`));
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }
      setPackMap(merged);
      refreshRef.current?.(Object.keys(merged).slice(-1)[0] ?? "");
    } finally {
      setBusy(false);
    }
  }, [packId, packMap, tr]);

  const renderCell = (entry: AssetEntry) => {
    const favorite = organized.favorites.includes(entry.key);
    const isAudio = entry.kind === "music" || entry.kind === "sound";
    const url = entry.kind === "background" || entry.kind === "character" ? thumbOf(entry, source) : "";
    return (
      <button
        type="button"
        key={entry.key}
        className={`ed-asset-cell${selected === entry.key ? " on" : ""}`}
        data-asset-key={entry.key}
        data-asset-cell-kind={entry.kind}
        draggable
        title={entry.key}
        onClick={() => setSelected(entry.key)}
        onDragStart={(event) => pick(event, entry)}
      >
        <span className="ed-asset-mark" aria-hidden="true">
          {isAudio ? "♪" : favorite ? "★" : entry.bundled ? "◆" : "◇"}
        </span>
        {url ? (
          <span className="ed-asset-thumb" data-asset-thumb="1" data-asset-thumb-kind={entry.kind}>
            <img className="ed-asset-img" src={url} alt="" loading="lazy" draggable={false} />
          </span>
        ) : (
          <span className="ed-asset-thumb" data-asset-thumb="1">
          <span className="ed-asset-glyph">{entry.kind === "background" ? "▤" : entry.kind === "character" ? "☻" : "♪"}</span>
          </span>
        )}
        <em className="ed-asset-label">{entry.label}</em>
        {entry.uses > 0 && <small className="ed-asset-uses">{tr("editor.assets.uses", { n: entry.uses }, `用量 ${entry.uses}`)}</small>}
        <span
          className={`ed-asset-star${favorite ? " on" : ""}`}
          data-asset-fav={favorite ? "1" : "0"}
          role="button"
          aria-label={tr("editor.assets.favorite", undefined, "收藏")}
          onClick={(event) => {
            event.stopPropagation();
            toggleFavorite(entry.key);
          }}
        >
          ★
        </span>
      </button>
    );
  };

  return (
    <div className="ed-assets" data-asset-lib="1">
      <div className="ed-assets-bar">
        <input
          className="ed-assets-search"
          data-asset-search="1"
          value={query}
          placeholder={tr("editor.assets.search", undefined, "搜索 key / 文件名")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="ed-assets-btn"
          data-asset-import="1"
          disabled={!inTauri() || !packId || busy}
          title={inTauri() && packId ? undefined : tr("editor.assets.onlyDesktop", undefined, "导入需要桌面版（Tauri）。")}
          onClick={() => void importFiles()}
        >
          {busy ? tr("editor.assets.importing", undefined, "导入中…") : tr("editor.assets.import", undefined, "导入…")}
        </button>
        <button
          type="button"
          className={`ed-assets-btn${organized.onlyBundled ? " on" : ""}`}
          aria-pressed={organized.onlyBundled}
          onClick={() => setOrganized((prev) => ({ ...prev, onlyBundled: !prev.onlyBundled }))}
        >
          {tr("editor.assets.onlyBundled", undefined, "只看随包")}
        </button>
        <button
          type="button"
          className={`ed-assets-btn${organized.favoritesOnly ? " on" : ""}`}
          aria-pressed={organized.favoritesOnly}
          onClick={() => setOrganized((prev) => ({ ...prev, favoritesOnly: !prev.favoritesOnly }))}
        >
          {tr("editor.assets.organize", undefined, "整理")}
        </button>
        <button
          type="button"
          className={`ed-assets-btn${organized.groupByKind ? " on" : ""}`}
          aria-pressed={organized.groupByKind}
          onClick={() => setOrganized((prev) => ({ ...prev, groupByKind: !prev.groupByKind }))}
        >
          {tr("editor.assets.groupByKind", undefined, "按类型分组")}
        </button>
        <button
          type="button"
          className="ed-assets-btn"
          onClick={() =>
            setOrganized((prev) => ({ ...prev, sort: prev.sort === "uses" ? "name" : "uses" }))
          }
        >
          {organized.sort === "uses"
            ? tr("editor.assets.sortUses", undefined, "按用量")
            : tr("editor.assets.sortName", undefined, "按名称")}
        </button>
      </div>

      <div className="ed-assets-kinds">
        <button
          type="button"
          className={`ed-assets-kind${kind === "all" ? " on" : ""}`}
          data-asset-kind="all"
          aria-pressed={kind === "all"}
          onClick={() => setKind("all")}
        >
          {tr("editor.assets.kindAll", undefined, "全部")}
          <small>{counts.all}</small>
        </button>
        {ASSET_KIND_IDS.map((id) => (
          <button
            type="button"
            key={id}
            className={`ed-assets-kind${kind === id ? " on" : ""}`}
            data-asset-kind={id}
            aria-pressed={kind === id}
            onClick={() => setKind(id)}
          >
            {tr(`editor.assets.${ASSET_KIND_KEY[id]}`, undefined, id)}
            <small>{counts[id]}</small>
          </button>
        ))}
      </div>

      {notice && <div className="ed-assets-notice" role="status">{notice}</div>}

      {script !== undefined && entries.length === 0 ? (
        <div className="ed-assets-empty" data-asset-empty="1">
          {tr("editor.assets.needTable", undefined, "素材表还没就绪（打开过一个剧本后可用）。")}
        </div>
      ) : shown.length === 0 ? (
        <div className="ed-assets-empty">{tr("editor.assets.empty", undefined, "没有匹配的素材。")}</div>
      ) : groups ? (
        <div className="ed-assets-groups">
          {groups.map((group) => (
            <section className="ed-assets-group" key={group.kind ?? "flat"} data-asset-group={group.kind ?? "flat"}>
              <h4>
                {group.kind
                  ? tr(`editor.assets.${ASSET_KIND_KEY[group.kind]}`, undefined, group.kind)
                  : tr("editor.assets.title", undefined, "素材库")}
                <small>{group.entries.length}</small>
              </h4>
              <div className="ed-assets-grid">{group.entries.map(renderCell)}</div>
            </section>
          ))}
        </div>
      ) : (
        <div className="ed-assets-grid">{shown.map(renderCell)}</div>
      )}

      <div
        className="ed-assets-preview"
        data-asset-preview="1"
        data-asset-selected={active?.key ?? ""}
      >
        {active ? (
          <>
            <div className="ed-assets-preview-main">
              <b>{active.key}</b>
              <span>
                {tr(`editor.assets.${ASSET_KIND_KEY[active.kind]}`, undefined, active.kind)}
                {active.bundled ? ` · ${tr("editor.assets.bundled", undefined, "随包")}` : ""}
                {active.uses > 0 ? ` · ${tr("editor.assets.uses", { n: active.uses }, `用量 ${active.uses}`)}` : ""}
              </span>
            </div>
            {(active.kind === "music" || active.kind === "sound") && active.audioUrl && (
              <audio className="ed-assets-audio" data-asset-audio="1" controls preload="none" src={active.audioUrl} />
            )}
            <div className="ed-assets-preview-actions">
              <button type="button" className="ed-assets-btn primary" data-asset-insert="1" onClick={() => onInsertKey(active.key)}>
                {tr("editor.assets.insertKeyAtCaret", undefined, "插入 key")}
              </button>
              <button type="button" className="ed-assets-btn" data-asset-apply="1" onClick={() => onApplyToStage(active)}>
                {tr("editor.assets.applyToStage", undefined, "应用到舞台")}
              </button>
            </div>
          </>
        ) : (
          <span className="ed-assets-hint">
            {tr("editor.assets.dragHint", undefined, "拖到正文＝插入 key；拖到舞台＝应用到当前场景。")}
          </span>
        )}
      </div>
    </div>
  );
}
