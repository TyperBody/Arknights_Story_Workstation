// Tracks which stories the user has opened in the player ("read"), so the
// bookshelf can distinguish read vs unread chapters. Persisted in localStorage
// (independent of the download cache — a story can be read without being cached,
// or cached without being read). 存 SQLite `state.db`，scope=library.

const KEY = "arkstage-read-stories";
import { getItem, setItem } from "./stateStore";

export function getReadStories(): Set<string> {
  try {
    const raw = getItem("library", KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Mark one story (by page_title) as read; persists immediately. */
export function markRead(pageTitle: string): void {
  try {
    const s = getReadStories();
    if (s.has(pageTitle)) return;
    s.add(pageTitle);
    setItem("library", KEY, JSON.stringify([...s]));
  } catch {
    /* storage unavailable — read state is best-effort */
  }
}

// "Last watched" — the most recently opened story (by page_title), so the shelf
// and chapter list can point the user back to where they left off ("上次观看").
const LAST_KEY = "arkstage-last-watched";

export function getLastWatched(): string | null {
  try {
    return getItem("library", LAST_KEY);
  } catch {
    return null;
  }
}

export function setLastWatched(pageTitle: string): void {
  try {
    setItem("library", LAST_KEY, pageTitle);
  } catch {
    /* best-effort */
  }
}
