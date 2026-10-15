# 验收台账（Lead 维护；每条 = 需求 → 证据 → 结果）

| # | 需求（用户原话） | 证据（命令） | 结果 |
|---|---|---|---|
| 1 | 舞台缩放只有 100%/50% → 连续 | `node build/harness/stage-zoom.mjs` | ✅ 38/38（滚轮锚点 <0.5px、几何 px 不变、`适配`/`1:1`/百分比；`npm run test:stage` 82/82） |
| 2 | 检视器在工具面板 → 不该有「脱离」按钮；显示/隐藏 | `node build/harness/window-chrome.mjs` / `demo-check` | ✅ `toolpanel`/`stage` 的 `.ed-win-btn` = 0；`preview`/`branch` 走 Map 开关 |
| 3 | 拼接工作区 / 自由调换位置 | `node build/harness/workbench-drag.mjs`、`wb-selftest.mjs` | ✅ 62/62 模型断言；拖分隔条 → `prts-editor-wb:*` 变更；拖标题条到边缘 → 结构变化 |
| 3b | **布局可命名保存** | `node build/harness/layout-named.mjs` | ✅ 9/9：另存为 / 切换（切走前存回原布局）/ 重置（不动命名快照）/ 删除 / **刷新后仍是命名布局** |
| 4 | 分支图不能移动 / 排版难看 → dify 风 | `node build/harness/branch-shot.mjs` + `build/harness/shots/branch.png` | ✅ 59/59，`variant:"dify"`，节点矩形零重叠、层号单调；`scripts/fanfic/branchGraph-selftest.mjs` 73/73 |
| 5 | `data:text/javascript` 资源加载失败噪音 | `node build/harness/engine-failure.mjs`、`engine-failure-min.mjs` | ✅ 2/2 + 4/4：单条横幅含 `HTTP 500` + 来源；`data:`/`blob:` 标 silent；重试 2 次（1.5s/3s） |
| 6 | 不要每次爬、要缓存、素材随包 | `engine_snapshot_read`（`src-tauri/resources/engine/v1` 3.4 MB）+ `demo-check` ⑥ | ✅ pack → cache(`widget-bundle-v7`) → network；离线首启可播 |
| 7 | 设计里可换下载镜像源 | `node tools/mirror/mirror-selftest.mjs` + 设置页 | ✅ 94/94；设置「下载源」下拉 + 自定义模板；镜像仓未发布前自动回退 |
| 8 | 并发拉满 | `demo-check` ⑦、`src-tauri/src/download.rs` | ✅ 下载并发默认 12（1…32）、manifest 10、默认不限速 |

| 9 | 用户追加：「要打包素材，不希望自创剧情每次打开都要下载」 | `npm run test:starter`（17）+ `scripts/fanfic/selfcontained-check.mjs`（原生 PASSED） | ✅ 287 张 / 14.6 MB 随包（`bundle.resources`）+ 覆盖层优先 + 每启 seed |

## 汇总命令（Lead 最终跑）

```
npx tsc -b frontend                      # 0 error
npx eslint -c frontend/eslint.config.js frontend   # 0 error（1 条既有 warning）
npm run build                            # ✓ built
npm run test:editor                      # 168 + 149
npm run test:stage                       # 82
node build/harness/demo-check.mjs         # 22/22
node build/harness/stage-zoom.mjs        # 38/38
node build/harness/window-chrome.mjs     # 5/5
node build/harness/workbench-drag.mjs     # 3/3
node build/harness/branch-shot.mjs        # 59/0
node build/harness/engine-failure.mjs     # 2/2
npm run test:harness                     # 16 个 harness（scripts/harness/run.mjs）
npm run test:starter                     # 17/17
node scripts/fanfic/selfcontained-check.mjs  # 原生 WebKitGTK：PASSED（在线 8/8 + 断网 8/8 overlay）
node build/ctx/… tools/mirror/mirror-selftest.mjs   # 94/94
```

## 第三轮（编辑器重构：侧边栏 / 素材库 / 竖排工作流 / 创建剧本）

| # | 需求（用户原话） | 证据（命令） | 结果 |
|---|---|---|---|
| 13 | 「窗口里套窗口…脱离出去…为什么还要保留位置」+「引入侧边栏…快速收缩 集合窗口」 | `node build/harness/float-window.mjs`（29）、`node build/harness/_rail-check.mjs`（33） | ✅ 脱离 = 树里 `drop()` 摘叶 → **不留洞**、邻居变宽 ≥60px；rail 88px（收起 32px）+ 5 图标 + `prts-editor-rail` 记忆 |
| 14 | 「引入素材库…快速预览…可互动（可视，播放）…拖拽（编辑器=名称、舞台=当前场景）…导入…整理」 | `node scripts/fanfic/assetLibrary-selftest.mjs`（50）、`node build/harness/_asset-lib-check.mjs`、`cargo test --release --lib`（`import_pack_asset`） | 进行中（本行在 task-9 收口后改成 ✅ + 数字） |
| 15 | 「工作流改成竖的编排 从上到下 方向键可以快速切换卡片预览」 | `node scripts/fanfic/branchGraph-selftest.mjs`（103）、`node build/harness/branch-shot.mjs`（153） | ✅ 默认 **TB**；`↑/↓`（`j/k`）按 layer→x 阅读序切卡、`Home/End`、`Enter` 跳行；`[data-branch-action="direction"]` 可切 LR |
| 16 | 「优化或者重构页面布局（…blender/vscode…但不要模仿）」+「创建剧本操作」 | `node build/harness/_layout-create-check.mjs`（21）、`node scripts/fanfic/createPack-selftest.mjs`（33）、`cargo test --release --lib`（73，含 `create_library_pack` 4 条） | ✅ 工具条 `file/view/edit` 三组 + `data-editor-part="breadcrumb"` + ≤1100/≤820 响应式；`CreatePackDialog` 三套模板（Tab 缩进 / 幂等 / 归一化逐字节） |

## 需要人工（非代码）动作
- 建 `djkcyl/arkstage-mirror` 空仓 + 配 `MIRROR_TOKEN`，跑一次 `.github/workflows/publish-mirror.yml` → jsd/fastly/ghproxy 才真正可用（当前自动回退 prts）。
- 真机验证：Windows WebView2 / Android 上的 `snapshot.json`（`include_bytes!`）与 CSP。
