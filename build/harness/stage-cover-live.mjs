// 真页面 E2E：**引擎真实 DOM 层级**（.story-player > section > div > div > canvas）下，
// 任意比例的容器里画面都必须是 16:9 且 cover（铺满 + 裁切）。用 dev server 现编现发的
// `installStageFit` + 同一份注入 CSS，等于把“预览扭曲”钉在回归里。
//   node build/harness/stage-cover-live.mjs     # 需要 dev server:5174
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";

/** 从生产源码里抽**真正注入**的那条舞台规则（不手抄，防止两边漂移）。 */
function stageRuleFromSource() {
  const src = readFileSync("frontend/src/lib/storyPlayerBoot.ts", "utf8");
  const line = src.split("\n").find((l) => l.includes(".story-player>section canvas"));
  if (!line) throw new Error("源码里找不到舞台规则（storyPlayerBoot.ts 的 layout CSS）");
  return line.trim();
}
const STAGE_RULE = stageRuleFromSource();
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  await p.goto(`${DEV}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await p.waitForTimeout(800);

  /** 复刻引擎 DOM（`index.vue` 的 render）：section > div.bg-black > div[hostRef] > canvas。 */
  await p.evaluate((rule) => { window.__stageRule = rule; }, STAGE_RULE);
  const measure = (w, h) => p.evaluate(async ([w, h]) => {
    const { installStageFit } = await import("/src/lib/storyPlayerBoot.ts");
    document.querySelector("#cover-fx")?.remove();
    const fx = document.createElement("div");
    fx.id = "cover-fx";
    fx.style.cssText = `position:fixed;left:0;top:0;z-index:9;background:#000;width:${w}px;height:${h}px`;
    // 真实层级：.story-player(100% 高、flex 列) > section(flex:1) > div.bg-black > div[hostRef] > canvas
    fx.innerHTML = `<div class="story-player" style="height:100%;display:flex;flex-direction:column">
        <section style="flex:1;min-height:0;position:relative;overflow:hidden">
          <div class="bg-black" style="position:absolute;inset:0"><div class="h-full w-full"></div></div>
        </section>
      </div>`;
    document.body.appendChild(fx);
    const section = fx.querySelector("section");
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    canvas.style.width = "100%"; canvas.style.height = "100%"; // 引擎 mount() 的内联样式
    section.querySelector(".h-full.w-full").appendChild(canvas);
    installStageFit(window, document);
    // 注入**生产源码里那条** CSS（由 Node 侧抽出来传进来，逐字节一致）
    const style = document.createElement("style");
    style.textContent = window.__stageRule;
    document.head.appendChild(style);
    const r = canvas.getBoundingClientRect(); const s = section.getBoundingClientRect();
    return { cw: Math.round(r.width), ch: Math.round(r.height), sw: Math.round(s.width), sh: Math.round(s.height) };
  }, [w, h]);

  console.log(`（注入的舞台规则取自源码：${STAGE_RULE.slice(0, 78)}…）`);
  for (const [w, h, label] of [[745, 300, "编辑器预览槽 2.48:1"], [520, 620, "竖排浮动窗"], [960, 540, "正好 16:9"]]) {
    const m = await measure(w, h);
    t(`${label}：画面恒 16:9`, Math.abs(m.cw / m.ch - 16 / 9) < 0.02, `${m.cw}×${m.ch} = ${(m.cw / m.ch).toFixed(3)}`);
    t(`${label}：cover 铺满（⊇ 容器）`, m.cw >= m.sw - 1 && m.ch >= m.sh - 1, `canvas ${m.cw}×${m.ch} ⊇ section ${m.sw}×${m.sh}`);
  }

  // 引擎在 dpr 变化时**自己**重写 canvas 内联尺寸 → 必须仍被压住
  const rewrite = await p.evaluate(async () => {
    const canvas = document.querySelector("#cover-fx canvas");
    canvas.style.width = "100%"; canvas.style.height = "100%";
    await new Promise((r) => setTimeout(r, 150));
    const r = canvas.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  t("引擎重写内联尺寸后仍 16:9", Math.abs(rewrite.w / rewrite.h - 16 / 9) < 0.02, `${rewrite.w}×${rewrite.h}`);

  // 容器变大 → 跟着变（ResizeObserver / resize）
  await p.evaluate(() => { const fx = document.querySelector("#cover-fx"); fx.style.width = "1100px"; fx.style.height = "520px"; window.dispatchEvent(new Event("resize")); });
  await p.waitForTimeout(300);
  const grown = await p.evaluate(() => { const r = document.querySelector("#cover-fx canvas").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  t("容器变化后重新 cover", Math.abs(grown.w / grown.h - 16 / 9) < 0.02 && grown.w > rewrite.w - 1, `${rewrite.w}×${rewrite.h} → ${grown.w}×${grown.h}`);
} finally {
  await b.close();
}
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
