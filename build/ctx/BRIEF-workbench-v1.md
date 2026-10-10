# BRIEF v1 — Arkstage 演出工作台 / 引擎快照 / 素材镜像（唯一权威交接）

仓库：`/home/typer/桌面/galArkn/arkstage`（`master`；基线 commit 见 `build/ctx/HEAD.txt`）。
`build/` 全目录在 `.gitignore` 内 → **中间产物 / harness / 日志 / 截图都写 `build/`**，别污染 git 状态。
浏览器 harness 前先起 dev server：`cd /home/typer/桌面/galArkn/arkstage && (nohup npm run dev > /tmp/arkstage-vite.log 2>&1 &)`；
Chromium 用 `playwright-core` + `/snap/bin/chromium`（写法抄 `build/ed-win-check.mjs`），页面根 `http://localhost:5174`。
提交前最小闭环：`npx tsc -b frontend` 绿 + 你负责的 selftest 绿。

## 0. 用户原话 → 目标

1. 「舞台缩放不正常阿 只有100%与50%」→ 舞台**连续缩放** 0.25…2.0（滚轮以指针为锚 + 按钮 + 适配）；缩放**只改视口**，画布 px 几何不变；状态条显示百分比。
2. 「检视器在工具面板 所以不应该和其他窗口一样单开脱离按钮 并且这是显示不显示也不是独立窗口阿」→
   **工具面板 toolpanel / 舞台 stage = 常驻停靠**（标题条**没有** `⧉`、**没有** `✕`）；
   **预览 preview / 分支图 branch = 地图 Map**：工具栏按需开关（`预览`、`⌥ 分支图`），关掉即从工作台移除。
3. 「另外你这也不能拼接工作区 自由调换位置」→ IDE 式**拼接**：拖标题条到区域左/右/上/下**吸附**分屏、拖到另一面板中心=**换位**、
   分隔条拖拽**调尺寸**、布局持久化（含命名布局）。
4. 「分支图模块不能移动 排版难看 参考dify那种工作流的那种节点排布」→ 分支图 = **dify 风 DAG**：分层（开始/条件/动作/合流/结束）、
   **正交折线**连线、**零重叠**、`⤢ 适配`（键 `0`）、滚轮缩放、拖空白平移；节点 = dify 风卡片（左侧分类色条 + 标题 + 两行摘要 + 状态点）。
5. 日志噪音（原文）：
   - `[engine] resource load failed: data:text/javascript;base64,Y29uc3QgX19hcmtzdGFnZVJlc29sdmU…`（解开 = `const __arkstageResolve…` → 引擎模块的 data: URL）
   - `[StoryPlayer] 模块失败 https://static.prts.wiki/widgets/production/StoryPlayer.BQgSL6Cy.js 源长度=221071`
   → **静默降级 + 一条人话横幅（可关） + 自动重试 2 次（1.5s / 3s 退避）**；失败信息必须带 **URL + HTTP 状态**。
6. 「不要每次都爬取资源 要缓存 另外最好素材大部分打包在安装包内 设计里还可以换下载镜像源」→
   引擎快照**磁盘缓存**（离线可播 / 可预打包 / 可回滚）+ **设置里换下载源**（主源 `pack` = 包内 + 官方；镜像 = jsDelivr / Fastly / gh-proxy；源表可扩展）。
7. 「速度并发可以拉满」→ 下载并发默认 **12**（滑杆 1…32），manifest 抓取并发 **10**（设置可选）；默认**不限速**。

## 1. 归属（写者唯一，别越界）

| 归属 | 文件 | 写者 |
|---|---|---|
| 设置存储 `appSettings.ts`、素材路由 `assetRouting.js`、源目录 `engineCatalog.js`、`scripts/mirror/*`、`.github/workflows/publish-mirror.yml` | `frontend/src/lib/appSettings.ts`、`src/akstage/{assetRouting,engineCatalog}.js`、`scripts/mirror/`、`tools/mirror/versions.json` | **P1** |
| 引擎「随包快照」+ 引擎加载 | `scripts/fanfic/build-engine-bundle.mjs`、`src-tauri/resources/engine/**`、`src-tauri/src/engine_snapshot.rs`、`frontend/src/lib/{enginePack,engineBoot,predownload,storyPlayerAdapter,storyPlayerBoot}.ts`、`src-tauri/src/lib.rs`(注册命令) | **P6** |
| 布局模型（纯函数） | `frontend/src/components/editor/{workbenchLayout.ts,workbenchStack.ts,history.ts(只读)}` | **P3** |
| 容器 / 拼接交互 | `frontend/src/components/editor/{Workbench.tsx,workbench.css}` | **P3** |
| 窗口壳（dock/map 语义 + 迁移） | `frontend/src/components/editor/{InspectorWindow.tsx,windowState.ts,inspectorWindow.css}` | **P4** |
| 编辑器页接线 + 页面 CSS | `frontend/src/pages/StoryEditorPage.tsx`、`frontend/src/styles/{browser.css,editor-windows.css}` | **P5** |
| 窗口内容：舞台 | `frontend/src/components/editor/{StagePane.tsx,stageModel.ts,stageZoom.ts}`、`frontend/src/lib/stageCatalog.ts` | **P2** |
| 窗口内容：分支图 | `frontend/src/components/editor/BranchGraph.tsx`、`src/akstage/local/branchGraph.js`、`frontend/src/components/editor/branchGraph.css` | **T6** |
| harness / 验收 | `build/harness/**`、`build/lint/**` | **Lead** |

## 2. 逐字契约（harness 按这些字符串/形状断言）

### 2.1 panel id 与 DOM 标记（P3 常量；P4/P5/T6 共用）

```
PANELS = ["toolpanel", "stage", "preview", "branch"]
"toolpanel" → 常驻 dock（标题「工具面板」，无 ⧉ 无 ✕，minW 240, minH 160）
"stage"     → 常驻 dock（标题「舞台」， 无 ⧉ 无 ✕，minW 280, minH 160）
"preview"   → Map（标题「预览」，工具栏「预览」开关，minW 320, minH 200）
"branch"    → Map（标题「分支图」，工具栏「⌥ 分支图」开关，minW 320, minH 200）
DOM：容器 [data-workbench]；面板块 [data-wb-panel="<id>"]；分隔条 [data-wb-gutter]；
     拖拽提示 [data-wb-overlay]（-drop="left|right|top|bottom|center"）；最小化项 [data-wb-min="<id>"]；
     窗口根 [data-win="<title>"]；标题条 class="ed-win-bar"；标题条按钮 class="ed-win-btn"
localStorage：布局 `prts-editor-wb:default`、命名 `prts-editor-wb:<name>`、活跃布局名 `prts-editor-wb:active`；
     **迁移**：旧的 `prts-editor-windows:*`（readWindowState 形状 `{kind:"dock",side}` | `{kind:"float",rect}`）只读一次后删除。
```

### 2.2 窗口壳契约：`frontend/src/components/editor/inspectorWindow.ts`（P4 写；P2/T6 的 chrome props 用它）

```ts
export interface PanelChromeProps {
  title: string; ariaLabel: string; visible: boolean;
  onToggle?: () => void;   // 「▾」折叠 = 隐藏（Map 语义）；停靠面板没有 visible:false 以外的浮动/关闭
  onSelect?: () => void; active?: boolean;
}
// 窗口内容组件（P2 写 StagePane.tsx；T6 写 BranchGraph.tsx；两者都在组件内部渲染 chrome 控件）：
//   props.chrome?: PanelChromeProps（可选！缺失时内容照常渲染）
//   StagePane 的 chrome 控件带 data-chrome="stage"；BranchGraph 的带 data-chrome="branch"。
//   class 名：.sp-chrome / .bg-chrome / .sp-fold / .bg-fold / .is-active
```

### 2.3 `frontend/src/components/editor/workbenchStack.ts`（P3 写：布局树纯模型，无 DOM）

```ts
export type PanelId = "toolpanel" | "stage" | "preview" | "branch";
export type Dir = "row" | "col";         // row = 左右；col = 上下
export type Zone = "left" | "right" | "top" | "bottom" | "center";
export type Subject = { t: "panel"; id: PanelId }
                    | { t: "split"; dir: Dir; share: number; a: Subject; b: Subject }
                    | { t: "min" };   // 最小化槽
export type Holder = { t: "holder" };   // 「编辑区」(textarea) 占位叶：P5 传 ReactNode 进来
export interface WorkbenchState { root: Subject; minimized: PanelId[] }
export function defaultState(): WorkbenchState;      // toolpanel(左 32%) | (col: editor-holder(上,不复用) / stage(下))；preview·branch 不在树里（Map 关）
export function normalize(state: WorkbenchState, visible: PanelId[]): WorkbenchState;
export function ids(state: WorkbenchState): PanelId[];
export function move(state: WorkbenchState, id: PanelId, target: PanelId | "root", zone: Zone): WorkbenchState;
export function resize(state: WorkbenchState, path: number[], share: number): WorkbenchState;  // 分隔条
export function stringify(state): string; export function parse(text: string): WorkbenchState | null;
export function pathTo(state, id): number[] | null;   // 供 DOM 渲染定位
```

### 2.4 `frontend/src/components/editor/workbenchLayout.ts`（P3 写：规格表 + 可见性 + 命名布局）

```ts
export const PANELS: PanelId[];
export const WINDOW_SPECS: Record<PanelId, {
  title: string; map: boolean; minW: number; minH: number; order: number; kind: "dock" | "map";
}>;
export function listLayouts(): string[]; export function saveLayout(name: string): void;
export function loadLayout(name: string): boolean; export function activeLayout(): string;
export function migrateLegacy(previousStorageKeys?: string[]): void;   // 迁移 prts-editor-windows:*（一次性）
// 说明：布局树本体在 P4 的 workbenchStack.ts；P3 只管「常量 + 保存/读取/迁移」。
```

### 2.5 `frontend/src/components/editor/stageZoom.ts`（P2 写，纯数学；StagePane 只 import）

```ts
export const MIN_ZOOM = 0.25, MAX_ZOOM = 2, DEFAULT_ZOOM = 1, WHEEL_STEP = 0.1;
export function clampZoom(v: number): number;
export function fitZoom(viewport: { w: number; h: number }, box: { w: number; h: number }): number; // min(vw/bw, vh/bh)
export function zoomAt(zoom: number, point: { x: number; y: number }, delta: number,
                      box: { w: number; h: number }, clamp = clampZoom): { zoom: number; x: number; y: number };
// zoomAt：point 是「画布坐标」（1280x720 域）；缩放前后 point 停在同一 CSS 像素位置（滚轮锚点保值）。
```

### 2.6 `frontend/src/lib/engineCatalog.ts`（P1）与 `frontend/src/lib/stageCatalog.ts`（P2）

```ts
// engineCatalog（P1）：源目录 + 源可用性 + 「下载引擎」选择表
export interface CatalogEntry { id: string; label: string; kind: "src" | "css" | "js" | "font" | "data";
                               key: string; urls: string[]; size: number }
export function catalog(): CatalogEntry[];                       // 由 tools/mirror/versions.json 打包进前端
export function mirrorUrl(source: string, raw: string): string | null;  // 该源不适用 → null
export function readEnginePack(): Promise<{ version: string; keys: string[]; files: number } | null>; // engine_pack_info
// stageCatalog（P2）：舞台素材（背景/立绘）清单 + 选择 + 镜像改写
export function bgCandidates(...); export function charCandidates(...);
export function defaultStageSelection(): string[];
export function resolveStageUrl(key: string, source: string): string;
```

### 2.7 横幅 / 状态契约（**P6 写** `debugLog.ts`；其他人只读）

```ts
// frontend/src/lib/debugLog.ts
export function pushStatus(kind: "engine" | "stage" | "download" | "boot", message: string, hint?: string): void;
export function resolveStatus(kind: string): void;              // 启动成功 → 清掉该 kind
export function statusEntries(): Array<{ kind: string; message: string; hint?: string }>;
// 纪律：data:text/javascript / blob: 的「模块加载失败」只在 debug 面板可见，不进横幅；
//      横幅 = 人话一条 + 可关；同 kind+message 去重。
```

---

## 3. 决策（Lead 已定，有异议先说再改）

1. **面板语义**：`toolpanel` / `stage` = 常驻停靠（无 ⧉ / 无 ✕）；`preview` / `branch` = Map（工具栏开关）；**「检视器」** 只是
   `toolpanel` 内部一块折叠区（`收起检视器` 按钮 + localStorage `prts-editor-inspector`），**不再是窗口**。
2. **并发默认拉满**：下载并发 12（1…32）、manifest 抓取 10、**默认不限速**；老用户已保存的值优先。
3. **镜像源**：默认 `pack`（包内快照 + 官方直连）→ 失败按 `jsDelivr → Fastly → gh-proxy` 自动回退；会话内**记住可用源**、
   并发探测（每源 HEAD/Range 前 1KB）、结果缓存 10 分钟；设置里可固定单一源（"自定义源"可填模板 URL）。
4. **引擎快照**：**随包内置一份**（`src-tauri/resources/engine/<ver>/`，`include_bytes!`）+ **磁盘缓存**（`data_root/engine/<ver>/`）+
   网络；离线首启可播；`engine_pack_info` 暴露给 UI 与探针。
5. **日志**：UI 里引擎/模块错误**只出一条横幅**；技术细节（data: URL、moduleErrors、HTTP 状态）在「调试日志」里成组展示。
6. **兼容**：`prts-editor-windows:*` 旧窗口状态做一次性迁移；`data-*` 标记（harness 用）只增不改；所有新 harness 走 `build/harness/`。

## 4. 验收（Lead 跑；各任务自带 harness 供复现）

| # | 需求 | 验收 |
|---|---|---|
| 1 | 舞台连续缩放 | `node build/harness/stage-zoom.mjs`：滚轮后 zoom 落在 (0.25,2) 内且 ≠1/0.5；按钮 100% 回到 1；几何 `transform` 不变 |
| 2 | 面板/舞台无 ⧉✕ | `node build/harness/window-chrome.mjs`：`[data-wb-panel=toolpanel] .ed-win-btn` 计数 = 0；stage 同 |
| 3 | 预览/分支图 = Map | 同上：点工具栏「⌥ 分支图」后 `[data-wb-panel=branch]` 出现；再点消失 |
| 4 | 拼接/换位/调尺寸 | `node build/harness/workbench-drag.mjs`：拖标题条到 edge → 布局树结构变化；拖 gutter → share 变化且持久化 |
| 5 | 分支图 dify 排布 | `node tools/harness/check.mjs branch`：`layoutGraph` 零重叠（矩形不相交）、层号单调；`node build/harness/stage-shot.mjs` 出图 |
| 6 | 引擎失败静默+横幅+重试 | `node build/harness/engine-failure.mjs`（mock：首个模块 500 → `beforeRequest` 放行） |
| 7 | 快照磁盘缓存 | `cargo build --release` 后 `node scripts/lib/…`；断言第 2 次启动命中 pack、0 次网络（`--offline` 探针） |
| 8 | 镜像源可选 | `node tools/mirror/mirror-selftest.mjs`：`mirrorUrl()` 各源产物与探测 |
| 9 | 全量回归 | `npm run build`（含 tsc）、`npm run test:editor`、`test:stage`、`test:selfcontained`、P6 的 `check.mjs` |
