/**
 * `/stage-demo.html` 的入口 —— **只给 `build/stage-check.mjs` 用**，不进 App 路由。
 *
 * 写成独立的 Vite HTML 入口（不是 `App.tsx` 的 `<Route>`）的原因：`StoryEditorPage`
 * 用 `import.meta.glob` **动态**载入 `StagePane.tsx`；如果演示页静态 import 同一个
 * 组件、又和编辑器页在同一个 bundle 图里，Vite 会报
 * `INEFFECTIVE_DYNAMIC_IMPORT`（动态 import 拆不出 chunk）。独立入口把两者分开：
 * 应用构建（`vite build frontend`，只吃 `index.html`）里没有演示页，
 * 编辑器页的动态 import 依旧是唯一引用。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import StageDemoPage from "./StageDemoPage";

const root = document.getElementById("stage-demo-root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StageDemoPage />
    </StrictMode>,
  );
}
