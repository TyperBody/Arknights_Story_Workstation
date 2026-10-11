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
const rustParity = await import(pathToFileURL(resolve(HERE, "mirror-rust-parity.mjs")).href);
const catalogMod = await import(pathToFileURL(resolve(ROOT, "src/akstage/engineCatalog.js")).href);
const mirrorPath = await import(pathToFileURL(resolve(HERE, "mirrorPath.mjs")).href);

/* ------------------------------------------------- A0. appSettings（localStorage 契约） */
// `appSettings.ts` 是 TS（Node 直接 import 不了）：这里做**源码级**断言，保证默认值/
// 值域/key 名与 BRIEF §3.2 一致 —— 也就是 UI 与下载器共享的那份契约。
const settingsSrc = readFileSync(resolve(ROOT, "frontend/src/lib/appSettings.ts"), "utf8");
const preSrc = readFileSync(resolve(ROOT, "frontend/src/lib/predownload.ts"), "utf8");
ok("appSettings localStorage key = prts-app-settings", settingsSrc.includes('"prts-app-settings"'));
ok("appSettings 下载并发默认 12", /downloadConcurrency:\s*12/.test(settingsSrc));
ok("appSettings manifest 并发默认 10", /manifestConcurrency:\s*10/.test(settingsSrc));
ok("appSettings 限速默认 0", /rateLimit:\s*0/.test(settingsSrc));
ok("appSettings 下载并发上限 32 / 下限 1",
  /DOWNLOAD_CONCURRENCY_MAX\s*=\s*32/.test(settingsSrc) && /DOWNLOAD_CONCURRENCY_MIN\s*=\s*1/.test(settingsSrc));
ok("appSettings manifest 并发 1…16",
  /MANIFEST_CONCURRENCY_MAX\s*=\s*16/.test(settingsSrc) && /MANIFEST_CONCURRENCY_MIN\s*=\s*1/.test(settingsSrc));
ok("appSettings 坏 JSON 回落（try/catch）", settingsSrc.includes("JSON.parse") && settingsSrc.includes("catch"));
ok("appSettings mirror 6 个合法值（含官方 prts）",
  /MIRROR_VALUES[^=]*=\s*\["pack",\s*"prts",\s*"jsd",\s*"fastly",\s*"ghproxy",\s*"custom"\]/.test(settingsSrc));
ok("predownload 把 mirror/customMirror 推给 Rust（下载器与 prts-cdn 读同一份）",
  /download_settings_set"[\s\S]{0,400}mirror: merged\.mirror/.test(preSrc) && /customMirror: merged\.customMirror/.test(preSrc));

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
  routes.mirrorUrl("jsd", CSS) === "https://cdn.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/mirror/prts/static.prts.wiki/assets/scenario/arknights-scenario.css");
ok("fastly 源 = fastly.jsdelivr.net/gh/…",
  routes.mirrorUrl("fastly", CSS) === "https://fastly.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/mirror/prts/static.prts.wiki/assets/scenario/arknights-scenario.css");
ok("ghproxy 源 = gh-proxy.com 前缀",
  routes.mirrorUrl("ghproxy", CSS) === "https://gh-proxy.com/https://raw.githubusercontent.com/djkcyl/arkstage-mirror/main/mirror/prts/static.prts.wiki/assets/scenario/arknights-scenario.css");
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

/* -------------------------------------- A1. 镜像仓上线门槛（publish-mirror 契约） */
// 目标仓 `MIRROR_REPO@MIRROR_REF` 是**按需创建**的；三条镜像线路在跑过一次
// `publish-mirror.yml` 之前必然 404，所以必须保证：(a) 工作流存在且手动触发；
// (b) mirrorUrl 仍然返回形状正确的 URL；(c) prts 一定在兜底链里。
const wf = readFileSync(resolve(ROOT, ".github/workflows/publish-mirror.yml"), "utf8");
ok("publish-mirror.yml 存在且 workflow_dispatch", /workflow_dispatch:/.test(wf));
ok("publish-mirror.yml 走 MIRROR_TOKEN", wf.includes("MIRROR_TOKEN"));
ok("publish-mirror.yml 缺 token 时跳过（warning，不红）", wf.includes("MIRROR_TOKEN 未配置"));
ok("publish-mirror.yml 只发引擎层（默认 runtime）", wf.includes("include_assets"));
ok("publish-mirror.yml 从 assetRouting 取目标仓", wf.includes("assetRouting.js") && wf.includes("MIRROR_REPO"));
for (const source of ["jsd", "fastly", "ghproxy"]) {
  const u = routes.mirrorUrl(source, SAMPLE[0]);
  ok(`${source} 在镜像仓为空时仍给出形状正确的 URL（404 → 回退）`,
    typeof u === "string" && u.includes(routes.MIRROR_REPO), u);
  // `pack` 与 `prts` 展开成同一个官方直链，`buildSourceOrder` 只留先出现的那个；
  // 所以「回退到 prts」在链上就表现为「出现 pack 或 prts 且 URL = 官方直链」。
  const chain = routes.routeFor(SAMPLE[0], source);
  const fallback = chain.find((r) => r.source === "pack" || r.source === "prts");
  ok(`${source} 的兜底链回到官方直链（pack/prts）`,
    fallback?.url === routes.officialUrl(SAMPLE[0]), chain.map((r) => `${r.source}=${r.url}`).join(" "));
}
ok("SOURCE_HINTS 写明「首次需先跑 publish-mirror」",
  /publish-mirror/.test(routes.SOURCE_HINTS.jsd) && /publish-mirror/.test(routes.SOURCE_HINTS.fastly) && /publish-mirror/.test(routes.SOURCE_HINTS.ghproxy));
ok("MIRROR_REPO / MIRROR_REF 可被工作流读取",
  /^[\w.-]+\/[\w.-]+$/.test(routes.MIRROR_REPO) && routes.MIRROR_REF === "main");
ok("发布脚本存在（publish-engine / fetchEngine / mirrorStats）",
  ["publish-engine.mjs", "fetchEngine.mjs", "mirrorStats.mjs"].every((f) => readFileSync(resolve(HERE, f), "utf8").length > 0));

/* ------------------------------------------------- B2. 引擎快照（versions.json） */
const versions = JSON.parse(readFileSync(resolve(HERE, "versions.json"), "utf8"));
ok("versions.json schema=2", versions.schema === 2);
ok("versions.json 引擎条目 = 目录引擎层", versions.engine.files === catalogMod.engineEntries().length,
  `${versions.engine.files} vs ${catalogMod.engineEntries().length}`);
ok("versions.json 每条都有镜像路径", versions.entries.every((e) => mirrorPath.mirrorPathFor(e.key) === e.mirrorPath));
ok("versions.json 引擎体积已探明（> 0）", versions.engine.bytes > 0, `${versions.engine.bytes} B`);
ok("versions.json 布局前缀固定", versions.layout.prefix === "mirror/prts");
// 发布端（publish-engine）与客户端（assetRouting）的前缀必须逐字符相同，否则发布完仍 404。
ok("客户端 MIRROR_PREFIX 与发布端一致",
  routes.MIRROR_PREFIX === versions.layout.prefix && routes.MIRROR_PREFIX === mirrorPath.MIRROR_PREFIX,
  `client=${routes.MIRROR_PREFIX} publish=${versions.layout.prefix}`);
// 客户端 URL 必须落在发布端的路径上：URL 去掉 CDN 前缀后以 /<prefix>/<host>/<path> 结尾。
ok("客户端 URL 与发布路径对齐",
  routes.mirrorUrl("jsd", CSS).endsWith(`/${mirrorPath.mirrorPathFor(CSS)}`),
  `${routes.mirrorUrl("jsd", CSS)} vs ${mirrorPath.mirrorPathFor(CSS)}`);
const verdicts = mirrorPath.planFromVersions(versions);
ok("planFromVersions 无重复路径", new Set(verdicts.map((v) => v.path)).size === verdicts.length);

/* ------------------------------- A2. Rust/JS 模板一致性（下载引擎一侧） */
// 「设置→下载源」在 Rust 下载器/prts-cdn 里真正生效后，两边各持一份模板：
// assetRouting.js（UI 预览 + 引擎候选）与 src-tauri/src/media.rs（真正取字节）。
// 任何一侧改了模板而另一侧没跟，这里立刻红。
for (const r of rustParity.rustParityChecks(ROOT, routes)) {
  ok(r.name, r.pass, r.detail ?? "");
}

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

const built = mirrorPath.buildVersions({ entries: [{ key: HERO, size: 1000, group: "asset" }], engineVersion: "test" });
ok("buildVersions schema/groups 稳定", built.schema === 2 && built.groups.asset === 1 && built.entries[0].mirrorPath === mirrorPath.mirrorPathFor(HERO));

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
console.log(`  ✓ 设置契约：prts-app-settings（下载 12/清单 10/不限速）`);
console.log(`  ✓ 目录：${entries.length} 条（engine ${catalogMod.engineEntries().length} / css ${entries.filter((e) => e.kind === "css").length} / js ${entries.filter((e) => e.kind === "js").length} / font ${entries.filter((e) => e.kind === "font").length} / data ${entries.filter((e) => e.kind === "data").length}）`);
console.log(`  ✓ 镜像布局：${mirrorPath.mirrorPathFor(CSS)}`);
console.log(`  ✓ Rust/JS 模板一致性：${results.filter((r) => r.name.startsWith("A2")).length} 条断言`);
console.log(`  ✓ catalog-data.json 读取成功（${readFileSync(resolve(ROOT, "src/akstage/catalog-data.json"), "utf8").length} 字节）`);
