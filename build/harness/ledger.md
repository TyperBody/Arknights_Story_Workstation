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

## 第四轮（UI 皮肤 = 明日方舟风 / 三包编译 / 补丁安装器）

| # | 需求（用户原话） | 证据（命令） | 结果 |
|---|---|---|---|
| 17 | 「全面优化 ui 要明日方舟同款风格」（后续：「色调太蓝了」+ ak-ui 参考） | `node build/harness/ui-skin.mjs`（10） | ✅ `theme-arknights.{css,tokens,pages,editor}.css` 皮肤层；token 按 **ak-ui**（`--ak-surface-canvas #111315` 中性近黑、`--ak-color-advanced #f1c644` 操作金、hairline 1px + 45° 切角、`--ak-motion-*`）；旧名全量重绑 → 旧 CSS 零改动换肤；`prefers-reduced-motion` 生效 |
| 18 | 「预览对目录与可视流不会跟随方向键」+「可视流不会跟随左右方向键」+「按钮大小不统一」+「(括号)不会自动补齐」 | `_probe-focus2` / `_probe-follow` 实测 + `run.mjs editor` | ✅ ←/→/↑/↓（含 `h/j/k/l`）都翻卡片并**同帧**跟随光标+预览读数；焦点不再被 `onJumpToLine` 抢走（补 `panFocusRef` 挂载 + 下一帧收回）；`[`/`(`/`"` **成对补齐**（有选区=包住；右半重复=跳过）；按钮统一 28/34/38px 三档基线 |
| 19 | 「编译三包 全量素材和音频补丁包 主程序只 200MB 基础素材…一共起码 5–6GB」 | `build/artifacts/` 实测 | ✅ 主程序 263 MB（含 250 MB 起步素材）/ 素材补丁 2.4 GB（立绘全差分 + CG 1,476 张）/ 音频补丁 823 MB；三包合计 **3.5 GB** |
| 20 | 「补丁包是安装包的形式 安装到 arkstage 的文件夹里 如果没有 arkstage 则提示没有本体」 | `scripts/fanfic/build-patch-installer.mjs`（+ `--win`） | ✅ `.run`（Linux/macOS 自解压：`--data-root`→`PRTS_DATA_DIR`→`config.json`→`~/.local/share`→exe 同级；**找不到 → exit 2**）。NSIS `.exe`（注册表→LOCALAPPDATA→Program Files→同级；**找不到 → MessageBox + Abort**；`SetOverwrite off`）；**>2 GiB 自动分卷**（NSIS 32 位偏移） |

## 需要人工（非代码）动作
- 建 `djkcyl/arkstage-mirror` 空仓 + 配 `MIRROR_TOKEN`，跑一次 `.github/workflows/publish-mirror.yml` → jsd/fastly/ghproxy 才真正可用（当前自动回退 prts）。
- 真机验证：Windows WebView2 / Android 上的 `snapshot.json`（`include_bytes!`）与 CSP。
