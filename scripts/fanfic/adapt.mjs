// `frontend/src/lib/storyPlayerAdapter.ts::adaptStoryPlayerEntry` 的 Node 版移植
// （取景器要在无头浏览器里直接驱动上游模块，故需要同一套「接口发现 + 注入」）。
// 契约保持一致：context 函数体含 `scriptText:`/`audioVariables:`/`backgroundPpuMap:`，
// manifest 函数体含 `faceAssets:`/`urls:`/`charMap`；两者各恰好一个，
// 然后把 `window.__arkstageAPI` / `window.__arkstageMount` 挂到模块末尾。
//
// 若上游结构变化，这里与 TS 版必须同时改（TS 版是应用运行时的那份）。
import { parse } from "acorn";

export function adaptStoryPlayerEntry(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const functions = ast.body.filter((node) => node.type === "FunctionDeclaration");
  const context = functions.filter((node) => {
    const body = source.slice(node.start, node.end);
    return /\bscriptText\s*:/.test(body) && /\baudioVariables\s*:/.test(body) && /\bbackgroundPpuMap\s*:/.test(body);
  });
  const manifest = functions.filter((node) => {
    const body = source.slice(node.start, node.end);
    return /\bfaceAssets\s*:/.test(body) && /\burls\s*:/.test(body) && body.includes("charMap");
  });
  if (context.length !== 1 || manifest.length !== 1) throw new Error("StoryPlayer context/manifest 接口发生变化");

  // 只读取景的第二个钩子：把每条被**执行**的脚本行记账（wrapping 构造函数原型上的
  // executeBuiltinCommand，子类/实例都走原型派发）。这是一个可选的调试桥，
  // 上游没有同名方法时静默跳过。
  const observer = `
;(() => {
  const prototype = globalThis.__storyRuntimeClass && globalThis.__storyRuntimeClass.prototype;
  if (!prototype || typeof prototype.executeBuiltinCommand !== "function") return;
  const original = prototype.executeBuiltinCommand;
  prototype.executeBuiltinCommand = function (line) {
    try { globalThis.__noteLine && globalThis.__noteLine(line); } catch {}
    return original.call(this, line);
  };
})();`;

  // 结构识别「剧本运行时类」：类体里同时有 executeBuiltinCommand 与 getDisplayedLineIndex。
  let runtimeClass;
  const wantClass = (node) => {
    if (!node || typeof node !== "object") return;
    if ((node.type === "ClassDeclaration" || node.type === "ClassExpression")
      && Array.isArray(node.body?.body)
      && node.body.body.some((member) => member.type === "MethodDefinition" && member.key?.name === "executeBuiltinCommand")
      && node.body.body.some((member) => member.type === "MethodDefinition" && member.key?.name === "getDisplayedLineIndex")) {
      if (runtimeClass) throw new Error("StoryPlayer 包含多个运行时类");
      runtimeClass = node;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(wantClass);
      else if (value && typeof value === "object") wantClass(value);
    }
  };
  wantClass(ast);
  if (!runtimeClass) throw new Error("StoryPlayer 运行时类发生变化");
  const publish = runtimeClass.type === "ClassDeclaration"
    ? `globalThis.__storyRuntimeClass = ${runtimeClass.id.name};`
    : `globalThis.__storyRuntimeClass = globalThis.__storyRuntimeClass ?? null;`;

  // 脚本 → 行数组的解析函数（`collectManifest` 真正遍历的输入）。
  const parseFn = functions.filter((node) => {
    const body = source.slice(node.start, node.end);
    return /\.split\(/.test(body) && /replace\(\/\\r/.test(body) && /lineNumber/.test(body);
  });

  const edits = [];
  let mount;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && node.callee.property?.name === "init") {
      const options = node.arguments[0];
      if (options?.type === "ObjectExpression") {
        for (const property of options.properties) {
          if (property.key?.name === "preference" && /^["'`]webgpu["'`]$/.test(source.slice(property.value.start, property.value.end))) {
            edits.push({ start: property.value.start, end: property.value.end, replacement: '"webgl"' });
          }
        }
      }
    }
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression"
      && node.callee.property?.name === "mount" && node.callee.object?.type === "CallExpression") {
      const props = node.callee.object.arguments?.[1];
      if (props?.type === "ObjectExpression" && props.properties.some((p) => p.key?.name === "script")) {
        if (mount) throw new Error("StoryPlayer 包含多个入口");
        const app = node.callee.object;
        const create = source.slice(app.start, props.end - 1) + ",autoStart:true" + source.slice(props.end - 1, app.end);
        const call = `(window.__arkstageVueApp=${create})` + source.slice(app.end, node.end);
        mount = { start: node.start, end: node.end, replacement: `(window.__arkstageMount=()=>{window.__arkstageApp=${call}})` };
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  if (!mount) throw new Error("StoryPlayer mount 接口发生变化");
  edits.push(mount);
  if (runtimeClass.type === "ClassExpression") {
    edits.push({ start: runtimeClass.start, end: runtimeClass.end, replacement: `globalThis.__storyRuntimeClass=(${source.slice(runtimeClass.start, runtimeClass.end)})` });
  }

  let adapted = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    adapted = adapted.slice(0, edit.start) + edit.replacement + adapted.slice(edit.end);
  }
  // 上报「运行时类」的原型：取景器借此挂执行钩子（executeBuiltinCommand 在原型上）。
  return `${adapted}
${runtimeClass.type === "ClassDeclaration" ? publish : ""}
window.__arkstageAPI={loadContext:${context[0].id.name},collectManifest:${manifest[0].id.name}${parseFn.length === 1 ? `,parse:${parseFn[0].id.name}` : ""}};
${parseFn.length === 1 ? `window.__arkstageParse=${parseFn[0].id.name};` : ""}
${observer}`;
}
