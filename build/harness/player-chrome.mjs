// 播放器底栏（§ 设置 → 播放器底栏）：`show` / `auto`（默认；纯隐藏）/ `hide` 三档契约。
//   node build/harness/player-chrome.mjs      # 纯静态断言（读源码 + CSS 注入字符串）
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const ui = readFileSync(resolve("frontend/src/lib/uiSettings.ts"), "utf8");
const boot = readFileSync(resolve("frontend/src/lib/storyPlayerBoot.ts"), "utf8");
const settings = readFileSync(resolve("frontend/src/pages/SettingsPage.tsx"), "utf8");

t("默认档 = auto", /PLAYER_CHROME_VALUES[\s\S]{0,200}?\?\s*\(raw as PlayerChrome\)\s*:\s*"auto"/.test(ui), "");
t("auto 是默认档（读取端回落，不依赖「写过 key」）", /PLAYER_CHROME_VALUES\.includes\(raw as PlayerChrome\)\s*\?\s*\(raw as PlayerChrome\)\s*:\s*"auto"/.test(ui), "");
t("「悬停显示」是独立开关（默认关 = 永久隐藏）",
  /const PLAYER_CHROME_HOVER_KEY = "prts-player-chrome-hover"/.test(ui)
  && /export function isPlayerChromeHover\(\): boolean \{\s*return getItem\("ui", PLAYER_CHROME_HOVER_KEY\) === "1"/.test(ui),
  "prts-player-chrome-hover");
t("auto 档：开关关时不装监听（永久隐藏）",
  /if \(!isPlayerChromeHover\(\)\)[\s\S]{0,320}?add\(CHROME_AUTO\)[\s\S]{0,160}?return;/.test(boot), "");
t("auto 档：开关开时才由 .ark-chrome-hover 放行显示",
  /add\(CHROME_HOVER\)/.test(boot) && /html\.ark-chrome-auto\.ark-chrome-hover\.ark-chrome-open/.test(boot.replace(/\s+/g, "")), "");
t("auto 档无 3 秒定时器（纯隐藏）", /CHROME_AUTO[\s\S]{0,2000}?setHidden\(true\)/.test(boot) && !/setTimeout\([\s\S]{0,200}3000/.test(boot), "");
t("auto 档：指针几何命中即显示", /pointermove"[\s\S]{0,60}onMove/.test(boot) && /getBoundingClientRect\(\)/.test(boot), "");
t("auto 档：移出即收起", /pointerleave"[^)]*setHidden\(true\)/.test(boot) || /onOut/.test(boot), "");
const cssFlat = boot.replace(/\s+/g, "");
t("CSS：收起态透明度 + 不接收指针",
  /ark-chrome-hidden\{opacity:0;pointer-events:none/.test(cssFlat)
  && /ark-chrome-auto/.test(cssFlat),
  cssFlat.match(/html\.ark-chrome-auto[^`]{0,200}/)?.[0]?.slice(0, 120) ?? "(未找到)");
t("CSS：展开态由 html.ark-chrome-open 决定（且要求 .ark-chrome-hover）",
  /ark-chrome-auto\.ark-chrome-hover\.ark-chrome-open/.test(boot.replace(/\s+/g, "")), "");
t("hide 档仍是 display:none", /ark-chrome-hide[\s\S]{0,80}display:none/.test(boot.replace(/\s+/g, "")), "");
t("设置页文案与默认一致（auto=默认）", /底栏常藏，指针移上去才显示/.test(settings), "");
t("设置页三档循环仍存在", /\["show",\s*"auto",\s*"hide"\]/.test(settings), "");
t("设置页有「悬停显示」开关（data-chrome-hover）", /data-chrome-hover=/.test(settings) && /setPlayerChromeHover/.test(settings), "");
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
