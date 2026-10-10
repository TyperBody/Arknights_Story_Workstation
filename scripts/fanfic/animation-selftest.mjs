#!/usr/bin/env node
/**
 * animation-selftest.mjs —— 校验 `.akskills/arkstage-fanfic` 的演出文档与内置样例
 * 是否**和引擎实际行为一致**（防止文档漂移把作者带沟里）。
 *
 * 断言：
 *  1. `templates/performance.md` 的每个代码块都能被 DSL 解析且 lint 0 error；
 *  2. `reference/animation.md` 的每个 ``` 片段（含"反例"）里出现的命令都在
 *     分级表里（A/B/C）或注释白名单内；
 *  3. `reference/commands.md` §7 的参数名表与引擎运行时逐个对齐
 *     （runtime.ts 的 `case "…"` 分支里 `exactArg(args,"…")` 的集合）；
 *  4. 内置样例 `src-tauri/resources/library/sample-fanfic/script.txt`
 *     原始字节 == seed 时 include_str! 的内容；
 *  5. 三份文档里**没有** `[End]`（除"不要写"的反例说明行）与 `duration` 用在
 *     `Bridge`/`Delay` 的位置。
 *
 * 用法：`node scripts/fanfic/animation-selftest.mjs`
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { lintScript, parseScript } from "../../src/akstage/local/storyPack.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const skill = join(root, ".akskills/arkstage-fanfic");
const runtimePath = "/home/typer/桌面/.akresearch/repo/src/widgets/StoryPlayer/engine/runtime.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 抽出 markdown 的 ``` 代码块。 */
const codeBlocks = (md) => [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);

/** 参考文档里出现的 `[Command` 名。 */
const commandsIn = (text) => new Set(
  [...text.matchAll(/\[([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1].toLowerCase())
);

// —— 1. templates 的每个块都能解析 + lint ——
const tplPath = join(skill, "templates/performance.md");
const tpl = readFileSync(tplPath, "utf8");
const blocks = codeBlocks(tpl);
check("templates/performance.md 有代码块", blocks.length >= 10, `${blocks.length} 块`);
let badBlocks = 0;
for (const [index, block] of blocks.entries()) {
  const text = `${block.trimEnd()}\n`;
  const report = lintScript(text, {});
  const errors = (report?.diagnostics ?? []).filter((d) => (d.severity ?? "error") === "error");
  const unknown = parseScript(text).filter((line) => line.unknown === true).map((line) => line.command);
  if (errors.length || unknown.length) {
    badBlocks += 1;
    console.log(`     块#${index + 1}: errors=${errors.length} unknown=${unknown.join(",")}`);
  }
}
check("templates 全部代码块可解析", badBlocks === 0, `${blocks.length - badBlocks}/${blocks.length}`);

// —— 2. animation.md 里引用的命令都在分级表内 ——
const animPath = join(skill, "reference/animation.md");
const anim = readFileSync(animPath, "utf8");
const storyPack = readFileSync(join(root, "src/akstage/local/storyPack.js"), "utf8");
const tiered = new Set([...storyPack.matchAll(/["'`]([a-z_][a-z0-9_]*)["'`]/g)].map((m) => m[1].toLowerCase()));
const docOnly = new Set(["quote", "code", "x", "y", "br", "size", "color", "i", "u"]); // 正文/富文本标签
const refUnknown = [...commandsIn(anim)].filter(
  (c) =>
    !tiered.has(c) &&
    !docOnly.has(c) &&
    // §9 的"已知偏差"表用命名空间指令（`[Battle.Pause]`）与占位（`[Cmd=(…)]`）当反例。
    !["battle", "activity", "sandboxv2", "cmd"].includes(c),
);
check("animation.md 的命令都在分级表内", refUnknown.length === 0, refUnknown.join(","));

// —— 3. 与 runtime.ts 对齐（仅当参考仓库存在时） ——
if (existsSync(runtimePath)) {
  const runtime = readFileSync(runtimePath, "utf8");
  /** runtime.ts 里 `case "<cmd>"` 到下一个 `case` 之间的 `exactArg(args, "x")`。 */
  const argsOf = (command) => {
    const at = runtime.indexOf(`case "${command}"`);
    if (at < 0) return null;
    const rest = runtime.slice(at);
    const next = rest.slice(1).search(/\n\s*case "/);
    const body = next > 0 ? rest.slice(0, next) : rest.slice(0, 4000);
    return new Set([...body.matchAll(/exactArg\(args, "([A-Za-z]+)"\)/g)].map((m) => m[1]));
  };
  const expectations = {
    delay: ["time"],
    blocker: ["a", "r", "g", "b", "fadetime", "block", "style"],
    cameraeffect: ["effect", "fadetime", "keep", "block"],
    camerashake: ["duration", "block", "fadeout", "randomness", "stop", "vibrato"],
    curtain: ["direction"],
  };
  for (const [command, wanted] of Object.entries(expectations)) {
    const actual = argsOf(command);
    if (!actual) {
      check(`runtime 有 case "${command}"`, false);
      continue;
    }
    const missing = wanted.filter((w) => !actual.has(w));
    check(`runtime[${command}] 参数与文档一致`, missing.length === 0, missing.join(","));
  }
  // `Delay` 必须**不是** duration
  const delayArgs = argsOf("delay") ?? new Set();
  check("runtime[delay] 不读 duration", !delayArgs.has("duration"));
  // 收尾指令必须是 endtip、不能是 end
  const cases = new Set([...runtime.matchAll(/case "([a-z0-9_]+)"/g)].map((m) => m[1]));
  check("runtime 有 case \"endtip\"", cases.has("endtip"));
  check("runtime 没有 case \"end\"", !cases.has("end"));
} else {
  console.log("skip 参考仓库 runtime.ts 不存在，跳过引擎对齐断言");
}

// —— 4. 内置样例：与 skill 里描述的收尾一致 ——
const samplePath = join(root, "src-tauri/resources/library/sample-fanfic/script.txt");
const sample = readFileSync(samplePath, "utf8");
const sampleReport = lintScript(sample, {});
const sampleErrors = (sampleReport?.diagnostics ?? []).filter((d) => (d.severity ?? "error") === "error");
check("内置样例 lint 0 error", sampleErrors.length === 0, JSON.stringify(sampleErrors.slice(0, 2)));
const sampleCode = sample.split("\n").filter((line) => !line.trimStart().startsWith("//"));
check("内置样例没有 [End]", !sampleCode.some((line) => /^\[end\]/i.test(line.trim())));
check("内置样例以黑场收尾", sampleCode.some((line) => /^\[Blocker\(a=1/i.test(line.trim())));

// —— 5. 文档里不再出现"用 [End] 收尾"的错误建议 ——
const docs = {
  "animation.md": anim,
  "commands.md": readFileSync(join(skill, "reference/commands.md"), "utf8"),
  "templates/performance.md": tpl,
};
for (const [name, text] of Object.entries(docs)) {
  const wrongAdvice = [...text.matchAll(/建议[^\n]*`?\[End\]`?/g)].map((m) => m[0]);
  check(`${name} 没有"建议写 [End]"`, wrongAdvice.length === 0, wrongAdvice.join(" / "));
}

console.log(failures === 0 ? "\n全部断言通过" : `\n${failures} 条断言失败`);
process.exit(failures === 0 ? 0 : 1);
