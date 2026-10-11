// 验收：P4 窗口壳的**纯逻辑**（`frontend/src/components/editor/inspectorWindow.ts`）——
//   node build/harness/p4-shell-unit.mjs
// Node 22 直接 import `.ts`（类型剥离，跑的就是组件 import 的同一份实现）；零浏览器零依赖。
import assert from "node:assert/strict";
import { resolve } from "node:path";

let pass = 0, fail = 0;
const failures = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; console.log(`ok   ${label}`); }
  catch (error) { fail += 1; failures.push(label); console.log(`FAIL ${label} — ${error?.message ?? error}`); }
};

const MOD = resolve("frontend/src/components/editor/inspectorWindow.ts");
let M;
try { M = await import(`file://${MOD}`); }
catch (error) { console.log(`FAIL inspectorWindow.ts 可 import — ${error?.message ?? error}`); process.exitCode = 1; }

if (M) {
  const { FALLBACK_TITLES, FALLBACK_KINDS, panelKind, panelSpec, panelTitle, registerWindowSpecs, resolveChrome, shellKindLabel } = M;

  ok("兜底标题（toolpanel/stage/preview/branch）", () => {
    assert.equal(FALLBACK_TITLES.toolpanel, "工具面板");
    assert.equal(FALLBACK_TITLES.stage, "舞台");
    assert.equal(FALLBACK_TITLES.preview, "预览");
    assert.equal(FALLBACK_TITLES.branch, "分支图");
  });
  ok("兜底语义：toolpanel/stage = dock；preview/branch = map", () => {
    assert.deepEqual(
      ["toolpanel", "stage", "preview", "branch"].map((id) => FALLBACK_KINDS[id]),
      ["dock", "dock", "map", "map"]
    );
  });
  ok("未注册时 panelTitle / panelKind 走兜底", () => {
    assert.equal(panelTitle("stage"), "舞台");
    assert.equal(panelKind("branch"), "map");
    assert.equal(panelTitle("nope"), "nope");
  });
  ok("显式 specs（P3 WINDOW_SPECS）优先", () => {
    const specs = { branch: { title: "分支图X", kind: "dock" } };
    assert.equal(panelTitle("branch", specs), "分支图X");
    assert.equal(panelKind("branch", specs), "dock");
    assert.equal(panelKind("preview", specs), "map"); // 表里没有 → 兜底
  });
  ok("registerWindowSpecs 注入 → resolveChrome 用真表；复位后回落", () => {
    registerWindowSpecs({ preview: { title: "预览X", map: true } });
    assert.equal(resolveChrome("preview").title, "预览X");
    assert.equal(resolveChrome("preview").ariaLabel, "预览X面板");
    registerWindowSpecs(null);
    assert.equal(resolveChrome("preview").title, "预览");
  });
  ok("resolveChrome 支持“单个 spec”形状", () => {
    assert.deepEqual(resolveChrome("toolpanel", { title: "工具面板", kind: "dock" }), {
      title: "工具面板", ariaLabel: "工具面板面板", visible: true, active: false,
    });
  });
  ok("spec.kind 优先于 spec.map（dock 不会被 map 顶掉）", () => {
    assert.equal(panelKind("x", { x: { kind: "dock", map: true } }), "dock");
    assert.equal(panelKind("x", { x: { map: true } }), "map");
    assert.equal(panelTitle("y", { y: { title: "Y" } }), "Y");
  });
  ok("shellKindLabel 三形态", () => {
    assert.equal(shellKindLabel("dock"), "常驻面板");
    assert.equal(shellKindLabel("map"), "地图面板");
    assert.equal(shellKindLabel("float"), "浮动窗口");
  });
  ok("resolveChrome 永远返回 4 个字段的可用对象", () => {
    const chrome = resolveChrome("stage");
    assert.deepEqual(Object.keys(chrome).sort(), ["active", "ariaLabel", "title", "visible"]);
    assert.equal(chrome.visible, true);
    assert.equal(chrome.active, false);
  });
  ok("未知 id 默认 map（保留 ⧉ 的安全侧）+ panelSpec 有 title/kind", () => {
    assert.equal(panelKind("who"), "map");
    assert.equal(panelSpec("who").kind, "map");
    assert.equal(panelSpec("stage").title, "舞台");
  });
}

console.log(`\np4-shell-unit: ${pass} ok / ${fail} fail`);
if (fail) process.exitCode = 1;
