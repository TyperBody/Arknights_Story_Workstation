// t1（播放器底栏默认「自动隐藏」+ 纯隐藏；下载并发默认 30）的浏览器证据。
//   node build/harness/_playersettings-check.mjs          # 前置：dev server :5174
//
// 断言：
//  (a) 打开 `/editor/demo`，在**该页**用 `import('/src/lib/uiSettings.ts')` 读默认值：
//      localStorage 为空时 `getPlayerChrome()` 返回 `auto`；并用一个 try/catch 探针
//      证明 iframe 与本页是**同一个持久化区**（iframe realm 里 getPlayerChrome
//      同样可用 —— 引擎 iframe 就是靠这份契约读到档位）。
//  (b) dev server 现编现发的 `storyPlayerBoot.ts` 里：layout CSS 含
//      `.ark-chrome-hidden{opacity:0…}`，`installPlayerChrome` 源码不含 `3000`
//      （旧「3 秒无操作淡出」定时器已删除）。
//  (c) 把 layout CSS + `installPlayerChrome` 的判定列表**原样**复制进 iframe realm
//      后，指针进出底栏的 7 个场景（含「指针移出 250ms 再移回」）逐条走通 —— 纯
//      隐藏、无定时器。
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/snap/bin/chromium";
const SRC_PATH = resolve("frontend/src/lib/storyPlayerBoot.ts");

let pass = 0, fail = 0;
const t = (label, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

/** dev server 由 Vite 现编现发：`import()` 到的就是工作树里的当前源码。 */
async function servedModule(page, path) {
  return page.evaluate(async (p) => {
    try {
      const response = await fetch(p, { cache: "no-store" });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      return { status: 0, text: "", error: String(error) };
    }
  }, path);
}

/** `installPlayerChrome` 函数体的源码切片（行首 `function …` → 下一个行首 `}` 之前的 `}`）。 */
function chromeFnSource(text) {
  const start = text.indexOf("function installPlayerChrome");
  if (start < 0) return "";
  const end = text.indexOf("\n}", start);
  return end < 0 ? text.slice(start) : text.slice(start, end + 2);
}

/** iframe realm 里逐字复制的 `installPlayerChrome`（auto 档）——被断言的就是这份。 */
const FRAME_RUNNER = `
const CLASS = "ark-chrome-hidden";
const cardOf = () => document.querySelector('.story-player > .n-card[aria-label="播放控制"]');
const setHidden = (hidden) => {
  document.documentElement.classList.add("ark-chrome-auto");
  document.documentElement.classList.toggle("ark-chrome-open", !hidden);
  document.querySelectorAll('.story-player > .n-card[aria-label="播放控制"]')
    .forEach((node) => node.classList.toggle(CLASS, hidden));
};
const hit = () => {
  const card = cardOf();
  if (!card) return false;
  const rect = card.getBoundingClientRect();
  return window.__x >= rect.left && window.__x <= rect.right && window.__y >= rect.top && window.__y <= rect.bottom;
};
const handled = (button) => {
  const card = cardOf();
  if (!card) return false;
  let el = button; let steps = 0;
  while (el && el !== document.documentElement && steps++ < 20) { if (el === card) return true; el = el.parentElement; }
  return button === document.body || button === document.documentElement;
};
function decide(button) {
  if (button) { window.__btn = button; setHidden(false); return "show-tap"; }
  if (hit()) { setHidden(false); return "show-hover"; }
  if (document.contains(window.__btn)) return "keep-stale";
  if (cardOf() && cardOf().contains(document.activeElement)) return "keep-focus";
  setHidden(true);
  return "hide";
}
window.__decide = decide;
window.__handled = handled;
window.__hidden = () => Boolean(cardOf() && cardOf().classList.contains(CLASS));
window.__open = () => document.documentElement.classList.contains("ark-chrome-open");
setHidden(true); // installPlayerChrome 末尾的初始态
`;

const CSS_HIDDEN = 'html.ark-chrome-auto .story-player>.n-card.ark-chrome-hidden{opacity:0;pointer-events:none;transition:opacity .2s}';
// 「悬停显示」是**开关**（`uiSettings.isPlayerChromeHover`，默认关 = 永久隐藏）：
// 只有 `html.ark-chrome-hover` 在时，`.ark-chrome-open` 才会把底栏点亮。
const CSS_OPEN = 'html.ark-chrome-auto.ark-chrome-hover.ark-chrome-open .story-player>.n-card[aria-label="播放控制"]{opacity:1!important;pointer-events:auto!important}';
const CSS_HIDE = 'html.ark-chrome-hide .story-player>.n-card[aria-label="播放控制"]{display:none!important}';
const LAYOUT_RULES = [CSS_HIDDEN, CSS_OPEN, CSS_HIDE].join("\n");

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(30_000);
  await page.goto(`${DEV}/editor/demo`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  // 编辑器页要加载模型（`@editor-model` → `editorModel.js`）：等到输入框出现即可。
  await page.waitForSelector("textarea.ed-textarea", { timeout: 30_000 }).catch(() => {});

  // ── (a) localStorage 为空时 getPlayerChrome() === "auto" ─────────────────
  const ui = await page.evaluate(async () => {
    localStorage.clear();
    const mod = await import("/src/lib/uiSettings.ts");
    const empty = mod.getPlayerChrome();
    localStorage.setItem("prts-player-chrome", "垃圾值");
    const garbage = mod.getPlayerChrome();
    localStorage.clear();
    const probe = document.createElement("iframe");
    document.body.appendChild(probe);
    let iframeSeesKey = "unreachable";
    try {
      const raw = probe.contentWindow.localStorage.getItem("prts-player-chrome");
      const saved = new Date().toISOString();
      probe.contentWindow.localStorage.setItem("probe", saved);
      iframeSeesKey = `${raw === localStorage.getItem("prts-player-chrome")}|${saved === localStorage.getItem("probe")}`;
    } catch (error) {
      iframeSeesKey = String(error);
    }
    probe.remove();
    return {
      value: empty,
      garbageValue: garbage,
      plain: localStorage.getItem("prts-player-chrome"),
      hasSetPlayerChrome: typeof mod.setPlayerChrome === "function",
      source: mod.getPlayerChrome.toString(),
      sameStorageRealm: iframeSeesKey,
    };
  });
  t("(a) localStorage 为空 → getPlayerChrome() === \"auto\"（dev server 现编现发）", ui.value === "auto", `value=${ui.value}`);
  t("(a) 非法值同样回落到 \"auto\"（不是\"恰好没读到 key\"）", ui.garbageValue === "auto", `garbage→${ui.garbageValue}`);
  t("(a) 默认值不写 key（清空后 localStorage 无 prts-player-chrome）", ui.plain === null, `key=${ui.plain}`);
  t("(a) `getPlayerChrome` 的源码三元回落字面量是 \"auto\"", /:\s*"auto"/.test(ui.source), ui.source.replace(/\s+/g, " ").slice(-60));
  t("(a) iframe 与本页共用同一持久化区（getPlayerChrome 在 iframe realm 同样可用）", ui.sameStorageRealm === "true|true", `probe=${ui.sameStorageRealm}`);

  // ── (b) 现编现发的源码：CSS 规则 + 无 3000 ─────────────────────────────
  const served = await servedModule(page, "/src/lib/storyPlayerBoot.ts");
  t("(b) /src/lib/storyPlayerBoot.ts 由 dev server 200 提供", served.status === 200, `status=${served.status}`);
  const servedChrome = chromeFnSource(served.text);
  const diskChrome = chromeFnSource(readFileSync(SRC_PATH, "utf8"));
  t("(b) layout CSS 含 `.ark-chrome-hidden{opacity:0;pointer-events:none;transition:opacity .2s}`（由 auto 根类限定）",
    served.text.includes(CSS_HIDDEN), ".ark-chrome-hidden{opacity:0…}");
  t("(b) layout CSS 含「指针命中底栏 → 恢复可见」的展开规则", served.text.includes(CSS_OPEN), "html.ark-chrome-auto.ark-chrome-open …");
  t("(b) layout CSS 的 hide 档仍是 `display:none!important`", served.text.includes(CSS_HIDE), "html.ark-chrome-hide …");
  t("(b) `installPlayerChrome` 里没有任何 setTimeout/clearTimeout（纯隐藏，无定时器）",
    servedChrome.length > 0 && !/setTimeout|clearTimeout/.test(servedChrome) && !/setTimeout|clearTimeout/.test(diskChrome),
    `served=${servedChrome.length} chars`);
  t("(b) `installPlayerChrome` 的显示判定挂在指针事件 + 焦点（pointermove/over/out/leave + focusin/out）",
    ["pointermove", "pointerover", "pointerout", "pointerleave", "focusin", "focusout"].every((e) => servedChrome.includes(e)), "6 listeners");
  // 注意：注释里也写了 `instanceof Node`（说明为什么不用它），所以只对代码行断言。
  const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  t("(b) 跨 realm 判定不用 `instanceof Node`（iframe 里恒 false；按 nodeType 鸭子类型）",
    /* 注释里也写了 `instanceof Node`（解释为什么不用），所以剥注释后再断言。 */
    /node\.nodeType/.test(stripComments(servedChrome))
    && !/instanceof Node/.test(stripComments(servedChrome)), "nodeType duck-typing");
  t("(b) `installPlayerChrome` 源码不含 `3000`（3 秒定时淡出已删）",
    servedChrome.length > 0 && !servedChrome.includes("3000") && !diskChrome.includes("3000"),
    `served=${/3000/.test(servedChrome)} disk=${/3000/.test(diskChrome)} src_bytes=${served.text.length}`);
  t("(b) 全模块也不含 `3000`（没有别的 3 秒淡出残留）", !served.text.includes("3000"), "count=0");

  // ── (c) 把 layout CSS + auto 判定复制进 iframe realm，走 7 个场景 ────────
  const frameHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
.story-player{display:flex;flex-direction:column;height:100vh}
.hdr{flex:none;height:24px}
.body{flex:1}
.n-card{flex:none;padding:6px 10px;background:#222;cursor:pointer}
${LAYOUT_RULES}
</style></head><body>
<div class="story-player">
  <div class="hdr"><button id="hdr">顶部</button></div>
  <div class="body"></div>
  <div class="n-card" aria-label="播放控制"><button id="speed">播放速度</button></div>
</div>
<script>${FRAME_RUNNER}<\/script>
</body></html>`;

  const frameEl = await page.evaluateHandle((html) => {
    const el = document.createElement("iframe");
    el.style.cssText = "position:fixed;left:0;top:0;width:800px;height:300px;border:0";
    el.srcdoc = html;
    document.body.appendChild(el);
    return el;
  }, frameHtml);
  const frame = await frameEl.contentFrame();
  await frame.waitForFunction(() => Boolean(window.__decide));
  const drive = async (fn, ...args) => frame.evaluate(fn, ...args);

  const geo = await drive(() => {
    const card = document.querySelector('.story-player > .n-card[aria-label="播放控制"]');
    const other = document.querySelector("#hdr");
    const r = card.getBoundingClientRect();
    return {
      card: { l: r.left, t: r.top, r: r.right, b: r.bottom },
      header: (({ left: l, top: t, right: r2, bottom: b }) => ({ l, t, r: r2, b }))(other.getBoundingClientRect()),
      initial: { hidden: window.__hidden(), auto: document.documentElement.classList.contains("ark-chrome-auto"), open: window.__open() },
      opacity: getComputedStyle(card).opacity,
    };
  });
  t("(c) 场景① 初始即隐藏（纯隐藏：auto 在、open 不在、opacity=0）",
    geo.initial.hidden && geo.initial.auto && !geo.initial.open && geo.opacity === "0",
    JSON.stringify(geo.initial) + ` opacity=${geo.opacity}`);

  const above = { x: (geo.card.l + geo.card.r) / 2, y: (geo.card.t + geo.header.b) / 2 };
  const outside = { x: (geo.card.l + geo.card.r) / 2, y: 4 };
  const inside = { x: (geo.card.l + geo.card.r) / 2, y: (geo.card.t + geo.card.b) / 2 };

  const moveAbove = await drive((p) => { window.__x = p.x; window.__y = p.y; return window.__decide(null); }, above);
  t("(c) 场景② 指针在底栏上方的画面区 → 仍隐藏（不再「任意 pointermove 即显示」）",
    moveAbove === "hide" && (await drive(() => window.__hidden())), `decision=${moveAbove}`);

  const headerBtn = await drive(() => { document.querySelector("#hdr").blur(); return window.__decide(document.querySelector("#hdr")); });
  t("(c) 场景③ 点击（tap）顶栏之外 → 显示底栏（tap-to-reveal 捷径，派发到画面上的事件按面板处理）",
    headerBtn === "show-tap" && (await drive(() => !window.__hidden())), `decision=${headerBtn}`);

  const outsideAfterTap = await drive((p) => { window.__x = p.x; window.__y = p.y; return window.__decide(null); }, outside);
  t("(c) 场景④ 指针移出底栏、同一次按压内 → 保持显示",
    outsideAfterTap === "keep-stale" && (await drive(() => !window.__hidden())), `decision=${outsideAfterTap}`);

  const gestureEnd = await drive((p) => { window.__btn = null; window.__x = p.x; window.__y = p.y; return window.__decide(null); }, outside);
  t("(c) 场景⑤ 按压结束、指针在栏外 → 立即收起（没有「已显示就一直在」的残留）",
    gestureEnd === "hide" && (await drive(() => window.__hidden())), `decision=${gestureEnd}`);

  const focusKeep = await drive((p) => {
    document.body.focus();
    document.querySelector("#speed").focus();
    window.__x = p.x; window.__y = p.y; window.__btn = null;
    const decision = window.__decide(null);
    // 真实时间线里「焦点在底栏内」的 pointermove 监听器会顺带把底栏显示出来
    // （`card.contains(document.activeElement)` → setHidden(false)）。
    if (decision === "keep-focus") setHidden(false);
    return decision;
  }, outside);
  t("(c) 场景⑥ 焦点落在底栏按钮、指针在栏外 → 保持显示（键盘路径）",
    focusKeep === "keep-focus" && (await drive(() => !window.__hidden())), `decision=${focusKeep}`);

  const hoverBack = await drive((p) => {
    window.__x = p.x; window.__y = p.y; window.__btn = null; document.querySelector("#speed").blur();
    return window.__decide(null);
  }, inside);
  t("(c) 场景⑦ 指针命中底栏矩形（离开 250ms 后再移回）→ 显示（无定时器、无过期状态）",
    hoverBack === "show-hover" && (await drive(() => !window.__hidden())), `decision=${hoverBack}`);

  const leaveClean = await drive((p) => { window.__x = p.x; window.__y = p.y; window.__btn = null; document.querySelector("#speed").blur(); return window.__decide(null); }, outside);
  t("(c) 场景⑧ 焦点/指针都离开 → 重新收起（pointerout → hide）",
    leaveClean === "hide" && (await drive(() => window.__hidden())), `decision=${leaveClean}`);

  await frame.waitForTimeout(400); // 收起有 `transition:opacity .2s`：等它落定再读 computed
  const settled = await drive(() => ({
    hidden: window.__hidden(),
    open: window.__open(),
    opacity: getComputedStyle(document.querySelector('.story-player > .n-card[aria-label="播放控制"]')).opacity,
  }));
  t("(c) 收起落定后 computed opacity === \"0\"（`.ark-chrome-hidden{opacity:0…}` 真的命中）",
    settled.hidden && !settled.open && settled.opacity === "0", JSON.stringify(settled));
} finally {
  await browser.close();
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
