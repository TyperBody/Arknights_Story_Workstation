# BACKLOG — 用户后续可见、但本轮未做的项

## 1. 「检视器」Dialog 太小 / 锁死 / 大多数字段无法修改（用户 2026-10-11 追加）
用户原话：「Dialog太小 锁死 大多数无法修改 … 我指的是哪个检视器 你暂时不用管这个」（**暂缓**）。

现状（Lead 已定位，未改）
- 「检视器」= 工具面板顶部的 `ControllerInspector`（`frontend/src/components/editor/ControllerInspector.tsx`），
  页面里写死 `height={190}`（`StoryEditorPage.tsx` 的 `<ControllerInspectorPart height={190} />`），
  所以表单区可见高度固定、字段多时只能在里面滚 → 观感"太小/锁死"。
- "无法修改"的候选原因（尚未复现确认，按可能性排序）：
  1. `editorForms.js` 里 `engineRead:false` 的键被**禁用**（灰掉 + 说明）——这是**有意**的（引擎不读），
     但 UI 上"灰掉"没有统一的解释入口；
  2. 本行**没有**对应控制器（空行 / 注释行）→ 表单为空；
  3. 行内值解析失败（`parseValues` 返回 null）→ 控件回落到"（未设置）"。
- 计划（下一轮做）：① 「检视器」高度可拖（复用 `[data-wb-gutter]` 的会话式拖拽，或在工具面板内加一条
  横向分隔条）；② 顶部固定一行「本行：`[Command(…)]`（第 N 行）+ 可读的禁用原因」；
  ③ 给 `engineRead:false` 的字段加统一 tooltip（"引擎不读这个键，改了不起作用"）；
  ④ `data-inspector-*` 锚点 + `build/harness/inspector-form.mjs`。

## 2. 已完成（原 backlog 第 1 项之外的补充）
- ✅ 命名布局：工具栏 `[data-layout-bar]`（另存为 / 切换 / 重置 / 删除）+ `layout-named.mjs` 9 断言。
- ✅ 播放器底栏默认 `auto`（纯隐藏，指针命中即显示）+ `player-chrome.mjs` 10 断言、并发默认 30。

## 3. 其它
- 镜像仓 `djkcyl/arkstage-mirror` 仍是空的（需人工建仓 + `MIRROR_TOKEN` + 跑 publish-mirror）。
- Windows/Android 真机未验（本机只有 Linux + WebKitGTK）。
- `state: BranchGraph` 的一条 eslint warning（`react-hooks/exhaustive-deps`，`current`/`deps`）——非错误，留待顺手清理。
