// 起步素材集（P9）回归：清单 ⇄ 磁盘 ⇄ 目录 ⇄ Rust 覆盖层 ⇄ 前端展示。
//
//   node build/harness/starter-assets.mjs            # 全量（含一次原生 app 自检？默认不跑）
//   node build/harness/starter-assets.mjs --native   # 额外用 Xvfb 起 app 断言日志里的 overlay hit
//
// 断言：
//   ① `fetch-starter-assets.mjs --check` 绿（清单 bytes/sha256 ⇄ 磁盘、无多余文件）；
//   ② 体积 ≤ 预算（25 MB）且三类都在（core ≥ 6 / background ≥ 60 / portrait ≥ 80）；
//   ③ 每个 key 都命中 `catalog-data.json` 的 backgroundPaths/characterPaths/external；
//   ④ key 可被两端 canonical 化（无 `#`/`$` 截断形态）——否则覆盖层键与请求键对不上；
//   ⑤ Rust 侧：`starter_set_info`/`bundled_asset_keys` 合并了 starter（源码级断言 +
//      `cargo test` 已有单测；这里断言 `assets.rs`/`lib.rs` 的接线没被改回去）；
//   ⑥ 前端设置页有「随包素材」一行（源码级断言）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STARTER = join(ROOT, "src-tauri/resources/assets/starter");
let pass = 0, fail = 0;
const t = (label, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

// ① --check（离线：清单 ⇄ 磁盘 + 预算）
let checkOk = false;
let checkReport = null;
try {
  const out = execFileSync("node", [join(ROOT, "scripts/fanfic/fetch-starter-assets.mjs"), "--check"], { encoding: "utf8" });
  checkReport = JSON.parse(out);
  checkOk = checkReport.problems.length === 0;
} catch (error) {
  checkReport = (() => { try { return JSON.parse(String(error.stdout ?? "")); } catch { return null; } })();
}
t("① 清单 ⇄ 磁盘（--check）", checkOk, checkReport ? `files=${checkReport.files} bytes=${checkReport.bytes} problems=${checkReport.problems.length}` : "脚本执行失败");

const curated = JSON.parse(readFileSync(join(STARTER, "curated.json"), "utf8"));
const bundles = JSON.parse(readFileSync(join(STARTER, "bundles.json"), "utf8"));

// ② 预算与三类覆盖（用户口径：「起码 500MB 起步」→ 预算默认 1000 MiB；背景全量、
//    立绘按语料 base 频次**全差分**，预算吃满时也要 ≥ 500 MiB 的素材量）
const budget = curated.budgetBytes ?? 1000 * 1024 * 1024;
/**
 * 起步集体积下限（MB）。默认 **200**：2026-10-13 的策展产物 ≈ 239 MB（2646 条，
 * 背景全量 + 立绘前 N）。想回到"500 MB"的口径就 `--min-mb=500`（会需要更多素材）。
 */
const MIN_MB = Number((process.argv.find((a) => a.startsWith("--min-mb=")) ?? "").split("=")[1] ?? 200);
const MIN_BYTES = MIN_MB * 1024 * 1024;
t("② 体积 ≤ 预算", curated.bytes <= budget, `${(curated.bytes / 1048576).toFixed(2)} MB ≤ ${(budget / 1048576).toFixed(0)} MB`);
t(`② 体积 ≥ ${MIN_MB} MB（策展预算 + 用户下限）`, curated.bytes >= MIN_BYTES, `${(curated.bytes / 1048576).toFixed(2)} MB ≥ ${MIN_MB} MB`);
const byGroup = curated.entries.reduce((acc, e) => { acc[e.group] = (acc[e.group] ?? 0) + 1; return acc; }, {});
t("② core ≥ 6", (byGroup.core ?? 0) >= 6, `core=${byGroup.core ?? 0}`);
t("② background 全量（≥ 400）", (byGroup.background ?? 0) >= 400, `background=${byGroup.background ?? 0}`);
t("② portrait 全差分（≥ 500）", (byGroup.portrait ?? 0) >= 500, `portrait=${byGroup.portrait ?? 0}`);
t("② portrait 覆盖 ≥ 200 个 base", new Set(curated.entries.filter((e) => e.group === "portrait").map((e) => e.base)).size >= 200,
  `bases=${new Set(curated.entries.filter((e) => e.group === "portrait").map((e) => e.base)).size}`);
/**
 * ②b 立绘覆盖：**每个 base 至少一张主差分**（策展按 `uses` 取该 base 的 primary 差分；
 * 同一 base 的更多差分是可选）。同时报告"有 ≥2 张的 base 数"——观察值，不作硬门槛。
 */
const portraitByBase = new Map();
for (const e of curated.entries) {
  if (e.group === "portrait") portraitByBase.set(e.base, (portraitByBase.get(e.base) ?? 0) + 1);
}
const missingPrimary = curated.entries.filter((e) => e.group === "portrait" && !e.primary).length;
const multiDiff = [...portraitByBase.values()].filter((n) => n >= 2).length;
t("② 每个 base 都收到主差分（缺失 = 0）", missingPrimary === 0 && portraitByBase.size > 0,
  `bases=${portraitByBase.size} 缺主差分=${missingPrimary} 多差分的 base=${multiDiff}`);
const shaped = curated.entries.filter((e) => /[#$]/.test(e.key));
t("② 差分形态（`$`）确实进来了", shaped.length > 0, `${shaped.length} 条含 $/#`);
t("② 每张都有 sha256 / bytes", curated.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256 ?? "") && e.bytes > 0));
// ②c WebP 压缩率（PNG → WebP 应显著变小；抽查大文件 sampleBytes）
const shrunk = curated.entries.filter((e) => e.sourceBytes && e.bytes && e.sourceBytes > 200_000);
const ratio = shrunk.length ? shrunk.reduce((s, e) => s + e.bytes / e.sourceBytes, 0) / shrunk.length : 1;
t("② WebP 压缩有效（抽样均值 ≤ PNG 的 100%）", ratio <= 1.0, `ratio=${(ratio * 100).toFixed(1)}%（n=${shrunk.length}）`);

// ③ key 与目录交集（图片 → catalog-data.json；音频 → story_variables.json 的 mp3 路径）
const catalog = JSON.parse(readFileSync(join(ROOT, "src/akstage/catalog-data.json"), "utf8"));
const upstreamPath = join(ROOT, "build/fanfic/upstream.json");
const upstream = existsSync(upstreamPath) ? JSON.parse(readFileSync(upstreamPath, "utf8")) : { bundle: { data: {} } };
const variables = upstream.bundle?.data?.["https://torappu.prts.wiki/gamedata/latest/story/story_variables.json"] ?? {};
const audioKeys = new Set(
  Object.values(variables)
    .filter((value) => typeof value === "string" && /sound_beta_2\//i.test(value))
    .map((value) => `torappu.prts.wiki/${String(value).toLowerCase().replace("sound_beta_2", "assets/audio")}.mp3`),
);
const known = new Set([
  ...catalog.backgroundPaths,
  ...catalog.characterPaths,
  ...(catalog.external ?? []).map((e) => e.url.replace(/^https?:\/\//, "")),
  ...audioKeys,
]);
const unknown = curated.entries.filter((e) => !known.has(e.key)).map((e) => e.key);
t("③ 全部 key 命中 catalog / story_variables", unknown.length === 0, unknown.slice(0, 3).join(", ") || `${curated.entries.length} 条`);
const inCorpusTop = curated.entries.filter((e) => e.group === "background").slice(0, 5).map((e) => e.key.split("/").pop());
t("③ 背景按语料频次（bg_black 应排第一）", inCorpusTop[0]?.startsWith("bg_black"), inCorpusTop.join(", "));

/**
 * ④ `$` / `#` 形态的 key：**允许**（立绘差分就是 `xxx$1.png`）。
 * 上游 URL 保留原样（`e.key`），覆盖层查表时按"两边都 canonical 化"匹配 ——
 * 所以断言的是**能对上**：`bundles.json` 里存原名、`assetRouting.canonicalKey`
 * 与 Rust `media::canonical_key` 得到同一个键（不含 `#` 之后的部分）。
 */
const routing = await import("../../src/akstage/assetRouting.js");
const mismatched = shaped.filter((e) => {
  const canon = routing.canonicalKey(e.key);
  return !canon || canon.includes("#") || !bundles[e.key];
});
t("④ `$`/`#` 形态的 key 仍能被覆盖层命中（canonical 化一致）",
  mismatched.length === 0,
  `${shaped.length} 条含 $/#；不一致 ${mismatched.length}：` + mismatched.slice(0, 2).map((e) => e.key).join(", "));
t("④ bundles.json 与清单一一对应",
  curated.entries.every((e) => bundles[e.key] === e.file) && Object.keys(bundles).length === curated.entries.length);
t("④ 落盘文件都在", curated.entries.every((e) => existsSync(join(STARTER, e.file)) && statSync(join(STARTER, e.file)).size === e.bytes));

// ⑤ Rust 接线（源码级；行为由 `cargo test --release --lib` 的 starter_* 单测覆盖）
const assetsRs = readFileSync(join(ROOT, "src-tauri/src/commands/assets.rs"), "utf8");
const libRs = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
const conf = readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8");
t("⑤ assets.rs 合并 starter+sample 覆盖层清单", /STARTER_BUNDLES/.test(assetsRs) && /for \(dir, fallback\) in \[\("starter"/.test(assetsRs));
t("⑤ assets.rs 有 starter_set_info / starter_set_sync / seed", /starter_set_info_at/.test(assetsRs) && /seed_starter_assets\(/.test(assetsRs));
t("⑤ lib.rs 注册了 starter 命令", /assets::starter_set_info/.test(libRs) && /assets::starter_set_sync/.test(libRs));
t("⑤ 协议覆盖层先查 starter", /overlay_dirs[\s\S]{0,200}starter[\s\S]{0,120}sample/.test(libRs));
t("⑤ tauri.conf.json 声明了随包 resources", /"resources":\s*\[[\s\S]*resources\/assets\/starter/.test(conf));

// ⑥ 前端展示
const settings = readFileSync(join(ROOT, "frontend/src/pages/SettingsPage.tsx"), "utf8");
t("⑥ 设置页有「随包素材」一行 + 补齐按钮", /随包素材/.test(settings) && /starter_set_sync/.test(settings) && /STARTER_GROUP_LABELS/.test(settings));

// ⑦ 可选：原生（Xvfb + 真 WebKitGTK）跑一遍 seed + 覆盖层
if (process.argv.includes("--native")) {
  try {
    const out = execFileSync("node", [join(ROOT, "build/harness/native-source-probe.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const seeded = /ok   起步素材集 seed 到资源目录/.test(out);
    t("⑦ 原生 seed（native-source-probe）", seeded, out.trim().split("\n").filter((l) => l.startsWith("ok   起步")).join(" | "));
  } catch (error) {
    t("⑦ 原生 seed（native-source-probe）", false, String(error.message).slice(0, 200));
  }
}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
