/**
 * engineCatalog.ts — P1 的源目录（TypeScript 包装）。
 *
 * 纯实现（含 `catalog-data.json` 的解析/缓存）在 `src/akstage/engineCatalog.js`
 * ——离线脚本（`tools/mirror/mirror-selftest.mjs`）与前端共用同一份。
 * 这里只做**类型**与再导出；`readEnginePack()` 单独走 `enginePack.ts`（Tauri 命令）。
 *
 * 契约见 BRIEF-workbench-v1 §2.6 / §3 决策 3。
 */

import { useSyncExternalStore } from "react";

import {
  catalog as rawCatalog,
  catalogSummary,
  engineEntries,
  entryFor,
  guessKind,
  kindOf,
  mirrorOf,
  missingKeys,
  projectManifest,
  TABLE_URLS,
  urlsFor,
} from "../../../src/akstage/engineCatalog.js";
import { getAppSettings } from "./appSettings";
import { readEnginePack as readPack } from "./enginePack";

export type { EnginePackInfo } from "./enginePack";

/** 目录条目分类。 */
export type CatalogKind = "src" | "css" | "js" | "font" | "data";

export interface CatalogEntry {
  id: string;
  label: string;
  kind: CatalogKind;
  /** canonical key（`host/path`；与 Rust 磁盘缓存的键一致）。 */
  key: string;
  /** 可用直链（官方 + jsDelivr/Fastly/gh-proxy；自定义源见 `mirrorUrl(source, raw, tpl)`）。 */
  urls: string[];
  /** 上游已知字节数（0 = 未知）。 */
  size: number;
}

export interface CatalogSummary {
  entries: number;
  engine: number;
  byKind: Record<CatalogKind, number>;
  /** `src/akstage/engineCatalog.js::catalogSummary()` 的版本串（`catalog:<n>`）。 */
  version: string;
  /** 可走镜像的 host（`assetRouting.js::MIRRORABLE_HOSTS`）；JS 实现里叫 `mirrorableHosts`。 */
  mirrorableHosts?: readonly string[];
  /** 目录首条的生成时间（可选：离线目录不带）。 */
  generatedAt?: string;
  sources: readonly string[];
}

/** 源目录（进程内缓存；含引擎代、上游 3 表、剧情变量、背景、立绘）。 */
export function catalog(): CatalogEntry[] {
  return rawCatalog() as CatalogEntry[];
}

/**
 * 用某个**源**把 `raw`（URL / canonical key）改写为下载地址；
 * 该源不适用 → `null`（例：非镜像 host 走 jsDelivr；自定义源缺模板）。
 *
 * `custom` 模板缺省读设置里的 `customMirror`（`prts-app-settings`）。
 */
export function mirrorUrl(source: string, raw: string, custom?: string): string | null {
  if (source === "custom") {
    const tpl = (custom ?? customMirrorFromSettings()).trim();
    if (!tpl) return null;
    return mirrorWithTemplate(raw, tpl);
  }
  return mirrorOf(raw, source);
}

/** `{url}` / `{key}` / `{host}` / `{path}` 模板展开（与离线脚本同一套语义）。 */
export function mirrorWithTemplate(raw: string, template: string): string | null {
  const value = template.trim();
  if (!value) return null;
  const url = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  const body = url.replace(/^https?:\/\//, "");
  const slash = body.indexOf("/");
  if (slash <= 0) return null;
  const host = body.slice(0, slash);
  const path = body.slice(slash + 1);
  const out = value
    .replaceAll("{url}", url)
    .replaceAll("{key}", body)
    .replaceAll("{host}", host)
    .replaceAll("{path}", path);
  return /^https?:\/\/\S+$/.test(out) ? out : null;
}

/** 设置里的自定义镜像模板（无 localStorage → `""`）。 */
export function customMirrorFromSettings(): string {
  try {
    return getAppSettings().customMirror;
  } catch {
    return "";
  }
}

/**
 * 「下载引擎」的清单：`{ files: { canonicalKey: { url, mirrorUrls[], size, kind } }, total }`。
 *
 * 缺省选择集 = `engine`（引擎层全部，含 widget 引擎代与 scenario 资源）；
 * `tables` 可带上要一起下载的舞台素材/变量。
 */
export function projectEngineManifest(
  selection: string[] = ["engine"],
  tables?: { characters?: string[]; backgrounds?: string[]; links?: string[]; variables?: string[] },
): { files: Record<string, { url: string; mirrorUrls: string[]; size: number; kind: CatalogKind }>; total: number } {
  return projectManifest(selection, tables) as ReturnType<typeof projectEngineManifest>;
}

/** 随包引擎快照信息（Rust `engine_pack_info`）；非 Tauri 运行时 → `null`。 */
export function readEnginePack(): Promise<{ version: string; keys: string[]; files: number } | null> {
  return readPack().then((info) => (info ? { version: info.version, keys: info.keys, files: info.files } : null));
}

/** React hook：目录摘要（设置页展示「已收录 N 条」；目录本身是静态数据，不会变）。 */
export function useCatalogSummary(): CatalogSummary {
  return useSyncExternalStore(
    () => () => {},
    () => catalogSummary() as unknown as CatalogSummary,
  );
}

export { catalogSummary, engineEntries, entryFor, guessKind, kindOf, missingKeys, projectManifest, TABLE_URLS, urlsFor };
export type { CatalogSummary as CatalogSummaryShape };

