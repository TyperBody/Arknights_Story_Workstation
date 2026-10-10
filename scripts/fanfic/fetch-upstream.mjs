// Fetch the full StoryPlayer snapshot (module graph, styles, sidecar tables) plus the
// chapter's own scenario text from PRTS, and write it as one JSON file.
//
//   node scripts/fanfic/fetch-upstream.mjs [out.json] [sourceTitle]
//
// Default source title is W2G/BEG (the tutorial chapter), whose page always
// carries the current engine generation. Mirrors src-tauri/src/commands/story_player.rs
// (entry detection, module graph walk, sidecar validation) closely enough for local
// packaging; the app still validates everything again before it plays.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OUT = resolve(process.argv[2] || "build/fanfic/upstream.json");
const SOURCE = process.argv[3] || "W2G/BEG";
const WIDGET_BASE = "https://static.prts.wiki/widgets/production/";
const UA = "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)";
const SIDECARS = [
  "https://torappu.prts.wiki/assets/avg/character.json",
  "https://torappu.prts.wiki/assets/avg/background.json",
  "https://torappu.prts.wiki/gamedata/latest/story/story_variables.json",
];

async function fetchText(url, { referer = "https://prts.wiki/", expectHtml = false } = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: referer } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  if (!expectHtml && text.trimStart().startsWith("<")) throw new Error(`HTML instead of asset: ${url}`);
  return text;
}

function widgetUrl(url) {
  if (!url.startsWith(WIDGET_BASE)) return false;
  const name = url.slice(WIDGET_BASE.length);
  return name.length > 0 && /^[A-Za-z0-9._-]+$/.test(name);
}

/** Entry/prelude/styles, exactly the shapes the Rust extractor accepts. */
function entryPoints(html) {
  const entry = [...html.matchAll(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/g)]
    .map((m) => m[1])
    .find((url) => /\/StoryPlayer\.[^/]*\.js$/.test(url) && widgetUrl(url));
  if (!entry) throw new Error("StoryPlayer entry module not found on the page");
  const styles = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((url) => widgetUrl(url) && url.endsWith(".css"));
  const prelude = [...html.matchAll(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((url) => widgetUrl(url) && /\/polyfills\.[^/]*\.js$/.test(url));
  if (!styles.length) throw new Error("StoryPlayer stylesheet missing");
  return { entry, styles, prelude };
}

/** Same dependency pattern as story_player.rs::module_dependencies. */
function moduleDependencies(source) {
  const out = [];
  for (const m of source.matchAll(/["'`](?:\.\/)?([A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+\.js)["'`]/g)) {
    out.push(WIDGET_BASE + m[1]);
  }
  return out;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Longest #datas_txt (the page can carry template examples before the real one). */
function extractScript(html) {
  const texts = [...html.matchAll(/<pre[^>]*id=["']datas_txt["'][^>]*>([\s\S]*?)<\/pre>/g)]
    .map((m) => decodeEntities(m[1]))
    .filter((t) => t.trim());
  if (!texts.length) throw new Error("#datas_txt not found");
  return texts.sort((a, b) => b.length - a.length)[0];
}

function extractTitle(html) {
  const m = html.match(/<h1[^>]*id=["']firstHeading["'][^>]*>([\s\S]*?)<\/h1>/);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim() : "";
}

async function main() {
  const pageUrl = `https://prts.wiki/w/${encodeURIComponent(SOURCE)}`;
  process.stderr.write(`fetching ${pageUrl}\n`);
  const html = await fetchText(pageUrl, { expectHtml: true });
  const { entry, styles, prelude } = entryPoints(html);
  const script = extractScript(html);

  const modules = {};
  const pending = [entry, ...prelude];
  while (pending.length) {
    const url = pending.shift();
    if (modules[url]) continue;
    if (Object.keys(modules).length >= 80) throw new Error("module graph exceeds limit");
    const source = await fetchText(url);
    modules[url] = source;
    pending.push(...moduleDependencies(source));
  }
  process.stderr.write(`modules: ${Object.keys(modules).length}\n`);

  const styleSources = {};
  for (const url of styles) styleSources[url] = await fetchText(url);

  const data = {};
  for (const url of SIDECARS) {
    const value = JSON.parse(await fetchText(url));
    const count = Object.keys(value).length;
    const minimum = url.endsWith("character.json") ? 100 : 10;
    if (count < minimum) throw new Error(`sidecar too small: ${url} (${count})`);
    data[url] = value;
    process.stderr.write(`sidecar ${url.split("/").pop()}: ${count}\n`);
  }

  const out = {
    source: SOURCE,
    story: { script, title: extractTitle(html) || SOURCE },
    bundle: { entry, prelude, modules, styles: styleSources, data },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  process.stderr.write(`wrote ${OUT}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
