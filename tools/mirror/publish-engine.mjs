/**
 * publish-engine.mjs — 把**引擎层**（`tools/mirror/versions.json` 的 `runtime` 条目）
 * 拉到本地暂存目录，供 `publish-mirror.yml` rsync 进镜像仓。
 *
 * 纯 Node 22（内置 fetch），无第三方依赖；**只写 `--out` 目录**，不动工作区。
 *
 *   node tools/mirror/publish-engine.mjs --out /tmp/arkstage-mirror [--only runtime|all]
 *
 * 产物布局与 `mirrorPath.mjs::mirrorPathFor` 完全一致：
 *   <out>/mirror/prts/<host>/<path>                  ← 每个引擎文件
 *   <out>/mirror/prts/versions.json                   ← 目录副本（客户端探测 / 人查）
 *
 * 容错：单条失败只记 warning（不中断），会打印 `失败 N`；重跑幂等。
 * `MIRROR_OFFLINE=1`（或 `--offline`）→ 只按清单落**占位文本**，用于本地演练布局。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { fetchEngineSnapshot } = await import(pathToFileURL(resolve(HERE, "fetchEngine.mjs")).href);

function argOf(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const out = resolve(argOf("out", "/tmp/arkstage-mirror"));
const only = argOf("only", "runtime");
const offline = process.env.MIRROR_OFFLINE === "1" || process.argv.includes("--offline");
const versions = JSON.parse(readFileSync(resolve(HERE, "versions.json"), "utf8"));

const entries = (versions.entries ?? []).filter((e) => only === "all" || e.group === only);
const { written, bytes, failed } = await fetchEngineSnapshot(entries, out, { offline });

mkdirSync(resolve(out, "mirror/prts"), { recursive: true });
writeFileSync(resolve(out, "mirror/prts/versions.json"), `${JSON.stringify(versions, null, 2)}\n`);

console.log(`publish-engine: 写入 ${written} 个文件 / ${bytes} 字节 → ${out}${failed ? `（失败 ${failed}）` : ""}`);
if (offline) console.log("  （offline 演练：文件内容为 key 占位文本）");
if (failed) console.log("  提示：失败的条目重跑会自动补齐（幂等覆盖）。");
