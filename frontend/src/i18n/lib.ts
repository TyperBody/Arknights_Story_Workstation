/**
 * `frontend/src/i18n/lib.ts` —— i18n 的**纯逻辑**（无 React、无副作用），
 * 供 `./index.ts`（React 绑定）与 Node 下的 selftest / checker 直接 import。
 *
 * 键空间形状与 LangBot 一致：`resources[locale]` 是根文件的默认导出
 * （`{ common, editor }`），命名空间由根文件从 `locales/<ns>/<lang>.ts` 展开，
 * 所以键路径就是 `editor.palette.hint` 这种「命名空间点路径」。
 */

/** 支持的语言（顺序 = 语言开关里的展示顺序）。 */
import { getItem, setItem } from "../lib/stateStore";

export const LOCALES = ["zh-Hans", "en-US"] as const;

export type Locale = (typeof LOCALES)[number];

/** 缺省语言 = 简体中文（参考语言）。 */
export const DEFAULT_LOCALE: Locale = "zh-Hans";

/** 回退语言（照 i18next 的 `fallbackLng`）。 */
export const FALLBACK_LOCALE: Locale = "zh-Hans";

/** `localStorage` 键（对应 LangBot 的 `langbot_language`）。 */
export const LOCALE_STORAGE_KEY = "prts-language";

/** 语言开关的显示名（下拉/按钮）。 */
export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-Hans": "简体中文",
  "en-US": "English",
};

/** 类型守卫：任意字符串 → `Locale`（非法值一律回落 `DEFAULT_LOCALE`）。 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** `a.b.c` 点路径取值；对象中间缺一层 → `undefined`（不抛）。 */
export function resolvePath(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object" || !key) return undefined;
  let cursor: unknown = source;
  for (const part of key.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** 取命名空间（`translations` 的命名空间名）；`sub` 缺省 = 整个命名空间对象。 */
export function pickNamespace(root: unknown, namespace: string): unknown {
  if (!namespace) return root;
  const slash = namespace.indexOf("/");
  if (slash < 0) return resolvePath(root, namespace);
  const head = resolvePath(root, namespace.slice(0, slash));
  return resolvePath(head, namespace.slice(slash + 1));
}

/** `{{var}}` 插值：缺失的变量原样保留，便于一眼看出没传。 */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** 键的末段（回退链最后一格：`editor.palette.hint` → `hint`）。 */
export function lastSegment(key: string): string {
  const parts = key.split(".");
  return parts[parts.length - 1] ?? key;
}

/**
 * **回退链**：完整键（当前语言）→ 命名空间子路径 + 完整键（当前语言）
 * → 同上两条（`FALLBACK_LOCALE`）→ `parts[0]` 命名空间裸键
 * → `parts[1..]` 相对键 → `defaultValue`（原文）→ 键末段。
 */
export function resolve(
  resources: Record<string, Record<string, unknown>>,
  locale: Locale,
  key: string,
  namespace = "",
  defaultValue?: string,
): string {
  const parts = key.split(".");
  const relative = parts.length > 1 ? parts.slice(1).join(".") : "";
  const chain: Array<{ locale: Locale; path: string }> = [];
  for (const candidate of [locale, FALLBACK_LOCALE]) {
    chain.push({ locale: candidate, path: key });
    if (namespace.trim()) chain.push({ locale: candidate, path: `${namespace.trim()}/${key}` });
  }
  for (const entry of chain) {
    const root = resources[entry.locale];
    if (!root) continue;
    const value = resolvePath(pickNamespace(root, namespace.trim()), entry.path);
    if (typeof value === "string") return value;
  }
  // 话题裸键（LangBot 里 `t("机器人")` 这类无点键）与相对键。
  for (const candidate of [locale, FALLBACK_LOCALE]) {
    const root = resources[candidate];
    if (!root) continue;
    for (const path of [parts[0], relative]) {
      if (!path) continue;
      const value = resolvePath(root, path);
      if (typeof value === "string") return value;
    }
  }
  if (defaultValue !== undefined) return defaultValue;
  return lastSegment(key);
}

export interface I18n {
  translate(
    locale: Locale,
    key: string,
    vars?: Record<string, string | number>,
    defaultValue?: string,
  ): string;
  getLocale(): Locale;
  setLocale(next: Locale): void;
  subscribe(listener: () => void): () => void;
}

/**
 * 建一个 i18n 实例：`resources` + 语言记忆（`state.db` 的 `scope=app`，
 * 键仍是 `prts-language`；无 Tauri / DB 坏 → 自动回落 `localStorage`）+ 变更订阅。
 *
 * 纯 Node（selftest / checker）里 `stateStore` 只在内存里记 —— 语言仍可切换，
 * 只是不跨进程保留（与旧 `localStorage` 缺席时的行为一致）。
 */
export function createI18n(
  resources: Record<string, Record<string, unknown>>,
  storageKey: string = LOCALE_STORAGE_KEY,
): I18n {
  const listeners = new Set<() => void>();
  let current: Locale = DEFAULT_LOCALE;

  /** 存储适配：`state.db`（scope=app）+ localStorage 兜底，全部 try/catch。 */
  const store = {
    read(): string | null {
      try {
        return getItem("app", storageKey);
      } catch {
        return null; // 隐私模式 / 存储被禁
      }
    },
    write(value: string): void {
      try {
        setItem("app", storageKey, value);
      } catch {
        /* 写失败：内存里已生效 */
      }
    },
  };

  try {
    const saved = store.read();
    if (isLocale(saved)) current = saved;
  } catch {
    // 读失败按缺省语言
  }

  return {
    translate(locale, key, vars, defaultValue) {
      return interpolate(
        resolve(resources, isLocale(locale) ? locale : DEFAULT_LOCALE, key, "", defaultValue),
        vars,
      );
    },
    getLocale: () => current,
    setLocale(next) {
      current = isLocale(next) ? next : DEFAULT_LOCALE;
      store.write(current);
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
