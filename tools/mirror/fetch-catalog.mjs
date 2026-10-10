// 开发期一次性脚本：把上游素材清单拉成 P1 的资产目录（catalog-data.json）。
// 不是 app 运行时依赖（离线脚本可用 `--offline` 跳过网络检查）。
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(HERE, "../../src/akstage/catalog-data.json");
const UA = { "User-Agent": "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)", Referer: "https://prts.wiki/" };

const SIDE = {
  character: "https://torappu.prts.wiki/assets/avg/character.json",
  background: "https://torappu.prts.wiki/assets/avg/background.json",
  variables: "https://torappu.prts.wiki/gamedata/latest/story/story_variables.json",
};
const WIDGET_PAGE = "https://prts.wiki/w/" + encodeURIComponent("EP10/ENTRY");
const WIDGET_BASE = "https://static.prts.wiki/widgets/production/";
export const EXTERNALS = [
  { url: "https://static.prts.wiki/assets/scenario/arknights-scenario.css", kind: "css" },
  { url: "https://code.jquery.com/jquery-3.7.1.min.js", kind: "js" },
  { url: "https://static.prts.wiki/npm/PreloadJS@1.0.1/preloadjs.min.js", kind: "js" },
  { url: "https://static.prts.wiki/assets/scenario/krliov.toolbox.js", kind: "js" },
  { url: "https://static.prts.wiki/assets/scenario/fonts/NotoSans.ttf", kind: "font" },
  { url: "https://static.prts.wiki/NotoSansHans-Medium.woff2", kind: "font" },
  { url: "https://static.prts.wiki/assets/scenario/ui/ui_speaker.png", kind: "src" },
  { url: "https://static.prts.wiki/assets/scenario/ui/ui_playback_all.png", kind: "src" },
  { url: "https://static.prts.wiki/assets/scenario/ui/ui_playback.png", kind: "src" },
  { url: "https://static.prts.wiki/assets/scenario/ui/ui_fullscreen.png", kind: "src" },
  { url: "https://static.prts.wiki/assets/scenario/ui/ui_bug_report.png", kind: "src" },
  // UI 小图（`ui_*` 那组的老兄弟；引擎 CSS/JS 里直接引，跟着引擎代走）
  { url: "https://static.prts.wiki/widgets/production/slide_mask.BQ3hXFW7.png", kind: "src" },
  { url: "https://static.prts.wiki/widgets/production/back_shadow.D4pyqE7x.png", kind: "src" },
  // 上游 JSON 清单（舞台/播放器都要用；`data` 类）
  { url: "https://torappu.prts.wiki/assets/avg/character.json", kind: "data" },
  { url: "https://torappu.prts.wiki/assets/avg/background.json", kind: "data" },
  { url: "https://torappu.prts.wiki/gamedata/latest/story/story_variables.json", kind: "data" },
];

async function get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}
async function getJson(url) {
  return JSON.parse(await get(url));
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const character = await getJson(SIDE.character);
  const background = await getJson(SIDE.background);
  const variables = await getJson(SIDE.variables);

  const characterPaths = new Set();
  for (const [base, v] of Object.entries(character)) {
    const refs = [base];
    for (const g of v.groups ?? []) if (g?.base) refs.push(g.base);
    for (const it of v.array ?? []) if (it?.image) refs.push(it.image);
    for (const it of v.array ?? []) if (it?.face) characterPaths.add(`torappu.prts.wiki/assets/avg/characters/1_${it.face}.png`);
    for (const ref of refs) if (ref) characterPaths.add(`torappu.prts.wiki/assets/avg/characters/${ref}.png`);
  }
  const backgroundPaths = new Set();
  for (const key of Object.keys(background)) backgroundPaths.add(`torappu.prts.wiki/assets/avg/background/${key}.png`);

  // 引擎「生成代」：先看页面里 <script type=module>/<link> 的条目，再沿 bundle 的
  // 静态 import / lazy chunk 表展开（与 Rust `module_dependencies` 同一套正则）。
  const page = await get(WIDGET_PAGE);
  const mods = [...new Set([...page.matchAll(/widgets\/production\/[A-Za-z0-9._-]+/g)].map((m) => m[0].split("/").pop()))]
    .filter((n) => n.endsWith(".js") || n.endsWith(".css"));
  const widgets = new Map(mods.map((n) => [n, n.endsWith(".css") ? "css" : "js"]));
  const RE_JS = /["'`](?:\.\/)?([A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+\.js)["'`]/g;
  const RE_CSS = /["'`](?:\.\/)?(style\.[A-Za-z0-9_-]+\.css)["'`]/g;
  const seen = new Set(mods);
  const queue = mods.filter((n) => n.endsWith(".js"));
  while (queue.length) {
    const name = queue.pop();
    let text;
    try {
      text = await get(WIDGET_BASE + name);
    } catch {
      // `.map` 之类 404 的候选：跳过，不影响真实 chunk
      continue;
    }
    for (const m of text.matchAll(RE_JS)) if (!seen.has(m[1])) { seen.add(m[1]); queue.push(m[1]); widgets.set(m[1], "js"); }
    for (const m of text.matchAll(RE_CSS)) if (!seen.has(m[1])) { seen.add(m[1]); widgets.set(m[1], "css"); }
  }

  const external = [];
  for (const { url, kind } of EXTERNALS) {
    external.push({ url, kind });
  }
  for (const w of [...widgets.keys()].sort()) {
    external.push({ url: `${WIDGET_BASE}${w}`, kind: widgets.get(w) });
  }

  const counts = {
    characters: Object.keys(character).length,
    backgrounds: backgroundPaths.size,
    variables: Object.keys(variables).length,
    characterPaths: characterPaths.size,
    backgroundPaths: backgroundPaths.size,
    widgets: widgets.size,
    external: external.length,
  };
  if (checkOnly) {
    const prev = JSON.parse(readFileSync(TARGET, "utf8"));
    const same = JSON.stringify(prev.counts) === JSON.stringify(counts);
    console.log(JSON.stringify({ counts, previous: prev.counts, same }));
    process.exit(same ? 0 : 1);
  }

  const json = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { ...SIDE, widgetPage: WIDGET_PAGE, widgetBase: WIDGET_BASE },
    counts,
    external,
    characterPaths: [...characterPaths].sort(),
    backgroundPaths: [...backgroundPaths].sort(),
    variableKeys: Object.keys(variables).sort(),
  };
  writeFileSync(TARGET, JSON.stringify(json));
  console.log(JSON.stringify(counts), `${statSync(TARGET).size} bytes`);
}

main().catch((e) => { console.error(e); process.exit(1); });
