/**
 * mirrorPath.mjs — 镜像仓的**路径布局**与「抽样聚合」纯函数（无网络、无 IO）。
 *
 * 设计（BRIEF §3.3「可预打包 / 可回滚」）：
 * - 镜像仓里**全量**按 canonical key 铺开：`mirror/prts/{host}/{path}`（根上再放
 *   `versions.json`）。键去掉了 `prts:` 前缀（`:` 在 Windows 检出时会变成 ADS）。
 * - `mirror/sample/` = **可选的抽样聚合**（例：把一批已压缩成 WebP 的小图打包成
 *   用户「最小可播」集合）。它靠**去重**决定装什么：同一份字节在多个 key 下只留最先
 *   出现的那个，其余写进 `aliases` 表由客户端重定向。
 * - 「价值」= 省下的字节：`sourceBytes - totalBytes`。抽样只挑真正能省的条目。
 */

export const MIRROR_PREFIX = "mirror/prts";
export const SAMPLE_PREFIX = "mirror/sample";

/** canonical key（`host/path`，或 `https://host/path`）→ 镜像仓相对路径。坏输入 → null。 */
export function mirrorPathFor(key) {
  if (typeof key !== "string") return null;
  const text = key.trim().replace(/^prts:/, "").replace(/^https?:\/\//, "").replace(/^\/+/, "");
  const at = text.indexOf("/");
  if (at <= 0) return null;
  const host = text.slice(0, at).toLowerCase();
  const path = text.slice(at + 1).replace(/[?#].*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || !path) return null;
  const safe = path.split("/").map((seg) => seg.replace(/:/g, "%3A")).join("/");
  return `${MIRROR_PREFIX}/${host}/${safe}`;
}

/** 随包相对路径（`vendor/jquery.min.js`、`assets/bg_black.webp`）→ 镜像路径（按 static.prts.wiki 记）。 */
export function packMirrorPath(rel, host = "static.prts.wiki") {
  const path = String(rel ?? "").replace(/^\/+/, "");
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  return mirrorPathFor(`${host}/${path}`);
}

/** 只保留「能进镜像仓」的条目（http(s) key）。 */
export function mirrorable(entries) {
  return (entries ?? []).filter((e) => mirrorPathFor(e?.key ?? e?.url) !== null);
}

/**
 * 按镜像路径去重（同一份字节多个 key → 一个物理文件）。
 *
 * @param {Array<{key: string, size?: number, kind?: string, group?: string}>} entries
 * @returns {Array<{path: string, key: string, size: number, keys: string[], kind: string, group: string}>}
 */
export function dedupeByPath(entries) {
  const byPath = new Map();
  for (const entry of entries ?? []) {
    const raw = entry?.key ?? entry?.url;
    const path = mirrorPathFor(raw);
    if (!path) continue;
    const key = String(raw).replace(/^https?:\/\//, "").replace(/^prts:/, "");
    const size = Number.isFinite(entry?.size) && entry.size > 0 ? Math.round(entry.size) : 0;
    const found = byPath.get(path);
    if (found) {
      if (!found.keys.includes(key)) found.keys.push(key);
      if (!found.size && size) found.size = size;
      continue;
    }
    byPath.set(path, {
      path,
      key,
      size,
      keys: [key],
      kind: String(entry?.kind ?? ""),
      group: String(entry?.group ?? ""),
    });
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 「抽样聚合」的选片：按 `policy` 过滤后，优先选**已完成压缩/体积已缩小**的条目
 * （`size` 相对 `rawSize` 有节省），按节省量降序，最多 `maxBytes`（0 = 不限）。
 *
 * @param {Array<{path: string, size: number, rawSize?: number, reason?: string}>} candidates
 * @param {{groups?: string[], maxBytes?: number}} [policy]
 * @returns {{files: Array<object>, totalBytes: number, sourceBytes: number, savedBytes: number}}
 */
export function aggregateSample(candidates, policy = {}) {
  const groups = Array.isArray(policy.groups) && policy.groups.length ? new Set(policy.groups) : null;
  const maxBytes = Number.isFinite(policy.maxBytes) && policy.maxBytes > 0 ? Math.round(policy.maxBytes) : 0;
  const rows = (candidates ?? [])
    .filter((c) => c && c.path)
    .filter((c) => (groups ? groups.has(String(c.group ?? "")) : true))
    .map((c) => {
      const size = Number.isFinite(c.size) && c.size > 0 ? Math.round(c.size) : 0;
      const rawSize = Number.isFinite(c.rawSize) && c.rawSize > 0 ? Math.round(c.rawSize) : size;
      return { path: c.path, size, rawSize, saved: Math.max(0, rawSize - size), reason: c.reason ?? "" };
    })
    .sort((a, b) => b.saved - a.saved || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files = [];
  let totalBytes = 0;
  let sourceBytes = 0;
  for (const row of rows) {
    if (maxBytes && totalBytes + row.size > maxBytes) continue;
    files.push(row);
    totalBytes += row.size;
    sourceBytes += row.rawSize;
  }
  return { files, totalBytes, sourceBytes, savedBytes: Math.max(0, sourceBytes - totalBytes) };
}

/**
 * `versions.json` 的唯一写入口（build / selftest 共用，保证形状一致）。
 *
 * @param {object} input
 * @returns {object}
 */
export function buildVersions(input = {}) {
  const entries = (input.entries ?? []).map((e) => ({
    key: e.key,
    mirrorPath: e.mirrorPath ?? mirrorPathFor(e.key),
    size: Number.isFinite(e.size) && e.size > 0 ? Math.round(e.size) : 0,
    group: e.group ?? "runtime",
    kind: e.kind ?? "",
  }));
  const byGroup = {};
  for (const entry of entries) byGroup[entry.group] = (byGroup[entry.group] ?? 0) + 1;
  const sample = input.sample ?? null;
  return {
    schema: 2,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    repo: input.repo ?? "djkcyl/arkstage-mirror",
    ref: input.ref ?? "main",
    engine: {
      version: input.engineVersion ?? "unknown",
      files: entries.filter((e) => e.group === "runtime").length,
      bytes: entries.filter((e) => e.group === "runtime").reduce((n, e) => n + e.size, 0),
    },
    assets: {
      files: entries.length,
      bytes: entries.reduce((n, e) => n + e.size, 0),
    },
    groups: byGroup,
    layout: {
      prefix: MIRROR_PREFIX,
      samplePrefix: SAMPLE_PREFIX,
      note: "全量按 canonical key 铺开；mirror/sample/ 是可选的抽样聚合（去重后的小体积集合）",
    },
    sample,
    entries,
  };
}

/** `versions.json` 里的条目 → 目录（去重后按路径排序）；坏输入 → 空表。 */
export function planFromVersions(versions) {
  const entries = Array.isArray(versions?.entries) ? versions.entries : [];
  return dedupeByPath(
    entries.map((e) => ({ key: e.key, size: e.size, kind: e.kind, group: e.group })),
  );
}
