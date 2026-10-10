# PLAN — 分工与顺序（详见 BRIEF-workbench-v1.md）

| id | 队友 | 任务 | 写作用域（唯一写者） | 依赖 |
|---|---|---|---|---|
| P1 | p1-assets | 设置(appSettings) + 源表/镜像 + 引擎快照随包 + 引擎加载静默降级/横幅/重试 + 并发拉满 | src/akstage/{assetRouting,engineCatalog}.js, frontend/src/lib/{appSettings,enginePack,engineBoot,predownload,storyPlayerAdapter,storyPlayerBoot}.ts, src-tauri/src/engine_snapshot.rs, src/tauri lib.rs(注册4命令), SettingsPage.tsx, tools/mirror/*, scripts/fanfic/build-engine-bundle.mjs | 无（契约已冻结） |
| P2 | p2-stage | 舞台连续缩放 + stageZoom.ts + StagePane chrome + 舞台素材源选择 | components/editor/{stageZoom.ts,StagePane.tsx}, lib/stageCatalog.ts, build/harness/stage-zoom.mjs | 无（P4 的 inspectorWindow.ts 用行内 stub 兜底） |
| T6 | t6-branch | 分支图 dify 风 DAG（layoutGraph/BranchGraph 重写）+ chrome + build/harness/branch-shot.mjs | components/editor/BranchGraph.tsx, src/akstage/local/branchGraph.js, build/harness/branch-shot.mjs | #4 的 body 块（编辑器页结构，只读） |
| P3 | p3-cues | 布局模型 workbenchStack.ts（纯函数 + 15 项 selftest） | components/editor/workbenchStack.ts, build/harness/wb-selftest.mjs | 无 |
| P5 | p5-page | 编辑器页接线 + CSS + #N 的 chrome/window 渲染（依赖 P4 的 API，缺失时自写 stub 并注明） | pages/StoryEditorPage.tsx, styles/{browser.css,editor-windows.css} | #7（P4 API）+ #3（P3 模型）；只补它没做的 |
| H  | h-host | harness 主线：dev host + DEMO + 截图/回归脚本（headless 可跑） | build/harness/{host.html,demo.html,shot.mjs,regress.mjs,README.md}, scripts/lib/playwright-env.mjs | #4 之后 |
| P6 | p6-lint | lint（1 textarea / ≤3 abs） + web-runtime HTML→模型快照（analyze.mjs） + 证据链 | scripts/lint/lint.cjs(可执行), src/akstage/analyze.mjs, tools/harness/check.mjs, waivers.txt | #4 之后 |

## 时间盒
1. 0–45m：P1/P2/T6/P3 落地骨架 + 各自 selftest（先纯函数/数据，后 UI）。
2. 30m–75m：P4 的 API 冻结（5 行签名）→ 解锁 P5（#7/#8）；P2/T6 补 chrome。
3. 60–105m：H 的 host/shot/regress；P6 的 check；Lead 跑总验收（stage-zoom / chrome / workbench-drag / branch / engine-failure）。
4. 105m+：全量回归（tsc / test:editor / test:stage / selfcontained）→ README/CLAUDE 文档 → 收口。

## 熔断
- P4 30m 内没写出 `useWorkbench` → P5 落地自带 fallback（写成三栏固定布局 + 无拖拽），Lead 在 final 说明降级。
- T6 30m 内没写出 `layoutGraph` → P5 保留旧分支图；harness 用旧 `data-branch-*` 断言。

## 命令
- dev：`cd /home/typer/桌面/galArkn/arkstage && (nohup npm run dev > /tmp/arkstage-vite.log 2>&1 &)`
- 类型：`npx tsc -b frontend`
- 单测：`node build/harness/wb-selftest.mjs` / `npm run test:stage` / `node tools/lint/lint.cjs`
