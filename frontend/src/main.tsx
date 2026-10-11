import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalCapture } from "./lib/debugLog";
import { flush, hydrate } from "./lib/stateStore";
import "./styles/global.css";
import "./styles/browser.css";

// Capture main-window errors/warnings before anything else runs.
installGlobalCapture();

// 本机"记忆"（SQLite `state.db`）**先 hydrate**：工作台排版/语言/播放器设置都是
// 渲染期同步读，必须在这一帧之前把 scope 拉进内存（无 Tauri → localStorage）。
void hydrate();
// 退出/切后台前把合并中的写落库（`pagehide` 比 `beforeunload` 在移动端更可靠）。
window.addEventListener("pagehide", () => { void flush(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flush(); });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
