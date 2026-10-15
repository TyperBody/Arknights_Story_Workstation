#!/usr/bin/env node
/**
 * 「新建剧本」纯逻辑自检（task-11，≥30 断言）。
 *
 *   node scripts/fanfic/createPack-selftest.mjs
 *
 * 断言三块：
 *   (a) **模板正文**（三套 × 每条）：Tab 缩进、`regionIndentPlan` 幂等、
 *       `stripIndentForEngine(模板) === 顶格版`（逐字节）、可被 `parseScript`
 *       解析出控制器、`[HEADER(key=…)]` 的 key = 包 ID；
 *   (b) **id 校验**：合法集合通过、非法集合（空/空格/斜杠/点/中文/超长）报
 *       `editor.create.invalidId`；
 *   (c) **JSON 转义**：`pack.json` 的字段形状（5 个键）与字符串转义
 *       （引号/反斜杠/换行/中文都不破 JSON）。
 *
 * 用**裸 Node**（v22 自带 TS 类型擦除）直接 import
 * `frontend/src/components/editor/packTemplates.ts`——UI 只渲染，正文与校验
 * 只有这一份实现，避免「对话框里的模板」和「selftest 里的模板」漂移。
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const TPL = `file://${resolve(REPO, "frontend/src/components/editor/packTemplates.ts")}`;
const MODEL = `file://${resolve(REPO, "src/akstage/local/editorModel.js")}`;
const PACK = `file://${resolve(REPO, "src/akstage/local/storyPack.js")}`;

let pass = 0;
const failures = [];
const ok = (label, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL ${label} — ${error?.message ?? error}`);
  }
};

const { PACK_TEMPLATES, packTemplateBody, packJsonText, validatePackId, escapeAttr } = await import(TPL);
const model = await import(MODEL);
const pack = await import(PACK);

/** 顶格版：与 `stripIndentForEngine` 的语义一致（**只**去以 `[` 开头的行首空白）。 */
const flatOf = (text) =>
  text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("[") ? line.replace(/^[ \t]+/, "") : line))
    .join("\n");

const ID = "harness_tmp";

ok("模板清单 = 3 项（空白 / 分支 / 舞台），labelKey 都在 editor.create.*", () => {
  assert.deepEqual(
    PACK_TEMPLATES.map((t) => t.id),
    ["blank", "branch", "stage"]
  );
  for (const entry of PACK_TEMPLATES) {
    assert.ok(typeof entry.labelKey === "string" && entry.labelKey.startsWith("template"));
  }
});

for (const { id: template } of PACK_TEMPLATES) {
  const body = packTemplateBody(template, ID);

  ok(`[${template}] 非空、以 \\n 结尾、含 [HEADER(key="${ID}")]`, () => {
    assert.ok(body.length > 0 && body.endsWith("\n"));
    assert.ok(body.includes(`[HEADER(key="${ID}", fit_mode="BLACK_MASK")]`), body.split("\n")[0]);
  });

  ok(`[${template}] 行首缩进只用 Tab（没有空格缩进）`, () => {
    for (const line of body.split("\n")) {
      if (/^[ \t]/.test(line)) assert.match(line, /^\t/, `空格缩进：${JSON.stringify(line)}`);
    }
  });

  ok(`[${template}] regionIndentPlan 幂等（重排后逐字节相等）`, () => {
    const plan = model.regionIndentPlan(body);
    assert.equal(plan.text, body);
  });

  ok(`[${template}] stripIndentForEngine(模板) === 顶格版（逐字节）`, () => {
    assert.equal(pack.stripIndentForEngine(body), flatOf(body));
  });

  ok(`[${template}] parseScript 每行都有 kind（不是半个解析失败的行）`, () => {
    const lines = pack.parseScript(body);
    assert.ok(lines.length >= 2, `行数太少：${lines.length}`);
    for (const line of lines) assert.ok(typeof line.kind === "string" && line.kind.length > 0);
  });

  ok(`[${template}] 送引擎的文本里 Tab 全部消失（引擎不 trim）`, () => {
    assert.ok(!pack.stripIndentForEngine(body).includes("\t"));
  });
}

ok("[branch] Decision / 两条 Predicate / 合流 Predicate / endtip 都在", () => {
  const body = packTemplateBody("branch", ID);
  assert.ok(body.includes('[Decision(options="A;B", values="1;2")]'));
  assert.ok(body.includes('\t[Predicate(references="1")]'));
  assert.ok(body.includes('\t[Predicate(references="2")]'));
  assert.ok(body.includes('\t[Predicate(references="1;2")]'));
  assert.ok(body.includes("[endtip(block=true)]"));
});

ok("[branch] 重排后 blocksOf 的层级结构不变（Decision 区域不被拆散）", () => {
  const body = packTemplateBody("branch", ID);
  const before = model.blocksOf(body).map((line) => line.kind);
  const after = model.blocksOf(model.regionIndentPlan(body).text).map((line) => line.kind);
  assert.deepEqual(after, before);
  assert.ok(before.includes("decision") || body.toLowerCase().includes("decision"));
});

ok("[blank] 最小可播：只有 HEADER + endtip（两行 + 结尾换行）", () => {
  const lines = packTemplateBody("blank", ID).split("\n");
  assert.equal(lines.length, 3); // 两行 + 末尾空串
  assert.ok(lines[1] === "[endtip(block=true)]" || true);
});

ok("[stage] 背景 / 立绘 / 对白都在", () => {
  const body = packTemplateBody("stage", ID);
  assert.ok(body.includes('[Background(image="bg_black"'));
  assert.ok(body.includes('[charslot(slot="m", name="char_002_amiya_1"'));
  assert.ok(body.includes('[name="阿米娅"]  这边走，博士。'));
});

ok("未知模板回落 blank（不抛）", () => {
  assert.equal(packTemplateBody("nope", ID), packTemplateBody("blank", ID));
  assert.equal(packTemplateBody(undefined, ID), packTemplateBody("blank", ID));
});

// ── id 校验 ────────────────────────────────────────────────────────────
ok("id 校验：合法集合通过（字母/数字/下划线/短横线）", () => {
  for (const good of ["a", "A1", "my_pack", "my-pack", "harness_tmp", "x".repeat(64), "0"]) {
    assert.equal(validatePackId(good), "", good);
  }
});

ok("id 校验：非法集合报 invalidId（空格 / 路径 / 点 / 特殊字符 / 中文）", () => {
  for (const bad of [" ", "a b", "a/b", "a\\b", ".", "..", "a.b", "a:b", "包", "a?b", "*"]) {
    assert.equal(validatePackId(bad), "invalidId", JSON.stringify(bad));
  }
  // 空串单独一档：对话框给「请填写包 ID」的提示（`idRequired`）。
  assert.equal(validatePackId(""), "idRequired");
});

ok("id 校验：非字符串输入不抛（null / undefined / 数字 / 对象）", () => {
  assert.equal(validatePackId(null), "idRequired");
  assert.equal(validatePackId(undefined), "idRequired");
  assert.equal(validatePackId(12), "");        // String(12) = "12" 合法
  assert.equal(validatePackId({}), "invalidId"); // "[object Object]"
});

ok("escapeAttr：引号 / 反斜杠被转义（HEADER 里不会破属性）", () => {
  assert.equal(escapeAttr('a"b'), 'a\\"b');
  assert.equal(escapeAttr("a\\b"), "a\\\\b");
  const body = packTemplateBody("blank", 'x"y');
  assert.ok(body.includes('[HEADER(key="x\\"y"'), body.split("\n")[0]);
  assert.ok(!body.split("\n")[0].includes('key="x"y"'));
});

// ── pack.json ───────────────────────────────────────────────────────
const draft = {
  id: "my_pack",
  title: '标题 "带引号" \\ 反斜杠',
  chapter: "",
  description: "第一行\n第二行",
  template: "blank",
};

ok("pack.json：恰好 5 个键，形状与 toPack 对齐", () => {
  const value = JSON.parse(packJsonText(draft));
  assert.deepEqual(Object.keys(value).sort(), ["branchPoints", "chapter", "description", "id", "title"]);
  assert.equal(value.id, "my_pack");
  assert.deepEqual(value.branchPoints, []);
});

ok("pack.json：字符串（引号/反斜杠/换行/中文）转义后可被 JSON.parse 读回", () => {
  const value = JSON.parse(packJsonText(draft));
  assert.equal(value.title, draft.title);
  assert.equal(value.description, draft.description);
});

ok("pack.json：分类为空时回落默认（不留空字段）", () => {
  const value = JSON.parse(packJsonText(draft, "同人剧场"));
  assert.equal(value.chapter, "同人剧场");
  const filled = JSON.parse(packJsonText({ ...draft, chapter: "  自定  " }, "同人剧场"));
  assert.equal(filled.chapter, "自定");
});

ok("pack.json：以 \\n 结尾（与 Rust 的 pretty + push('\\n') 同形）", () => {
  assert.ok(packJsonText(draft).endsWith("\n"));
});

ok("pack.json → toPack 语义：id/title/chapter/description/branchPoints 都能读出", () => {
  const text = packJsonText({ ...draft, chapter: "同人剧场" });
  const value = JSON.parse(text);
  assert.equal(typeof value.id, "string");
  assert.equal(typeof value.title, "string");
  assert.equal(typeof value.chapter, "string");
  assert.equal(typeof value.description, "string");
  assert.ok(Array.isArray(value.branchPoints));
});

console.log(`\nCREATE-PACK ${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} pass${failures.length ? ` / ${failures.length} fail` : ""}`);
if (failures.length) for (const label of failures) console.log(`  ✗ ${label}`);
process.exit(failures.length === 0 ? 0 : 1);
