/**
 * fetchEngine.mjs — 「把当前引擎代抓下来」的小工具（`publish-engine.mjs` 与
 * `mirror-selftest.mjs` 共用）。
 *
 * - `fetchEngineSnapshot(sel, outDir)`：把选中条目写到磁盘（保持镜像布局）。
 * - `encodingForMirrorPath(p)`：路径 → 仓库里该用的写法（只对非法字符转义）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 仓库路径里的 `@` / 空格 / `#` 等按需转义（`PreloadJS@1.0.1` 这种最典型）。 */
export function encodingForMirrorPath(path) {
  return String(path)
    .split("/")
    .map((seg) => {
      try {
        return encodeURI(decodeURI(seg));
      } catch {
        return encodeURI(seg);
      }
    })
    .join("/");
}

/**
 * 抓取 `entries`（`[{key, mirrorPath}]`）到 `outDir`（保持镜像布局）。
 * 单条失败只记 warning；返回 `{written, bytes, failed}`。
 */
export async function fetchEngineSnapshot(entries, outDir, { offline = false, referer = "https://prts.wiki/" } = {}) {
  const { mirrorPathFor } = await import("./mirrorPath.mjs");
  let written = 0;
  let bytes = 0;
  let failed = 0;
  for (const entry of entries ?? []) {
    const mirrorPath = entry.mirrorPath ?? mirrorPathFor(entry.key);
    if (!mirrorPath) {
      failed += 1;
      continue;
    }
    const target = resolve(outDir, mirrorPath);
    mkdirSync(dirname(target), { recursive: true });
    if (offline) {
      writeFileSync(target, `${entry.key}\n`);
      written += 1;
      continue;
    }
    try {
      const res = await fetch(`https://${entry.key}`, {
        headers: { "User-Agent": "Arkstage-mirror-publisher (+https://github.com/djkcyl/arkstage)", Referer: referer },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(target, buf);
      written += 1;
      bytes += buf.length;
    } catch (error) {
      failed += 1;
      console.warn(`! ${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written, bytes, failed };
}

/** 读 `tools/mirror/versions.json`（缺失 → `null`）。 */
export function readVersions(here) {
  try {
    return JSON.parse(readFileSync(resolve(here, "versions.json"), "utf8"));
  } catch {
    return null;
  }
}
