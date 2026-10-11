/**
 * `frontend/src/i18n/index.ts` —— 极简 i18n 入口（**零新增依赖**）。
 *
 * 选型说明：LangBot 的 `web/src/i18n/index.ts` 用 i18next + react-i18next +
 * LanguageDetector；arkstage 只要两种语言、且**目录/文件的拆分方式**才是要照抄的
 * 东西（`locales/<lang>.ts` 根 + `locales/<ns>/<lang>.ts` 命名空间子目录），
 * 所以这里保留同一套「resources 汇总 + fallbackLng + localStorage 记忆」的语义，
 * 但用 ~100 行原生实现，避免给桌面端多引三个运行时依赖。
 *
 * 语义（与 i18next 对齐的部分）：
 * - 语言表 `LOCALES`（`zh-Hans` / `en-US`）、显示名 `LOCALE_LABELS`；
 * - `FALLBACK_LOCALE = "zh-Hans"`：当前语言缺键 → 回落；
 * - `localStorage: prts-language`（对应 LangBot 的 `langbot_language`）：读写 + 变更广播；
 * - `translate(locale, key, vars)`：`a.b.c` 点路径、`{{var}}` 插值、
 *   回退链「当前 → fallback → `defaultValue` → key 末段」，**永不抛**；
 * - `t()` —— 页面里沿用（依赖 `subscribe` 触发重渲染）；`useLocale()` / `useT()` —— hook。
 *
 * 纯逻辑在 `./lib.ts`（Node 里可直接 import，供 selftest 用）；本文件只做
 * React 绑定（`useSyncExternalStore`），照 `frontend/src/lib/uiSettings.ts` 的写法。
 */

import { useSyncExternalStore } from "react";

import enUS from "./locales/en-US.ts";
import zhHans from "./locales/zh-Hans.ts";
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  LOCALES,
  LOCALE_LABELS,
  LOCALE_STORAGE_KEY,
  createI18n,
  isLocale,
  type Locale,
} from "./lib.ts";

export type { Locale };
export { DEFAULT_LOCALE, FALLBACK_LOCALE, LOCALES, LOCALE_LABELS, LOCALE_STORAGE_KEY, isLocale };

/** `resources` 汇总（照 LangBot：`{ 'en-US': {...}, 'zh-Hans': {...} }`，命名空间已由根文件展开）。 */
export const resources: Record<Locale, Record<string, unknown>> = {
  "en-US": enUS,
  "zh-Hans": zhHans,
};

const i18n = createI18n(resources);

/** `useT()` 的**稳定**函数身份：每个语言一个包装（`current === next` 时原样返回）。 */
const boundT = new Map<Locale, (key: string, vars?: Record<string, string | number>, defaultValue?: string) => string>();

function translatorFor(locale: Locale) {
  let fn = boundT.get(locale);
  if (!fn) {
    fn = (key, vars, defaultValue) => translate(locale, key, vars, defaultValue);
    boundT.set(locale, fn);
  }
  return fn;
}

/** 翻译（`vars` 用于 `{{var}}`；`defaultValue` 是回退链的最后一格，迁移期一律传原文）。 */
export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
  defaultValue?: string,
): string {
  return i18n.translate(locale, key, vars, defaultValue);
}

/** 当前语言（`localStorage` 缺失/非法 → `DEFAULT_LOCALE`）。 */
export function getLocale(): Locale {
  return i18n.getLocale();
}

/** 切换语言：写 `localStorage: prts-language` 并广播（非法值按 `DEFAULT_LOCALE` 存）。 */
export function setLocale(next: Locale): void {
  i18n.setLocale(next);
}

/** 订阅语言变更（`setLocale` 后逐个调用；返回退订函数）。 */
export function subscribeLocale(listener: () => void): () => void {
  return i18n.subscribe(listener);
}

/** React hook：当前语言（变更即重渲染）。 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

/**
 * React hook：翻译函数。依赖 `useLocale()`，语言一变，用了 `t` 的组件整体重渲染；
 * 同语言内**引用稳定**（`useMemo`/`useCallback` 里可以安全依赖它）。
 */
export function useT(): (key: string, vars?: Record<string, string | number>, defaultValue?: string) => string {
  const locale = useLocale();
  return translatorFor(locale);
}

/** 页面/组件里可直接用的翻译（依赖订阅触发重渲染；`t` = 当前语言）。 */
export function t(
  key: string,
  vars?: Record<string, string | number>,
  defaultValue?: string,
): string {
  return i18n.translate(i18n.getLocale(), key, vars, defaultValue);
}

export default i18n;
