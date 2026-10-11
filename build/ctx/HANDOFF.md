# HANDOFF — 「演出工作台 / 引擎快照 / 素材镜像」v1（Lead 收口）

日期 2026-10-11；分支 `master`。契约原文：`build/ctx/BRIEF-workbench-v1.md`；
分工：`build/ctx/PLAN.md`；逐条验收：`build/harness/ledger.md`；架构：`docs/dev/workbench.md`。

## 用户 8 条 → 结论

| # | 用户原话 | 结果 |
|---|---|---|
| 1 | 舞台缩放只有 100%/50% | ✅ `stageZoom.ts` 连续缩放（0.25…2，滚轮以指针为锚 + `−＋/适配/1:1/百分比`），只改 `viewBox` |
| 2 | 检视器在工具面板 → 不该有「脱离」按钮；是显示/隐藏 | ✅ `toolpanel`/`stage` 常驻 dock（`.ed-win-btn` = 0）；「检视器」= 面板内折叠区；`preview`/`branch` = Map | 
| 3 | 不能拼接工作区 / 自由调换位置 | ✅ `Workbench` + `workbenchStack`（拖边缘分屏、中心换位、分隔条调尺寸）；**命名布局**可另存为/切换/重置/删除，刷新保持 |
| 4 | 分支图不能移动 / 排版难看 | ✅ dify 风 DAG（`layoutGraph` 分层 + 正交折线 + 零重叠 + `⤢ 适配` + 平移缩放） |
| 5 | `data:text/javascript` 资源加载失败噪音 | ✅ `pack→cache→网络` + 2 次退避重试 + **单条**人话横幅（URL + HTTP 状态）；`data:`/`blob:` 静默 |
| 6 | 不要每次爬 / 要缓存 / 素材随包 | ✅ 随包 `resources/engine/v1` 3.4 MB（`include_bytes!`）+ 磁盘 cache（`widget-bundle-v7`）+ **随包起步素材集 287 张 / 14.6 MB**（core 7 + 背景 120 + 立绘 160，按剧情语料频次策展；`bundle.resources`）→ 自创剧情**不再每次联网** |
| 7 | 设计里能换下载镜像源 | ✅ 设置 →「下载源」（pack/prts/jsd/fastly/ghproxy/custom）；**Rust 侧真正生效**（`media::source_chain`：首选源→custom→官方→其余镜像→prts，首个 2xx；下载器与 `prts-cdn://` 都走；落盘仍按 canonical key） |
| 8 | 并发拉满 | ✅ 下载 12（1…32）、manifest 10、默认不限速 |

## 验证（Lead 实跑）

```
npx tsc -b frontend                 # 0 error
npx eslint -c frontend/eslint.config.js frontend   # 0 error（1 warning: BranchGraph 的 current/deps）
npm run build                       # ✓ built
npm run test:editor                 # 168 + 149
npm run test:stage                  # 82
npm run test:mirror                 # 121/121 + rust-mirror-live 13 + live-download 3
npm run test:starter                # 17/17（`--native` 追加真 WebKitGTK seed 断言 → 18）
npm run test:harness                # 18 个 harness 全绿（scripts/harness/run.mjs；见 docs/dev/harness.md）
                                    # ＋预览修复：preview-bar-oneline（单行）/ preview-fill-probe（填满壳 + 放大）
node scripts/fanfic/fetch-starter-assets.mjs --check   # 287 张 / 15,301,040 B / problems=[]
npm run test:workbench             # demo-check 22/22 · stage-zoom 38 · window-chrome 5/5 · workbench-drag 3/3 · branch-shot 59 · engine-failure 2/2
npm run test:workbench:model       # 62/62
node scripts/fanfic/branchGraph-selftest.mjs  # 73/73
node scripts/fanfic/selfcontained-check.mjs   # 原生 WebKitGTK：PASSED（在线 + 断网，0 加载失败）
cargo check --release --features custom-protocol   # ✓（7m51s）
cargo test --release --lib                        # 66 passed（mirror 模板 ⇄ JS 逐字节 + starter 覆盖层 5 条）
```

## 人工（非代码）

1. 建 `djkcyl/arkstage-mirror`（空仓 + README）→ 配 `MIRROR_TOKEN`（contents:write）→ 跑一次
   `.github/workflows/publish-mirror.yml`（引擎层 25 条 / ~17.6 MB）。客户端 URL 已按
   `mirror/prts/<host>/<path>` 对齐（`assetRouting.js::MIRROR_PREFIX` ⇄ `mirrorPath.mjs::MIRROR_PREFIX`）。
2. Windows WebView2 / Android 真机：验证 `snapshot.json`（`include_bytes!`）与 CSP；两处 `tsconfig`/包体未在 Linux 覆盖。**Android 打包路径尚未包含 `resources/assets/starter`**（APK 由 `gen/android` 走另一套 asset 打包）。
3. `build/toolchain/env.sh` 的 `CARGO_TARGET_DIR` 花括号 bug 已修（曾把 `:-` 变成路径）。
4. 安装包体：deb 基线 ≈20 MB + starter 14.6 MB ≈ **35 MB**；`--budget` 可调、还能再塞 ~10 MB。
5. 换源后行为：下载器/协议**立即**按新源试（正在跑的任务也生效）；镜像仓为空 → 自动回落官方，日志 `source=… key=…`；`mirror_probe_url`/`mirror_probe_chain`/`system_counts` 可自查命中计数。
