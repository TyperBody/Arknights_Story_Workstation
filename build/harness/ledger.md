# 验收台账（Lead 维护；每条 = 需求 → 证据 → 结果）

| # | 需求（用户原话） | 证据（命令） | 结果 |
|---|---|---|---|
| 1 | 舞台缩放只有 100%/50% → 连续 | `node build/harness/stage-zoom.mjs` | ✅ 38/38（滚轮锚点 <0.5px、几何 px 不变、`适配`/`1:1`/百分比；`npm run test:stage` 82/82） |
| 2 | 检视器在工具面板 → 不该有「脱离」按钮；显示/隐藏 | `node build/harness/window-chrome.mjs` / `demo-check` | ✅ `toolpanel`/`stage` 的 `.ed-win-btn` = 0；`preview`/`branch` 走 Map 开关 |
| 3 | 拼接工作区 / 自由调换位置 | `node build/harness/workbench-drag.mjs`、`wb-selftest.mjs` | ✅ 62/62 模型断言；拖分隔条 → `prts-editor-wb:default` 变更；拖标题条到边缘 → 结构变化 |
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
npm run test:harness                     # 15 个 harness（scripts/harness/run.mjs）
npm run test:starter                     # 17/17
node scripts/fanfic/selfcontained-check.mjs  # 原生 WebKitGTK：PASSED（在线 8/8 + 断网 8/8 overlay）
node build/ctx/… tools/mirror/mirror-selftest.mjs   # 94/94
```

## 需要人工（非代码）动作
- 建 `djkcyl/arkstage-mirror` 空仓 + 配 `MIRROR_TOKEN`，跑一次 `.github/workflows/publish-mirror.yml` → jsd/fastly/ghproxy 才真正可用（当前自动回退 prts）。
- 真机验证：Windows WebView2 / Android 上的 `snapshot.json`（`include_bytes!`）与 CSP。
