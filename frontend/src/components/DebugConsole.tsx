import { useEffect, useRef, useState } from "react";
import { clearLog, getEntries, statusEntries, subscribe, subscribeStatus, dismissStatus, type LogEntry } from "../lib/debugLog";
import { isDebugConsoleEnabled, subscribeDebugSetting } from "../lib/debugSettings";

/**
 * Always-mounted floating debug console. Shows errors/warnings captured from the
 * main window and the engine iframe (see debugLog.ts), so the user can read and
 * screenshot the real failure even when WebView DevTools aren't available.
 *
 * Collapsed to a small button by default; the button turns red and shows a count
 * when errors are present.
 */
/**
 * 展开态面板的尺寸（T3）：`data-dbg-resize="1"` 的右下手柄可拖，尺寸存
 * `localStorage: prts-debug-console-size`（`{w,h}`，px）。
 * clamp：宽 `320…min(90vw)`、高 `200…min(80vh)`；读不出/非法 → 现状默认
 * （`min(720px,90vw)` × `min(320px,50vh)`）。收起态按钮与横幅的键名不变。
 */
const SIZE_KEY = "prts-debug-console-size";
const MIN_W = 320;
const MIN_H = 200;

interface ConsoleSize {
  w: number;
  h: number;
}

/** 视口内的合法上界（`min(90vw)` / `min(80vh)`，单位 px）。 */
function sizeLimits(): { maxW: number; maxH: number } {
  const vw = typeof window === "undefined" ? 0 : Number(window.innerWidth) || 0;
  const vh = typeof window === "undefined" ? 0 : Number(window.innerHeight) || 0;
  return { maxW: Math.max(MIN_W, vw * 0.9), maxH: Math.max(MIN_H, vh * 0.8) };
}

/** 现状默认尺寸（`width: min(720px,90vw); height: min(320px,50vh)` 的数值形态）。 */
function defaultSize(): ConsoleSize {
  const vw = typeof window === "undefined" ? 0 : Number(window.innerWidth) || 0;
  const vh = typeof window === "undefined" ? 0 : Number(window.innerHeight) || 0;
  return clampSize({ w: Math.min(720, vw ? vw * 0.9 : 720), h: Math.min(320, vh ? vh * 0.5 : 320) });
}

/** 收进 `[320, min(90vw)] × [200, min(80vh)]`；非有限值 → 下限。 */
function clampSize(size: Partial<ConsoleSize> | null | undefined): ConsoleSize {
  const { maxW, maxH } = sizeLimits();
  const w = Number(size?.w);
  const h = Number(size?.h);
  return {
    w: Math.min(Math.max(Number.isFinite(w) ? w : MIN_W, MIN_W), maxW),
    h: Math.min(Math.max(Number.isFinite(h) ? h : MIN_H, MIN_H), maxH),
  };
}

/** 读记忆的尺寸；缺失/坏 JSON/非数字 → `null`（调用方回落默认）。 */
function readSize(): ConsoleSize | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { w?: unknown; h?: unknown };
    const w = Number(parsed?.w);
    const h = Number(parsed?.h);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    return clampSize({ w, h });
  } catch {
    return null;
  }
}

function writeSize(size: ConsoleSize): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(size.w), h: Math.round(size.h) }));
  } catch {
    // 隐私模式 / 配额：拖拽本身照常可用，只是不记忆。
  }
}

export default function DebugConsole() {
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);
  /** 展开态面板尺寸（像素；clamp 后使用）。 */
  const [size, setSize] = useState<ConsoleSize>(() => readSize() ?? defaultSize());
  /** 局部关闭的横幅：`kind → message`（同一条再出现时重新显示）。 */
  const [closed, setClosed] = useState<Record<string, string>>({});
  const resizeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  // Banner pushes resolve/publish outside the log stream; re-render on those too.
  useEffect(() => subscribeStatus(() => force((n) => n + 1)), []);
  // Re-render when the user flips the debug-console setting so it can show/hide live.
  useEffect(() => subscribeDebugSetting(() => force((n) => n + 1)), []);
  // 视口变小后重新 clamp（渲染时也算一次；这里只为触发重渲染）。
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** 拖右下手柄：面板锚在左下角 → 手柄跟着**指针**走。 */
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const shown = clampSize(size);
    resizeRef.current = { x: event.clientX, y: event.clientY, w: shown.w, h: shown.h };
    setSize(shown);
    const onMove = (move: PointerEvent) => {
      const start = resizeRef.current;
      if (!start) return;
      // 右 → 变宽；上 → 变高（底部锚定：手柄 1:1 贴指针）。
      const next = clampSize({ w: start.w + (move.clientX - start.x), h: start.h - (move.clientY - start.y) });
      setSize(next);
      writeSize(next);
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const banners = statusEntries().filter((entry) => closed[entry.kind] !== entry.message);

  // User-facing status rows: ONE line per live banner, closable, on top of
  // everything — visible even when the debug console itself is off. Harness hook:
  // `[data-asset-banner="1"]`.
  const bannerBar = banners.length > 0 && (
    <div style={bannerBarStyle} data-asset-banner="1">
      {banners.map((entry) => (
        <div style={bannerRowStyle} key={entry.kind} data-banner-kind={entry.kind}>
          <span style={{ flex: 1 }}>
            {entry.message}
            {entry.hint ? <span style={bannerHintStyle}>{" "}{entry.hint}</span> : null}
          </span>
          <button
            onClick={() => {
              setClosed((prev) => ({ ...prev, [entry.kind]: entry.message }));
              dismissStatus(entry.kind);
            }}
            style={bannerCloseStyle}
            title="关闭提示"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );

  // Hidden unless enabled (build default, overridable in Settings).
  if (!isDebugConsoleEnabled()) return bannerBar || null;

  const entries = getEntries();
  const errorCount = entries.filter((e) => e.level === "error" && !e.silent).length;

  const copyAll = () => {
    const text = [
      ...banners.map((entry) => `[${entry.kind}] ${entry.message}${entry.hint ? ` — ${entry.hint}` : ""}`),
      ...entries.map((e) => `[${levelTag(e)}] ${e.msg}`),
    ].join("\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  if (!open) {
    return (
      <>
        {bannerBar}
        <button
          onClick={() => setOpen(true)}
          style={{ ...toggleStyle, background: errorCount ? "#b71c1c" : "rgba(0,0,0,0.6)" }}
          title="查看调试日志"
        >
          调试日志{errorCount ? ` (${errorCount})` : entries.length ? ` ·${entries.length}` : ""}
        </button>
      </>
    );
  }

  const shown = clampSize(size);

  return (
    <>
      {bannerBar}
      <div style={{ ...panelStyle, ...sizeFallback, width: shown.w, height: shown.h }}>
        <div style={headerStyle}>
          <span style={{ fontWeight: 600 }}>调试日志 ({entries.length})</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={copyAll} style={smallBtn}>复制</button>
            <button onClick={clearLog} style={smallBtn}>清空</button>
            <button onClick={() => setOpen(false)} style={smallBtn}>收起</button>
          </div>
        </div>
        <div style={listStyle}>
          {entries.length === 0 && <div style={{ color: "#888" }}>暂无日志</div>}
          {entries.map((e) => (
            <div key={e.id} style={{ color: levelColor(e.level), whiteSpace: "pre-wrap", marginBottom: 4 }}>
              [{levelTag(e)}] {e.msg}
              {e.silent ? "（已降噪）" : ""}
              {e.count && e.count > 1 ? ` ×${e.count}` : ""}
            </div>
          ))}
        </div>
      {/* 右下拖拽手柄：宽 → 指针右移变大、高 → 指针上移变大（面板左下角锚定）。 */}
      <div
        data-dbg-resize="1"
        onPointerDown={startResize}
        style={resizeHandleStyle}
        title="拖动调整调试日志大小"
        aria-label="调整调试日志大小"
      >
        ◢
      </div>
      </div>
    </>
  );
}

/** 面板尺寸兜底（`min()` 形态，与内联像素值同语义；读不到记忆时用）。 */
const sizeFallback = {
  width: "min(720px, 90vw)",
  height: "min(320px, 50vh)",
};

function levelTag(e: LogEntry): string {
  const d = new Date(e.time);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${t} ${e.level.toUpperCase()}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function levelColor(level: string): string {
  if (level === "error") return "#ff6b6b";
  if (level === "warn") return "#ffd166";
  return "#cfcfcf";
}

/** 顶部横幅条：最上层、可关闭、一条一行；`data-asset-banner` 是 harness 钩子。 */
/** 右下缩放手柄（`data-dbg-resize` 是 harness 锚点）。 */
const resizeHandleStyle: React.CSSProperties = {
  position: "absolute",
  right: 2,
  bottom: 2,
  width: 18,
  height: 18,
  display: "grid",
  placeItems: "center",
  cursor: "nwse-resize",
  touchAction: "none",
  color: "rgba(255,255,255,0.6)",
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.22)",
  borderRadius: 3,
  fontSize: 12,
  userSelect: "none",
};

const bannerBarStyle: React.CSSProperties = {
  position: "fixed",
  top: "calc(6px + env(safe-area-inset-top, 0px))",
  left: 8,
  right: 8,
  zIndex: 100000,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  pointerEvents: "none",
};

const bannerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "rgba(183,28,28,0.94)",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.35)",
  borderRadius: 4,
  fontSize: 12.5,
  lineHeight: 1.35,
  boxShadow: "0 3px 12px rgba(0,0,0,0.45)",
  pointerEvents: "auto",
};

const bannerHintStyle: React.CSSProperties = { opacity: 0.85 };

const bannerCloseStyle: React.CSSProperties = {
  flex: "none",
  padding: "0 6px",
  background: "rgba(255,255,255,0.14)",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 3,
  fontSize: 12,
  cursor: "pointer",
};

const toggleStyle: React.CSSProperties = {
  position: "fixed",
  bottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
  left: "calc(8px + env(safe-area-inset-left, 0px))",
  zIndex: 99999,
  padding: "4px 10px",
  color: "white",
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 3,
  fontSize: 12,
  cursor: "pointer",
};

const panelStyle: React.CSSProperties = {
  position: "fixed",
  bottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
  left: "calc(8px + env(safe-area-inset-left, 0px))",
  zIndex: 99999,
  // 尺寸由内联 width/height 覆盖（可拖 + 记忆）；这两条是「读不到记忆 + 视口
  // 未知（SSR/首帧）」时的兜底，语义与旧值（min(720px,90vw) / min(320px,50vh)）一致。
  width: "min(720px, 90vw)",
  height: "min(320px, 50vh)",
  background: "rgba(15,15,15,0.96)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 6,
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.15)",
  color: "white",
  fontSize: 13,
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px 10px",
  fontFamily: "monospace",
  fontSize: 12,
  lineHeight: 1.4,
};

const smallBtn: React.CSSProperties = {
  padding: "2px 8px",
  background: "rgba(255,255,255,0.12)",
  color: "white",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 3,
  fontSize: 12,
  cursor: "pointer",
};
