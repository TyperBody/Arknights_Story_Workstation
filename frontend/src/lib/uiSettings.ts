import { useSyncExternalStore } from "react";

// Small UI preferences kept in localStorage. "hidePlayerBack" hides ONLY the
// reader's on-screen back button (the other pages keep theirs); users who use the
// system back gesture can declutter the immersive reader. "playerChrome" controls
// the engine's bottom control strip (播放模式 / 播放速度 …) inside the reader.

const HIDE_PLAYER_BACK_KEY = "prts-hide-player-back";
const PLAYER_CHROME_KEY = "prts-player-chrome";
const listeners = new Set<() => void>();

/**
 * 播放器底部控制条（引擎 `.story-player > .n-card[aria-label="播放控制"]`）的显示方式。
 * `auto`（默认）= 纯隐藏：初始即收起，指针移入底栏才显示、移出立即隐藏（无定时器）。
 */
export type PlayerChrome = "show" | "auto" | "hide";

const PLAYER_CHROME_VALUES: readonly PlayerChrome[] = ["show", "auto", "hide"];

/** 当前「播放器底栏」设置（默认 `auto`：底栏常藏，指针移上去才显示；非法/缺失一律回落）。 */
export function getPlayerChrome(): PlayerChrome {
  const raw = localStorage.getItem(PLAYER_CHROME_KEY);
  return PLAYER_CHROME_VALUES.includes(raw as PlayerChrome) ? (raw as PlayerChrome) : "auto";
}

export function setPlayerChrome(value: PlayerChrome): void {
  // `auto` 是默认值：不写 key，回到默认即「清掉」。
  if (value === "auto") localStorage.removeItem(PLAYER_CHROME_KEY);
  else localStorage.setItem(PLAYER_CHROME_KEY, value);
  listeners.forEach((l) => l());
}

/** React hook：订阅「播放器底栏」设置（播放页用；iframe 启动只读一次）。 */
export function usePlayerChrome(): PlayerChrome {
  return useSyncExternalStore(subscribe, getPlayerChrome);
}

export function isHidePlayerBack(): boolean {
  return localStorage.getItem(HIDE_PLAYER_BACK_KEY) === "1";
}

export function setHidePlayerBack(value: boolean): void {
  if (value) localStorage.setItem(HIDE_PLAYER_BACK_KEY, "1");
  else localStorage.removeItem(HIDE_PLAYER_BACK_KEY);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: true when the reader's on-screen back button should be hidden. */
export function useHidePlayerBack(): boolean {
  return useSyncExternalStore(subscribe, isHidePlayerBack);
}
