# 验收台账（Lead 维护；每条 = 需求 → 证据）

| # | 需求（用户原话） | 证据（命令 / 文件） | 状态 |
|---|---|---|---|
| 1 | 舞台缩放只有 100/50 → 连续 | `node build/harness/stage-zoom.mjs` | 进行中（P2） |
| 2 | 检视器在工具面板，不该有「脱离」按钮；是显示/隐藏不是独立窗口 | `node build/harness/window-chrome.mjs`（`[data-wb-panel=toolpanel] .ed-win-btn`=0） | 待 P4+P5 |
| 3 | 能拼接工作区、自由调换位置 | `node build/harness/wb-selftest.mjs`（62 ok）+ `workbench-drag.mjs` | 模型完成，待接线 |
| 4 | 分支图不能移动、排版难看 → dify 风 | `node build/harness/branch-shot.mjs` + `shots/branch.png` | 待 T6 落盘 |
| 5 | data: URL 资源加载失败噪音 | `node build/harness/engine-failure.mjs`（横幅 + HTTP 状态） | 待 P6 |
| 6 | 别每次爬、要缓存、素材随包 | `engine_snapshot_read` + pack→cache→network | 快照已落盘（3.4 MB），待接线 |
| 7 | 换下载镜像源 | `node tools/mirror/mirror-selftest.mjs` + 设置页 | 进行中（P1） |
| 8 | 并发拉满 | `download::DEFAULT_CONCURRENCY` + 设置滑杆 | 待 P6/P1 |

## 已知集成风险
- `frontend/src/pages/StoryEditorPage.tsx` 由 P5 独占改写；TS 目前有该文件的 4 个 unused import + `readWindowState` 未定义（P5 正在做）。
- `stageZoom.ts` 有 4 个未定义符号（P2 正在做）：`originOf/snapZoom/viewScale/interpolate/indexOf`。
- `src/akstage/local/branchGraph.js.head` 是 T6 的中间备份，最后由 Lead 决定删或留。
- `frontend/src/lib/stageCatalog.ts` 的 `./stageModel` 路径已由 Lead 修正为 `../components/editor/stageModel`。
