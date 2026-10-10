/**
 * mirrorStats.mjs — 一行摘要（`publish-mirror.yml` 的 job summary 用）。
 *
 *   node tools/mirror/mirrorStats.mjs [versions.json 路径]   # 缺省 tools/mirror/versions.json
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, "versions.json");
const v = JSON.parse(readFileSync(target, "utf8"));
const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;
console.log(`${v.engine?.files ?? 0} 条 / ${mb(v.engine?.bytes)}（版本 ${v.engine?.version ?? "unknown"}，schema ${v.schema}）`);
