// 舞台 cover 的**行为**回归（真 chromium）：给出任意比例的容器，画面的比例必须是 16:9，
// 且**覆盖**容器（cover：两边都不小于容器 → 多余部分裁掉、绝不拉伸）。
//   node build/harness/stage-fit.mjs      # 需要 dev server:5174
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  await p.goto(`${DEV}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await p.waitForTimeout(800);

  /** 在页面里搭一个"假播放器"：`.story-player > section` + 引擎风格的 canvas，
   *  注入与生产**同一份** CSS，然后调生产代码 `installStageFit`。 */
  const measure = (w, h) => p.evaluate(async ([w, h]) => {
    const { installStageFit } = await import("/src/lib/storyPlayerBoot.ts");
    document.querySelector("#fixture")?.remove();
    const root = document.createElement("div");
    root.id = "fixture";
    root.innerHTML = `<style>
      #fixture{position:fixed;left:0;top:0;z-index:9}
      #fixture .story-player{height:${h}px;width:${w}px;display:flex;flex-direction:column}
      #fixture .story-player>section{position:relative;overflow:hidden;flex:1;min-height:0}
      #fixture .story-player>section canvas,#fixture .story-player>section video{position:absolute!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;width:var(--ark-stage-w,100%)!important;height:var(--ark-stage-h,100%)!important;display:block}
    </style><div class="story-player"><section>
      <div class="bg-black absolute inset-0"><div class="h-full w-full"><!-- canvas 在这里 --></div></div>
    </section></div>`;
    document.body.appendChild(root);
    const section = root.querySelector("section");
    const canvas = document.createElement("canvas");
    // 引擎 mount()：canvas 挂进 `hostRef` div（**不是** section 直接子节点），
    // 并且带 `width:100%;height:100%` 内联样式（必须被压过）。
    canvas.width = 1280; canvas.height = 720;
    canvas.style.width = "100%"; canvas.style.height = "100%";
    section.querySelector(".h-full.w-full").appendChild(canvas);
    installStageFit(window, document);
    const cr = canvas.getBoundingClientRect();
    const sr = section.getBoundingClientRect();
    return { cw: Math.round(cr.width), ch: Math.round(cr.height), sw: Math.round(sr.width), sh: Math.round(sr.height) };
  }, [w, h]);

  for (const [w, h, label] of [[800, 200, "21:9 扁槽"], [400, 600, "竖容器"], [960, 540, "正好 16:9"]]) {
    const m = await measure(w, h);
    const ratio = m.cw / m.ch;
    t(`${label}（${w}×${h}）：画面比例仍是 16:9`, Math.abs(ratio - 16 / 9) < 0.02, `${m.cw}×${m.ch} = ${ratio.toFixed(3)}`);
    t(`${label}：cover（两边都不小于容器 → 铺满 + 裁切）`, m.cw >= m.sw - 1 && m.ch >= m.sh - 1, `canvas ${m.cw}×${m.ch} ⊇ section ${m.sw}×${m.sh}`);
  }
  // 尺寸变化后跟着更新
  const before = await measure(800, 200);
  await p.evaluate(() => { const f = document.querySelector("#fixture .story-player"); f.style.width = "300px"; f.style.height = "700px"; window.dispatchEvent(new Event("resize")); });
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => { const c = document.querySelector("#fixture canvas").getBoundingClientRect(); return { cw: Math.round(c.width), ch: Math.round(c.height) }; });
  t("容器变化后重新 cover", after.ch !== before.ch && Math.abs(after.cw / after.ch - 16 / 9) < 0.02, `${before.cw}×${before.ch} → ${after.cw}×${after.ch}`);

  // 引擎在 dpr 变化时会**自己**重写 canvas 内联尺寸 → 我们必须在 DOM 变动后再压一次。
  const afterRewrite = await p.evaluate(async () => {
    const canvas = document.querySelector("#fixture canvas");
    canvas.style.width = "100%"; canvas.style.height = "100%";
    await new Promise((r) => setTimeout(r, 120));
    const r = canvas.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  t("引擎重写 canvas 内联尺寸后仍保持 16:9 cover",
    Math.abs(afterRewrite.w / afterRewrite.h - 16 / 9) < 0.02 && afterRewrite.w > 100,
    `${afterRewrite.w}×${afterRewrite.h}`);
} finally {
  await b.close();
}
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
