// 预览 / 播放的**舞台比例**：铺满容器（cover）+ 不拉伸。
//   node build/harness/stage-aspect.mjs     # 纯静态断言（读注入 CSS + installStageFit）
//   断言（原生/浏览器手测补充）：容器 21:9 → canvas 仍是 16:9、且**覆盖**容器。
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const boot = readFileSync("frontend/src/lib/storyPlayerBoot.ts", "utf8");
const flat = boot.replace(/\s+/g, "");

t("不再把 section 拉成任意比例（aspect-ratio:auto 有 cover 兜底）",
  /story-player>section\{[^}]*aspect-ratio:auto!important/.test(flat) && /installStageFit/.test(boot));
t("覆盖算法 = cover（max，取大 → 铺满 + 裁切）",
  /Math\.max\(w\s*\/\s*STAGE_W,\s*h\s*\/\s*STAGE_H\)/.test(boot),
  (boot.match(/const scale = [^\n]*/) ?? ["-"])[0].slice(0, 60));
t("基准分辨率 = 引擎的 1280×720",
  /const STAGE_W = 1280;/.test(boot) && /const STAGE_H = 720;/.test(boot));
t("canvas 尺寸由 --ark-stage-w/h 驱动（!important 压过引擎内联 100%）",
  /--ark-stage-w,100%\)!important/.test(flat) && /--ark-stage-h,100%\)!important/.test(flat));
t("canvas 居中 + 裁切（overflow:hidden 在 section）",
  /left:50%!important/.test(flat) && /translate\(-50%,-50%\)!important/.test(flat) && /story-player>section\{[^}]*overflow:hidden/.test(flat));
t("跟随尺寸变化（ResizeObserver + window.resize + MutationObserver 兜异步挂载）",
  /ResizeObserver/.test(boot) && /addEventListener\("resize",\s*apply\)/.test(boot.replace(/\s+/g, "")) && /MutationObserver/.test(boot));
t("播放器底栏三档不变（show/hide 的 CSS 仍在）",
  /ark-chrome-hide[\s\S]{0,120}display:none/.test(flat));
t("悬停显示是**开关**（默认永久隐藏）",
  /PLAYER_CHROME_HOVER_KEY/.test(readFileSync("frontend/src/lib/uiSettings.ts", "utf8"))
  && /isPlayerChromeHover\(\)/.test(boot)
  && /html\.ark-chrome-auto\.ark-chrome-hover\.ark-chrome-open/.test(flat),
  "CSS 展开态要求 .ark-chrome-hover");
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
