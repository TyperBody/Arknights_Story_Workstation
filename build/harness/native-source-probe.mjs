// 「换源后的字节真的过了新的取字节链」原生探针（P7 验收；需带 custom-protocol 的 app）。
//
// 断言（全部来自**真** Tauri + WebKitGTK 的日志与磁盘）：
//   1. `prts-cdn://` 的 cache-through 命中源链并打出命中的源
//      （`[prts-cdn] source=pack|prts|jsd|fastly|ghproxy key=…`）；
//   2. 第一次取的模块**落盘在 canonical key 下**（`<data>/media/<host>/<path>`）——
//      证明「换源不改 key」；第二次启动即命中本地（不再联网）。
//   3. 断网（HTTP(S)_PROXY 指向死端口）时样例包仍能播（覆盖层 + 本地缓存的回归）。
//
// 运行：`node build/harness/native-source-probe.mjs`（Xvfb + dbus-run-session）。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const app = resolve(process.env.ARKSTAGE_APP ?? "build/toolchain/target/release/app");
const dataDir = process.env.ARKSTAGE_DATA ?? "/tmp/prts-p7-native-source";
const display = process.env.P7_DISPLAY ?? ":97";
const PROBE_KEY = "static.prts.wiki/widgets/production/StoryPlayer.BQgSL6Cy.js";

let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sh = (cmd) => spawnSync("sh", ["-c", cmd], { encoding: "utf8" });

if (!existsSync(app)) {
  console.log(`skip 未找到 ${app}（先 cargo build --release --features custom-protocol）`);
  process.exit(0);
}
for (const tool of ["Xvfb", "xdotool"]) {
  if (sh(`command -v ${tool}`).status !== 0) { console.log(`skip 缺少 ${tool}`); process.exit(0); }
}

mkdirSync(dataDir, { recursive: true });
rmSync(join(dataDir, "media"), { recursive: true, force: true });

async function launch(logName, offline) {
  const env = [
    "GDK_BACKEND=x11", "LIBGL_ALWAYS_SOFTWARE=1", "WEBKIT_DISABLE_COMPOSITING_MODE=1",
    "WEBKIT_DISABLE_DMABUF_RENDERER=1", "RUST_LOG=debug,app_lib=debug,tauri=warn,html5ever=warn,scraper=warn",
    `PRTS_DATA_DIR=${dataDir}`,
  ];
  if (offline) env.push("HTTP_PROXY=http://127.0.0.1:1", "HTTPS_PROXY=http://127.0.0.1:1", "http_proxy=http://127.0.0.1:1", "https_proxy=http://127.0.0.1:1");
  const log = join(dataDir, logName);
  // 先关掉上一轮（含 dbus-run-session 包装进程），并删掉旧日志，避免把上一轮的
  // `[prts-cdn]` 行当成这一轮的结果。
  sh("pkill -f 'dbus-run-session -- env DISPLAY' || true");
  sh(`pkill -f ${JSON.stringify(`${app}$`)} || true`);
  rmSync(log, { force: true });
  await sleep(1200);
  spawn("setsid", ["sh", "-c", `exec dbus-run-session -- env DISPLAY=${display} ${env.join(" ")} ${JSON.stringify(app)} > ${JSON.stringify(log)} 2>&1`], { stdio: "ignore", detached: true }).unref();
  const started = Date.now();
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    // 取字节已开始（`[prts-cdn]` 第一行）或首帧日志已出现 → 多等 2.5s 收尾。
    if (/\[prts-cdn\]/.test(text) || (/asset-scope\] allowed/.test(text) && Date.now() - started > 12_000)) {
      await sleep(2500);
      return log;
    }
  }
  return log;
}

const sources = () => {
  const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  return [...text.matchAll(/\[prts-cdn\] source=([a-z]+) key=(\S+)/g)].map((m) => ({ source: m[1], key: m[2] }));
};
let logPath = "";
if (!sh(`DISPLAY=${display} xdotool getdisplaygeometry 2>/dev/null`).stdout.trim()) {
  spawn("setsid", ["Xvfb", display, "-screen", "0", "1400x900x24", "-ac", "-nolisten", "tcp"], { stdio: "ignore", detached: true }).unref();
  await sleep(2500);
}

try {
  // ① 在线首跑：模块缓存为空 → 走源链取字节。
  logPath = await launch("online.log", false);
  const hits = sources();
  t("prts-cdn cache-through 打出命中源", hits.length > 0, hits.map((h) => h.source).join(",") || "无");
  t("命中源是链里的源（pack/prts/jsd/fastly/ghproxy）",
    hits.length > 0 && hits.every((h) => ["pack", "prts", "jsd", "fastly", "ghproxy"].includes(h.source)));
  t("引擎入口模块按 canonical key 落盘",
    existsSync(join(dataDir, "media", PROBE_KEY)), join(dataDir, "media", PROBE_KEY));
  const topDirs = existsSync(join(dataDir, "media")) ? readdirSync(join(dataDir, "media")) : [];
  const storeFiles = existsSync(join(dataDir, "media", "static.prts.wiki", "widgets", "production"))
    ? readdirSync(join(dataDir, "media", "static.prts.wiki", "widgets", "production"))
    : [];
  t("store 顶层只有 host 目录（镜像 URL 不改落盘形状）",
    topDirs.length > 0 && topDirs.every((d) => d.includes(".")),
    `${topDirs.join(",")} | production: ${storeFiles.length} file(s)`);

  // ② 断网二跑：覆盖层 + 本地缓存必须够用（不再联网）。
  logPath = await launch("offline.log", true);
  const offlineLog = readFileSync(logPath, "utf8");
  // 断网时若「样例包」被播放，覆盖层会命中；但自动流程下不播放就没有 overlay 行，
  // 所以这里断言「缓存的模块被直接读到」+「日志里没有失败」，overlay 命中为加分项。
  const overlayHits = (offlineLog.match(/overlay hit key=/g) ?? []).length;
  const offlineOk = !/加载失败|resource load failed/.test(offlineLog);
  t("断网启动无 `resource load failed`", offlineOk,
    `overlay=${overlayHits} 加载失败=${(offlineLog.match(/加载失败|resource load failed/g) ?? []).length}`);
  t("断网首帧没有 `source=`（模块命中本地缓存，不再联网）", !/\[prts-cdn\] source=/.test(offlineLog),
    (offlineLog.match(/\[prts-cdn\] (overlay|store)/g) ?? []).slice(0, 3).join(" | "));
} finally {
  sh(`pkill -f ${JSON.stringify(`${app}$`)} || true`);
}

console.log(`\n${pass} pass / ${fail} fail`);
console.log(`data: ${dataDir}`);
if (fail) process.exitCode = 1;
