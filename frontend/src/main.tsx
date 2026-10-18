import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalCapture } from "./lib/debugLog";
import { flush, hydrate } from "./lib/stateStore";
import "./styles/global.css";
// **ak-ui（`@yunyoujun/ak-ui`）**：明日方舟风格的 CSS Core。它只提供
// `.ak-*` 组件类 + `--ak-*` token（**没有全局 reset**，实测无 `html/body/*` 规则），
// 所以放在自有样式**之前**，由 `theme-arknights.css` 做"把 app 类映射到 ak-ui token"
// 的适配层 —— 观感统一来自 ak-ui，DOM/类名契约不动。
import "@yunyoujun/ak-ui/style.css";
import "./styles/browser.css";
// 适配层：**最后**加载（同名规则以它为准），只把旧变量名接到 ak-ui token 上。
import "./styles/theme-arknights.css";

// Capture main-window errors/warnings before anything else runs.
installGlobalCapture();

// 本机"记忆"（SQLite `state.db`）：**先 hydrate 完再渲染**。
// 工作台排版 / 语言 / 播放器设置都是**渲染期同步读**（`workbenchBoot()` 在模块加载时
// 就跑完），若"先渲染、后 hydrate"，首帧必然用默认值 —— 用户看到的就是
// 「排版每次打开都重置」。无 Tauri（浏览器 dev）时 `hydrate()` 同步播种 localStorage，
// 这里只多一个微任务；DB 坏/慢也不会卡住（`hydrate` 内部全 catch）。
try {
  await hydrate();
} catch (error) {
  console.warn("[stateStore] hydrate 失败（按默认值渲染）：", error);
}
// 退出/切后台前把合并中的写落库（`pagehide` 比 `beforeunload` 在移动端更可靠）。
window.addEventListener("pagehide", () => { void flush(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flush(); });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
