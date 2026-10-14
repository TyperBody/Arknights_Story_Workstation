// 「起步素材集」：把**常用**素材（UI 小图 + 全量背景 + 语料高频角色**全差分**立绘）
// 下载/转码后随安装包，让自创剧情不必联网拉资料。
//
//   src-tauri/resources/assets/starter/<file>          ← 下载/转换产物（PNG 或 WebP）
//   src-tauri/resources/assets/starter/curated.json    ← 策展清单（key/kind/group/bytes/sha256/file）
//   src-tauri/resources/assets/starter/bundles.json    ← canonical key → 文件名（`prts-cdn://` 覆盖层）
//   src-tauri/resources/assets/starter/SOURCES.md      ← 出处 / 许可
//
//   node scripts/fanfic/fetch-starter-assets.mjs                     # 下载/补齐（幂等）
//   node scripts/fanfic/fetch-starter-assets.mjs --check             # 离线：清单 ⇄ 磁盘 + 预算
//   node scripts/fanfic/fetch-starter-assets.mjs --budget=560MB --concurrency=12
//   node scripts/fanfic/fetch-starter-assets.mjs --plan              # 只出清单（不下载/转码）
//
// **选择规则（确定性，可重跑）**，按优先级吃预算（默认 ≤ 560 MiB）：
//   0) archive    —— 把下载/转码结果打成 `starter.zip`（**安装包里只放 zip**：几百 MB
//                     的 PNG/WebP 逐文件放出会让 NSIS/deb 显著膨胀 + 安装慢；zip 后
//                     再被安装包压缩一次也有收益）。运行期首次启动 `assets.rs::seed`
//                     把 zip 解到 `<资源目录>/assets/starter/`（幂等，见 Rust 侧）。
//                     `--check` 同时校验 zip 与目录。
//   1) core       —— `src/akstage/catalog-data.json::external` 里 `kind="src"` 的 UI 小图
//                     （`assets/scenario/ui/*` 与 `widgets/production/{slide_mask,back_shadow}`），
//                     保持 PNG 原格式；全部入选（约 7 张，几十 KB）。
//   2) background —— **全量**：`catalog-data.json::backgroundPaths` 的每一条（约 1000 张），
//                    按**语料** `[Background(image=…)]` 频次降序（并列按 key 升序），
//                    高频在前；PNG → WebP q80（约 PNG 的 25–40%）。
//   3) portrait   —— 按语料的 `[Character|charslot(name=…)]` base 频次降序，**逐 base 收全差分**：
//                    每个 base 取 `character.json` 里该 base 的所有可用 `image`（含 `$N` 分组、
//                    NPC 多差分），PNG → WebP q82；预算吃满即止（**至少** `--min-bases` 个 base，
//                    默认 1 —— 保证"一个角色也有十几张差分"）。
//   预算：按上面顺序贪心；超预算的条目**跳过并继续**找更小的，充分利用额度。
//   语料目录：`$AKSTAGE_CORPUS_DIR` → `/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story`
//   → `~/.akresearch/akgd/zh_CN/gamedata/story`（与 `scripts/fanfic/stage-selftest.mjs` 同源）。
//   语料缺失时退化为按 catalog 排序取前 N（并在 JSON 里注明 `rank: "catalog"`）。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cpus } from "node:os";

const ROOT = resolve(import.meta.dirname, "..", "..");
/** argv 的一行式解析（`value`/`flag` 定义在下方；这里先用最朴素的实现）。 */
const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a === name || a.startsWith(`${name}=`));
  if (!hit) return fallback;
  return hit === name ? "" : hit.slice(name.length + 1);
};
/**
 * 打包档：
 * - `full`     —— 历史行为：背景全量 + 立绘全差分 + 音频（≈1000 MB，全部随包）。
 * - `starters` —— **随包预素材**：背景全量 + 立绘每 base **主差分**，**不含音频**（≈230 MB）。
 * - `patch`    —— **补丁包**：立绘**其余差分** + 全部音频（≈2.5 GB）；用户下载后解到
 *                 `<资源目录>/assets/starter/` 即生效（覆盖层按 canonical key 命中）。
 */
const PACK = (argOf("--pack", "") || "full").toLowerCase();
/** 产出目录：`--dir` 优先；`patch` 默认落 `build/starter-patch`（不进安装包）。 */
const STARTER_DIR = argOf("--dir", "")
  ? resolve(ROOT, argOf("--dir", ""))
  : resolve(ROOT, PACK === "patch" ? "build/starter-patch" : "src-tauri/resources/assets/starter");
const CATALOG = join(ROOT, "src/akstage/catalog-data.json");
const UPSTREAM = join(ROOT, "build/fanfic/upstream.json");
const CURATED = join(STARTER_DIR, "curated.json");
const BUNDLES = join(STARTER_DIR, "bundles.json");
const SOURCES = join(STARTER_DIR, "SOURCES.md");
/** 默认预算 1000 MiB（用户要求"起码 500MB 起步"，后追加"可以扩到 1000MB"）。 */
const DEFAULT_BUDGET = 1000 * 1024 * 1024;
/** 并发（抓取 + 转码同一池；默认 min(12, CPU)）。 */
const DEFAULT_CONCURRENCY = Math.max(4, Math.min(12, cpus().length || 4));
/** 立绘至少覆盖多少个 base（保证"每个角色十几张差分"至少有一批角色做到）。 */
const MIN_PORTRAIT_BASES = 60;
const UA = "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)";
const ORIGIN = "https://torappu.prts.wiki";
const CORPUS_CANDIDATES = [
  process.env.AKSTAGE_CORPUS_DIR,
  "/home/typer/桌面/.akresearch/akgd/zh_CN/gamedata/story",
  join(process.env.HOME ?? "", ".akresearch/akgd/zh_CN/gamedata/story"),
].filter(Boolean);

/**
 * 质量档（libwebp `-quality`，0–100）：**近无损优先**。
 * 用户要求「素材分辨率越高越好，为了高点可以接受放弃之前的素材换一批」——
 * 因此不做任何缩放（分辨率 = 上游原图），只把 PNG → WebP 高质量转码：
 * 88 ≈ PNG 视觉无损（背景有大面积渐变/噪点）；90 对立绘的 alpha 边缘更稳。
 * 体积换算 ≈ PNG 的 45–60%；预算吃满由「背景全量 + 立绘高频全差分」共同决定。
 */
const QUALITY = { background: 88, portrait: 90 };

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : fallback;
};
const parseBytes = (text, fallback) => {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|MiB|KiB|GiB)?$/i.exec(String(text ?? "").trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] ?? "B").toUpperCase();
  return Math.round(n * { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3 }[unit]);
};

const only = (value("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const budget = parseBytes(value("--budget", ""), DEFAULT_BUDGET);
const minBases = Number(value("--min-bases", "")) || MIN_PORTRAIT_BASES;
const concurrency = Math.max(1, Math.min(32, Number(value("--concurrency", "")) || DEFAULT_CONCURRENCY));
const checkOnly = flag("--check");
const planOnly = flag("--plan");
const force = flag("--force");
const quiet = flag("--quiet");
/**
 * 是否额外产出 `starter.zip`。用户结论：「exe 安装包自带压缩」→ NSIS/deb 已压缩随包
 * 资源，逐文件放即可；zip 只对「直接拷贝 resources/ 的绿色版」有意义。默认**关**。
 */
const useArchive = flag("--archive");
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
  if (!root) return { root: null, files: 0, backgrounds: [], characters: [], sounds: [] };
  const bg = new Map();
  const chr = new Map();
  const snd = new Map();
  let files = 0;
  for (const file of walk(root)) {
    files += 1;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\[Background\(([^\]]*)\)/g)) {
      const image = /image\s*=\s*"([^"]+)"/.exec(m[1]);
      if (image) bg.set(image[1], (bg.get(image[1]) ?? 0) + 1);
    }
    // 音频变量引用：`$name` → 变量名（小写，与 `story_variables.json` 的键同域）。
    for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)/g)) {
      const name = m[1].toLowerCase();
      snd.set(name, (snd.get(name) ?? 0) + 1);
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
  return { root, files, backgrounds: rank(bg), characters: rank(chr), sounds: rank(snd) };
}

// ── 策展 ────────────────────────────────────────────────────────────────
/** 该 pack 是否需要音频组（`PACK` 见文件顶部）。 */
const wantsAudio = () => PACK !== "starters";
/** 立绘差分取哪一段（`first` = 每 base 主差分；`rest` = 其余差分/表情）。 */
const wantsPortrait = (part) => (PACK === "starters" ? part === "first" : PACK === "patch" ? part === "rest" : true);

function fileNameFor(key, extension) {
  // `torappu.prts.wiki/assets/avg/black.../bg_corridor.png` → `bg_corridor.webp`
  // 立绘带一层目录（`char_x/char_x$1.png`）→ 两级都用 `__` 连起来，避免重名；
  // `$` 保留（PNG 的 canonical key 里就带 `$`，Rust `canonical_key` 不切 `$`）。
  const parts = key.split("/");
  const tail = parts.length > 4 ? parts.slice(4).join("__") : parts[parts.length - 1];
  const base = tail.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9_.$-]/g, "_");
  return `${base}.${extension}`;
}

/** `$` → `%24`、`#` → `%23`（PRTS 把两者都当文件名的一部分；URL 里需转义）。 */
const encodeAssetUrl = (url) => encodeURI(url).replace(/\$/g, "%24").replace(/#/g, "%23");

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

  // 1) core：UI 小图（`patch` 是**增量**包 —— starters 已含 UI，跳过）。
  if (PACK !== "patch") {
    for (const item of catalog.external ?? []) {
      if (item.kind !== "src") continue;
      if (!/\/assets\/scenario\/ui\/|widgets\/production\/(slide_mask|back_shadow)\./.test(item.url)) continue;
      const key = item.url.replace(/^https?:\/\//, "");
      push({ key, group: "core", kind: "ui", url: item.url, file: fileNameFor(key, key.split(".").pop()), quality: null });
    }
  }

  // 2) background：**全量**，语料频次降序（缺语料 → 按 catalog 排序）。`patch` 跳过。
  if (PACK !== "patch") {
    const bgRanked = corpus.backgrounds.length
      ? corpus.backgrounds.map(([name, uses]) => [`${ORIGIN}/assets/avg/background/${name}.png`, uses])
      : catalog.backgroundPaths.map((key) => [key, 0]);
    for (const [url, uses] of bgRanked) {
      const key = url.replace(/^https?:\/\//, "");
      if (!backgroundPaths.has(key)) continue;
      push({ key, group: "background", kind: "background", url, uses, file: fileNameFor(key, "webp"), quality: QUALITY.background });
    }
  }

  // 3) portrait：语料 base 频次 → 每个 base 收**全差分**。
  //    **差分的真正来源是目录**：`assets/avg/characters/<base>/<base>_2.png`、
  //    `<base>_3.png`…（`character.json` 的 `array[].image` 常常只列到本体，
  //    实测「每 base 中位数 1 张」就是这个原因）；所以**优先**把该 base 目录下的
  //    所有 PNG 收全，`character.json` 的 `image`/`face` 作补充（含 `$N` 分组）。
  const catalogByDir = new Map();
  for (const path of characterPaths) {
    const dir = path.split("/").slice(4, 5)[0];
    if (!dir) continue;
    if (!catalogByDir.has(dir)) catalogByDir.set(dir, []);
    catalogByDir.get(dir).push(path);
  }
  for (const list of catalogByDir.values()) list.sort();
  const prefix = `${ORIGIN.replace(/^https?:\/\//, "")}/assets/avg/characters/`;
  /**
   * 一个 base 的**全部**立绘 key（顺序 = 本体优先、差分按名字自然序）。
   * ① 目录里的全量 PNG（`char_x/char_x.png`、`char_x/char_x_2.png`…）——主来源；
   * ② `character.json` 的 `array[].image` / `face`（补目录里没有的 `$N` 形态）。
   */
  const stylesOf = (base) => {
    const out = new Set(catalogByDir.get(base) ?? []);
    const fromTable = (characterTable[base]?.array ?? []).flatMap((a) => [a?.image, a?.face])
      .filter(Boolean).map((raw) => `${prefix}${String(raw).endsWith(".png") ? raw : `${raw}.png`}`);
    for (const path of fromTable) if (characterPaths.has(path)) out.add(path);
    const list = [...out].filter((path) => characterPaths.has(path));
    const rank = (path) => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (name === `${base}.png`) return [0, name];
      if (name.startsWith(`${base}_`)) return [1, Number(/(\d+)\.png$/.exec(name)?.[1] ?? 0), name];
      return [2, name];
    };
    return list.sort((a, b) => {
      const [ga, na, sa] = rank(a);
      const [gb, nb, sb] = rank(b);
      return ga - gb || (typeof na === "number" && typeof nb === "number" ? na - nb : 0) || String(sa).localeCompare(String(sb));
    });
  };
  // 候选 base：语料频次 → 全部目录 base（目录里没立绘的 base 自然被 `stylesOf` 过滤掉）。
  const ranked = new Map(
    corpus.characters.map(([base, uses]) => [base, uses]),
  );
  for (const base of catalogByDir.keys()) if (!ranked.has(base)) ranked.set(base, 0);
  const chrRanked = [...ranked.entries()]
    .filter(([base]) => base !== "char_empty")
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // 两趟（**保障覆盖**）：第一趟每个 base 收**本体**一张（`<base>.png`，没有则
  // 第一张候选）；第二趟按 base 频次从高到低把**其余差分**补齐。这样预算被吃满时
  // 也是"所有 base 都有主体立绘 + 高频角色差分更全"，而不是"前几百个 base 全差分、
  // 其余一个都没有"。
  const first = [];
  const rest = [];
  let bases = 0;
  for (const [base, uses] of chrRanked) {
    const styles = stylesOf(base);
    if (!styles.length) continue;
    bases += 1;
    const entryOf = (key) => ({ key, group: "portrait", kind: "portrait", base, url: `https://${key}`, uses, file: fileNameFor(key, "webp"), quality: QUALITY.portrait });
    const body = styles[0];
    first.push({ ...entryOf(body), primary: true });
    for (const key of styles.slice(1)) rest.push(entryOf(key));
  }
  if (wantsPortrait("first")) for (const entry of first) push(entry);
  if (wantsPortrait("rest")) for (const entry of rest) push(entry);

  // 4) audio：`story_variables.json` 里指向 `Sound_Beta_2/...` 的音频变量，按语料
  //    `$变量` 引用频次降序。URL 规则与引擎（`pack.mjs::audioUrl` /
  //    `asset.ts::audioUrlFromValue`）逐字一致：`sound_beta_2` → `assets/audio`。
  //    mp3 已压缩 → 不转码（`quality: null`）；体积大（≈0.3 MB/条）正是补足预算的主力。
  const variables = upstream?.bundle?.data?.[`${ORIGIN}/gamedata/latest/story/story_variables.json`] ?? {};
  const audioUses = new Map(corpus.sounds ?? []);
  const audioRanked = Object.entries(variables)
    .filter(([name, value]) => name && typeof value === "string" && /sound_beta_2\//i.test(value))
    .map(([name, value]) => {
      const url = `${ORIGIN}/${String(value).toLowerCase().replace("sound_beta_2", "assets/audio")}.mp3`;
      return { name, url, uses: audioUses.get(name) ?? 0 };
    })
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  for (const item of wantsAudio() ? audioRanked : []) {
    const key = item.url.replace(/^https?:\/\//, "");
    if (!/\.mp3$/.test(key)) continue;
    push({ key, group: "audio", kind: "audio", url: item.url, uses: item.uses, file: fileNameFor(key, "mp3"), quality: null });
  }
  return { entries, corpus, rank: corpus.backgrounds.length ? "corpus" : "catalog", bases };
}

/**
 * 「已确认没有的 key」缓存（`build/starter-missing.json`）。
 * PRTS 的 `characterPaths` 里约 **83% 的 `$` 形态**已经下线（实测命中 ≈17%）：
 * 第一轮为它们打了 1.4 万个 404，重跑不该再来一遍。
 */
const MISS_FILE = join(ROOT, "build/starter-missing.json");
const missing = new Set((() => {
  try { return JSON.parse(readFileSync(MISS_FILE, "utf8")); } catch { return []; }
})());

/** 单条：URL → 目标文件路径。已在磁盘且非 --force → 复用；已知缺失 → 立刻失败（不打网络）。 */
async function ensure(entry) {
  const target = join(STARTER_DIR, entry.file);
  if (!force && existsSync(target)) {
    const size = statSync(target).size;
    return { bytes: size, reused: true, bytes0: size };
  }
  if (!force && missing.has(entry.key)) throw new Error(`HTTP 404（缓存）for ${entry.url}`);
  // PRTS 在**高频并发**下会对正常资源偶发 404 / 中转页（限流）。实测同一张
  // `char_002_amiya_2.png`：单独请求 200，批量并发时被记成 404。故 404 →
  // 退避重试 2 次；仍失败才抛（调用方据此写进 missing 缓存）。
  const url = encodeAssetUrl(entry.url);
  const headers = { "User-Agent": UA, Referer: "https://prts.wiki/" };
  let res;
  for (let attempt = 1; ; attempt += 1) {
    res = await fetch(url, { headers });
    if (res.ok || attempt > 2) break;
    await res.arrayBuffer().catch(() => {});
    await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${entry.url}`);
  const source = Buffer.from(await res.arrayBuffer());
  const head = source.subarray(0, 8).toString("latin1");
  // PNG / RIFF(WebP) / JPEG / MP3（`ID3` 标签或裸帧同步 0xFF）。
  const magicOk = head.startsWith("\x89PNG") || head.slice(0, 4) === "RIFF"
    || head.slice(0, 3) === "\xff\xd8\xff" || head.startsWith("ID3") || source[0] === 0xff;
  // PRTS 图床对「目录里有、图还没生成」的差分（几乎全是 `$` 形态）回 200 + 57 B 中转页：
  //   `<html><script>document.location.reload();</script></html>`
  // 语义是"下次再来"，重试 6 次也**不变**（实测）→ 记 missing，重跑不再打网络。
  if (/document\.location\.reload\(\)/.test(source.subarray(0, 200).toString("utf8"))) {
    throw new Error(`PRTS 中转页（${source.length} B，图床未就绪）for ${entry.url}`);
  }
  if (source.length < 16 || !magicOk) {
    throw new Error(`不是图片（${source.length} B, head=${JSON.stringify(head)}）：${entry.url}`);
  }
  let bytes = source;
  if (entry.quality) {
    // `-preset 4` = 图片（libwebp 的整数 preset；`-preset picture` 需新版 ffmpeg，
    // 8.0 会报 `Option not found`）。`-compression_level 5` 在体积/耗时之间折中；
    // 注意本构建的 libwebp **没有** `-alpha_quality`（透明度按 `-quality` 走）。
    const tmp = `${target}.src`;
    writeFileSync(tmp, source);
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", tmp,
      "-c:v", "libwebp", "-preset", "4", "-compression_level", "5",
      "-quality", String(entry.quality), target]);
    rmSync(tmp, { force: true });
    bytes = readFileSync(target);
  } else {
    writeFileSync(target, bytes);
  }
  return { bytes: bytes.length, reused: false, bytes0: source.length };
}

const human = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

/** 归档文件名（安装包 `bundle.resources` 里**只**放它 + 三个清单）。 */
const ARCHIVE = join(STARTER_DIR, "starter.zip");

/**
 * 把 `files` 打进 `starter.zip`（deflate）。
 * 为什么归档：NSIS/deb 逐文件收起几百 MB 的小 PNG 会产生大量条目（安装慢、增量更新差），
 * zip 内条目名 = 文件名（扁平），Rust 侧 `unzip` 到 `<资源目录>/assets/starter/`。
 */
function writeArchive(files) {
  rmSync(ARCHIVE, { force: true });
  if (!files.length) return { bytes: 0 };
  // `zip -X`（去 extra field）→ 可复现；`-@` 从 stdin 读文件清单（几百 MB 不必进 argv）。
  const list = files.map((name) => join(STARTER_DIR, name));
  execFileSync("zip", ["-q", "-X", "-9", "-j", ARCHIVE, ...list], { cwd: STARTER_DIR, maxBuffer: 64 * 1024 * 1024 });
  return { bytes: statSync(ARCHIVE).size };
}

function writeManifests(entries, meta) {
  const bundles = {};
  for (const entry of entries) bundles[entry.key] = entry.file;
  mkdirSync(STARTER_DIR, { recursive: true });
  writeFileSync(BUNDLES, `${JSON.stringify(bundles, null, 1)}\n`);
  const byGroup = groupCounts(entries);
  writeFileSync(CURATED, `${JSON.stringify({
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    budgetBytes: meta.budgetBytes,
    bytes: meta.bytes,
    archiveBytes: meta.archiveBytes ?? 0,
    archive: "starter.zip",
    rank: meta.rank,
    corpus: meta.corpus,
    selection: {
      core: byGroup.core?.files ?? 0,
      background: byGroup.background?.files ?? 0,
      portrait: byGroup.portrait?.files ?? 0,
      portraitBases: meta.bases ?? null,
      minBases: meta.minBases ?? null,
      note: "core=UI 小图（原格式）；background=全量（catalog）；portrait=语料 base 频次降序 + 全差分；均 WebP 压缩",
      skipped: meta.skipped ?? [],
    },
    entries,
  }, null, 1)}\n`);
  const total = entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  writeFileSync(SOURCES, [
    "# 起步素材集出处（bundled starter assets）",
    "",
    "为了「自创剧情不必每次打开都联网下载」，安装包内置一批**常用**素材：",
    `UI 小图 ${byGroup.core?.files ?? 0} 张 + 背景 ${byGroup.background?.files ?? 0} 张 + 立绘 ${byGroup.portrait?.files ?? 0} 张（覆盖 ${meta.bases ?? "?"} 个角色 base 的全差分），合计 ${human(total)}。`,
    "全部取自 PRTS Wiki 托管的《明日方舟》AVG 资源；版权归上海鹰角网络（Hypergryph）所有，",
    "此处仅作离线播放/同人创作之用，遵循应用整体免责声明（仓库根 `README.md`）。",
    "",
    `选择规则（确定性）：背景 = \`backgroundPaths\` 全量、按语料 \`[Background(image=…)]\` 频次降序（来源：\`${meta.corpus.root ?? "无（按目录排序兜底）"}\`，${meta.corpus.files} 个脚本文件）；`,
    "立绘 = `[Character|charslot(name=…)]` base 频次降序，**逐 base 收全差分**（`character.json` 的 `array[].image` / `face`）。",
    `转码：背景 PNG → WebP q${QUALITY.background}、立绘 PNG → WebP q${QUALITY.portrait}（libwebp，含 alpha）；UI 小图保持 PNG。`,
    `预算：${human(meta.budgetBytes)}（\`--budget=…\` 可调）；超出即跳过并继续找更小的条目。`,
    "",
    "重新生成 / 离线校验：",
    "",
    "```bash",
    "node scripts/fanfic/fetch-starter-assets.mjs             # 下载并转换（幂等）",
    "node scripts/fanfic/fetch-starter-assets.mjs --plan      # 只看清单与预估体积",
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
  const onDisk = readdirSync(STARTER_DIR)
    .filter((name) => !["curated.json", "bundles.json", "SOURCES.md", "starter.zip"].includes(name)
      && !name.endsWith(".src") && !name.endsWith(".pending"));
  const known = new Set(curated.entries.map((e) => e.file));
  for (const name of onDisk) if (!known.has(name)) problems.push(`目录里有多余文件 ${name}`);
  if (bytes > curated.budgetBytes) problems.push(`素材总量 ${bytes} B 超预算 ${curated.budgetBytes} B`);
  if (!existsSync(SOURCES)) problems.push("缺少 SOURCES.md");
  // 归档（可选）：`--check` 时存在就校验条目齐不齐（安装包默认不依赖 zip）。
  let archiveBytes = 0;
  if (existsSync(ARCHIVE)) {
    archiveBytes = statSync(ARCHIVE).size;
    try {
      const list = execFileSync("unzip", ["-Z1", ARCHIVE], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
        .split("\n").map((s) => s.trim()).filter(Boolean).sort();
      const want = [...known].sort();
      if (list.length !== want.length) problems.push(`starter.zip 条目 ${list.length} ≠ 清单 ${want.length}`);
      else {
        const missing = want.filter((name, index) => list[index] !== name);
        if (missing.length) problems.push(`starter.zip 缺条目：${missing.slice(0, 3).join(", ")}`);
      }
    } catch (error) {
      problems.push(`starter.zip 读取失败：${String(error.message).slice(0, 120)}`);
    }
  }
  return finish({
    mode: "check",
    files: curated.entries.length,
    bytes,
    archiveBytes,
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

/** `--plan`：只出清单（各分组条目数 + 预估体积用 PNG 均值的粗略外推）。 */
function plan() {
  const curated = curate();
  const counts = { core: 0, background: 0, portrait: 0 };
  const basesByGroup = {};
  for (const entry of curated.entries) {
    counts[entry.group] = (counts[entry.group] ?? 0) + 1;
    if (entry.group === "portrait") (basesByGroup[entry.base] = basesByGroup[entry.base] ?? 0);
    if (entry.group === "portrait") basesByGroup[entry.base] += 1;
  }
  const widths = Object.values(basesByGroup).sort((a, b) => b - a);
  finish({
    mode: "plan",
    budgetBytes: budget,
    bytesOnDisk: existsSync(CURATED) ? JSON.parse(readFileSync(CURATED, "utf8")).bytes : 0,
    candidates: counts,
    portraitBases: widths.length,
    portraitPerBase: { max: widths[0] ?? 0, median: widths[Math.floor(widths.length / 2)] ?? 0, min: widths[widths.length - 1] ?? 0 },
    rank: curated.rank,
    corpus: { root: curated.corpus.root, files: curated.corpus.files },
    note: "预估：背景 PNG→WebP ≈ 28%，立绘 PNG→WebP ≈ 30%（实测见 curated.json）",
  });
}

/** 并发池：`--concurrency` 个 worker 拉同一队列（顺序 = 候选顺序，结果按顺序回收）。 */
async function mapPool(items, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index], index).catch((error) => ({ error }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function fetchAll() {
  mkdirSync(STARTER_DIR, { recursive: true });
  const curated = curate();
  const wants = (entry) => !only.length || only.includes(entry.group);
  const pool = curated.entries.filter(wants);
  if (planOnly) return plan();
  process.stderr.write(`[starter] 候选 ${pool.length} 条（并发 ${concurrency}，预算 ${human(budget)}）\n`);

  let done = 0;
  const results = await mapPool(pool, async (entry) => {
    const result = await ensure(entry);
    done += 1;
    if (!quiet && (done % 100 === 0 || done === pool.length)) {
      process.stderr.write(`[starter] ${done}/${pool.length} 已处理…\n`);
    }
    return { entry, result };
  });

  const selected = [];
  const skipped = [];
  let bytes = 0;
  let reused = 0;
  let fetched = 0;
  for (const item of results) {
    if (!item || item.error) {
      const key = item?.entry?.key;
      const reason = `fetch-failed: ${String(item?.error?.message ?? "?")}`.slice(0, 200);
      // 明确的 404 → 记进缓存，重跑时不再打网络（catalog 里大量 `$` 形态已下线）。
      if (key && /HTTP 404/.test(reason)) missing.add(key);
      skipped.push({ key: key ?? "?", reason });
      continue;
    }
    const { entry, result } = item;
    if (bytes + result.bytes > budget) {
      // 超预算：跳过这一张，继续看后面更小的（充分利用额度）。
      skipped.push({ key: entry.key, reason: "over-budget" });
      continue;
    }
    bytes += result.bytes;
    if (result.reused) reused += 1; else fetched += 1;
    selected.push({ ...entry, bytes: result.bytes, sha256: sha256(readFileSync(join(STARTER_DIR, entry.file))), sourceBytes: result.bytes0 });
  }
  // 清理：不再入选的旧文件（改名 / 重新策展后）不该留在目录里，否则 `--check` 会报多余文件。
  if (!only.length) {
    const keep = new Set(selected.map((e) => e.file));
    for (const name of readdirSync(STARTER_DIR)) {
      if (["curated.json", "bundles.json", "SOURCES.md"].includes(name)) continue;
      if (!keep.has(name)) rmSync(join(STARTER_DIR, name), { force: true });
    }
    // 中断/失败留下的 `.src` 临时文件 / `.pending` 中转页标记也清掉。
    for (const name of readdirSync(STARTER_DIR)) {
      if (name.endsWith(".src") || name.endsWith(".pending")) rmSync(join(STARTER_DIR, name), { force: true });
    }
  }
  if (bytes > budget) process.stderr.write(`warn 超出预算：${bytes} > ${budget}\n`);
  // 404 缓存落盘：重跑只需处理"新候选"，不必再为已下线的 `$` 形态打一轮网络。
  if (!only.length && missing.size) {
    mkdirSync(join(ROOT, "build"), { recursive: true });
    writeFileSync(MISS_FILE, `${JSON.stringify([...missing].sort(), null, 0)}\n`);
  }
  // 归档（`--archive` 才写）：安装包本身已压缩（NSIS/deb），zip 只对绿色版有意义。
  const archive = useArchive ? writeArchive(selected.map((e) => e.file)) : { bytes: 0 };
  if (useArchive) process.stderr.write(`[starter] 归档 starter.zip ${human(archive.bytes)}（源文件 ${human(bytes)}）\n`);
  const bases = new Set(selected.filter((e) => e.group === "portrait").map((e) => e.base)).size;
  writeManifests(selected, {
    budgetBytes: budget,
    bytes,
    rank: curated.rank,
    corpus: { root: curated.corpus.root, files: curated.corpus.files },
    bases,
    minBases,
    skipped,
    archiveBytes: archive.bytes,
  });
  finish({
    mode: "fetch",
    files: selected.length,
    bytes,
    archiveBytes: archive.bytes,
    budgetBytes: budget,
    reused,
    fetched,
    portraitBases: bases,
    byGroup: groupCounts(selected),
    dir: relative(ROOT, STARTER_DIR),
  });
}

if (checkOnly) check();
else await fetchAll();
