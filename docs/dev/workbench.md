# 演出工作台（可拼接窗口）+ 舞台缩放 + 分支图 / 引擎快照 / 镜像源

> 面向开发者。用户向说明见仓库根 `README.md`；本页记录**模块边界、契约、回归命令**。
> 变更历史：2026-10-11「工作台 v1」——按用户反馈重做（缩放连续、面板语义、拼接、分支图排版、资源缓存/镜像）。

## 1. 工作台（`frontend/src/components/editor/`）

| 文件 | 职责 |
|---|---|
| `workbenchStack.ts` | **纯模型**（零 React/DOM）：`defaultState/normalize/ids/pathTo/move/resize/reorder/minimize/restore/stringify/parse/summarize`。布局是二叉树：`{t:"panel"\|"split"\|"holder"\|"min"}`，`share` clamp 0.12…0.88 |
| `workbenchLayout.ts` | `PANELS` / `WINDOW_SPECS`（标题、minW/minH、`kind: "dock"\|"map"`）+ 命名布局 `listLayouts/saveLayout/loadLayout/activeLayout` + `migrateLegacy()/consumeLegacy()`（旧 `prts-editor-windows:*` 一次性迁移） |
| `Workbench.tsx` / `workbench.css` | 递归 flex 渲染 + `[data-wb-gutter]` 分隔条 + 拖拽会话（≥4px）+ 边缘/中心 overlay（`[data-wb-overlay][data-wb-drop]`）+ 事件委托把手（标题条 `.ed-win-bar` 或 `data-drag-handle`） |
| `InspectorWindow.tsx` | 窗口壳：`shellKind: "dock"`（常驻，**无 ⧉ 无 ✕**）/ `"map"`（按需，`✕` 关闭、`⧉` 浮动） |
| `inspectorWindow.ts` / `PanelChrome.tsx` | `PanelChromeProps{title,ariaLabel,visible,onToggle?,onSelect?,active?}` + chrome 控件 |
| `stageZoom.ts` | 舞台缩放纯数学：`MIN .25 / MAX 2 / DEFAULT 1 / WHEEL_STEP .1`、`clampZoom/fitZoom/zoomAt`（滚轮锚点保值） |
| `StagePane.tsx` | 16:9 舞台：滚轮/±/适配/1:1/百分比；**缩放只改 `viewBox`**，几何 px 不变 |
| `BranchGraph.tsx` + `src/akstage/local/branchGraph.js` | dify 风 DAG：`layoutGraph()` 分层 + 正交折线 + 零重叠；`⤢ 适配`(0)、滚轮缩放、拖空白平移 |

### DOM 契约（harness 锚点，只增不改）

`[data-workbench]`、`[data-wb-panel="<id>"]`、`[data-wb-gutter]`、`[data-wb-overlay][data-wb-drop]`、
`[data-win="<title>"]`、`.ed-win-bar`、`.ed-win-btn`；
舞台：`[data-stage-pane]`、`[data-stage-svg]`、`[data-stage-status="zoom"]`、`[data-stage-action="zoom-in|zoom-out|zoom-reset|fit|zoom-1|zoom-05"]`、`[data-chrome="stage"]`；
分支图：`[data-branch-graph]`、`[data-branch-node]`、`[data-branch-layer]`、`[data-branch-edge]`、`[data-branch-path]`、`[data-branch-pan]`、`[data-branch-action="fit"]`、`[data-branch-empty]`、`[data-chrome="branch"]`。

### 持久化键

`prts-editor-wb:default`（当前布局）、`prts-editor-wb:<name>`（命名布局）、`prts-editor-wb:active`、`prts-editor-wb:migrated`（一次性）。

## 2. 引擎快照（随包 + 磁盘 + 网络）

- 随包：`src-tauri/resources/engine/v1/{snapshot.json,meta.json}`（3.4 MB，由 `scripts/fanfic/build-engine-bundle.mjs` 从 `scripts/fanfic/fetch-upstream.mjs` 产物生成），经 `engine_snapshot.rs` 的 `engine_snapshot_info/engine_snapshot_read` + `engine_pack_info` 暴露（`include_bytes!`，**离线可读**）。
- 前端：`enginePack.ts` 的顺序 **pack → 磁盘 cache（`cache/widget-bundle-v7`）→ 网络**；网络成功才回写 cache + `-previous`。
- 失败：`storyPlayerBoot.ts` 在 `viaSrc → viaInline → 重试 2 次（1.5s/3s）` 全失败后换来源；同时 `debugLog.pushStatus("engine", 人话, hint)` → UI 顶部**单条**横幅（`[data-asset-banner="1"]`），`data:`/`blob:` 的模块错误标 `silent`，只在调试面板可见。

## 3. 下载源 / 镜像

- `appSettings.ts`：`mirror: pack|prts|jsd|fastly|ghproxy|custom`、`customMirror`、`downloadConcurrency`（默认 **12**，1…32）、`manifestConcurrency`（**10**）、`rateLimit`（0=不限速）。
- `src/akstage/assetRouting.js`：源模板集中在 `MIRRORS`；`routeFor/buildSourceOrder/mirrorUrl/describe`、`toMirrorKey ⇄ fromMirrorUrl`、`canonicalKey`。**镜像仓需先跑 `.github/workflows/publish-mirror.yml`**（默认 `djkcyl/arkstage-mirror@main`），否则镜像 404 → 自动回退 prts。
- `src/akstage/engineCatalog.js` + `catalog-data.json`：引擎 25 条（css/js/font/src/data）、素材 19,861 条；`frontend/src/lib/engineCatalog.ts` 是 TS 包装。
- Rust：`download::DEFAULT_CONCURRENCY = 12`、`MAX_CONCURRENCY = 32`；`setDownloadSettings` 由设置页写入。

## 4. 回归

```bash
cd <repo>
( nohup npm run dev > /tmp/arkstage-vite.log 2>&1 & )   # harness 前置：dev server :5174
node build/harness/demo-check.mjs                      # 编辑器/舞台/分支图/拼接 端到端
node scripts/fanfic/branchGraph-selftest.mjs           # 分支图语义（73）
node build/harness/branch-shot.mjs                     # dify 布局零重叠 + 截图
node build/ctx/… 见 build/harness/*.mjs
npx tsc -b frontend                                   # 类型
npm run test:editor && npm run test:stage             # 编辑器 / 舞台内核
```
