#!/usr/bin/env node
/**
 * `scripts/harness/run.mjs` —— 一条命令跑完整套**无头验收**（工作台 / 引擎 / 素材）。
 *
 *   node scripts/harness/run.mjs                 # 全部（需要 dev server:5174 的会自己提示）
 *   node scripts/harness/run.mjs workbench       # 只跑工作台组
 *   node scripts/harness/run.mjs stage branch    # 只跑指定几项
 *   node scripts/harness/run.mjs --list
 *
 * 设计：每个 harness 都是**独立可跑**的 `node build/harness/*.mjs`（自带断言、自带退出码）；
 * 这里只做「按组串起来 + 汇总」，不隐藏失败（任一项 fail → 整体 exit 1）。
 * 真实实现留在 `build/harness/`（`build/` 是本仓库的中间产物目录，harness 已 `git add -f`）。
 *
 * 组与需求映射见 `docs/dev/harness.md`。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const H = (name) => resolve(ROOT, "build/harness", name);

/** 组 → 用例（顺序即执行顺序；`nodeNeed` 只是文档提示）。 */
const GROUPS = {
  workbench: [
    ["demo-check.mjs", "8 条需求合流：编辑页/舞台/工作台/分支图/横幅/快照/设置"],
    ["persist-check.mjs", "布局持久化（拖分隔条 → 刷新仍在）"],
    ["stage-zoom.mjs", "① 舞台连续缩放（纯函数 + 浏览器）"],
    ["window-chrome.mjs", "② toolpanel/stage 无 ⧉✕；preview/branch = Map"],
    ["workbench-drag.mjs", "③ 拼接/换位/调尺寸 + 落盘"],
    ["wb-selftest.mjs", "③ 布局模型纯函数（62 断言 + fuzz）"],
    ["layout-named.mjs", "③ 布局自动记忆：拖→落库→刷新复用 + 只剩「重置」"],
    ["state-db-frontend.mjs", "③ 排版/开关落 **SQLite**（hydrate→首帧→拖→刷新仍在）"],
    ["inspector-resize.mjs", "③ 检视器高度可拖 + 落库（旧的写死 190 → 默认 240）"],
  ],
  branch: [
    ["branch-shot.mjs", "④ dify 风 DAG（零重叠 + 分层 + 截图）"],
  ],
  engine: [
    ["engine-failure.mjs", "⑤ 模块失败 → 单条横幅（含 HTTP 状态）+ 不白屏"],
    ["engine-failure-min.mjs", "⑤ 坏快照 → 换 pack → 内置快照"],
  ],
  assets: [
    ["starter-assets.mjs", "⑥ 随包起步素材集（287 张/14.6 MB，覆盖层优先）"],
    ["rust-mirror-live.mjs", "⑦ Rust 源链接线 + 镜像 URL 形状"],
    ["live-download.mjs", "⑦ 设置页换源 → 落盘 + 预览 URL"],
  ],
  shell: [
    ["float-window.mjs", "⓪ 划区/浮动窗 7 契约（分隔条命中区/分离/浮动层+占位/不被裁剪/双击回树/刷新记忆）"],
    ["p4-shell-unit.mjs", "窗口壳纯逻辑（兜底表/注册表/resolveChrome）"],
    ["p4-shell-probe.mjs", "窗口壳交互（折叠/⧉/拖动/缩放/✕）"],
    ["preview-bar-oneline.mjs", "② 预览条恒单行（拖窄 + 多行报错都不撑高）"],
    ["preview-fill-probe.mjs", "② 预览填满壳；放大=整页覆盖层，还原可退"],
    ["stage-aspect.mjs", "⑨ 舞台比例：cover 注入 + 悬停开关（纯静态）"],
    ["stage-fit.mjs", "⑨ 舞台比例：任意容器仍是 16:9 且覆盖（真 chromium）"],
    ["stage-cover-live.mjs", "⑨ 舞台比例：**引擎真实 DOM 层级**下仍 cover（防「>section>canvas」回归）"],
  ],
  player: [
    ["player-chrome.mjs", "播放器底栏三档（auto=默认纯隐藏/指针几何命中/hide）"],
    ["_playersettings-check.mjs", "底栏默认 auto + 去掉 3 秒定时器（源码/CSS/运行时三查）"],
  ],
  editor: [
    ["_stage-clip-check.mjs", "⑧ 舞台裁剪恒 16:9（50~170%）+ 舞台可调大小"],
    ["_indent-ui-check.mjs", "⑧ 区域缩进 UI（按钮/快捷键/Tab/撤销/提示）"],
    ["_editor-tab-hl-check.mjs", "⑧ Tab/Enter/Backspace 的 VSCode 语义 + 语法着色逐像素对齐"],
    ["_stage-visual-check.mjs", "⑧ 编辑器舞台 100%/150% 的 16:9 观感（截图 + clip 对齐）"],
    ["_i18n-check.mjs", "⑧ i18n 运行时（zh-Hans/en-US 查找与语言持久化）"],
    ["_i18n-ui-check.mjs", "⑧ 语言切换后编辑器页文案变英文"],
  ],
};

const argv = process.argv.slice(2);
if (argv.includes("--list")) {
  for (const [group, cases] of Object.entries(GROUPS)) {
    console.log(`\n${group}`);
    for (const [file, what] of cases) console.log(`  ${file.padEnd(26)} ${what}`);
  }
  process.exit(0);
}

/** 选择要跑的组：无参数 = 全部；有参数 = 组名或 harness 名。 */
const wanted = argv.filter((a) => !a.startsWith("-"));
const selected = [];
for (const [group, cases] of Object.entries(GROUPS)) {
  for (const [file, what] of cases) {
    const id = file.replace(/\.mjs$/, "");
    if (!wanted.length || wanted.includes(group) || wanted.includes(id)) selected.push([group, file, what]);
  }
}
if (!selected.length) {
  console.error(`没有匹配的 harness：${wanted.join(", ")}（用 --list 看清单）`);
  process.exit(2);
}

const dev = await fetch("http://localhost:5174/", { method: "HEAD" }).then((r) => r.ok).catch(() => false);
if (!dev) console.log("提示：dev server 不在 5174；浏览器段会自动跳过（纯函数段仍会跑）。\n");

const results = [];
for (const [group, file, what] of selected) {
  const path = H(file);
  if (!existsSync(path)) { results.push({ group, file, ok: false, detail: "missing" }); console.log(`MISS ${file} — 文件不存在`); continue; }
  // 浏览器 harness 之间给 chromium 一点释放时间（同机连跑时偶发 GPU/zygote 竞争）。
  await new Promise((done) => setTimeout(done, 400));
  let run = spawnSync(process.execPath, [path], { cwd: ROOT, encoding: "utf8" });
  let attempts = 1;
  // 失败**重试一次**：浏览器 harness 在同机连跑时会偶发抖动（GPU stall / zygote 通信）；
  // 真失败两次仍失败 → 才算失败（`attempts` 会打出来，别把抖动当绿灯）。
  if (run.status !== 0) {
    attempts = 2;
    await new Promise((done) => setTimeout(done, 1200));
    run = spawnSync(process.execPath, [path], { cwd: ROOT, encoding: "utf8" });
  }
  const ok = run.status === 0;
  const tail = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
    .split("\n").filter((l) => /pass \/|ok \/|PASS|结果：|=== /.test(l)).slice(-1)[0] ?? "";
  results.push({ group, file, ok, attempts, detail: tail.trim() });
  console.log(`${ok ? "ok  " : "FAIL"} ${file.padEnd(26)} ${what}${attempts > 1 ? "  (retry×1)" : ""}`);
  if (!ok) console.log(`${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").slice(-14).join("\n"));
}

const byGroup = new Map();
for (const r of results) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
console.log("\n── 汇总 ──");
for (const [group, rows] of byGroup) {
  const bad = rows.filter((r) => !r.ok);
  console.log(`${bad.length ? "FAIL" : "ok  "} ${group.padEnd(10)} ${rows.length - bad.length}/${rows.length}`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length) { console.log(`\n失败：${failed.map((r) => r.file).join(", ")}`); process.exit(1); }
console.log(`\n全部通过（${results.length} 个 harness）。`);
