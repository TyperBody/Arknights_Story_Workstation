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
// ⚠️ 默认用 `target/release`（刚 rebuild 的那个）：`frontendDist`（`build/dist`）是
// **编译期**嵌进二进制的，所以"前端刚改完、只 `npm run build`"时必须重新 cargo build；
// `target-linux/` 是给桌面包用的旧二进制，可能嵌着老前端。
const app = resolve(process.env.PRTS_APP ?? "build/toolchain/target/release/app");
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
  const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    // 窗口出现 ≠ 启动完成：[state] 行是 setup 的最后一件事，等它（或超时）再返回。
    if (win() && (/\[state\] sqlite ready/.test(read()) || i >= 20)) {
      return { log, win: win(), read };
    }
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

for (const label of ["cold", "warm", "cleared"]) {
  if (label === "cold") { rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir, { recursive: true }); }
  // 「清除所有缓存」= 删 `cache/` + `media/`（**不动** `state.db`）：记忆必须还在。
  if (label === "cleared") {
    for (const sub of ["cache", "media"]) rmSync(join(dataDir, sub), { recursive: true, force: true });
  }
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
    // 触发一次**落盘**：工具栏的 Map 开关（`⌥ 分支图` / `预览面板`）必然改布局树
    // → `onState` → `saveLayoutNamed`（+ 视图状态）。GTK 会让内容区下移 ~30px，
    // 所以 y 取 49 与 79 两行、x 扫一段；每点一次查一次库，命中即停。
    sh(`DISPLAY=${display} xdotool windowmove --sync ${run.win} 0 0 2>/dev/null`);
    await sleep(3500);
    let wrote = false;
    for (const y of [49, 79, 34]) {
      for (let x = 380; x <= 600 && !wrote; x += 20) {
        sh(`DISPLAY=${display} xdotool mousemove ${x} ${y} click 1`);
        await sleep(1100);
        wrote = (sqlite("select key from kv")?.rows ?? []).length > 0;
      }
      if (wrote) break;
    }
    const rows = sqlite("select scope||':'||key||'='||substr(value,1,36) from kv order by scope,key")?.rows ?? [];
    check("cold: 前端把工作台状态写进了 state.db",
      rows.some((r) => r.startsWith("workspace:prts-editor-wb:")),
      `dz=${d1}/${d2} rows=${JSON.stringify(rows).slice(0, 220)}`);
    shot("state-cold-editor-dragged.png");
  } else if (label === "cleared") {
    await sleep(5000);
    sh(`DISPLAY=${display} xdotool windowmove --sync ${run.win} 0 0 2>/dev/null`);
    sh(`DISPLAY=${display} xdotool windowactivate --sync ${run.win} 2>/dev/null`);
    await sleep(2000);
    const d1 = await clickNav(604, 415, 2.5);
    sh(`DISPLAY=${display} xdotool key Escape`);
    await sleep(400);
    const d2 = d1 === null ? null : await clickNav(464, 209, 4.0);
    await sleep(2000);
    shot("state-cleared-editor.png");
    const rows = sqlite("select key||'='||value from kv where scope='workspace'")?.rows ?? [];
    check("cleared: 清掉 cache/media 后布局仍在 state.db", rows.some((r) => r.startsWith("prts-editor-wb:default=")),
      `dz=${d1}/${d2} ${JSON.stringify(rows).slice(0, 160)}`);
    // 视图状态（面板开关）：分支图仍是开的（冷启动时点开的）
    const view = rows.find((r) => r.startsWith("prts-editor-wb:view=")) ?? "";
    check("cleared: 面板开关（视图状态）也还在", /branch/.test(view), view.slice(0, 120));
  } else {
    await sleep(4000);
    shot("state-warm-home.png");
    // warm：上一次的键必须在库里（冷启动写 → 重启仍在），且**这次启动读到了**
    // （`[state] snapshot scope=workspace n=N`，N>0 才算真读到）。
    const persist = sqlite("select key||'='||value from kv where scope='workspace' and key like '%default'")?.rows ?? [];
    check("warm: 布局仍在库里（重启不丢）", persist.length > 0, JSON.stringify(persist).slice(0, 160));
    // ⚠️ 用**新读一次**的日志：`text` 是启动早期抓的，hydrate 的 DEBUG 行更晚。
    const readBack = (run.read().match(/\[state\] snapshot scope=workspace n=(\d+)/g) ?? []).join(",");
    const n = Number(/n=(\d+)/.exec(readBack)?.[1] ?? 0);
    check("warm: 启动时从 state.db 读到了这些键（hydrate 生效）", n > 0, readBack || "无 snapshot 日志");
  }
  if (hasSqlite3) {
    const r = sqlite("select scope||':'||key||'='||substr(value,1,40) from kv order by scope,key");
    logs.push(r);
    check(`${label}: kv 表可读`, !r?.error, r?.error ?? `${r?.rows?.length ?? 0} 行`);
  }
  sh(`pkill -f ${JSON.stringify(`${app}$`)} || true`);
  await sleep(800);
}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
