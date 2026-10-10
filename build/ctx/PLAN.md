# PLAN — 分工（契约：BRIEF-workbench-v1.md；本文件只排依赖与时间盒）

P1  设置存储 appSettings.ts / 源表 assetRouting+engineCatalog / tools/mirror + versions.json + publish 工作流
    验收：`node tools/mirror/mirror-selftest.mjs`；`npx tsc -b frontend`
P2  舞台连续缩放 stageZoom.ts + StagePane chrome + stageCatalog.ts
    验收：`node build/harness/stage-zoom.mjs`；`npm run test:stage`（82 断言）仍绿
P3  workbench 布局模型 + 容器（workbenchLayout.ts / workbenchStack.ts / Workbench.tsx|css）
    验收：`node build/harness/wb-selftest.mjs`（纯函数 ≥ 25 断言）；UI 拖拽见 #7
P4  窗口壳（dock/map、无 ⧉✕、迁移、分隔条）
    验收：`node build/harness/window-chrome.mjs` 的 DOM 断言从 P4 起可跑
P5  编辑器页接线（StoryEditorPage.tsx + CSS），依赖 #3(P3) 与 #7(P4) 的 API
    验收：`node build/harness/workbench-drag.mjs`；`npx tsc -b frontend`
P6  引擎随包快照 + 加载降级/横幅/重试 + 下载并发拉满
    验收：`node build/harness/engine-failure.mjs`；`cd src-tauri && cargo build --release`（或 cargo check）

时间盒（Lead 节奏）：
- T+30m：P1/P2/P3/P6 出骨架（纯函数/数据先行）；P4 出 workbenchStack API 后 P5 才能接线。
- T+60m：窗口 chrome 语义（dock 无按钮 / map 可选）在 dev server 上肉眼可验；Lead 跑 window-chrome + stage-zoom。
- T+90m：T6 的 dify 分支图 + 全量回归（tsc / test:editor / test:stage / selfcontained）。
- 熔断：谁的模块 30m 没落地 → 按 BRIEF §3.6 兼容策略降级并由 Lead 在 final 说明。

命令：
- dev：`cd /home/typer/桌面/galArkn/arkstage && (nohup npm run dev > /tmp/arkstage-vite.log 2>&1 &)`
- 类型：`npx tsc -b frontend`   lint：`npx eslint -c frontend/eslint.config.js frontend`
- git：`git add -f <files> && git commit`（build/ 默认被忽略；契约文件用 -f）
