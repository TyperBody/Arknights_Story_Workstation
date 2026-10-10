/**
 * Lightweight in-app diagnostic log. The release build ships without DevTools by
 * default, and engine failures happen inside an isolated iframe whose console we
 * can't otherwise see — so errors there used to surface as a silent frozen loading
 * screen. This module captures errors from the main window AND the engine iframe
 * and exposes them to an on-screen overlay (DebugConsole) the user can read/screenshot.
 */

export type LogLevel = "log" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  time: number;
  level: LogLevel;
  msg: string;
  /**
   * Expected/benign noise (e.g. a `data:`/`blob:` module URL failing a
   * `modulepreload` hint). Kept in the debug panel for diagnosis, but never
   * promoted into the user-facing status banner.
   */
  silent?: boolean;
  /** Repeat count for coalesced `silent` lines (never shows as N rows). */
  count?: number;
}

/** A user-facing one-liner (banner) — NOT a raw log line. See BRIEF §2.7. */
export interface StatusEntry {
  kind: StatusKind;
  message: string;
  hint?: string;
  time: number;
}

export type StatusKind = "engine" | "stage" | "download" | "boot";

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let seq = 0;
let installed = false;

/**
 * `data:`/`blob:` module URLs are how we inject the engine into the iframe. A
 * failed `<link rel=modulepreload>` for one of them is expected (the import map
 * already points at the same module), so it must not surface as a scary error.
 */
export function isVolatileModuleUrl(value: unknown): boolean {
  return typeof value === "string" && /^(?:data|blob):/.test(value);
}

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  if (typeof a === "object" && a !== null) {
    // Errors created in the isolated engine iframe belong to another JS realm,
    // so `instanceof Error` is false in the parent window.  JSON.stringify also
    // drops Error's non-enumerable fields, reducing the only useful diagnostic to
    // `{}`.  Read the standard error-shaped fields explicitly before JSON.
    const errorLike = a as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof errorLike.stack === "string" && errorLike.stack) return errorLike.stack;
    if (typeof errorLike.message === "string" && errorLike.message) {
      return `${typeof errorLike.name === "string" ? `${errorLike.name}: ` : ""}${errorLike.message}`;
    }
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

export function pushLog(level: LogLevel, ...args: unknown[]): void {
  const msg = args.map(fmt).join(" ");
  const silent = isSilentNoise(level, msg, args);
  // 同一句 `data:`/`blob:` 噪音只留一行（计数累加），否则启动一次能刷满 500 条。
  if (silent) {
    for (let index = entries.length - 1; index >= Math.max(0, entries.length - 40); index -= 1) {
      const entry = entries[index];
      if (entry.silent && entry.msg === msg) {
        entry.count = (entry.count ?? 1) + 1;
        entry.time = Date.now();
        listeners.forEach((l) => l());
        return;
      }
    }
  }
  entries.push({ id: seq++, time: Date.now(), level, msg, silent });
  if (entries.length > MAX_ENTRIES) entries.shift();
  listeners.forEach((l) => l());
}

/**
 * Our own engine modules are injected as `data:text/javascript;base64,…` (and,
 * historically, `blob:`). The iframe reports a failed *preload hint* for those on
 * some WebViews even though execution succeeds from the import map — so the noise
 * stays in the debug panel (`silent`) and never reaches the banner.
 */
function isSilentNoise(level: LogLevel, msg: string, args: unknown[]): boolean {
  if (level !== "error" && level !== "warn") return false;
  if (args.some(isVolatileModuleUrl)) return true;
  return /(?:^|[\s"'(`=])(?:data:text\/javascript|blob:)/.test(msg);
}

export function getEntries(): readonly LogEntry[] {
  return entries;
}

// ── 用户可见横幅（BRIEF §2.7） ────────────────────────────────────────────────
// 纪律：横幅 = 人话一条 + 可关；同 kind+message 去重；`data:`/`blob:` 的
// 「模块加载失败」只在 debug 面板可见（silent 标记），不进横幅。
const statuses = new Map<StatusKind, StatusEntry>();
const statusListeners = new Set<() => void>();

/** Publish (or refresh, if identical) the user-facing banner for `kind`. */
export function pushStatus(kind: StatusKind, message: string, hint?: string): void {
  const key = String(kind) as StatusKind;
  const current = statuses.get(key);
  if (current && current.message === message && current.hint === hint) return;
  statuses.set(key, { kind: key, message, hint, time: Date.now() });
  statusListeners.forEach((l) => l());
}

/** Drop the banner for `kind` (e.g. the engine finally booted from the network). */
export function resolveStatus(kind: string): void {
  if (!statuses.delete(kind as StatusKind)) return;
  statusListeners.forEach((l) => l());
}

/** Read-only snapshot of the live banners (DebugConsole renders these; others read). */
export function statusEntries(): Array<{ kind: string; message: string; hint?: string }> {
  return [...statuses.values()].map(({ kind, message, hint }) => ({ kind, message, hint }));
}

/** Drop one banner by kind — the "✕" on a status row. */
export function dismissStatus(kind: string): void {
  resolveStatus(kind);
}

/** Subscribe to banner changes so the UI can re-render live. */
export function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function clearLog(): void {
  entries.length = 0;
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Install capture on the MAIN window. Idempotent; call once at app start. */
export function installGlobalCapture(): void {
  if (installed) return;
  installed = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a: unknown[]) => {
    pushLog("error", ...a);
    origError(...a);
  };
  console.warn = (...a: unknown[]) => {
    pushLog("warn", ...a);
    origWarn(...a);
  };

  window.addEventListener("error", (e) => {
    if (e.error) pushLog("error", e.error);
    else pushLog("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) =>
    pushLog("error", "UnhandledRejection:", e.reason)
  );
}

/**
 * Attach capture to an engine IFRAME's window. Catches uncaught script errors,
 * failed resource loads (img/audio/source/script/link), promise rejections, and
 * console.error/warn happening inside the engine realm.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function captureIframe(iwin: any): void {
  try {
    // Capture phase catches resource-load errors (which don't bubble) AND script errors.
    iwin.addEventListener(
      "error",
      (e: ErrorEvent) => {
        const t = e.target as { tagName?: string; src?: string; href?: string } | null;
        const tag = t && typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
        if (["IMG", "AUDIO", "VIDEO", "SOURCE", "SCRIPT", "LINK"].includes(tag)) {
          pushLog("error", "[engine] resource load failed:", t?.src || t?.href || tag);
        } else if (e.error) {
          const location = e.filename
            ? `@ ${e.filename}:${e.lineno}:${e.colno}`
            : "";
          pushLog("error", "[engine]", e.error, location);
        } else if (e.message) {
          pushLog("error", `[engine] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
        }
      },
      true
    );
    iwin.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) =>
      pushLog("error", "[engine] rejection:", e.reason)
    );
    // CSP violations don't fire 'error' — catch them explicitly, as a signal that a
    // real resource (img/font/external script) is being blocked by policy.
    // EXCEPTION: inline-script blocks are EXPECTED and not actionable — our CSP
    // intentionally forbids inline scripts (engine code runs via blob: URLs), and
    // libraries such as jQuery still attempt the occasional inline eval. Logging
    // those produced a scary "CSP blocked script-src-elem: inline" on every boot,
    // so we suppress that specific (by-design) case and surface everything else.
    iwin.addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => {
      const directive = e.effectiveDirective || e.violatedDirective || "";
      const isInlineScript =
        directive.startsWith("script-src") && (!e.blockedURI || e.blockedURI === "inline");
      if (isInlineScript) return;
      pushLog(
        "error",
        `[engine] CSP blocked ${e.violatedDirective}: ${e.blockedURI || e.sourceFile || "(inline)"}`
      );
    });

    const ic = iwin.console;
    if (ic) {
      const oe = ic.error?.bind(ic);
      const ow = ic.warn?.bind(ic);
      ic.error = (...a: unknown[]) => {
        pushLog("error", "[engine]", ...a);
        oe?.(...a);
      };
      ic.warn = (...a: unknown[]) => {
        pushLog("warn", "[engine]", ...a);
        ow?.(...a);
      };
    }
  } catch (err) {
    pushLog("warn", "captureIframe failed:", err);
  }
}
