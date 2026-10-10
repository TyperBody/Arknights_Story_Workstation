/**
 * build-versions.mjs — 生成/刷新 `tools/mirror/versions.json`（镜像仓的索引）。
 *
 * 纯本地（读 `src/akstage/catalog-data.json` 与 engineCatalog 的目录），不联网。
 * 「引擎快照」= 目录里 `static.prts.wiki/**` 的那一层（widget 引擎代 + scenario 外链 + 字体）；
 * `mirror/sample/` 的抽样聚合由 publish 工作流按需填（`sample: null` = 尚未生成）。
 *
 *   node tools/mirror/build-versions.mjs          # 写入 versions.json
 *   node tools/mirror/build-versions.mjs --check  # 只比对，不改文件
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const TARGET = resolve(HERE, "versions.json");

const { catalog, engineEntries } = await import(pathToFileURL(resolve(ROOT, "src/akstage/engineCatalog.js")).href);
const { buildVersions, mirrorPathFor } = await import(pathToFileURL(resolve(HERE, "mirrorPath.mjs")).href);

const data = JSON.parse(readFileSync(resolve(ROOT, "src/akstage/catalog-data.json"), "utf8"));
/** 引擎快照版本 = catalog 的生成日期 + widget 条目数（同一代产物 → 同一个版本串）。 */
const engineVersion = `${String(data.generatedAt ?? "").slice(0, 10)}+g${Number(data.counts?.widgets ?? 0)}`;

const entries = engineEntries().map((entry) => ({
  key: entry.key,
  mirrorPath: mirrorPathFor(entry.key),
  size: entry.size,
  group: "runtime",
  kind: entry.kind,
}));

const versions = buildVersions({
  entries,
  engineVersion,
  repo: "djkcyl/arkstage-mirror",
  ref: "main",
  generatedAt: data.generatedAt,
  sample: null,
});
versions.catalog = {
  entries: catalog().length,
  dataBytes: readFileSync(resolve(ROOT, "src/akstage/catalog-data.json"), "utf8").length,
  source: data.source,
};

const text = `${JSON.stringify(versions, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const prev = readFileSync(TARGET, "utf8");
  const same = JSON.stringify(JSON.parse(prev).entries) === JSON.stringify(versions.entries);
  console.log(`versions.json ${same ? "一致" : "过期"}（engine ${versions.engine.files} 条 / ${versions.engine.bytes} B）`);
  process.exit(same ? 0 : 1);
}
writeFileSync(TARGET, text);
console.log(`versions.json 已写入：engine ${versions.engine.files} 条、${versions.engine.bytes} B、版本 ${engineVersion}`);
