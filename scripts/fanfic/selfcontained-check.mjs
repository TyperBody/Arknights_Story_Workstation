#!/usr/bin/env node
// 结束门禁：**自带素材在原生 WebView 上零网络可播**（task-12 的回归）。
//
//   node scripts/fanfic/selfcontained-check.mjs [--library src-tauri/resources/library]
//        [--app build/toolchain/target-linux/release/app] [--data /tmp/prts-selfcontained]
//        [--keep] [--out build/fanfic/selfcontained]
//
// 为什么不能只靠 `verify-pack.mjs`：那条是 headless Chromium，Pixi 的图片解码
// 走 Worker；WebKitGTK 的 Worker 取不到自定义 `asset://`（主线程可以），表现为
// `Loader.load ... TypeError: Load failed`。这里用**真的** Tauri + WebKitGTK
// （Xvfb）跑一遍，并断言：
//   1) 把 `<资源目录>/assets/library|sample` 与 `media/` 全删后首启，样例包仍出现；
//   2) 播放到 `[Character(char_130_doberm_ex)]`（杜宾）与分支合流（陈）；
//   3) `prts-cdn://` 覆盖层命中 8 个 canonical key（= 包自带的全部素材）；
//   4) 日志里 **0** 条 `加载失败`，且第二次（断网）跑同样成立；
//   5) 全程 `media/` 里没有一张图片（素材只可能来自包内）。
//
// 依赖：Xvfb / xdotool / ImageMagick 的 `import`（本仓库的原生测试一直这么跑）。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
/** `--flag value`：末尾的裸开关返回 fallback（见 verify-pack.mjs 的同名 helper）。 */
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const libraryDir = resolve(arg("--library", "src-tauri/resources/library"));
const app = resolve(arg("--app", "build/toolchain/target-linux/release/app"));
const dataDir = resolve(arg("--data", "/tmp/prts-selfcontained-check"));
const outDir = resolve(arg("--out", "build/fanfic/selfcontained"));
const display = arg("--display", ":98");
const timeoutMs = Number(arg("--timeout", "60000"));
/** `app_lib` 单独开 debug：依赖（scraper/html5ever）的 DEBUG 会淹掉日志。 */
const logEnv = arg("--rust-log", "info,app_lib=debug");
const keep = argv.includes("--keep");
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).join("\n"));
  process.exit(0);
}

const failures = [];
const notes = [];
const fail = (message) => { failures.push(message); console.error(`FAIL  ${message}`); };
const note = (message) => { notes.push(message); console.log(`ok    ${message}`); };

for (const tool of ["Xvfb", "xdotool", "import"]) {
  const probe = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.error(`missing required tool: ${tool}`);
    process.exit(2);
  }
}
if (!existsSync(app)) {
  console.error(`app binary not found: ${app}`);
  process.exit(2);
}

const sh = (command) => spawnSync("sh", ["-c", command], { encoding: "utf8", env: process.env });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const shot = (path) => sh(`DISPLAY=${display} import -window root ${JSON.stringify(path)}`);
const click = async (x, y, wait = 1.6) => {
  sh(`DISPLAY=${display} xdotool mousemove ${x} ${y} click 1`);
  await sleep(wait * 1000);
};

/** 屏幕指纹：两次截图内容是否不同（`import` → `sha1sum`）。 */
const screenHash = () =>
  spawnSync("sh", ["-c", `DISPLAY=${display} import -window root png:- 2>/dev/null | sha1sum | cut -c1-12`], { encoding: "utf8" }).stdout.trim();

/**
 * **导航点击**：先按标定坐标点一次；若画面没变（说明落空——例如 GTK 客户端标题栏
 * 把内容整体下移了 ~30px），就带 ±30px 的纵向偏移各重试一次。
 * 返回实际生效的偏移量（0 / 30 / -30），`null` = 三次都没变。
 */
const clickNav = async (x, y, wait = 1.6) => {
  for (const dy of [0, 30, -30]) {
    const before = screenHash();
    sh(`DISPLAY=${display} xdotool mousemove ${x} ${y + dy} click 1`);
    await sleep(wait * 1000);
    if (screenHash() !== before) return dy;
  }
  return null;
};
const findWindow = () => sh(`DISPLAY=${display} xdotool search --name 方舟 2>/dev/null | head -1`).stdout.trim();

/** 起一次应用；`deadNet` 时把 HTTP(S)_PROXY 指向死端口（离线）。 */
async function launch(logName, deadNet) {
  const env = [
    "GDK_BACKEND=x11", "LIBGL_ALWAYS_SOFTWARE=1", "WEBKIT_DISABLE_COMPOSITING_MODE=1",
    "WEBKIT_DISABLE_DMABUF_RENDERER=1", `RUST_LOG=${logEnv}`, `PRTS_DATA_DIR=${dataDir}`,
  ];
  if (deadNet) env.push("HTTP_PROXY=http://127.0.0.1:1", "HTTPS_PROXY=http://127.0.0.1:1", "http_proxy=http://127.0.0.1:1", "https_proxy=http://127.0.0.1:1");
  const log = join(outDir, logName);
  sh(`pkill -f ${JSON.stringify(`${app}$`)} || true`);
  await sleep(1500);
  spawn("setsid", ["sh", "-c",
    `exec dbus-run-session -- env DISPLAY=${display} ${env.join(" ")} ${JSON.stringify(app)} > ${JSON.stringify(log)} 2>&1`],
  { stdio: "ignore", detached: true }).unref();
  for (let i = 0; i < Math.ceil(timeoutMs / 1000); i += 1) {
    await sleep(1000);
    if (findWindow()) return { log, window: findWindow(), text: () => readFileSync(log, "utf8") };
  }
  return { log, window: "", text: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

/** 日志只保留 app_lib 与关键行（去依赖噪声）。 */
const trimLog = (text) => text.split("\n").filter((line) => /app_lib|overlay|加载失败/.test(line)).join("\n");
const installedAssets = () => {
  const root = join(dataDir, "assets");
  if (!existsSync(root)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".webp")) count += 1;
    }
  };
  walk(root);
  return count;
};
const mediaImages = () => {
  const root = join(dataDir, "media");
  if (!existsSync(root)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(png|jpe?g|webp)$/i.test(entry)) count += 1;
    }
  };
  walk(root);
  return count;
};

// 5174 上有 dev server 时，**开发版** app 会连它 → 测的就不是「自带素材 + 内嵌前端」
// 那条链路了。这里直接要求端口空着（也顺带防止误用 dev 二进制而误判通过）。
const port5174 = spawnSync("sh", ["-c", "ss -ltn 2>/dev/null | grep -c ':5174 '"], { encoding: "utf8" }).stdout.trim();
if (port5174 !== "0" && port5174 !== "") {
  fail("port 5174 has a dev server — stop it (or use the production binary) so the check exercises the bundled frontend");
}

console.log(`== self-contained check ==`);
console.log(`   app     ${app}`);
console.log(`   library ${libraryDir}`);
console.log(`   data    ${dataDir}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "shots"), { recursive: true });
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

// 期望的覆盖层名单：`bundles.json`（seed 会写到 `<资源目录>/assets/sample/`）。
const bundles = JSON.parse(readFileSync(join(repo, "src-tauri/resources/assets/sample/bundles.json"), "utf8"));
const expectedKeys = Object.keys(bundles);
note(`bundles.json: ${expectedKeys.length} keys`);

if (!findWindow()) {
  spawn("setsid", ["Xvfb", display, "-screen", "0", "1280x900x24", "-ac", "-nolisten", "tcp"], { stdio: "ignore", detached: true }).unref();
  await sleep(2500);
}

/** 播放样例：首页 → 同人剧本 → ▶ → 推进到杜宾 / 选项 / 分支 / 合流。 */
async function playThrough(tag) {
  // 前两步是**导航**（必须落到按钮上）→ 用自适应点击并记下生效偏移；
  // 后面都是"点画面推进对话"，偏移沿用同一个即可。
  const dy = (await clickNav(599, 415, 3)) ?? 0;   // 首页 → 同人剧本
  note(`${tag}: 点击偏移 dz=${dy}`);
  await clickNav(461, 168 + dy, 12);               // ▶ 播放
  shot(join(outDir, "shots", `${tag}-1-first.png`));
  await sleep(5000);
  await click(512, 430 + dy, 3.5);
  shot(join(outDir, "shots", `${tag}-2-doberm.png`));   // [Character(char_130_doberm_ex)] 立绘
  for (let i = 0; i < 4; i += 1) await click(512, 430 + dy, 3);
  shot(join(outDir, "shots", `${tag}-3-decision.png`));
  await click(512, 249 + dy, 4);   // 选「跟着她走」
  shot(join(outDir, "shots", `${tag}-4-branch.png`));   // 阿米娅 + bg_forest
  for (let i = 0; i < 2; i += 1) await click(512, 430 + dy, 3);
  shot(join(outDir, "shots", `${tag}-5-merge.png`));    // 合流：陈 + bg_forest
}

for (const pass of [{ name: "online", deadNet: false }, { name: "offline", deadNet: true }]) {
  console.log(`\n== pass ${pass.name} (${pass.deadNet ? "network dead" : "network ok"}) ==`);
  const run = await launch(`pass-${pass.name}.log`, pass.deadNet);
  if (!run.window) { fail(`${pass.name}: no app window`); continue; }
  // 无 WM 时 GTK 可能把窗口摆在屏幕中央（曾是 (128,150)），下面的像素点击是按
  // **默认窗口尺寸 1024×600 贴左上角**标定的 → 这里只把窗口**挪到 (0,0)**，
  // 千万**别改尺寸**（一改版面就变，点击坐标全废）。
  sh(`DISPLAY=${display} xdotool windowmove --sync ${run.window} 0 0 2>/dev/null`);
  sh(`DISPLAY=${display} xdotool windowactivate --sync ${run.window} 2>/dev/null`);
  await sleep(7000);
  // 引擎横幅（`[data-asset-banner]`，P6 的静默降级提示）会占据顶部 ~35px 并把整页内容
  // 下推 → 下面按默认版面标定的像素点击会整体落空。先点它的 ✕ 关掉（1024×600 时约 (994,54)）。
  await clickNav(994, 24, 1.0);
  await clickNav(994, 24, 1.0);
  note(`${pass.name}: seeded ${installedAssets()} bundled .webp (library + sample)`);
  if (installedAssets() < expectedKeys.length * 2) fail(`${pass.name}: seed wrote only ${installedAssets()} files`);
  await playThrough(pass.name);
  const text = run.text();
  writeFileSync(join(outDir, `pass-${pass.name}.log`), trimLog(text));
  const overlayHits = [...text.matchAll(/overlay hit key=(\S+)/g)].map((match) => match[1]);
  const served = new Set(overlayHits);
  const loadFailures = (text.match(/加载失败/g) ?? []).length;
  const images = mediaImages();
  note(`${pass.name}: overlay served ${served.size}/${expectedKeys.length} keys`);
  if (served.size !== expectedKeys.length) {
    fail(`${pass.name}: overlay served ${served.size} of ${expectedKeys.length} keys (${[...expectedKeys].filter((k) => !served.has(k)).join(", ")})`);
  }
  note(`${pass.name}: 加载失败=${loadFailures}, media images=${images}`);
  if (loadFailures) fail(`${pass.name}: ${loadFailures} 条 '加载失败'`);
  if (images) fail(`${pass.name}: media/ contains ${images} image(s) — art did not come from the pack`);
  writeFileSync(join(outDir, `pass-${pass.name}.keys.txt`), `${[...served].sort().join("\n")}\n`);
  sh(`pkill -f ${JSON.stringify(`${app}$`)} || true`);
  await sleep(3500);
  // 第二趟必须沿用第一趟的 media（只有引擎 widget/字体），才叫「素材自带」。
  if (!pass.deadNet) note(`pass online: media kept for the offline pass (${mediaImages()} images)`);
}

writeFileSync(join(outDir, "summary.json"), JSON.stringify({ app, libraryDir, dataDir, expectedKeys, failures, notes }, null, 1));
if (!keep) sh(`pkill -f ${JSON.stringify(`${app}$`)} || true`);
console.log(`\n== ${failures.length ? `FAILED (${failures.length})` : "PASSED"} == ${outDir}`);
process.exit(failures.length ? 1 : 0);
