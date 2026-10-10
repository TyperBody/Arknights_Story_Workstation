/* global document */
/**
 * `/branch-demo.html` 的入口 —— **只给截图 harness 用**，不进 App 路由。
 *
 * 独立 Vite HTML 入口的原因：`StoryEditorPage` 用 `import.meta.glob` 动态载入
 * `components/editor/*.tsx`；演示页若静态 import 同一个组件、又和应用在同一张
 * bundle 图里，Vite 会报 `INEFFECTIVE_DYNAMIC_IMPORT`（动态 import 拆不出
 * chunk）。演示页只 import 本文件，`BranchGraph.tsx` 仍是应用里唯一的动态引用。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import BranchDemoPage from "./BranchDemoPage";
import "./styles/browser.css";

export const DEMO_ROOT_ID = "branch-demo-root";

const host = document.getElementById(DEMO_ROOT_ID) ?? document.getElementById("root");
if (host) {
  createRoot(host).render(
    <StrictMode>
      <BranchDemoPage />
    </StrictMode>,
  );
}

export {};
