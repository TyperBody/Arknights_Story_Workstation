// 「起步素材集」：把**常用**素材（UI 小图 + 高频背景 + 主要角色立绘）下载/转码后随安装包，
// 让自创剧情不必每次打开都联网拉资料。
//
//   src-tauri/resources/assets/starter/<file>          ← 下载/转换产物（PNG 或 WebP）
//   src-tauri/resources/assets/starter/curated.json    ← 策展清单（key/kind/group/bytes/sha256/file）
//   src-tauri/resources/assets/starter/bundles.json    ← canonical key → 文件名（`prts-cdn://` 覆盖层）
//   src-tauri/resources/assets/starter/SOURCES.md      ← 出处 / 许可
//
//   node scripts/fanfic/fetch-starter-assets.mjs                 # 下载/补齐（幂等）
//   node scripts/fanfic/fetch-starter-assets.mjs --check          # 离线：清单 ⇄ 磁盘 + 预算
//   node scripts/fanfic/fetch-starter-assets.mjs --budget=25MB --only=background --force
//
// **选择规则（确定性，可重跑）**，按优先级吃预算（默认 ≤ 25 MB）：
//   1) core       —— `src/akstage/catalog-data.json::external` 里 `kind="src"` 的 UI 小图
//                     （`assets/scenario/ui/*` 与 `widgets/production/{slide_mask,back_shadow}`），
//                     保持 PNG 原格式；全部入选。
//   2) background —— 按**剧情语料**的 `[Background(image=…)]` 出现频次降序（并列按 key 升序），
//                     只取能在 `backgroundPaths` 里解析成 PNG 的键；上限 120 张。
//   3) portrait   —— 按语料的 `[Character|charslot(name=…)]` base 频次降序，取
//                     `character.json` 里该 base 的**首个可用 image**（缺失则 `<base>/<base>`）
//                     且能在 `characterPaths` 里解析到 PNG 的键；每个 base 只取一张；上限 160 张。
//   预算：按上面顺序贪心；某张加进来会超预算就跳过（继续看后面更小的，充分利用额度）。
//   语料目录：`$AKSTAGE_CORPUS_DIR` → `/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story`
//   → `~/.akresearch/akgd/zh_CN/gamedata/story`（与 `scripts/fanfic/stage-selftest.mjs` 同源）。
//   语料缺失时**退化为**：背景/立绘按 catalog 里的键排序取前 N（并在 JSON 里注明 `rank: "catalog"`）。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const STARTER_DIR = join(ROOT, "src-tauri/resources/assets/starter");
const CATALOG = join(ROOT, "src/akstage/catalog-data.json");
const UPSTREAM = join(ROOT, "build/fanfic/upstream.json");
const CURATED = join(STARTER_DIR, "curated.json");
const BUNDLES = join(STARTER_DIR, "bundles.json");
const SOURCES = join(STARTER_DIR, "SOURCES.md");
const DEFAULT_BUDGET = 25 * 1024 * 1024;
const MAX_BACKGROUNDS = 120;
const MAX_PORTRAITS = 160;
const UA = "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)";
const ORIGIN = "https://torappu.prts.wiki";
const CORPUS_CANDIDATES = [
  process.env.AKSTAGE_CORPUS_DIR,
  "/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story",
  join(process.env.HOME ?? "", ".akresearch/akgd/zh_CN/gamedata/story"),
].filter(Boolean);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : fallback;
};
const parseBytes = (text, fallback) => {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(String(text ?? "").trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] ?? "B").toUpperCase();
  return Math.round(n * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit]);
};

const only = (value("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const budget = parseBytes(value("--budget", ""), DEFAULT_BUDGET);
const checkOnly = flag("--check");
const force = flag("--force");
const quiet = flag("--quiet");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ── 语料频次（可缺省；确定性排序）────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".txt")) out.push(path);
  }
  return out;
}

function corpusRanking() {
  const root = CORPUS_CANDIDATES.find((p) => existsSync(p) && statSync(p).isDirectory());
  if (!root) return { root: null, files: 0, backgrounds: [], characters: [] };
  const bg = new Map();
  const chr = new Map();
  let files = 0;
  for (const file of walk(root)) {
    files += 1;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\[Background\(([^\]]*)\)/g)) {
      const image = /image\s*=\s*"([^"]+)"/.exec(m[1]);
      if (image) bg.set(image[1], (bg.get(image[1]) ?? 0) + 1);
    }
    for (const m of text.matchAll(/\[(?:Character|charslot)\(([^\]]*)\)/g)) {
      for (const key of ["name", "name2"]) {
        const hit = new RegExp(`${key}\\s*=\\s*"([^"]+)"`).exec(m[1]);
        if (!hit) continue;
        const base = String(hit[1]).split(/[#$@]/)[0].toLowerCase();
        if (base) chr.set(base, (chr.get(base) ?? 0) + 1);
      }
    }
  }
  const rank = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { root, files, backgrounds: rank(bg), characters: rank(chr) };
}

// ── 策展 ────────────────────────────────────────────────────────────────
function fileNameFor(key, extension) {
  // `torappu.prts.wiki/assets/avg/black.../bg_corridor.png` → `bg_corridor.webp`
  // 立绘带一层目录（`char_x/char_x.png`）→ 两级都用 `__` 连起来，避免重名。
  const parts = key.split("/");
  const tail = parts.length > 4 ? parts.slice(4).join("__") : parts[parts.length - 1];
  const base = tail.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9_.$-]/g, "_");
  return `${base}.${extension}`;
}

function curate() {
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
  const backgroundPaths = new Set(catalog.backgroundPaths);
  const characterPaths = new Set(catalog.characterPaths);
  const upstream = existsSync(UPSTREAM) ? JSON.parse(readFileSync(UPSTREAM, "utf8")) : null;
  const characterTable = upstream?.bundle?.data?.[`${ORIGIN}/assets/avg/character.json`] ?? {};
  const corpus = corpusRanking();

  const entries = [];
  const seen = new Set();
  const sizes = new Map();
  const push = (entry) => {
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    sizes.set(entry.file, entry.bytes ?? 0);
    entries.push(entry);
  };

  // 1) core：UI 小图，保持原格式。
  for (const item of catalog.external ?? []) {
    if (item.kind !== "src") continue;
    if (!/\/assets\/scenario\/ui\/|widgets\/production\/(slide_mask|back_shadow)\./.test(item.url)) continue;
    const key = item.url.replace(/^https?:\/\//, "");
    push({ key, group: "core", kind: "ui", url: item.url, file: fileNameFor(key, key.split(".").pop()), quality: null });
  }

  // 2) background：语料频次（或用 catalog 排序兜底）。
  const bgRanked = corpus.backgrounds.length
    ? corpus.backgrounds.map(([name, uses]) => [`${ORIGIN}/assets/avg/background/${name}.png`, uses])
    : catalog.backgroundPaths.map((key) => [key, 0]);
  let backgrounds = 0;
  for (const [url, uses] of bgRanked) {
    if (backgrounds >= MAX_BACKGROUNDS) break;
    const key = url.replace(/^https?:\/\//, "");
    if (!backgroundPaths.has(key)) continue;
    push({ key, group: "background", kind: "background", url, uses, file: fileNameFor(key, "webp"), quality: 78 });
    backgrounds += 1;
  }

  // 3) portrait：语料 base 频次 → 每个 base 一张**真实存在**的 image。
  //    候选顺序：`character.json` 的 `array[].image`（优先不含 `#`/`$` 的「本体」形态，
  //    因为应用的 canonical key 会丢掉 `#` 之后的部分）→ `<base>/<base>` → 目录里第一个
  //    可解析路径。全部要能在 `characterPaths` 里命中。
  const catalogByDir = new Map();
  for (const path of characterPaths) {
    const dir = path.split("/").slice(4, 5)[0];
    if (!dir) continue;
    if (!catalogByDir.has(dir)) catalogByDir.set(dir, []);
    catalogByDir.get(dir).push(path);
  }
  for (const list of catalogByDir.values()) list.sort();
  const pickPortrait = (base) => {
    const prefix = `${ORIGIN.replace(/^https?:\/\//, "")}/assets/avg/characters/`;
    const images = (characterTable[base]?.array ?? []).map((a) => a?.image).filter(Boolean);
    const candidates = [
      ...images.filter((img) => !/[#$]/.test(img)),
      `${base}/${base}`,
      ...images,
      ...(catalogByDir.get(base) ?? []).map((path) => path.slice(prefix.length).replace(/\.png$/, "")),
    ];
    for (const candidate of candidates) {
      const key = `${prefix}${candidate}.png`;
      // `#` 形态在**两端**都会被 canonical 规则截断（Rust `media::canonical_key` /
      // JS `canonicalAssetKey` 都 `split("#")[0]`），覆盖层键与请求键就对不上了 →
      // 只在没有别的选择时才收（这里直接跳过：候选量大，够用）。
      if (!/[#$]/.test(key) && characterPaths.has(key)) return key;
    }
    return null;
  };
  const chrRanked = corpus.characters.length
    ? corpus.characters.map(([base, uses]) => [base, uses])
    : Object.keys(characterTable).sort().map((base) => [base, 0]);
  let portraits = 0;
  for (const [base, uses] of chrRanked) {
    if (portraits >= MAX_PORTRAITS) break;
    const key = pickPortrait(base);
    if (!key) continue;
    push({ key, group: "portrait", kind: "portrait", url: `https://${key}`, uses, file: fileNameFor(key, "webp"), quality: 85 });
    portraits += 1;
  }
  return { entries, corpus, rank: corpus.backgrounds.length ? "corpus" : "catalog" };
}

/** 单条：URL → 目标文件路径。已在磁盘且非 --force → 复用。 */
async function ensure(entry) {
  const target = join(STARTER_DIR, entry.file);
  if (!force && existsSync(target)) return { bytes: statSync(target).size, reused: true, bytes0: statSync(target).size };
  // 上游把 `#1` 这类形态**当成文件名的一部分**（percent-encode 后的 `%231` 才 200）。
  const res = await fetch(encodeURI(entry.url).replace(/#/g, "%23"), { headers: { "User-Agent": UA, Referer: "https://prts.wiki/" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${entry.url}`);
  const source = Buffer.from(await res.arrayBuffer());
  // 小图（`ui_*` / `char_empty`）可以很小（几十字节的占位也算合法）；只挡 HTML/空响应。
  const magicOk = source.subarray(0, 8).toString("latin1").startsWith("\x89PNG")
    || source.subarray(0, 4).toString("latin1") === "RIFF"
    || source.subarray(0, 3).toString("latin1") === "\xff\xd8\xff";
  if (source.length < 64 || !magicOk) {
    throw new Error(`不是图片（${source.length} B）：${entry.url}`);
  }
  let bytes = source;
  if (entry.quality) {
    const tmp = `${target}.src`;
    writeFileSync(tmp, source);
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", tmp,
      "-c:v", "libwebp", "-quality", String(entry.quality), target]);
    rmSync(tmp, { force: true });
    bytes = readFileSync(target);
  } else {
    writeFileSync(target, bytes);
  }
  return { bytes: bytes.length, reused: false, bytes0: source.length };
}

const human = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

function writeManifests(entries, meta) {
  const bundles = {};
  for (const entry of entries) bundles[entry.key] = entry.file;
  mkdirSync(STARTER_DIR, { recursive: true });
  writeFileSync(BUNDLES, `${JSON.stringify(bundles, null, 1)}\n`);
  writeFileSync(CURATED, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    budgetBytes: meta.budgetBytes,
    bytes: meta.bytes,
    rank: meta.rank,
    corpus: meta.corpus,
    selection: {
      core: entries.filter((e) => e.group === "core").length,
      background: entries.filter((e) => e.group === "background").length,
      portrait: entries.filter((e) => e.group === "portrait").length,
      note: "core=UI 小图（原格式）；background/portrait=语料频次降序（WebP q78/q85）；预算内贪心",
      skipped: meta.skipped ?? [],
    },
    entries,
  }, null, 1)}\n`);
  const total = entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  writeFileSync(SOURCES, [
    "# 起步素材集出处（bundled starter assets）",
    "",
    "为了「自创剧情不必每次打开都联网下载」，安装包内置一批**常用**素材：",
    `UI 小图 ${entries.filter((e) => e.group === "core").length} 张 + 背景 ${entries.filter((e) => e.group === "background").length} 张 + 立绘 ${entries.filter((e) => e.group === "portrait").length} 张，合计 ${human(total)}。`,
    "全部取自 PRTS Wiki 托管的《明日方舟》AVG 资源；版权归上海鹰角网络（Hypergryph）所有，",
    "此处仅作离线播放/同人创作之用，遵循应用整体免责声明（仓库根 `README.md`）。",
    "",
    `选择规则（确定性）：语料频次排序（来源：\`${meta.corpus.root ?? "无（按目录排序兜底）"}\`，${meta.corpus.files} 个脚本文件）；`,
    `背景 = \`[Background(image=…)]\` 频次降序，立绘 = \`[Character|charslot(name=…)]\` base 频次降序取首个可解析 image。`,
    `转码：背景 PNG → WebP q78、立绘 PNG → WebP q85（libwebp，含 alpha）；UI 小图保持 PNG。`,
    "",
    "重新生成 / 离线校验：",
    "",
    "```bash",
    "node scripts/fanfic/fetch-starter-assets.mjs            # 下载并转换（幂等）",
    "node scripts/fanfic/fetch-starter-assets.mjs --check    # 离线：清单 ⇄ 磁盘 + 预算",
    "```",
    "",
    "清单：`curated.json`（含 bytes/sha256）+ `bundles.json`（canonical key → 文件名）。",
    "",
  ].join("\n"));
}

function check() {
  const problems = [];
  if (!existsSync(CURATED)) problems.push(`缺少 ${relative(ROOT, CURATED)}（先跑一次不带 --check 的脚本）`);
  if (!existsSync(BUNDLES)) problems.push(`缺少 ${relative(ROOT, BUNDLES)}`);
  if (problems.length) return finish({ mode: "check", problems, files: 0, bytes: 0, budgetBytes: budget });
  const curated = JSON.parse(readFileSync(CURATED, "utf8"));
  const bundles = JSON.parse(readFileSync(BUNDLES, "utf8"));
  let bytes = 0;
  for (const entry of curated.entries) {
    const file = join(STARTER_DIR, entry.file);
    if (!existsSync(file)) { problems.push(`缺少文件 ${entry.file}`); continue; }
    const data = readFileSync(file);
    bytes += data.length;
    if (data.length !== entry.bytes) problems.push(`${entry.file}: 字节 ${data.length} ≠ 清单 ${entry.bytes}`);
    if (sha256(data) !== entry.sha256) problems.push(`${entry.file}: sha256 不符`);
    if (bundles[entry.key] !== entry.file) problems.push(`bundles.json 缺映射 ${entry.key} → ${entry.file}`);
  }
  const extra = Object.keys(bundles).filter((key) => !curated.entries.some((e) => e.key === key));
  if (extra.length) problems.push(`bundles.json 有未知键：${extra.join(", ")}`);
  const onDisk = readdirSync(STARTER_DIR).filter((name) => !["curated.json", "bundles.json", "SOURCES.md"].includes(name));
  const known = new Set(curated.entries.map((e) => e.file));
  for (const name of onDisk) if (!known.has(name)) problems.push(`目录里有多余文件 ${name}`);
  if (bytes > curated.budgetBytes) problems.push(`素材总量 ${bytes} B 超预算 ${curated.budgetBytes} B`);
  if (!existsSync(SOURCES)) problems.push("缺少 SOURCES.md");
  return finish({
    mode: "check",
    files: curated.entries.length,
    bytes,
    budgetBytes: curated.budgetBytes,
    byGroup: groupCounts(curated.entries),
    problems,
  });
}

const groupCounts = (entries) => entries.reduce((acc, e) => {
  acc[e.group] = acc[e.group] ?? { files: 0, bytes: 0 };
  acc[e.group].files += 1;
  acc[e.group].bytes += e.bytes ?? 0;
  return acc;
}, {});

function finish(report) {
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.problems?.length ? 1 : 0);
}

async function fetchAll() {
  mkdirSync(STARTER_DIR, { recursive: true });
  const curated = curate();
  const wants = (entry) => !only.length || only.includes(entry.group);
  const selected = [];
  const skipped = [];
  let bytes = 0;
  let reused = 0;
  let fetched = 0;
  for (const entry of curated.entries) {
    if (!wants(entry)) { skipped.push({ key: entry.key, reason: "group-not-selected" }); continue; }
    let result;
    try {
      result = await ensure(entry);
    } catch (error) {
      process.stderr.write(`warn ${entry.file}: ${error.message}\n`);
      skipped.push({ key: entry.key, reason: "fetch-failed" });
      continue;
    }
    if (bytes + result.bytes > budget) {
      // 超预算：跳过这一张，继续看后面更小的（充分利用额度）。
      skipped.push({ key: entry.key, reason: "over-budget" });
      continue;
    }
    bytes += result.bytes;
    if (result.reused) reused += 1; else fetched += 1;
    selected.push({ ...entry, bytes: result.bytes, sha256: sha256(readFileSync(join(STARTER_DIR, entry.file))), sourceBytes: result.bytes0 });
    if (!quiet && !result.reused) {
      process.stderr.write(`${entry.group}/${entry.file}: ${result.bytes0} B → ${result.bytes} B\n`);
    }
  }
  // 清理：不再入选的旧文件（改名 / 重新策展后）不该留在目录里，否则 `--check` 会报多余文件。
  if (!only.length) {
    const keep = new Set(selected.map((e) => e.file));
    for (const name of readdirSync(STARTER_DIR)) {
      if (["curated.json", "bundles.json", "SOURCES.md"].includes(name)) continue;
      if (!keep.has(name)) rmSync(join(STARTER_DIR, name), { force: true });
    }
  }
  if (bytes > budget) process.stderr.write(`warn 超出预算：${bytes} > ${budget}\n`);
  writeManifests(selected, {
    budgetBytes: budget,
    bytes,
    rank: curated.rank,
    corpus: { root: curated.corpus.root, files: curated.corpus.files },
    skipped,
  });
  finish({
    mode: "fetch",
    files: selected.length,
    bytes,
    budgetBytes: budget,
    reused,
    fetched,
    byGroup: groupCounts(selected),
    dir: relative(ROOT, STARTER_DIR),
  });
}

if (checkOnly) check();
else await fetchAll();
