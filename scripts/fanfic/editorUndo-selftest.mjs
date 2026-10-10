#!/usr/bin/env node
/**
 * 撤销/重做历史栈自检（offline, node 直跑）——task-15 交付 A 的验收。
 *
 *   node scripts/fanfic/editorUndo-selftest.mjs [--json out.json]
 *
 * 断言（对齐任务描述）：
 *   (a) 合并规则：<500ms 的连续"纯插入且不含 \n"合并成一条；含 `\n`、
 *       替换选中区间、超时 → 各自成条；
 *   (b) 上限裁剪：超过 `limit` 只保留最新的 limit 条；
 *   (c) undo/redo 顺序：来回都按原路（含"undo → redo → undo"两次往返）；
 *   (d) `text` 相等不入栈（snapshot/commit 两条入口都测）；
 *   (e) undo 后再做新编辑 → redo 清空；
 *   (f) `diffOf`（onChange 归位用）在插入/删除/替换三种情形下正确；
 *   (g) `snapshot` 与 `commit` 混合使用时（打字 → 拖立绘 → 打字）顺序正确。
 *
 * 退出码：0 = 全过；1 = 有断言失败；2 = 用法/环境错误。
 * 契约见 `frontend/src/components/editor/history.ts` 顶部。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createHistory, diffOf } from "../../frontend/src/components/editor/history.ts";

const argv = process.argv.slice(2);
const jsonPath = argv.includes("--json") ? resolve(argv[argv.indexOf("--json") + 1]) : null;

let passed = 0;
const failures = [];
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) passed += 1;
  else failures.push(`${label}\n    actual  : ${a}\n    expected: ${b}`);
};
const ok = (value, label) => eq(Boolean(value), true, label);

/** 注入时钟的历史栈（确定性）。 */
function makeClock(start = 0) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

const entry = (text, sel = [text.length, text.length]) => ({ text, sel });

// ── (a) 合并规则 ────────────────────────────────────────────────────────
{
  const clock = makeClock(1000);
  const h = createHistory({ now: clock.now, mergeMs: 500 });
  const base = "abc";
  h.commit({ before: entry(base), after: entry("abcd"), insert: "d", source: "typing" });   // 1 条
  clock.tick(100);
  h.commit({ before: entry("abcd"), after: entry("abcde"), insert: "e", source: "typing" }); // 合并 → 仍 1 条
  clock.tick(100);
  h.commit({ before: entry("abcde"), after: entry("abcdef"), insert: "f", source: "typing" });
  eq(h.sizes(), { undo: 1, redo: 0 }, "(a1) <500ms 连续纯插入合并成 1 条");
  eq(h.undo(entry("abcdef")), { text: "abc", sel: [3, 3] }, "(a2) 撤销回到合并前");

  const clock2 = makeClock(2000);
  const h2 = createHistory({ now: clock2.now, mergeMs: 500 });
  // 先打一行（a → ab），稍后回车换行（ab → ab\n），再打下一行首字符。
  h2.commit({ before: entry("a"), after: entry("ab"), insert: "b", source: "typing" });
  clock2.tick(600); // 超时 → 新串
  h2.commit({ before: entry("ab"), after: entry("ab\n"), insert: "\n", source: "typing" });
  clock2.tick(50);
  h2.commit({ before: entry("ab\n"), after: entry("ab\nc"), insert: "c", source: "typing" });
  eq(h2.sizes(), { undo: 2, redo: 0 }, "(a3) 含 \\n 的插入单独成条，其后的字符并入该条（一次输入行 = 一次撤销）");
  const step = h2.undo(entry("ab\nc"));
  eq(step, entry("ab"), "(a3b) 撤销一步 → 回到换行前（本行整体回退）");
  eq(h2.sizes().redo, 1, "(a3c) redo 里有 1 条");

  const clock3 = makeClock(3000);
  const h3 = createHistory({ now: clock3.now, mergeMs: 500 });
  h3.commit({ before: { text: "abc", sel: [1, 3] }, after: entry("ax"), insert: "x", source: "typing" });
  clock3.tick(10);
  h3.commit({ before: entry("ax"), after: entry("axy"), insert: "y", source: "typing" });
  eq(h3.sizes(), { undo: 2, redo: 0 }, "(a4) 替换选中区间不合并（下一条才合并）");

  const clock4 = makeClock(4000);
  const h4 = createHistory({ now: clock4.now, mergeMs: 500 });
  h4.commit({ before: entry("a"), after: entry("ab"), insert: "b", source: "typing" });
  clock4.tick(600); // 超时
  h4.commit({ before: entry("ab"), after: entry("abc"), insert: "c", source: "typing" });
  eq(h4.sizes(), { undo: 2, redo: 0 }, "(a5) 超时后新开一条");

  const clock5 = makeClock(5000);
  const h5 = createHistory({ now: clock5.now, mergeMs: 500 });
  h5.commit({ before: entry("a"), after: entry("ab"), insert: "b", source: "typing" });
  clock5.tick(10);
  h5.commit({ before: entry("ab"), after: entry("abX"), insert: "X" }); // applyEdit（默认 edit）
  clock5.tick(10);
  h5.commit({ before: entry("abX"), after: entry("abXY"), insert: "Y", source: "typing" });
  eq(h5.sizes(), { undo: 3, redo: 0 }, "(a6) applyEdit 打断打字串（它自己 + 前后打字各成一条）");
}

// ── (b) 上限裁剪 ────────────────────────────────────────────────────
{
  const clock = makeClock(0);
  const h = createHistory({ limit: 3, now: clock.now });
  for (let i = 0; i < 10; i += 1) {
    clock.tick(10000); // 超时 → 永不合并且每次都是新的一条
    h.commit({ before: entry("x".repeat(i)), after: entry("x".repeat(i + 1)), insert: "x", source: "typing" });
  }
  eq(h.sizes().undo, 3, "(b1) 超过 limit 只保留最新 3 条");
  // 连撤 3 次后应恰好用尽（第 4 次返回 null）
  let present = entry("x".repeat(10));
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const next = h.undo(present);
    seen.push(next ? next.text.length : null);
    if (next) present = next;
  }
  eq(seen, [9, 8, 7, null], "(b2) 裁剪后仍按 LIFO 用尽");
}

// ── (c) undo/redo 顺序 ──────────────────────────────────────────────
{
  const clock = makeClock(0);
  const h = createHistory({ now: clock.now, mergeMs: 1 });
  const a = entry("A");
  const b = entry("AB");
  const c = entry("ABC");
  clock.tick(1000); h.commit({ before: a, after: b, insert: "B", source: "typing" });
  clock.tick(1000); h.commit({ before: b, after: c, insert: "C", source: "typing" });
  const u1 = h.undo(c);
  eq(u1, b, "(c1) undo#1 → AB");
  const u2 = h.undo(u1);
  eq(u2, a, "(c2) undo#2 → A");
  const r1 = h.redo(u2);
  eq(r1, b, "(c3) redo#1 → AB");
  const u3 = h.undo(r1);
  eq(u3, a, "(c4) undo 后又 redo 再 undo → 原路");
  const r2 = h.redo(u3);
  eq(r2, b, "(c5) 再次 redo → AB");
  const r3 = h.redo(r2);
  eq(r3, c, "(c6) 再 redo → ABC");
  eq(h.redo(r3), null, "(c7) redo 用尽 → null");
}

// ── (d) text 相等不入栈 ──────────────────────────────────────────
{
  const clock = makeClock(0);
  const h = createHistory({ now: clock.now, mergeMs: 0 });
  h.commit({ before: entry("same"), after: entry("same"), insert: "" });
  eq(h.sizes(), { undo: 0, redo: 0 }, "(d1) commit: text 相等不入栈");
  h.snapshot(entry("dup"), entry("dup"));
  eq(h.sizes(), { undo: 0, redo: 0 }, "(d2) snapshot: text 相等不入栈");
  h.snapshot(entry("old"), entry("new"));
  eq(h.sizes().undo, 1, "(d3) snapshot: 变化才入栈");
}

// ── (e) undo 后新编辑清空 redo ──────────────────────────────────
{
  const clock = makeClock(0);
  const h = createHistory({ now: clock.now, mergeMs: 0 });
  clock.tick(100); h.commit({ before: entry("A"), after: entry("AB"), insert: "B", source: "typing" });
  clock.tick(100); h.commit({ before: entry("AB"), after: entry("ABC"), insert: "C", source: "typing" });
  const back = h.undo(entry("ABC"));
  eq(back.text, "AB", "(e1) 先撤到 AB");
  eq(h.sizes().redo, 1, "(e2) redo 有 1 条");
  clock.tick(100); h.commit({ before: back, after: entry("ABZ"), insert: "Z", source: "typing" });
  eq(h.sizes().redo, 0, "(e3) 新编辑后 redo 清空");
  eq(h.redo(entry("ABZ")), null, "(e4) redo 返回 null");
}

// ── (f) diffOf（onChange 归位） ───────────────────────────────
{
  eq(diffOf("abc", "abcd"), { from: 3, to: 3, insert: "d" }, "(f1) 尾部插入");
  eq(diffOf("abcd", "abc"), { from: 3, to: 4, insert: "" }, "(f2) 尾部删除");
  eq(diffOf("abc", "axc"), { from: 1, to: 2, insert: "x" }, "(f3) 中段替换");
  eq(diffOf("", "x"), { from: 0, to: 0, insert: "x" }, "(f4) 空文档插入");
  eq(diffOf("[a]", "[a]\n[b]"), { from: 3, to: 3, insert: "\n[b]" }, "(f5) 多行插入");
  eq(diffOf("same", "same"), { from: 4, to: 4, insert: "" }, "(f6) 相等 → 空 diff");
}

// ── (g) 混合路径（打字 / 拖立绘 / 打字） ──────────────────────
{
  const clock = makeClock(0);
  const h = createHistory({ now: clock.now, mergeMs: 500 });
  // 打字两下（合并）
  clock.tick(10); h.commit({ before: entry("[Cha"), after: entry("[Char"), insert: "r", source: "typing" });
  clock.tick(10); h.commit({ before: entry("[Char"), after: entry("[Chara"), insert: "a", source: "typing" });
  // 隔一会儿：拖立绘（非打字路径，走 snapshot）
  clock.tick(5000);
  h.snapshot(entry("[Chara"), entry('[Character(name="x", xpos1=-20)]'));
  eq(h.sizes().undo, 2, "(g1) 打字合并 + 拖拽 = 2 条");
  const s1 = h.undo(entry('[Character(name="x", xpos1=-20)]'));
  eq(s1, entry("[Chara"), "(g2) 第一次撤销 → 拖拽前");
  const s2 = h.undo(s1);
  eq(s2, entry("[Cha"), "(g3) 第二次撤销 → 本串打字前");
}

const total = passed + failures.length;
if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ passed, failed: failures.length, total }, null, 1));
if (failures.length) {
  console.error(`✗ editorUndo-selftest: ${passed}/${total} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ editorUndo-selftest: ${passed}/${total} 断言通过（合并/裁剪/往返/去重/redo 清空/diffOf/混合路径）`);
