# 验收 harness 一览（无头、可独立跑）

> 每个 harness 都有两个等价入口：`node scripts/harness/<name>.mjs`（推荐，随源码走）
> 与 `node build/harness/<name>.mjs`（真身；`build/` 是中间产物目录）。**自带断言、自带退出码、可单独跑**。
> 本机**记忆**存 `state.db`（SQLite，`<资源目录>/`）：原生层回归 `build/harness/state-db.mjs`
> （真 Tauri 启动 → 日志 `[state] sqlite ready` → 库落资源目录 → 重启仍在；`--unit` 只跑纯断言）。
> 断言有效性自检：`build/harness/preview-bar-regress-check.mjs`（人为恢复旧样式 → bar 42px → 319px，
> 证明 `preview-bar-oneline.mjs` 不是空跑；只做一次性验证，不在 runner 里）。
> 一条命令跑全套：`npm run test:harness`（= `node scripts/harness/run.mjs`；`--list` 看清单，
> 也可只跑某组：`… run.mjs shell assets` / 某项：`… run.mjs branch-shot`）。
> 浏览器段需要 dev server：`( nohup npm run dev > /tmp/arkstage-vite.log 2>&1 & )`（:5174）。

## 需求 → harness 映射

| # | 需求 | harness | 组 |
|---|---|---|---|
| 全 | 8 条需求合流（编辑页/舞台/工作台/分支图/横幅/快照/设置） | `demo-check.mjs`（22） | workbench |
| — | 布局「记得住」 | `persist-check.mjs`（3） | workbench |
| ① | 舞台缩放连续（几何 px 不变、滚轮锚点 <0.5px） | `stage-zoom.mjs`（38） | workbench |
| ② | toolpanel/stage 无 ⧉✕；preview/branch = Map | `window-chrome.mjs`（5） | workbench |
| ③ | 拼接/换位/调尺寸 + 落盘 | `workbench-drag.mjs`（3）、`wb-selftest.mjs`（62） | workbench |
| ③ | **命名布局**（另存为 / 切换 / 重置 / 删除 / 刷新保持） | `layout-named.mjs`（9） | workbench |
| ③ | **排版落 SQLite**（hydrate 先于首帧 → 拖 → 刷新仍在；旧 localStorage 一次性迁移） | `state-db-frontend.mjs`（7） | workbench |
| ④ | dify 风 DAG（零重叠/分层/适配）+ 截图 | `branch-shot.mjs`（59）、`t6-visual-check.mjs` | branch |
| ⑤ | 单条横幅（URL+HTTP 状态）+ 不白屏 | `engine-failure.mjs`（2）、`engine-failure-min.mjs`（4） | engine |
| ⑥ | 随包起步素材集（287 张/14.6 MB） | `starter-assets.mjs`（17；`--native` 18） | assets |
| ⑦ | 下载源真正生效（Rust 源链 + 镜像 URL 形状 + 设置推送） | `rust-mirror-live.mjs`（13）、`live-download.mjs`（3） | assets |
| — | 窗口壳（折叠/⧉/拖动/缩放/✕） | `p4-shell-unit.mjs`（10）、`p4-shell-probe.mjs`（11） | shell |
| — | 播放器底栏三档（`auto` = 默认**永久隐藏**；「悬停显示」是设置里的独立开关） | `player-chrome.mjs`（10）、`stage-aspect.mjs`（含开关断言） | player |
| ② | **预览条恒单行**（面板拖窄 / 状态里带 `\n` 的多行 loader 报错都不把 bar 撑高） | `preview-bar-oneline.mjs`（6） | shell |
| ② | **预览填满壳 + 放大/还原**（槽位/浮动窗不留白；「放大」= `.full` 整页覆盖层，可退） | `preview-fill-probe.mjs`（4） | shell |
| ⑨ | **舞台比例 = cover**（铺满 + 裁切，绝不拉伸） | `stage-aspect.mjs`（8）、`stage-fit.mjs`（7） | shell |
| ⑩ | **编辑器键位 = VSCode**（Tab 插 `\t`、Enter 自动缩进、Backspace 跳 tab stop）+ 脚本文本**语法着色层**与 textarea 逐像素对齐（`tab-size: 8`、Tab 宽 = 8 字符格、行 top 误差 0px、光标像素误差 ≤ 1px、DOM span ↔ 内核 `tokenizeLine` 逐 span 对拍） | `_editor-tab-hl-check.mjs`（28） | editor |
| — | 原生 WebKitGTK：断网复用 + 覆盖层命中 + 起步素材集 seed | `native-source-probe.mjs`、`scripts/fanfic/selfcontained-check.mjs`（需 Xvfb） | 手动 |

`npm run test:harness` 当前 = **20 个 harness**（workbench 8 / branch 1 / engine 2 / assets 3 / shell 6 / player 1）。

配套（不在本 runner 内，属产品自测）：`npm run test:editor|test:stage|test:mirror|test:selfcontained`、`cargo test --release --lib`。

## 「写后即用 / 写坏不崩」的调度规则

1. **写后即用**：harness 只依赖 DOM 契约（`[data-workbench]`、`[data-wb-panel]`、`[data-stage-*]`、
   `[data-branch-*]`、`[data-asset-banner]`、`[data-wb-gutter]`）——新功能**只增标记**，旧 harness 立刻能跑。
2. **写坏不崩**：可选组件用 `optionalPart()`（`import.meta.glob`）懒加载；缺文件 → 渲染占位行，
   页面不白屏；`Workbench` 的布局解析坏 JSON → 回落 `defaultState()`；`stageZoom`/`branchGraph` 纯函数对
   坏输入返回默认值并**不抛**（harness 里有 garbage 用例）。
3. **失败必可定位**：断言失败打印 `label — detail`（带测量值/计数），exit code ≠ 0；runner 汇总每组的
   `n/m`，并把失败项的**最后 14 行**贴出来。
4. **抖动处理**：`scripts/harness/run.mjs` 对**浏览器** harness 失败会**重试一次**（同机连跑时
   偶发 GPU stall / zygote 竞争）；日志里会打 `(retry×1)`。**两次都失败才算失败**。
   各 harness 自己也等懒加载部件（`[data-wb-panel]` / `[data-stage-svg]`）而不是固定 `sleep`。
5. **顺序**：`tsc -b` + `eslint` → 产品自测（`test:editor/stage/mirror/starter/selfcontained`）→
   `cargo test` → `npm run test:harness`（浏览器段）→ 收口提交。
