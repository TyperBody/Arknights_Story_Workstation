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

// ② 预算与三类覆盖
const budget = curated.budgetBytes ?? 25 * 1024 * 1024;
t("② 体积 ≤ 预算", curated.bytes <= budget, `${(curated.bytes / 1048576).toFixed(2)} MB ≤ ${(budget / 1048576).toFixed(0)} MB`);
const byGroup = curated.entries.reduce((acc, e) => { acc[e.group] = (acc[e.group] ?? 0) + 1; return acc; }, {});
t("② core ≥ 6", (byGroup.core ?? 0) >= 6, `core=${byGroup.core ?? 0}`);
t("② background 60…120", (byGroup.background ?? 0) >= 60 && (byGroup.background ?? 0) <= 120, `background=${byGroup.background ?? 0}`);
t("② portrait 80…160", (byGroup.portrait ?? 0) >= 80 && (byGroup.portrait ?? 0) <= 160, `portrait=${byGroup.portrait ?? 0}`);
t("② 每张都有 sha256 / bytes", curated.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256 ?? "") && e.bytes > 0));

// ③ key 与目录交集
const catalog = JSON.parse(readFileSync(join(ROOT, "src/akstage/catalog-data.json"), "utf8"));
const known = new Set([
  ...catalog.backgroundPaths,
  ...catalog.characterPaths,
  ...(catalog.external ?? []).map((e) => e.url.replace(/^https?:\/\//, "")),
]);
const unknown = curated.entries.filter((e) => !known.has(e.key)).map((e) => e.key);
t("③ 全部 key 命中 catalog-data.json", unknown.length === 0, unknown.slice(0, 3).join(", ") || `${curated.entries.length} 条`);
const inCorpusTop = curated.entries.filter((e) => e.group === "background").slice(0, 5).map((e) => e.key.split("/").pop());
t("③ 背景按语料频次（bg_black 应排第一）", inCorpusTop[0]?.startsWith("bg_black"), inCorpusTop.join(", "));

// ④ canonical 化不会截断（`#`/`$` 形态两端都会切掉 → 覆盖层永远命中不了）
t("④ 无 `#`/`$` 形态的 key", curated.entries.every((e) => !/[#$]/.test(e.key)),
  curated.entries.filter((e) => /[#$]/.test(e.key)).slice(0, 3).map((e) => e.key).join(", ") || "ok");
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
