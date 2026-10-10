// 下载内置样例包**自带**的少量素材（4 背景 + 4 立绘），转成 WebP 存进仓库：
//
//   src-tauri/resources/assets/sample/<file>.webp   ← 下载/转换产物（含 SOURCES.md 出处表）
//   src-tauri/resources/library/sample-fanfic/assets/<file>.webp  ← 包内副本（pack-local）
//   src-tauri/resources/library/sample-fanfic/build/assets.local.json ← canonical key → 包内相对路径
//
// 「canonical key」与 `src-tauri/src/media.rs::canonical_key` 一致（`host/path`，无 scheme、
// 无 query），也正是引擎拼出来的素材 URL（`https://torappu.prts.wiki/assets/avg/...`）。
// 键全部取自引擎已知的表：背景键在 `assets/avg/background.json`、立绘键是
// `assets/avg/character.json` 里 `array[].image`（`char_xxx/char_xxx`）。
//
//   node scripts/fanfic/fetch-sample-assets.mjs            # 下载（缺什么补什么，已存在则校验）
//   node scripts/fanfic/fetch-sample-assets.mjs --check    # 离线：只按表校验字节数 + sha256
//   node scripts/fanfic/fetch-sample-assets.mjs --force    # 重新下载/转换
//
// 依赖：node 20+（内置 fetch）、ffmpeg（libwebp）。--check 不需要网络与 ffmpeg。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const ASSET_DIR = join(ROOT, "src-tauri/resources/assets/sample");
const PACK_DIR = join(ROOT, "src-tauri/resources/library/sample-fanfic");
const PACK_ASSET_DIR = join(PACK_DIR, "assets");
const OUT_DIR = join(PACK_DIR, "build");
const SOURCES = join(ASSET_DIR, "SOURCES.md");
const BUNDLES = join(ASSET_DIR, "bundles.json");
const LOCAL_MAP = join(OUT_DIR, "assets.local.json");

const UA = "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)";
const ORIGIN = "https://torappu.prts.wiki";

/**
 * 样例要用的素材表。
 * - `key`     canonical key（媒体仓/引擎 URL 的键，`torappu.prts.wiki/assets/avg/...`）
 * - `url`     上游 PNG（唯一来源，PRTS）
 * - `file`    包内文件名（WebP；`<img>`/`createImageBitmap` 按内容嗅探，扩展名不影响）
 * - `quality` libwebp 质量档
 */
const ASSETS = [
  { kind: "background", key: "torappu.prts.wiki/assets/avg/background/bg_black.png", url: `${ORIGIN}/assets/avg/background/bg_black.png`, file: "bg_black.webp", quality: 80 },
  { kind: "background", key: "torappu.prts.wiki/assets/avg/background/bg_room_2.png", url: `${ORIGIN}/assets/avg/background/bg_room_2.png`, file: "bg_room_2.webp", quality: 80 },
  { kind: "background", key: "torappu.prts.wiki/assets/avg/background/bg_forest.png", url: `${ORIGIN}/assets/avg/background/bg_forest.png`, file: "bg_forest.webp", quality: 80 },
  { kind: "background", key: "torappu.prts.wiki/assets/avg/background/bg_rhodeslounge_2.png", url: `${ORIGIN}/assets/avg/background/bg_rhodeslounge_2.png`, file: "bg_rhodeslounge_2.webp", quality: 80 },
  { kind: "portrait", key: "torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png", url: `${ORIGIN}/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png`, file: "char_002_amiya_1.webp", quality: 88 },
  { kind: "portrait", key: "torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_3.png", url: `${ORIGIN}/assets/avg/characters/char_002_amiya_1/char_002_amiya_3.png`, file: "char_002_amiya_3.webp", quality: 88 },
  { kind: "portrait", key: "torappu.prts.wiki/assets/avg/characters/char_130_doberm_ex/char_130_doberm_ex.png", url: `${ORIGIN}/assets/avg/characters/char_130_doberm_ex/char_130_doberm_ex.png`, file: "char_130_doberm_ex.webp", quality: 88 },
  { kind: "portrait", key: "torappu.prts.wiki/assets/avg/characters/char_010_chen_1/char_010_chen_1.png", url: `${ORIGIN}/assets/avg/characters/char_010_chen_1/char_010_chen_1.png`, file: "char_010_chen_1.webp", quality: 88 },
];

/** 预算：整套 ≤ 1.5 MiB（含包内副本后仍远小于）。 */
const BUDGET = 1.5 * 1024 * 1024;

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const force = argv.includes("--force");
const quiet = argv.includes("--quiet");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packRel = (file) => `assets/${file}`;

function vaporizeError(message) {
  console.error(message);
  process.exit(2);
}

// ── 下载 + 转码 ────────────────────────────────────────────────────────────
async function download(url, tmp) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://prts.wiki/" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 512 || bytes.subarray(0, 8).toString("latin1").includes("<!DOCTYP")) {
    throw new Error(`不是 PNG（${bytes.length} B）：${url}`);
  }
  writeFileSync(tmp, bytes);
  return bytes;
}

function toWebp(pngPath, webpPath, quality) {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", pngPath,
    "-c:v", "libwebp", "-quality", String(quality), webpPath]);
  return readFileSync(webpPath);
}

// ── SOURCES.md（出处 / 字节数 / sha256，供人工核对与许可说明）─────────────
function writeSources(rows) {
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const lines = [
    "# 内置样例素材出处（bundled sample assets）",
    "",
    "方舟剧场内置的二创样例包（`sample-fanfic`）**自带**这 8 份素材，断网首启即可播放。",
    "全部取自 PRTS Wiki 托管的《明日方舟》AVG 资源；版权归上海鹰角网络（Hypergryph）所有，",
    "此处仅作离线演示与同人创作示例，遵循应用的整体免责声明（见仓库根 `README.md`）。",
    "",
    "下载/转换脚本：`node scripts/fanfic/fetch-sample-assets.mjs`（`--check` 离线校验本表的字节数与 sha256）。",
    `转换：PNG → WebP（libwebp，q80 背景 / q88 立绘）；合计 ${total} B（${(total / 1024).toFixed(1)} KiB ≤ 1.5 MiB 预算）。`,
    "",
    "| # | 用途 | canonical key | 上游 PNG | 文件 | 字节 | sha256 |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row, index) => `| ${index + 1} | ${row.kind === "background" ? "背景" : "立绘"} | \`${row.key}\` | ${row.url} | \`${packRel(row.file)}\` | ${row.bytes} | \`${row.sha256}\` |`),
    "",
    "键取自引擎已知的表：背景键来自 `assets/avg/background.json`，立绘键是",
    "`assets/avg/character.json` 中 `array[].image`（形如 `char_xxx/char_xxx`）。",
    "映射表：包内 `src-tauri/resources/library/sample-fanfic/build/assets.local.json`",
    "（canonical key → 包内相对路径，应用侧 `pack_asset_path`）与本目录的",
    "`bundles.json`（canonical key → 文件名，`prts-cdn://` 协议的内置兜底层）。",
    "",
  ];
  writeFileSync(SOURCES, `${lines.join("\n")}`);
}

// ── 映射表 ───────────────────────────────────────────────────────────
// 1) 包内：`<pack>/build/assets.local.json`（canonical key → 包内相对路径）
// 2) 内置兜底：`src-tauri/resources/assets/sample/bundles.json`（canonical key → 文件名），
//    由 `src-tauri/src/lib.rs` 在 `prts-cdn://` 协议里先于缓存仓查（离线零网络）。
function writeMaps(rows) {
  const map = {};
  const bundles = {};
  for (const row of rows) {
    map[row.key] = packRel(row.file);
    bundles[row.key] = row.file;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(LOCAL_MAP, `${JSON.stringify(map, null, 1)}\n`);
  writeFileSync(BUNDLES, `${JSON.stringify(bundles, null, 1)}\n`);
  return Object.keys(map).length;
}

/** `--check`：只认磁盘上的文件，表里的 bytes/sha256 从现有 SOURCES.md 解析即可，
 * 但脚本自身就是唯一真源（ASSETS）；这里按脚本重算并要求与磁盘一致。 */
function check() {
  const rows = [];
  const problems = [];
  for (const asset of ASSETS) {
    const file = join(ASSET_DIR, asset.file);
    const mirrored = join(PACK_ASSET_DIR, asset.file);
    if (!existsSync(file)) { problems.push(`缺少 ${relative(ROOT, file)}（跑一次不带 --check 的脚本）`); continue; }
    const bytes = statSync(file).size;
    const digest = sha256(readFileSync(file));
    rows.push({ ...asset, bytes, sha256: digest });
    if (!existsSync(mirrored)) problems.push(`缺少包内副本 ${relative(ROOT, mirrored)}`);
    else {
      const copy = readFileSync(mirrored);
      if (copy.length !== bytes || sha256(copy) !== digest) problems.push(`包内副本与源文件不一致：${relative(ROOT, mirrored)}`);
    }
  }
  if (existsSync(BUNDLES)) {
    const bundles = JSON.parse(readFileSync(BUNDLES, "utf8"));
    for (const row of rows) if (bundles[row.key] !== row.file) problems.push(`bundles.json 缺映射 ${row.key} → ${row.file}`);
  } else {
    problems.push("缺少 assets/sample/bundles.json");
  }
  if (existsSync(LOCAL_MAP)) {
    const map = JSON.parse(readFileSync(LOCAL_MAP, "utf8"));
    for (const row of rows) if (map[row.key] !== packRel(row.file)) problems.push(`assets.local.json 缺映射 ${row.key} → ${packRel(row.file)}`);
    const extra = Object.keys(map).filter((key) => !rows.some((row) => row.key === key));
    if (extra.length) problems.push(`assets.local.json 有未知键：${extra.join(", ")}`);
  } else {
    problems.push("缺少 build/assets.local.json");
  }
  if (existsSync(SOURCES)) {
    const sources = readFileSync(SOURCES, "utf8");
    for (const row of rows) if (!sources.includes(row.sha256)) problems.push(`SOURCES.md 未记录 ${row.file} 的 sha256`);
  } else {
    problems.push("缺少 SOURCES.md");
  }
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (total > BUDGET) problems.push(`素材总量 ${total} B 超出预算 ${BUDGET} B`);
  const report = {
    mode: "check",
    files: rows.length,
    expected: ASSETS.length,
    bytes: total,
    budget: BUDGET,
    sampleDir: relative(ROOT, ASSET_DIR),
    packAssets: relative(ROOT, PACK_ASSET_DIR),
    sha256: Object.fromEntries(rows.map((row) => [row.file, row.sha256])),
    problems,
  };
  console.log(JSON.stringify(report, null, 1));
  process.exit(problems.length ? 1 : 0);
}

async function fetchAll() {
  mkdirSync(ASSET_DIR, { recursive: true });
  mkdirSync(PACK_ASSET_DIR, { recursive: true });
  const rows = [];
  for (const asset of ASSETS) {
    const target = join(ASSET_DIR, asset.file);
    const mirror = join(PACK_ASSET_DIR, asset.file);
    const useCache = !force && existsSync(target) && !checkOnly;
    if (!useCache) {
      const tmp = `${target}.src.png`;
      const png = await download(asset.url, tmp);
      const webp = toWebp(tmp, target, asset.quality);
      rmSync(tmp, { force: true });
      if (!quiet) process.stderr.write(`fetched ${asset.file}: png ${png.length} B → webp ${webp.length} B\n`);
    }
    const bytes = readFileSync(target);
    copyFileSync(target, mirror);
    rows.push({ ...asset, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  writeMaps(rows);
  writeSources(rows);
  console.log(JSON.stringify({
    mode: "fetch",
    files: rows.length,
    bytes: total,
    budget: BUDGET,
    sampleDir: relative(ROOT, ASSET_DIR),
    packAssets: relative(ROOT, PACK_ASSET_DIR),
    localMap: relative(ROOT, LOCAL_MAP),
    bundles: relative(ROOT, BUNDLES),
    filesBySize: Object.fromEntries(rows.map((row) => [row.file, row.bytes])),
  }, null, 1));
  if (total > BUDGET) vaporizeError(`素材总量 ${total} B 超出预算 ${BUDGET} B`);
}

if (checkOnly) check();
else await fetchAll();
