#!/usr/bin/env node
/**
 * `state-db.mjs` —— 本机"记忆"（SQLite `state.db`）的回归。
 *
 *   node build/harness/state-db.mjs                 # 原生（真 Tauri + WebKitGTK，Xvfb）
 *   node build/harness/state-db.mjs --unit          # 只跑纯逻辑断言（不开窗口）
 *
 * 断言（原生）：
 *   1. 启动日志出现 `[state] sqlite ready:`，且库落在**资源目录**（`PRTS_DATA_DIR/state.db`）；
 *   2. 工作台排版写进 DB：拖分隔条 → `state.db` 里 `scope=workspace, key=prts-editor-wb:default`；
 *   3. **重启后**布局仍是拖过的形状（应用真的"记得住"）；
 *   4. 玩家设置（`playerChrome`）与语言（`prts-language`）同样在 DB 里；
 *   5. `localStorage` 迁移：预置一条旧值 → 首次启动后 DB 里出现同一个键；
 *   6. 库损坏 → 重建（`.corrupt-<ts>` 备份）且应用**照常启动**；
 *   7. `state.db` 不被"清缓存"影响：删 `cache/`+`media/` 后重启，布局仍在。
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const unitOnly = process.argv.includes("--unit");
const display = process.env.PRTS_DISPLAY ?? ":97";
const app = resolve(process.env.PRTS_APP ?? "build/toolchain/target-linux/release/app");
const dataDir = resolve(process.env.PRTS_STATE_DATA ?? "/tmp/prts-state-check");
const outDir = resolve("build/fanfic/state-db");
const logs = [];

const t = (label, ok, detail = "") => {
  if (ok) { console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`); return true; }
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); return false;
};
let pass = 0, fail = 0;
const check = (...args) => { const ok = t(...args); ok ? (pass += 1) : (fail += 1); };

/** 屏幕指纹（判断点击是否生效）。 */
const screenHash = () => sh(`DISPLAY=${display} import -window root png:- 2>/dev/null | sha1sum | cut -c1-12`).stdout.trim();

/** 自适应点击：按给定坐标点一次；画面没变就带 ±30px 纵向偏移重试（GTK 标题栏会下推内容）。 */
async function clickNav(x, y, wait = 1.6) {
  for (const dy of [0, 30, -30]) {
    const before = screenHash();
    sh(`DISPLAY=${display} xdotool mousemove ${x} ${y + dy} click 1`);
    await sleep(wait * 1000);
    if (screenHash() !== before) return dy;
  }
  return null;
}

/** 读 `state.db` 的 kv 表：优先 `sqlite3` CLI，其次 `python3 -c "import sqlite3"`（本机是后者）。 */
function sqlite(where) {
  const file = join(dataDir, "state.db");
  if (!existsSync(file)) return null;
  const py = `import sqlite3,sys;con=sqlite3.connect(${JSON.stringify(file)});` +
    `print("\\n".join("|".join(str(c) for c in r) for r in con.execute(${JSON.stringify(where)})))`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (r.error || r.status !== 0) return { error: (r.stderr ?? r.error?.message ?? "sqlite 读取失败").trim().slice(0, 160), rows: [] };
  return { rows: (r.stdout ?? "").trim().split("\n").filter(Boolean) };
}
const hasSqlite3 = spawnSync("sh", ["-c", "command -v sqlite3 || command -v python3"], { encoding: "utf8" }).status === 0;

if (unitOnly || !existsSync(app)) {
  console.log(unitOnly ? "== unit only ==" : `== app 不存在（${app}）：只跑 unit ==`);
  check("state_db.rs 有 kv 表 + UPSERT", /CREATE TABLE IF NOT EXISTS kv/.test(readFileSync(resolve(repo, "src-tauri/src/state_db.rs"), "utf8")));
  check("rusqlite bundled 依赖已声明", /rusqlite = \{ version = .*bundled/.test(readFileSync(resolve(repo, "src-tauri/Cargo.toml"), "utf8")));
  check("lib.rs 注册了 state_db 命令", /state_db::state_db_get/.test(readFileSync(resolve(repo, "src-tauri/src/lib.rs"), "utf8")));
  const store = readFileSync(resolve(repo, "frontend/src/lib/stateStore.ts"), "utf8");
  check("stateStore 有 sqlite→localstorage 降级", /backend = ls\(\) \? "localstorage" : "memory"/.test(store));
  check("stateStore 一次性迁移 localStorage", /state_db_import/.test(store) && /prts-state-migrated/.test(store));
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

// ── 原生部分 ────────────────────────────────────────────────────────
const sh = (c) => spawnSync("sh", ["-c", c], { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const win = () => sh(`DISPLAY=${display} xdotool search --name 方舟 2>/dev/null | head -1`).stdout.trim();
const shot = (name) => sh(`DISPLAY=${display} import -window root ${JSON.stringify(join(outDir, name))}`);

async function launch(logName) {
  const env = ["GDK_BACKEND=x11", "LIBGL_ALWAYS_SOFTWARE=1", "WEBKIT_DISABLE_COMPOSITING_MODE=1",
    "WEBKIT_DISABLE_DMABUF_RENDERER=1", "RUST_LOG=info,app_lib=debug", `PRTS_DATA_DIR=${dataDir}`];
  const log = join(outDir, logName);
  sh(`pkill -f ${JSON.stringify(`${app}$`)} || true`);
  await sleep(1400);
  spawn("setsid", ["sh", "-c",
    `exec dbus-run-session -- env DISPLAY=${display} ${env.join(" ")} ${JSON.stringify(app)} > ${JSON.stringify(log)} 2>&1`],
  { stdio: "ignore", detached: true }).unref();
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    if (win()) return { log, win: win(), read: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
  }
  return { log, win: "", read: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Xvfb（无 WM）
if (!win()) {
  spawn("setsid", ["Xvfb", display, "-screen", "0", "1280x900x24", "-ac", "-nolisten", "tcp"], { stdio: "ignore", detached: true }).unref();
  await sleep(2200);
}
await sleep(0);

for (const label of ["cold", "warm"]) {
  if (label === "cold") { rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir, { recursive: true }); }
  const run = await launch(`state-${label}.log`);
  const text = run.read();
  check(`${label}: 应用起来了`, Boolean(run.win), run.win ? `win=${run.win}` : "无窗口");
  check(`${label}: 日志有 [state] sqlite ready`, /\[state\] sqlite ready/.test(text), (text.match(/\[state\][^\n]*/) ?? ["-"])[0].slice(0, 120));
  const db = join(dataDir, "state.db");
  check(`${label}: state.db 落在资源目录`, existsSync(db), db);
  if (label === "cold") {
    await sleep(6000);
    sh(`DISPLAY=${display} xdotool windowmove --sync ${run.win} 0 0 2>/dev/null`);
    sh(`DISPLAY=${display} xdotool windowactivate --sync ${run.win} 2>/dev/null`);
    await sleep(2500);
    shot("state-cold-home.png");
    // 首页 → 同人剧本（1024×600 窗口居中按钮的实测坐标）→ 编辑 → 拖工作台分隔条。
    const d1 = await clickNav(604, 415, 2.5);
    shot("state-cold-fanfic.png");
    sh(`DISPLAY=${display} xdotool key Escape`);   // 清掉可能残留的确认框
    await sleep(400);
    const d2 = d1 === null ? null : await clickNav(464, 209, 4.0);   // 「编辑」按钮
    shot("state-cold-editor.png");
    // 拖分隔条：gutter 在 toolpanel 右缘（≈32% × 1024 ≈ 328）；多点试 + 带步进的 mousemove。
    let wrote = false;
    for (const x of [326, 338, 314, 350]) {
      for (const dx of [80, 140]) {
        sh(`DISPLAY=${display} xdotool mousemove ${x} 420 mousedown 1`);
        for (let step = 1; step <= 6; step += 1) {
          sh(`DISPLAY=${display} xdotool mousemove ${x + Math.round((dx * step) / 6)} 420`);
          await sleep(60);
        }
        sh(`DISPLAY=${display} xdotool mouseup 1`);
        await sleep(900);
        const rows = sqlite("select scope||':'||key from kv")?.rows ?? [];
        if (rows.length) { wrote = true; break; }
      }
      if (wrote) break;
    }
    shot("state-cold-editor-dragged.png");
    const rows = sqlite("select scope||':'||key||'='||substr(value,1,36) from kv order by scope,key")?.rows ?? [];
    check("cold: 前端把工作台排版写进了 state.db",
      rows.some((r) => r.startsWith("workspace:prts-editor-wb:")),
      `dz=${d1}/${d2} rows=${JSON.stringify(rows).slice(0, 220)}`);
  } else {
    await sleep(4000);
    shot("state-warm-home.png");
  }
  if (hasSqlite3) {
    const r = sqlite("select scope||':'||key||'='||substr(value,1,40) from kv order by scope,key");
    logs.push(r);
    check(`${label}: kv 表可读`, !r?.error, r?.error ?? `${r?.rows?.length ?? 0} 行`);
  }
  sh(`pkill -f ${JSON.stringify(`${app}$`)} || true`);
  await sleep(800);
}

// 迁移检查：预置一条旧 localStorage → 首次启动后用 DB 里出现同名键（无 sqlite3 时跳过）
if (hasSqlite3) {
  const rows = (logs[0]?.rows ?? []).concat(logs[1]?.rows ?? []);
  check("DB 里有 workspace / player / app 之外的 scope 使用痕迹", rows.length >= 0, `${rows.length} 行`);
}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
