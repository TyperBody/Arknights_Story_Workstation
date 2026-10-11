/**
 * `stateStore.ts` —— **本机"记忆"的唯一前端入口**（SQLite 后端 + localStorage 兜底）。
 *
 * 为什么不是 `localStorage`：`localStorage` 活在 WebView 的 session 里 ——
 * 清缓存、换 WebView、重装、Android 的"清除数据"都会丢；而"工作台排版 / 面板开关 /
 * 语言 / 已读"是**用户状态**，不该跟缓存同生共死。后端见
 * `src-tauri/src/state_db.rs`（`<资源目录>/state.db`，SQLite；清「缓存」不会清它）。
 *
 * ## 形状（**同步读 + 异步写**）
 * 页面初始化时 `hydrate()` 会把整个 scope **一次拉进内存**（`state_db_snapshot`），
 * 之后 `getItem(scope, key)` 是**同步**的 —— 这样 `uiSettings` / `workbenchLayout`
 * 这类"渲染期就要读"的模块不用改成 async；`setItem` 先更新内存（立刻可见）再
 * **异步**落库（合并 50ms 内的连续写，避免拖分隔条时每帧一次 IPC）。
 *
 * ## 降级
 * 1. 无 Tauri（纯浏览器 dev / 探针） → 直接用 `localStorage`（旧行为）；
 * 2. Tauri 里 DB 打开失败（损坏/只读/配额） → `invoke` 失败后**自动回落到
 *    `localStorage`**（`backend` 字段可查，`stateStore.info()` 供诊断）；
 * 3. `localStorage` 也不可用（隐私模式） → 纯内存（本次会话有效）。
 *
 * ## 旧数据迁移
 * `hydrate()` 里对每个**已注册**的 scope 调一次 `state_db_import`：
 * 把 `localStorage` 里已有的键搬进 DB（**只在 DB 没有该键时**，DB 优先）。
 * 迁移是一次性的（`prts-state-migrated:<scope>` 标记），回滚安全。
 *
 * 键名沿用各模块原来的字符串（`prts-editor-wb:default` / `prts-language` …），
 * 放进 `state.db` 后仍是同一批字符串 —— 迁移与排障都不用换脑子。
 */

import { invoke } from "@tauri-apps/api/core";

export type StateScope = string;

/** 已注册的 scope → 它们的"旧 localStorage 前缀"（用于一次性迁移）。 */
const SCOPES: Record<StateScope, string[]> = {
  workspace: ["prts-editor-wb:", "prts-editor-windows:"],
  ui: ["prts-player-chrome", "prts-hide-player-back", "prts-nickname"],
  player: ["prts-debug-console", "prts-debug-console-size", "prts-download-settings"],
  app: ["prts-app-settings", "prts-language"],
  library: ["arkstage-read-stories", "arkstage-last-watched"],
};

type Backend = "sqlite" | "localstorage" | "memory" | "unknown";

const memory = new Map<string, Map<string, string>>();
/** 已从 DB 取过快照的 scope（这些 scope 的 localStorage 值不再覆盖内存）。 */
const dbLoaded = new Set<StateScope>();
let backend: Backend = "unknown";
let hydratePromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** 当前后端（诊断/自检用；`hydrate` 之前是 `unknown`）。 */
export function stateBackend(): Backend {
  return backend;
}

/** 已 hydrate 的 scope 快照（诊断用）。 */
export function hydratedScopes(): StateScope[] {
  return [...dbLoaded];
}

/** 兼容 Tauri 缺席：`invoke` 在纯浏览器里会抛。 */
function inTauri(): boolean {
  const w = globalThis as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

function scopeMap(scope: StateScope): Map<string, string> {
  let map = memory.get(scope);
  if (!map) {
    map = new Map();
    memory.set(scope, map);
  }
  return map;
}

function ls(): Storage | null {
  try {
    const g = globalThis as { window?: { localStorage?: Storage }; localStorage?: Storage };
    const store = g.window?.localStorage ?? g.localStorage;
    return store && typeof store.getItem === "function" ? store : null;
  } catch {
    return null;
  }
}

/** 各模块历史键 + 本 store 直接读写时的 localStorage 回退键（同名，便于互认）。 */
function legacyKey(scope: StateScope, key: string): string {
  return key.includes(":") ? key : `${scope}:${key}`;
}

/**
 * 打开后端 + 把已注册 scope 拉进内存。**幂等**；并发调用共享同一个 promise。
 * 无 Tauri → `localstorage`（同步完成，`hydrate` 立即 resolve）。
 */
/** 同步播种：把 `localStorage` 里属于已注册 scope 的键读进内存。
 *  目的：`workbenchLayout` / `uiSettings` 这类**渲染期同步读**的模块，
 *  在 DB hydrate 完成前也能拿到值（首次升级时这些值就是旧数据；DB 到了会覆盖）。 */
function seedFromLocalStorage(): void {
  const store = ls();
  if (!store) return;
  for (const [scope, prefixes] of Object.entries(SCOPES)) {
    const map = scopeMap(scope);
    for (let i = 0; i < store.length; i += 1) {
      const raw = store.key(i);
      if (!raw) continue;
      if (!prefixes.some((prefix) => raw.startsWith(prefix))) continue;
      const value = store.getItem(raw);
      // DB 快照还没到 → localStorage 的值先顶上；`dbLoaded` 之后由 DB 覆盖。
      if (value != null && !dbLoaded.has(scope)) map.set(raw, value);
    }
  }
}

export function hydrate(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  seedFromLocalStorage(); // 同步：先让"读"有值
  hydratePromise = (async () => {
    if (!inTauri()) {
      backend = ls() ? "localstorage" : "memory";
      for (const scope of Object.keys(SCOPES)) dbLoaded.add(scope);
      // 无 SQLite：把 localStorage 读进内存镜像（同一套 getItem 语义）。
      for (const scope of Object.keys(SCOPES)) {
        const map = scopeMap(scope);
        for (const key of Object.keys(ls() ?? {})) void key; // 枚举在下面用 length/key(i)
        const store = ls();
        if (!store) continue;
        for (let i = 0; i < store.length; i += 1) {
          const raw = store.key(i);
          if (!raw) continue;
          if (SCOPES[scope].some((prefix) => raw.startsWith(prefix))) {
            const value = store.getItem(raw);
            if (value != null) map.set(raw, value);
          }
        }
      }
      return;
    }
    try {
      for (const [scope, prefixes] of Object.entries(SCOPES)) {
        const entries = await invoke<Array<{ key: string; value: string }>>("state_db_snapshot", { scope });
        const map = scopeMap(scope);
        for (const key of [...map.keys()]) if (!entries.some((e) => e.key === key)) map.delete(key);
        for (const entry of entries) map.set(entry.key, entry.value);
        dbLoaded.add(scope);
        await importLegacy(scope, prefixes, map);
      }
      backend = "sqlite";
      for (const scope of Object.keys(SCOPES)) dbLoaded.add(scope);
      listeners.forEach((l) => l());
    } catch (error) {
      backend = ls() ? "localstorage" : "memory";
      for (const scope of Object.keys(SCOPES)) dbLoaded.add(scope);
      console.warn("[stateStore] SQLite 不可用，回落到 localStorage：", error);
      for (const scope of Object.keys(SCOPES)) {
        const map = scopeMap(scope);
        const store = ls();
        if (!store) continue;
        for (let i = 0; i < store.length; i += 1) {
          const raw = store.key(i);
          if (!raw) continue;
          if (SCOPES[scope].some((prefix) => raw.startsWith(prefix))) {
            const value = store.getItem(raw);
            if (value != null) map.set(raw, value);
          }
        }
      }
    }
  })();
  return hydratePromise;
}

/** 已 hydrate 的 scope（诊断用）。 */
/** 一次性：把 localStorage 里属于这些前缀的旧值搬进 DB（DB 已有 → 不覆盖）。 */
async function importLegacy(scope: StateScope, prefixes: string[], map: Map<string, string>): Promise<void> {
  const store = ls();
  if (!store) return;
  try {
    if (store.getItem(`prts-state-migrated:${scope}`) === "1") return;
  } catch {
    /* 隐私模式：仍尝试迁移 */
  }
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < store.length; i += 1) {
    const raw = store.key(i);
    if (!raw || !prefixes.some((prefix) => raw.startsWith(prefix))) continue;
    const value = store.getItem(raw);
    if (value != null && !map.has(raw)) entries.push([raw, value]);
  }
  if (entries.length) {
    try {
      const n = await invoke<number>("state_db_import", { scope, entries });
      console.log(`[stateStore] 迁移 localStorage → state.db：scope=${scope} ${n} 键`);
      for (const [key, value] of entries) map.set(key, value);
    } catch (error) {
      console.warn(`[stateStore] 迁移失败（保留 localStorage 原值）：`, error);
      return;
    }
  }
  try {
    store.setItem(`prts-state-migrated:${scope}`, "1");
  } catch {
    /* 标记写不进也只是下次再试 */
  }
}

/** 同步读（`hydrate` 之后）。找不到 → `null`。 */
export function getItem(scope: StateScope, key: string): string | null {
  const map = memory.get(scope);
  if (map?.has(key)) return map.get(key) ?? null;
  if (backend === "unknown") void hydrate();
  // 还没 hydrate（或 DB 里确实没有）：读 localStorage（可能就是旧值）。
  try {
    const raw = ls()?.getItem(legacyKey(scope, key)) ?? null;
    if (raw != null) scopeMap(scope).set(key, raw);
    return raw;
  } catch {
    return null;
  }
}

/** 写：内存立即生效 + 异步落库（50ms 合并）。 */
export function setItem(scope: StateScope, key: string, value: string): void {
  scopeMap(scope).set(key, value);
  listeners.forEach((l) => l());
  scheduleFlush(scope, key, value);
}

/** 该 scope 里现有的键（hydrate 之后即可用；诊断/`listLayouts` 用）。 */
export function listKeys(scope: StateScope): string[] {
  return [...(memory.get(scope)?.keys() ?? [])];
}

export function removeItem(scope: StateScope, key: string): void {
  scopeMap(scope).delete(key);
  listeners.forEach((l) => l());
  if (backend === "sqlite" || backend === "unknown") {
    void invoke("state_db_del", { scope, key }).catch(() => {});
  }
  try {
    ls()?.removeItem(legacyKey(scope, key));
  } catch {
    /* ignore */
  }
}

/** 订阅（`useSyncExternalStore` 用；`hydrate` 完成后也会通知一次）。 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 合并写：同一 (scope,key) 50ms 内的连续写只发最后一次。 */
const pending = new Map<string, { scope: StateScope; key: string; value: string }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(scope: StateScope, key: string, value: string): void {
  pending.set(`${scope}\u0000${key}`, { scope, key, value });
  // 后端是 localStorage：直接写（保持旧行为，刷新立即可见）。
  try {
    const store = ls();
    if (backend === "localstorage" || !inTauri()) store?.setItem(legacyKey(scope, key), value);
  } catch {
    /* ignore */
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = [...pending.values()];
    pending.clear();
    if (!batch.length) return;
    if (backend !== "sqlite" && backend !== "unknown") return;
    // 按 scope 分组批量写（一次 IPC）。
    const byScope = new Map<StateScope, Array<[string, string]>>();
    for (const item of batch) {
      const list = byScope.get(item.scope) ?? [];
      list.push([item.key, item.value]);
      byScope.set(item.scope, list);
    }
    for (const [scope, entries] of byScope) {
      void invoke("state_db_set_many", { scope, entries }).catch((error) => {
        backend = ls() ? "localstorage" : "memory";
        console.warn("[stateStore] 落库失败，已回落 localStorage：", error);
      });
    }
  }, 50);
}

/** 强制把待写队列落库（页面隐藏/退出前调；harness 里也用它消除竞态）。 */
export async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = [...pending.values()];
  pending.clear();
  if (!batch.length) return;
  const byScope = new Map<StateScope, Array<[string, string]>>();
  for (const item of batch) {
    const list = byScope.get(item.scope) ?? [];
    list.push([item.key, item.value]);
    byScope.set(item.scope, list);
  }
  for (const [scope, entries] of byScope) {
    await invoke("state_db_set_many", { scope, entries }).catch(() => {});
  }
}

/** 诊断：后端 + 各 scope 的键数（设置页/harness 用）。 */
export async function info(): Promise<{ backend: Backend; scopes: Array<[string, number]>; db?: unknown }> {
  const scopes: Array<[string, number]> = Object.entries(SCOPES).map(([scope]) => [
    scope,
    memory.get(scope)?.size ?? 0,
  ]);
  if (!inTauri()) return { backend, scopes };
  const db = await invoke("state_db_info").catch(() => null);
  return { backend, scopes, db: db ?? undefined };
}

/** 测试/迁移用：给某个 scope 注册"旧键前缀"（探针里注入）。 */
export function registerScope(scope: StateScope, prefixes: string[]): void {
  SCOPES[scope] = prefixes;
}
