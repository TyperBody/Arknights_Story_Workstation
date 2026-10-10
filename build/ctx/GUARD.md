# GUARD — 避免 Lead / 队友暴毙

1. **内存**：本机 8 GB，7 个 agent + WebKit + vite。**同时最多跑 1 个 headless chromium**；
   harness 里 `browser.close()` 必须在 `finally`；长等待用 60–120s 超时，别 30s 死等。
2. **别并行跑 `npx tsc -b frontend` ×N**（各自 300–500 MB）；Lead 在收口时统一跑。
   队友自查可用 `npx tsc --noEmit -p frontend/tsconfig.app.json` 单跑一次。
3. **dev server** 只有一份（端口 5174，`npm run dev` 已在跑）；**不要**再起第二个 vite。
4. `cargo` 构建（P6）单独跑，别与 chromium harness 同时。
5. 每完成一小步就 `git add -f && git commit`，避免工作丢失；
   `build/` 被 gitignore → 契约/笔记/harness 用 `-f`。
6. 若 `npx tsc` 报的不是你的文件：**先看 `git status`**，不要顺手改别人的文件；把错误写进你的 NOTES 并发给 lead。
7. 上下文将满时分三段推进：①纯逻辑+单测 ②UI 接线 ③harness；每段结束都 commit。
