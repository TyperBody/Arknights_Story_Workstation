# NOTES — P4（窗口壳 dock/map 语义）

## 交付（已落地）
- `frontend/src/components/editor/inspectorWindow.ts`（新）：`PanelChromeProps`（BRIEF §2.2 逐字）
  + `registerWindowSpecs / windowSpecs / findSpec / panelSpec / panelTitle / panelKind /
  resolveChrome / shellKindLabel` + `FALLBACK_TITLES/KINDS/SPECS`。
  **不复制 P3 的表**：`StoryEditorPage` 挂载时 `registerWindowSpecs(WINDOW_SPECS)`；表缺项回落兜底。
- `InspectorWindow.tsx`：三形态窗口壳。
  - 常驻 dock（toolpanel/stage，`shellKind="dock"`）：标题条**只有**折叠 `▾`（`.ed-win-collapse`，
    **不是** `.ed-win-btn` → harness 计数 0）；无 `⧉`、无 `✕`；`Esc` 不关它；标题条拖动交给 P3 的
    `Workbench`（`onDragStart?(node, size)`，4px 阈值后交 `[data-drag-handle]`）。
  - Map（preview/branch，`shellKind="map"`，`state.kind==="map"`）：`▾` + `⧉` + `✕`；
    `✕` = 关闭（页面把它翻译成"从工作台移除"）；`⧉` = 块 ↔ 浮动（`state.kind="float"`）。
  - `dock|map|float` 全部保留 `data-win` / `data-win-state` / `.ed-win-bar` / `.ed-win-btn`；
    新增 `data-shell`、按钮 `data-win-action="fold|float|close"`（只增不改）。
- `windowState.ts`：`WindowState = {kind:"dock";side} | {kind:"float";rect} | {kind:"map"}`；
  `parseWindowState` 纯函数 + `isDockState/isFloatState/isMapState`；`clampWindowState` 对 map 原样返回。
- `PanelChrome.tsx` + `chromeHidden.ts`：内容组件的 chrome 小控件（P2/T6 若想用可直接 import；
  它们目前各自渲染了 `sp-chrome/bg-chrome`，效果一致）。
- harness：`build/harness/p4-shell-unit.mjs`（10 断言，纯逻辑）、`build/harness/p4-shell-probe.mjs`
  （11 断言，浏览器；需 dev server 5174）。

## 需要 P5（`StoryEditorPage.tsx`）的一条改动（**已代为落地**，见 diff）
`onWinChange` 原用 `clampWindowState(next, bounds)`：`bounds` 是**整页**，而浮动窗 rect 是
`[data-wb-panel]` 槽位坐标系（`absoluteRect`）——槽位在工作台右侧时 rect 天然是 `(0,1)`，
一 clamp 就被钉成 `{x:0,y:1}` → **浮动窗拖不动、右下角拉不大**。现改为宽松夹取
（`w>=minW, h>=max(minH,300), x∈[-minW+80, W-80], y∈[-40, H-40]`）。
同理 `InspectorWindow` 的 move 分支**不再**按 `bounds` clamp（`resize` 分支本来就只做 `>=min`）。
→ 若 P5 后续重写这段，请保留"宽松 clamp"语义。

## 验证（本机已跑）
- `npx tsc -b frontend` → 0 error
- `node build/harness/window-chrome.mjs` → **5/5 ok**（toolpanel/stage `.ed-win-btn`=0；分支图 `before=0 mid=1 after=0`）
- `node build/harness/workbench-drag.mjs` → 3 pass / 0 fail
- `node build/harness/p4-shell-unit.mjs` → 10 ok / 0 fail
- `node build/harness/p4-shell-probe.mjs` → 11 ok / 0 fail
