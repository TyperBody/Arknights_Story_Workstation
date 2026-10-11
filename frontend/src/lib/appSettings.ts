import { getItem, setItem } from "./stateStore";
import { useSyncExternalStore } from "react";

/**
 * 应用级设置（下载源 / 并发 / 限速 / 引擎自更新 / 横幅关闭记录）。
 *
 * 存储：**SQLite `state.db`**（`scope=app`, key=`prts-app-settings`，单个 JSON 对象；
 * 由 `stateStore` 统一读写，无 Tauri/DB 坏时自动回落 `localStorage` 同名键）。
 * 纪律（BRIEF §3.2 / §3.3）：
 * - **坏数据永不抛**：坏 JSON、缺字段、类型不对、越界 → 逐字段回落默认值；
 * - 读取/写入都用 try/catch 包住（隐私模式 / 存储被禁时也能用，只是不持久）；
 * - 白名单字段：未知键忽略；`setAppSettings` 只接受 patch，永远返回**完整**对象。
 *
 * 默认值：下载并发 12（1…32）、manifest 抓取并发 10（1…16）、限速 0 = 不限速。
 */

const STORAGE_KEY = "prts-app-settings";

/** 素材下载源。`pack` = 随包快照 + 官方直连（默认，不断网也能用）。 */
export type MirrorSource = "pack" | "prts" | "jsd" | "fastly" | "ghproxy" | "custom";

/** 舞台素材来源（透传给 P2 的 `stageCatalog`；本模块只负责存取）。 */
export type StageSource = string;

export interface AppSettings {
  /** 素材下载源（默认 `pack`）。 */
  mirror: MirrorSource;
  /** 自定义镜像模板（`{url}` = 原始直链，`{key}` = 规范化 key）。`custom` 源用。 */
  customMirror: string;
  /** 下载并发（1…32，默认 30）。 */
  downloadConcurrency: number;
  /** manifest 抓取并发（1…16，默认 10）。 */
  manifestConcurrency: number;
  /** 限速字节/秒（0 = 不限速，默认 0）。 */
  rateLimit: number;
  /** 引擎是否随上游自动更新（默认 true；关 = 只用随包快照）。 */
  engineAutoUpdate: boolean;
  /** 已手动关掉的一次性横幅 id（同 id 不再弹）。 */
  bannerDismissed: string[];
  /** 舞台素材来源（P2 读写；缺失 = ""）。 */
  stageSource: StageSource;
}

export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  mirror: "pack",
  customMirror: "",
  downloadConcurrency: 30,
  manifestConcurrency: 10,
  rateLimit: 0,
  engineAutoUpdate: true,
  bannerDismissed: [],
  stageSource: "",
});

/** 并发取值域（设置页滑杆与这里共用；越界一律 clamp）。 */
export const DOWNLOAD_CONCURRENCY_MIN = 1;
export const DOWNLOAD_CONCURRENCY_MAX = 32;
export const MANIFEST_CONCURRENCY_MIN = 1;
export const MANIFEST_CONCURRENCY_MAX = 16;

// 与 `src/akstage/assetRouting.js::SOURCE_IDS` / Rust `media::SOURCE_IDS` 一致
// （`prts` = 官方直连；镜像模板表在 assetRouting.js）。
const MIRROR_VALUES: readonly MirrorSource[] = ["pack", "prts", "jsd", "fastly", "ghproxy", "custom"];
const BANNER_CAP = 64;
const MAX_URL_LEN = 512;

let cache: AppSettings = DEFAULT_SETTINGS;
let cacheRaw: string | null = null;
let cacheLoaded = false;
const listeners = new Set<() => void>();

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readString(value: unknown, maxLen = MAX_URL_LEN): string {
  return typeof value === "string" ? value.trim().slice(0, maxLen) : "";
}

/** 一份 JSON 原始值 → 规范设置（**纯函数**，坏值逐字段回落）。 */
export function normalize(raw: unknown): AppSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mirror: MirrorSource = MIRROR_VALUES.includes(o.mirror as MirrorSource)
    ? (o.mirror as MirrorSource)
    : DEFAULT_SETTINGS.mirror;
  const banners = Array.isArray(o.bannerDismissed)
    ? o.bannerDismissed
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.trim().slice(0, 120))
        .slice(0, BANNER_CAP)
    : DEFAULT_SETTINGS.bannerDismissed;
  return {
    mirror,
    customMirror: readString(o.customMirror),
    downloadConcurrency: clampInt(
      o.downloadConcurrency,
      DOWNLOAD_CONCURRENCY_MIN,
      DOWNLOAD_CONCURRENCY_MAX,
      DEFAULT_SETTINGS.downloadConcurrency,
    ),
    manifestConcurrency: clampInt(
      o.manifestConcurrency,
      MANIFEST_CONCURRENCY_MIN,
      MANIFEST_CONCURRENCY_MAX,
      DEFAULT_SETTINGS.manifestConcurrency,
    ),
    rateLimit: clampInt(o.rateLimit, 0, Number.MAX_SAFE_INTEGER, DEFAULT_SETTINGS.rateLimit),
    engineAutoUpdate: typeof o.engineAutoUpdate === "boolean"
      ? o.engineAutoUpdate
      : DEFAULT_SETTINGS.engineAutoUpdate,
    bannerDismissed: banners,
    stageSource: readString(o.stageSource, 120),
  };
}

function parseText(text: string | null): AppSettings {
  if (!text) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(text);
    return normalize(parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** 当前设置（**总是**返回一份完整、可用的对象；模块级缓存 + 原始串比对）。 */
export function getAppSettings(): AppSettings {
  let text: string | null = null;
  try {
    text = getItem("app", STORAGE_KEY);
  } catch {
    text = cacheRaw; // 存储不可用：沿用内存里的最后一版
  }
  if (!cacheLoaded || text !== cacheRaw) {
    cacheRaw = text;
    cache = parseText(text);
    cacheLoaded = true;
  }
  return cache;
}

/** 合并写入（`patch` 里 `undefined` 的字段保持不动）。返回写入后的完整设置。 */
export function setAppSettings(patch: Partial<AppSettings>): AppSettings {
  const before = getAppSettings();
  const merged: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key in DEFAULT_SETTINGS) merged[key] = value;
  }
  const next = normalize(merged);
  const text = JSON.stringify(next);
  cache = next;
  cacheRaw = text;
  cacheLoaded = true;
  try {
    setItem("app", STORAGE_KEY, text);
  } catch {
    /* 落库失败 / 隐私模式：内存里仍然生效 */
  }
  listeners.forEach((l) => l());
  return next;
}

/** 一次性横幅：`true` = 已被用户关过（不再弹）。 */
export function isBannerDismissed(id: string): boolean {
  return getAppSettings().bannerDismissed.includes(String(id));
}

/** 记住「这个横幅被关过了」（幂等，最多记 64 条）。 */
export function dismissBanner(id: string): AppSettings {
  const key = String(id ?? "").trim().slice(0, 120);
  if (!key) return getAppSettings();
  const before = getAppSettings();
  if (before.bannerDismissed.includes(key)) return before;
  return setAppSettings({ bannerDismissed: [...before.bannerDismissed, key] });
}

/** 供非 React 场景（离线脚本 / 测试）复位进程内缓存。 */
export function resetAppSettingsCache(): void {
  cache = DEFAULT_SETTINGS;
  cacheRaw = null;
  cacheLoaded = false;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook：订阅完整设置对象（用 `useSyncExternalStore`，跨组件即时同步）。 */
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribe, getAppSettings);
}
