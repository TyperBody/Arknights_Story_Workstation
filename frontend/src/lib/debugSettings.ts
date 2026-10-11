/**
 * Controls whether the on-screen debug console (DebugConsole) is visible.
 *
 * Default is build-time. The OFFICIAL RELEASE ships with diagnostics OFF
 * (release.yml + the build-* release scripts set VITE_DEBUG_DEFAULT=false).
 * Every other build keeps it ON: the dev server (import.meta.env.DEV), debug
 * APKs and CI test artifacts (VITE_DEBUG_DEFAULT=true). The user can override
 * either way from Settings; the choice is persisted in the state store (`scope=player`) and survives
 * across launches. "default" means "follow the build-time default".
 */

const STORAGE_KEY = "prts-debug-console";
import { getItem, setItem } from "./stateStore";
const BUILD_DEFAULT =
  import.meta.env.VITE_DEBUG_DEFAULT === "true" || import.meta.env.DEV === true;

export type DebugPref = "on" | "off" | "default";

const listeners = new Set<() => void>();

/** Resolved visibility: explicit user choice if set, otherwise the build default. */
export function isDebugConsoleEnabled(): boolean {
  const stored = getItem("player", STORAGE_KEY);
  if (stored === "on") return true;
  if (stored === "off") return false;
  return BUILD_DEFAULT;
}

/** The user's stored preference, or "default" when none has been set. */
export function getDebugPref(): DebugPref {
  const stored = getItem("player", STORAGE_KEY);
  return stored === "on" || stored === "off" ? stored : "default";
}

/** Whether builds default this on (shown next to the "default" choice in Settings). */
export function debugBuildDefault(): boolean {
  return BUILD_DEFAULT;
}

export function setDebugPref(pref: DebugPref): void {
  setItem("player", STORAGE_KEY, pref);
  listeners.forEach((l) => l());
}

export function subscribeDebugSetting(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
