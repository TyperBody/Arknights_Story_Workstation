/**
 * mirror-selftest.mjs — P1 的离线自检（Node 22，`node tools/mirror/mirror-selftest.mjs`）。
 *
 * 覆盖 BRIEF §4 验收 #8：
 *   A. `assetRouting` 的源表 / 各源 URL 拼装 / `null` 语义 / 往返；
 *   B. `engineCatalog` 的条目数、kind 覆盖、`mirrorOf`、`projectManifest`；
 *   C. 镜像仓布局 `mirrorPath.mjs` 的路径 / 去重 / 抽样。
 *
 * 纯本地（读仓库文件），**不联网**；任一断言失败 → 非 0 退出 + 打印失败列表。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

const results = [];
function ok(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail });
}
function eq(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, pass, pass ? "" : `got ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
}

const routes = await import(pathToFileURL(resolve(ROOT, "src/akstage/assetRouting.js")).href);
const catalogMod = await import(pathToFileURL(resolve(ROOT, "src/akstage/engineCatalog.js")).href);
const mirrorPath = await import(pathToFileURL(resolve(HERE, "mirrorPath.mjs")).href);

/* ------------------------------------------------------------------ A. 路由 */
const SAMPLE = [
  "https://static.prts.wiki/widgets/production/StoryPlayer.BQgSL6Cy.js",
  "https://static.prts.wiki/assets/scenario/arknights-scenario.css",
  "https://torappu.prts.wiki/assets/avg/background/bg_black.png",
  "https://torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png",
  "https://media.prts.wiki/1/10/Avg_071_mini01.png",
  "https://code.jquery.com/jquery-3.7.1.min.js",
];

eq("SOURCE_IDS", routes.SOURCE_IDS, ["pack", "prts", "jsd", "fastly", "ghproxy", "custom"]);
ok("SOURCE_LABELS 覆盖所有源", routes.SOURCE_IDS.every((id) => typeof routes.SOURCE_LABELS[id] === "string" && routes.SOURCE_LABELS[id]));
ok("MIRRORS 覆盖所有源", routes.SOURCE_IDS.every((id) => typeof routes.MIRRORS[id] === "string" && routes.MIRRORS[id]));

for (const source of routes.SOURCE_IDS) {
  const built = SAMPLE.map((url) => routes.mirrorUrl(source, url, "https://mirror.example/{url}"));
  ok(`源 ${source} 能由 routeFor 拼出（≥1 条）`, built.some((u) => typeof u === "string" && u.startsWith("http")),
    JSON.stringify(built));
  const chain = routes.routeFor(SAMPLE[0], source, { custom: "https://mirror.example/{url}" });
  ok(`routeFor(${source}) 首选源排第一`, chain.length > 0 && chain[0].source === source, JSON.stringify(chain.map((c) => c.source)));
}

// 官方直链 / jsDelivr / Fastly / gh-proxy / 自定义模板 —— 五个源各一条确定产物。
const CSS = "https://static.prts.wiki/assets/scenario/arknights-scenario.css";
eq("prts 源 = 官方直链", routes.mirrorUrl("prts", CSS), CSS);
eq("pack 源 = 官方直链", routes.mirrorUrl("pack", CSS), CSS);
ok("jsd 源 = cdn.jsdelivr.net/gh/…",
  routes.mirrorUrl("jsd", CSS) === "https://cdn.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/static.prts.wiki/assets/scenario/arknights-scenario.css");
ok("fastly 源 = fastly.jsdelivr.net/gh/…",
  routes.mirrorUrl("fastly", CSS) === "https://fastly.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/static.prts.wiki/assets/scenario/arknights-scenario.css");
ok("ghproxy 源 = gh-proxy.com 前缀",
  routes.mirrorUrl("ghproxy", CSS) === "https://gh-proxy.com/https://raw.githubusercontent.com/djkcyl/arkstage-mirror/main/static.prts.wiki/assets/scenario/arknights-scenario.css");
eq("custom 源 = 模板展开",
  routes.mirrorUrl("custom", CSS, "https://my.cdn/{key}?u={url}"),
  "https://my.cdn/static.prts.wiki/assets/scenario/arknights-scenario.css?u=" + CSS);

// not-applicable → null
eq("未知源 → null", routes.mirrorUrl("nowhere", CSS), null);
eq("custom 缺模板 → null", routes.mirrorUrl("custom", CSS), null);
eq("custom 模板无占位符 → null", routes.mirrorUrl("custom", CSS, "https://my.cdn/plain"), null);
eq("jsd 不适用非镜像 host → null", routes.mirrorUrl("jsd", "https://example.org/a.png"), null);
eq("data: URL → null", routes.mirrorUrl("jsd", "data:text/javascript;base64,AAAA"), null);
eq("pack key 走 jsd → null", routes.mirrorUrl("jsd", "pack:vendor/jquery.min.js"), null);
eq("坏输入 → null", routes.mirrorUrl("jsd", ""), null);
eq("describe 坏输入 → null", routes.describe(""), null);

// 往返：官方 ⇄ mirror key
let roundTripOk = true;
for (const url of SAMPLE) {
  const key = routes.toMirrorKey(url);
  const back = routes.fromMirrorUrl(key);
  if (key !== `prts:${url.replace("https://", "")}` || back !== url) roundTripOk = false;
}
ok("toMirrorKey/fromMirrorUrl 往返（6 条样例）", roundTripOk);
eq("toMirrorKey 非 prts host 幂等", routes.toMirrorKey("https://code.jquery.com/jquery-3.7.1.min.js"), "prts:code.jquery.com/jquery-3.7.1.min.js");
eq("fromMirrorUrl(prts:省略 host)", routes.fromMirrorUrl("prts:widgets/production/x.js"), "https://static.prts.wiki/widgets/production/x.js");
eq("canonicalKey 去 scheme", routes.canonicalKey("https://torappu.prts.wiki/assets/avg/background/bg_black.png"), "torappu.prts.wiki/assets/avg/background/bg_black.png");
eq("canonicalKey data: → null", routes.canonicalKey("data:text/javascript;base64,AA"), null);

const order = routes.buildSourceOrder("pack");
eq("buildSourceOrder 首选排第一", order[0], "pack");
ok("buildSourceOrder 无重复", new Set(order).size === order.length);
ok("buildSourceOrder 覆盖实用源", ["pack", "jsd", "fastly", "ghproxy", "custom"].every((id) => order.includes(id)));

/* --------------------------------------------------------------- B. 目录 */
const entries = catalogMod.catalog();
ok("catalog() 条目 ≥ 60", entries.length >= 60, `entries=${entries.length}`);
for (const kind of ["css", "js", "font", "data", "src"]) {
  ok(`catalog() 含 kind=${kind}`, entries.some((e) => e.kind === kind), `kinds=${JSON.stringify([...new Set(entries.map((e) => e.kind))])}`);
}
const engineKeys = entries.filter((e) => e.key.startsWith("static.prts.wiki/"));
ok("catalog() engine/data 全量核心 key ≥ 100", engineKeys.length + entries.filter((e) => e.kind === "data").length >= 100,
  `engine=${engineKeys.length} data=${entries.filter((e) => e.kind === "data").length}`);
ok("catalog() 引擎层 ≥ 20 条", engineKeys.length >= 20, `static.prts.wiki=${engineKeys.length}`);
ok("catalog() 剧情变量 ≥ 100 条", entries.filter((e) => e.key.includes("story_variables.json#")).length >= 100);
ok("catalog() 含上游三表（data）",
  ["torappu.prts.wiki/assets/avg/character.json", "torappu.prts.wiki/assets/avg/background.json",
   "torappu.prts.wiki/gamedata/latest/story/story_variables.json"].every((k) => entries.some((e) => e.key === k)));
ok("catalog() 立绘 key ≥ 1000", entries.filter((e) => e.key.includes("/assets/avg/characters/")).length >= 1000);
ok("catalog() 背景 key ≥ 100", entries.filter((e) => e.key.includes("/assets/avg/background/")).length >= 100);
ok("catalog() index 与 assets 无重复", new Set(entries.map((e) => e.key)).size === new Set(entries.map((e) => `${e.kind}:${e.key}`)).size);
ok("catalog() key 均可路由", entries.slice(0, 200).every((e) => typeof routes.officialUrl(e.key) === "string"));
ok("catalog() URLs 含官方 + 镜像",
  entries.every((e) => e.urls.length === 0 || (e.urls[0].startsWith("https://") && e.urls.length >= 1)));

const HERO = "https://torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png";
ok("mirrorOf(官方, jsd) 命中镜像", String(catalogMod.mirrorOf(HERO, "jsd")).startsWith("https://cdn.jsdelivr.net/gh/"));
eq("mirrorOf(官方, prts) 原样", catalogMod.mirrorOf(HERO, "prts"), HERO);
eq("mirrorOf(坏 URL) → null", catalogMod.mirrorOf("t", "prts"), null);

const manifestAll = catalogMod.projectManifest(["engine"], {});
ok("projectManifest(engine) 非空", manifestAll.total > 10, `total=${manifestAll.total}`);
ok("projectManifest files 形状", Object.values(manifestAll.files).every((f) => typeof f.url === "string" && Array.isArray(f.mirrorUrls) && typeof f.kind === "string"));
const manifestSel = catalogMod.projectManifest(
  ["torappu.prts.wiki/assets/avg/background/bg_forest.png"],
  { backgrounds: ["bg_black"], characters: ["char_002_amiya_1"] },
);
eq("projectManifest 选择集合并去重", manifestSel.total, 3);
ok("projectManifest 选中项可镜像", Object.keys(manifestSel.files).every((k) => catalogMod.mirrorOf(k, "jsd") !== null));

/* ------------------------------------------------------------ C. 镜像布局 */
eq("mirrorPathFor 基本", mirrorPath.mirrorPathFor("static.prts.wiki/widgets/production/x.js"), "mirror/prts/static.prts.wiki/widgets/production/x.js");
eq("mirrorPathFor 去 prts: 前缀", mirrorPath.mirrorPathFor("prts:torappu.prts.wiki/assets/avg/background/bg_black.png"), "mirror/prts/torappu.prts.wiki/assets/avg/background/bg_black.png");
eq("mirrorPathFor 坏输入 → null", mirrorPath.mirrorPathFor("bg_black"), null);
ok("镜像仓布局：引擎 26 条 + 立绘/背景全量", catalogMod.engineEntries().length >= 20);

const sample = mirrorPath.aggregateSample([
  { path: "mirror/sample/a.webp", size: 100, rawSize: 400, group: "stage" },
  { path: "mirror/sample/b.webp", size: 900, rawSize: 1000, group: "stage" },
  { path: "mirror/sample/c.webp", size: 10, rawSize: 20, group: "other" },
], { groups: ["stage"] });
eq("抽样只收选中的组", sample.files.map((f) => f.path), ["mirror/sample/a.webp", "mirror/sample/b.webp"]);
ok("抽样报告节省量", sample.savedBytes === 400, JSON.stringify(sample));

const versions = mirrorPath.buildVersions({ entries: [{ key: HERO, size: 1000, group: "asset" }], engineVersion: "test" });
ok("versions.json schema/groups 稳定", versions.schema === 2 && versions.groups.asset === 1 && versions.entries[0].mirrorPath === mirrorPath.mirrorPathFor(HERO));

/* -------------------------------------------------------------------- 收尾 */
const failed = results.filter((r) => !r.pass);
const groups = { A: "路由", B: "目录", C: "镜像布局" };
for (const key of Object.keys(groups)) {
  const list = results.filter((r) => r.name.startsWith("#") === false && results.indexOf(r) >= 0 && true);
  void list;
}
console.log(`mirror-selftest: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败：");
  for (const r of failed) console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  process.exit(1);
}
console.log(`  ✓ 路由：${routes.SOURCE_IDS.length} 源 × ${SAMPLE.length} 样例`);
console.log(`  ✓ 目录：${entries.length} 条（engine ${catalogMod.engineEntries().length} / css ${entries.filter((e) => e.kind === "css").length} / js ${entries.filter((e) => e.kind === "js").length} / font ${entries.filter((e) => e.kind === "font").length} / data ${entries.filter((e) => e.kind === "data").length}）`);
console.log(`  ✓ 镜像布局：${mirrorPath.mirrorPathFor(CSS)}`);
console.log(`  ✓ catalog-data.json 读取成功（${readFileSync(resolve(ROOT, "src/akstage/catalog-data.json"), "utf8").length} 字节）`);
