// 纯 Node 单测：StoryPlayerModuleError / 重试阶梯常量 的契约（无需浏览器）。
globalThis.window = undefined;
const mod = await import("/tmp/spb-enginePack.js").catch(() => null);
console.log("loaded", Boolean(mod));
