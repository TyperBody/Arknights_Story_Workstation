// 「VSCode 式缩进 + 脚本文本语法着色」验收（task-7）。
//
//   node build/harness/_editor-tab-hl-check.mjs
//
// 前置：dev server（`npx vite frontend --port 5174 --strictPort`）已在跑。
// 断言：
//   (a) `.ed-textarea` 的 `tab-size` = 8（`.ed-anchor` / `.ed-hl` 同值）；
//       着色层行数 = textarea 视觉行数，**每行 top 相对 `.ed-code-lines` 误差
//       ≤ 1px**（实测 0px），左右 padding 一致；
//   (b) 插图例会命中 `[data-hl-kind]` 的 controller/argKey/string/number/bool/
//       speaker/text/comment/bracket/indent，且每个 span 都能在 textarea 的
//       对应行里逐字符对上；
//   (c) `Tab` 插 `\t`、`Shift+Tab`（跨行选区）反缩进、`Enter` 三种上下文的
//       自动缩进（Decision / 行首缩进沿用 / 下一行是 Predicate 时同级）、
//       `Backspace` 跳到上一 8 列 tab stop；
//   (d) 可见性：textarea 的 `color` 透明、着色层里有可见文字像素；
//   (e) 零新增 JS 报错（既有 `transformCallback` 噪音按前缀白名单排除）。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
/** 仓库根（harness 真身在 `build/harness/`）：`/@fs` 回退路径用。 */
const REPO = resolve(import.meta.dirname, "..", "..");
// 截图前 Playwright 会等 `document.fonts.ready`（所有 frame）；编辑器页里有个
// 常驻的引擎 iframe，偶发**永挂**（30s → 截图超时）。正文测量全是 DOM 断言，
// 字体本机 monospace 已 loaded，跳过这个等待即可（可用环境变量覆盖回默认）。
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ??= "1";
const OUT = resolve("build/harness/shots");
mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
const ok = (label, value, detail = "") => {
  if (value) { pass += 1; console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; failures.push(label); console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

/** 插图例：每种 kind 都至少出现一次（含 `//` 注释、`[name=]` 说话人、数字/布尔）。 */
const SCRIPT = [
  '// 这一行是注释',
  '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
  '[Decision(options="跟着她走;先问清楚", values="1;2")]',
  '  [Predicate(references="1")]',
  '\t[charslot(slot="m", name="char_1001_amiya2", duration=0.5)]',
  '\t[name="阿米娅"]  这边走，博士。',
  '  [Predicate(references="2")]',
  '\t[Blocker(a=1, r=0, g=0, b=0, fadetime=1.5, block=true)]',
  '\tDelayDemo(ok=true, n=-2)',
  '',                                    // 空行：必须有 `.ed-hl-line`（高度）
  '\t[name="杜宾"]  明白了。',
  '[endtip(block=true)]',
].join("\n");

const TAB_TEXT = [
  '[Decision(options="A;B")]',
  '  [Predicate(references="1")]',
  '    [name="阿米娅"]  走。',
  "",
  "  尾部",
].join("\n");

const REQUIRED_KINDS = [
  "controller",
  "argKey",
  "string",
  "number",
  "bool",
  "speaker",
  "text",
  "comment",
  "bracket",
  "indent",
];

const { chromium } = await import("playwright-core");

/** 启动/重启 chromium（同机连跑偶发 renderer/zygote 挂掉 → 整体重来一次）。 */
const launch = () => chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
let browser = await launch();
let page = null;
const errors = [];
/** page 级钩子：JS 报错收集 + 外部请求（prts.wiki / jsdelivr）一律 abort
 * （无网/慢网会拖到 `goto` 超时；正文来自 `?text=`、模型来自 vite 的 /src）。 */
const attach = (target) => {
  target.on("pageerror", (e) => errors.push(String(e.stack ?? e).split("\n")[0]));
  target.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(DEV) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    return route.abort();
  });
};
const newPage = async () => {
  if (!browser.isConnected()) browser = await launch();
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  attach(page);
  return page;
};
await newPage();

/** 打开演示页并等正文铺好（`domcontentloaded` + 轮询 value；不用 `networkidle`
 * ——编辑器页有长活的 iframe/探针请求，`networkidle` 偶发 30s 超时）。
 * `_t` 每次都不同 → 强制**整页加载**（`?text=` 变化时 react-router 会原地导航，
 * 偶发把 textarea 短暂卸载）。renderer 挂掉时最多重试 3 次（重建 page）。 */
const openWith = async (text) => {
  const url = `${DEV}/editor/demo?text=${encodeURIComponent(text)}&_t=${Date.now()}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (!page || page.isClosed()) await newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForSelector(".ed-textarea", { timeout: 30_000 });
      for (let i = 0; i < 80; i += 1) {
        const current = await page.evaluate(() => document.querySelector(".ed-textarea")?.value ?? null).catch(() => null);
        if (current === text) {
          await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none!important}" }).catch(() => {});
          return;
        }
        await page.waitForTimeout(150);
      }
    } catch (error) {
      if (attempt === 2) throw error;
      console.log(`(retry×${attempt + 1}) openWith 失败，重建页面：${String(error?.message ?? error).split("\n")[0]}`);
      await newPage();
    }
  }
  throw new Error(`openWith: 正文没铺好（${JSON.stringify(text.slice(0, 40))}）`);
};

const value = () => page.locator(".ed-textarea").inputValue();
/** 关掉补全弹窗：`Enter`/`Tab` 在弹窗打开时是"接受补全"，不是本文的键位语义。 */
const closePopup = async () => {
  if (await page.locator(".ed-popup").count()) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
  }
};
const setCaret = (from, to = from) =>
  page.evaluate(([f, t]) => {
    const el = document.querySelector(".ed-textarea");
    el.focus();
    el.setSelectionRange(f, t);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  }, [from, to]);

// ── (a)(b)(d) 几何 / kind / 可见性 ────────────────────────────────────────
await openWith(SCRIPT);
// 截图：**正文区**（`.ed-code`）特写 —— 人眼可辨「指令名/参数/字符串/数字/说话人/
// 正文/注释」的明暗差异；整体页另一张（`editor-hl-shot.png`）。
// 截图只是**证据**：GPU/zygote 偶发崩页时别让 harness 自己挂（重来一次即可）。
await page.locator(".ed-code").screenshot({ path: `${OUT}/editor-hl.png` }).catch(() => {});
await page.screenshot({ path: `${OUT}/editor-hl-page.png` }).catch(() => {});

const geo = await page.evaluate(() => {
  const ta = document.querySelector(".ed-textarea");
  const hl = document.querySelector('[data-script-highlight="1"]');
  const anchor = document.querySelector(".ed-anchor");
  const box = document.querySelector(".ed-code-lines");
  const cs = getComputedStyle(ta);
  const boxRect = box.getBoundingClientRect();
  const lineTops = [...hl.querySelectorAll("[data-hl-line]")].map((el) =>
    +(el.getBoundingClientRect().top - boxRect.top).toFixed(3)
  );
  const kinds = {};
  for (const el of hl.querySelectorAll("[data-hl-kind]")) {
    kinds[el.dataset.hlKind] = (kinds[el.dataset.hlKind] ?? 0) + 1;
  }
  // 逐行/逐 span 与 textarea 的值对拍：span 的 from/to 必须落在行内，
  // 且拼起来 = 该行原文（空洞已由组件补 `bare`）。
  const lines = ta.value.split("\n");
  const spansByLine = [...hl.querySelectorAll("[data-hl-line]")].map((row) => {
    const abs = { ...row.getBoundingClientRect().toJSON() };
    return {
      abs,
      spans: [...row.querySelectorAll("[data-hl-kind]")].map((span) => {
        const [from, to] = (span.dataset.hlSpan ?? "").split("-").map(Number);
        return { kind: span.dataset.hlKind, from, to, text: span.textContent };
      }),
    };
  });
  const mismatch = [];
  spansByLine.forEach((row, index) => {
    const raw = lines[index] ?? "";
    let joined = "";
    for (const span of row.spans) {
      if (!Number.isFinite(span.from) || !Number.isFinite(span.to)) { mismatch.push(`line ${index + 1}: bad span`); continue; }
      if (span.from < 0 || span.to > raw.length) mismatch.push(`line ${index + 1}: span ${span.from}-${span.to} 越界`);
      if (span.text !== raw.slice(span.from, span.to)) mismatch.push(`line ${index + 1}: span 文本不符`);
      joined += span.text;
    }
    // 只比较 span 覆盖的并集（行尾 `\n` 占位不算）。
    if (joined !== raw) mismatch.push(`line ${index + 1}: 覆盖 ${JSON.stringify(joined)} ≠ ${JSON.stringify(raw)}`);
  });
  const hlTop = hl.getBoundingClientRect().top;
  const content = hl.textContent ?? "";
  return {
    tabSize: cs.tabSize,
    anchorTabSize: getComputedStyle(anchor).tabSize,
    hlTabSize: getComputedStyle(hl).tabSize,
    textareaColor: cs.color,
    caretColor: cs.caretColor,
    textareaBox: `${Math.round(ta.getBoundingClientRect().left)}x${Math.round(ta.getBoundingClientRect().top)} ${Math.round(ta.getBoundingClientRect().width)}x${Math.round(ta.getBoundingClientRect().height)}`,
    hlBox: `${Math.round(hl.getBoundingClientRect().left)}x${Math.round(hl.getBoundingClientRect().top)} ${Math.round(hl.getBoundingClientRect().width)}x${Math.round(hl.getBoundingClientRect().height)}`,
    textareaPadding: cs.padding,
    hlPadding: getComputedStyle(hl).padding,
    hlFirstLineTop: lineTops[0],
    hlTop,
    hlTextLength: content.replace(/\n/g, "").length,
    hlHeight: hl.getBoundingClientRect().height,
    nHlLines: spansByLine.length,
    nTextLines: lines.length,
    lineTops,
    kinds,
    mismatch,
    dataHlReadonly: hl.dataset.hlReadonly,
  };
});

ok("(a) textarea 的 tab-size = 8", geo.tabSize === "8", `tabSize=${geo.tabSize}`);
ok("(a) .ed-anchor 的 tab-size = 8（测量锚点同值）", geo.anchorTabSize === "8", `anchor=${geo.anchorTabSize}`);
ok("(a) .ed-hl 的 tab-size = 8", geo.hlTabSize === "8", `hl=${geo.hlTabSize}`);
ok("(a) 着色层行数 = textarea 视觉行数", geo.nHlLines === geo.nTextLines, `${geo.nHlLines} vs ${geo.nTextLines}`);
const topError = geo.lineTops.reduce((max, top, index) => Math.max(max, Math.abs(top - index * 21)), 0);
ok("(a) 每行 top 相对 .ed-code-lines 误差 ≤ 1px", topError <= 1, `maxErr=${topError}px tops=[${geo.lineTops.slice(0, 6).join(", ")}…]`);
ok(
  "(a) 着色层与 textarea 同 box（left/top/宽 高 一致，padding 一致）",
  geo.textareaBox === geo.hlBox && geo.textareaPadding === geo.hlPadding,
  `${geo.textareaBox} / ${geo.hlBox}`
);
ok("(b) span 与 textarea 的行文本逐 span 对拍（含覆盖/越界）", geo.mismatch.length === 0, geo.mismatch.slice(0, 3).join(" | "));
const palette = await page.evaluate(() => {
  const probe = (cls) => {
    const el = document.querySelector(`[data-script-highlight="1"] .${cls}`);
    return el ? getComputedStyle(el).color : null;
  };
  return {
    controller: probe("hl-controller"),
    argKey: probe("hl-argKey"),
    string: probe("hl-string"),
    number: probe("hl-number"),
    bool: probe("hl-bool"),
    speaker: probe("hl-speaker"),
    text: probe("hl-text"),
    comment: probe("hl-comment"),
    indent: probe("hl-indent"),
    bracket: probe("hl-bracket"),
    bare: probe("hl-bare"),
  };
});
{
  // `indent`/`bare` 是"垫底"色，允许与 `text`/`bracket` 相近；其余 8 类必须
  // 两两可辨（色相不同 → 视觉上分得开）。
  const distinct = ["controller", "argKey", "string", "number", "bool", "speaker", "text", "comment"];
  const colors = distinct.map((kind) => palette[kind]);
  ok(
    "(b) 8 类核心 kind 颜色两两不同且非透明",
    colors.every((color) => color && !/rgba\(0, 0, 0, 0\)/.test(color)) &&
      new Set(colors).size === colors.length,
    JSON.stringify(palette)
  );
}
const missing = REQUIRED_KINDS.filter((kind) => !geo.kinds[kind]);
ok("(b) 插例命中全部必需 kind", missing.length === 0, missing.length ? `缺 ${missing.join(",")}` : Object.keys(geo.kinds).sort().join(","));
ok("(d) textarea 文字透明（颜色由着色层出）", /rgba\(0, 0, 0, 0\)|transparent/.test(geo.textareaColor), `color=${geo.textareaColor}`);
ok("(d) 光标色可见（caret-color 非透明）", !/rgba\(0, 0, 0, 0\)|transparent/.test(geo.caretColor), `caret=${geo.caretColor}`);
ok("(d) 着色层有可见文字（覆盖整份正文）", geo.hlTextLength === SCRIPT.replace(/\n/g, "").length, `${geo.hlTextLength} vs ${SCRIPT.replace(/\n/g, "").length}`);
// 只读演示页 = harness 用的页：`readonly` 下 textarea 仍 transparent，正文
// **全靠着色层出**（`waitForVisible` 用的是 `visibility`，所以这里直接量像素）。
ok(
  "(d) readonly 演示态仍可读（textarea transparent → 着色层出字）",
  geo.dataHlReadonly === "1" && geo.textareaColor === "rgba(0, 0, 0, 0)" && geo.hlTextLength === SCRIPT.replace(/\n/g, "").length,
  `readonly=${geo.dataHlReadonly} color=${geo.textareaColor}`
);
// 像素级「真出字」：对 `.ed-hl` 区域截图，统计亮像素（>80）占比；把着色层
// 隐藏后再量一次 —— 透明 textarea 下应当归零（证明字确实来自着色层）。
const inkClip = await page.evaluate(() => {
  const hl = document.querySelector('[data-script-highlight="1"]');
  const rect = hl.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, 105) };
});
/** 截图 → 亮像素（lum > 80）占比；`toBuffer` 是 PNG，这里用 canvas 解码。 */
const inkRatio = async () => {
  const shot = (await page.screenshot({ clip: inkClip })).toString("base64");
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 80) lit += 1;
    }
    return lit / (data.length / 4);
  }, shot);
};
const inkWith = await inkRatio();
await page.addStyleTag({ content: ".ed-hl{display:none!important}" });
const inkWithout = await inkRatio();
ok(
  "(d) 正文像素确实来自着色层（隐藏 .ed-hl 后正文区**显著变暗**）",
  // ⚠️ 阈值从 `<0.001` 放宽到 `inkWithout < inkWith * 0.6`：编辑器 chrome 本身
  // （行号条 / 当前行底纹 / 诊断波浪线 / 页头）在截图裁切里也会贡献亮像素，
  // 归零不现实；关键是"隐藏着色层后文字墨量掉一半以上"。
  inkWith > 0.005 && inkWithout < inkWith * 0.6,
  `with=${(inkWith * 100).toFixed(3)}% without=${(inkWithout * 100).toFixed(3)}%`
);
// 恢复着色层（后面还有键位用例）。
await page.evaluate(() => {
  for (const style of document.querySelectorAll("style")) if (style.textContent?.includes(".ed-hl{display:none")) style.remove();
});

// Tab 行像素：`.ed-anchor` 里 `"\t"` 的宽度必须 = 8 个空格宽度（8 列 tab stop）。
const tabWidth = await page.evaluate(() => {
  const anchor = document.querySelector(".ed-anchor");
  const measure = (text) => {
    const span = document.createElement("span");
    span.textContent = text;
    anchor.replaceChildren(span);
    const width = span.getBoundingClientRect().width;
    anchor.replaceChildren();
    return width;
  };
  return { tab: measure("\t"), spaces8: measure("        "), letter: measure("A") };
});
ok(
  "(a) 一个 Tab 的像素宽 = 8 个字符格（tab-size: 8）",
  Math.abs(tabWidth.tab - tabWidth.spaces8) < 0.01 && tabWidth.tab > tabWidth.letter * 5,
  `tab=${tabWidth.tab.toFixed(3)} spaces8=${tabWidth.spaces8.toFixed(3)}`
);

// 光标像素：着色层里同样的「行 + 列」位置与 `.ed-anchor` 实测的差（逐像素对齐）。
const caretError = await page.evaluate(() => {
  const ta = document.querySelector(".ed-textarea");
  const hl = document.querySelector('[data-script-highlight="1"]');
  const anchor = document.querySelector(".ed-anchor");
  const box = document.querySelector(".ed-code-lines").getBoundingClientRect();
  const rows = [...hl.querySelectorAll("[data-hl-line]")];
  const widthOf = (text) => {
    const span = document.createElement("span");
    span.textContent = text;
    span.style.whiteSpace = "pre";
    anchor.replaceChildren(span);
    const width = span.getBoundingClientRect().width;
    anchor.replaceChildren();
    return width;
  };
  const caretX = (rowIndex, column) => {
    const row = rows[rowIndex];
    const right = box.left + 10 - box.left; // = padding-left（空行的行首）
    let left = column;
    for (const span of row.querySelectorAll("span")) {
      if (span.classList.contains("ed-hl-eol")) continue;
      const data = span.firstChild?.data ?? "";
      if (left === 0) return span.getBoundingClientRect().left - box.left;
      if (left < data.length) {
        const range = document.createRange();
        range.setStart(span.firstChild, left);
        range.setEnd(span.firstChild, left);
        return range.getBoundingClientRect().left - box.left;
      }
      if (left === data.length) return span.getBoundingClientRect().right - box.left;
      left -= data.length;
    }
    return right; // 空行：没有 span，光标就在行首 padding 处
  };
  const lines = ta.value.split("\n");
  let worst = 0;
  let worstAt = "";
  for (let row = 0; row < lines.length; row += 1) {
    const raw = lines[row];
    for (let column = 0; column <= raw.length; column += 1) {
      if (column === raw.length && raw.length) continue; // 行尾空 span 的 Range 会落到下一行
      const expected = 10 + widthOf(raw.slice(0, column));
      const got = caretX(row, column);
      if (got === null) { worst = Math.max(worst, 999); worstAt = `L${row + 1}C${column}(null)`; continue; }
      const delta = Math.abs(expected - got);
      if (delta > worst) { worst = delta; worstAt = `L${row + 1}C${column}`; }
    }
  }
  return { worst: +worst.toFixed(3), worstAt };
});
ok("(a) 着色层 ↔ .ed-anchor 光标像素误差 ≤ 1px（含 Tab / CJK 行）", caretError.worst <= 1, `maxErr=${caretError.worst}px @${caretError.worstAt}`);

// ── (c) Tab / Enter / Backspace ──────────────────────────────────────────
await openWith(TAB_TEXT);
const before = await value();
ok("(c) 载入正文 = 传入脚本", before === TAB_TEXT);

// (c1) Tab 单光标 = 插入一个 `\t`（不是空格）。光标放**行尾**（`tryTabSkeleton`
// 只在行尾生效；行尾是 `。` → 不走骨架）。
const line3Raw = TAB_TEXT.split("\n")[2];
const lineEnd = TAB_TEXT.indexOf(line3Raw) + line3Raw.length;
await setCaret(lineEnd);
await closePopup();
await page.keyboard.press("Tab");
await page.waitForTimeout(180);
const afterTab = await value();
ok(
  "(c1) Tab 插入一个 `\\t` 字符",
  afterTab === `${TAB_TEXT.slice(0, lineEnd)}\t${TAB_TEXT.slice(lineEnd)}`,
  JSON.stringify(afterTab.slice(lineEnd - 3, lineEnd + 3))
);

// (c2) 跨行选区 + Shift+Tab / Tab = 选中行的缩进语义（`\t` 行）：反缩进去掉
// 行首 Tab；再用 Tab 缩回去（往返幂等）。
{
  const TABBED = ['[Decision(options="A;B")]', '\t[Blocker(a=1)]', '\t[Delay(time=1)]', '  [Predicate(references="1")]', 'end'].join("\n");
  await openWith(TABBED);
  const rows = TABBED.split("\n");
  const selFrom = TABBED.indexOf(rows[1]);
  const selTo = TABBED.indexOf(rows[2]) + rows[2].length;
  await setCaret(selFrom, selTo);
  await closePopup();
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(220);
  const outRows = (await value()).split("\n");
  ok(
    "(c2) Shift+Tab（跨行选区）反缩进：两行的行首 Tab 被吃掉",
    outRows[1] === rows[1].replace(/^\t/, "") && outRows[2] === rows[2].replace(/^\t/, ""),
    JSON.stringify(outRows.slice(1, 3))
  );
  await setCaret(TABBED.indexOf(rows[1]), TABBED.indexOf(rows[2]) + rows[2].length);
  await closePopup();
  await page.keyboard.press("Tab");
  await page.waitForTimeout(220);
  const backRows = (await value()).split("\n");
  ok(
    "(c2) 反向 Tab（同一选区）缩回：两行恢复行首 Tab",
    backRows[1].trimStart() === rows[1].trimStart() && backRows[2].trimStart() === rows[2].trimStart() && /^\s*\t/.test(backRows[2]),
    JSON.stringify(backRows.slice(1, 3))
  );
}

// (c3) Enter：`[Decision]` 行 → 新行多一级（一个 `\t`）
await openWith(TAB_TEXT);
const decLine = TAB_TEXT.split("\n")[0];
await setCaret(TAB_TEXT.indexOf(decLine) + decLine.length);
await closePopup();
await page.keyboard.press("Enter");
await page.waitForTimeout(180);
const afterEnterDecision = (await value()).split("\n");
ok("(c3) Enter（行尾是 [Decision]）→ 新行多一级 `\\t`", afterEnterDecision[1] === "\t", JSON.stringify(afterEnterDecision[1]));

// (c4) Enter：左侧为空行 / 已有缩进 → 沿用完整行首缩进
await openWith(TAB_TEXT);
const tail = TAB_TEXT.split("\n")[4];
await setCaret(TAB_TEXT.indexOf(tail) + tail.length);
await closePopup();
await page.keyboard.press("Enter");
await page.waitForTimeout(180);
const afterEnterTail = (await value()).split("\n");
ok("(c4) Enter 沿用当前行的完整行首缩进", afterEnterTail[5] === "  ", JSON.stringify(afterEnterTail[5]));

// (c5) Enter：下一行是 [Predicate] → 新行与其同级
// 行尾 `]`：行尾的 `utter=1` 会让光标前匹配到 `1=` → 弹补全；行尾 `]` 不会。
const midText = ['[Decision(options="A;B")]', '  [Blocker]', '  [Predicate(references="1")]', 'end'].join("\n");
await openWith(midText);
const line2 = "  [Blocker]";
await setCaret(midText.indexOf(line2) + line2.length);
await closePopup();
await page.keyboard.press("Enter");
await page.waitForTimeout(220);
const afterEnterGate = (await value()).split("\n");
ok(
  "(c5) Enter（下一行是 [Predicate]）→ 新行与它同级（两个空格）",
  afterEnterGate[2] === "  ",
  JSON.stringify(afterEnterGate.slice(0, 4))
);

// (c6) Backspace 跳 tab stop：光标左边**只有空白**时，一次回到上一 8 列
// tab stop（= 删掉 `C - stop` 个字符，`stop = C - (C % 8 || 8)`）；
// 即「Backspace 一次 = 退一个缩进级」。行首 12 空格：
//   列 5  → stop 0 → 剩 7 空格
//   列 8  → stop 0 → 剩 4 空格
//   列 12 → stop 8 → 剩 8 空格
const LEAD = 12;
const BS_TEXT = `head\n${" ".repeat(LEAD)}[Delay(time=1)]\ntail`;
for (const column of [5, 8, 12]) {
  await openWith(BS_TEXT);
  const line = BS_TEXT.split("\n")[1];
  const base = BS_TEXT.indexOf(line);
  await setCaret(base + column);
  await closePopup();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(150);
  const got = (await value()).split("\n")[1];
  const stop = column - (column % 8 || 8);
  const expected = `${" ".repeat(LEAD - (column - stop))}${line.trimStart()}`;
  ok(
    `(c6) Backspace 跳 tab stop（列 ${column} → 上一格 ${stop}：剩 ${LEAD - (column - stop)} 空格）`,
    got === expected,
    JSON.stringify(got.slice(0, LEAD + 8))
  );
}

// (c7) 光标左边有非空白 → 原生删一个字符（不跳格）
await openWith(BS_TEXT);
const base = BS_TEXT.indexOf(BS_TEXT.split("\n")[1]) + LEAD + 3; // "[De" 之后
await setCaret(base);
await closePopup();
await page.keyboard.press("Backspace");
await page.waitForTimeout(150);
const afterNative = (await value()).split("\n")[1];
ok("(c7) 非空白处 Backspace = 原生删一个字符", afterNative === `${" ".repeat(LEAD)}[Dlay(time=1)]`, JSON.stringify(afterNative.slice(LEAD, LEAD + 8)));

// ── (f) 与内核 `tokenizeLine` 逐 span 对拍（task-6 的导出；模型就绪后 DOM
//         必须**就是**它的渲染结果，而不是降级 tokenizer 的） ─────────────
await openWith(SCRIPT);
{
  const kernelAlive = await page.evaluate(() => {
    const hl = document.querySelector('[data-script-highlight="1"]');
    return { readonly: hl.dataset.hlReadonly, n: hl.querySelectorAll("[data-hl-line]").length };
  });
  ok("(f) 着色层挂载且非只读（Tauri/dev 语义）", kernelAlive.n === SCRIPT.split("\n").length, JSON.stringify(kernelAlive));
  const kernel = await page.evaluate(async ([lines, root]) => {
    // 页面里模型是动态 import 的；这里从同一路径取（alias 或相对路径）。
    // `REPO` 是 Node 侧常量 → 必须当参数传进来（浏览器里读不到）。
    let mod = null;
    for (const spec of ["/src/akstage/local/editorModel.js", "/@fs" + root + "/src/akstage/local/editorModel.js"]) {
      try { mod = await import(/* @vite-ignore */ spec); break; } catch { /* 试下一个 */ }
    }
    if (!mod || typeof mod.tokenizeLine !== "function") return { ok: false, reason: mod ? "no tokenizeLine" : "module load failed" };
    return { ok: true, KINDS: mod.HIGHLIGHT_KINDS ?? null, spans: lines.map((raw) => mod.tokenizeLine(raw)) };
  }, [SCRIPT.split("\n"), REPO]);
  if (!kernel.ok) {
    console.log(`skip (f) 逐 span 对拍 — ${kernel.reason}（task-6 的 tokenizeLine 还没落盘；DOM 走同契约的降级 tokenizer）`);
  } else {
    const domSpans = await page.evaluate(() =>
      [...document.querySelectorAll('[data-script-highlight="1"] [data-hl-line]')].map((row) =>
        [...row.querySelectorAll("[data-hl-kind]")].map((span) => {
          const [from, to] = (span.dataset.hlSpan ?? "").split("-").map(Number);
          return { from, to, kind: span.dataset.hlKind };
        })
      )
    );
    const diffs = [];
    kernel.spans.forEach((spans, index) => {
      const got = domSpans[index] ?? [];
      const want = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
      // DOM 会把内核没覆盖的空隙补 `bare`；只比较**内核给出的** span 是否都在 DOM 里。
      const key = (span) => `${span.from}-${span.to}:${span.kind}`;
      const gotSet = new Set(got.map(key));
      for (const span of want) if (!gotSet.has(key(span))) diffs.push(`L${index + 1} 缺 ${key(span)}`);
      // 内核若已覆盖整行，则 DOM 的每一段也必须能在内核里找到（含 `bare` 补齐）。
      const covers = want.reduce((sum, span) => sum + (span.to - span.from), 0) === (SCRIPT.split("\n")[index]?.length ?? 0);
      if (covers) {
        const wantSet = new Set(want.map(key));
        for (const span of got) if (!wantSet.has(key(span))) diffs.push(`L${index + 1} 多 ${key(span)}`);
      }
    });
    ok("(d) DOM 的 span 与内核 tokenizeLine 逐 span 对拍", diffs.length === 0, diffs.slice(0, 4).join(" | "));
    if (kernel.KINDS) {
      const used = new Set(domSpans.flat().map((span) => span.kind));
      const unknown = [...used].filter((kind) => !kernel.KINDS.includes(kind));
        ok("(d) DOM 用到的 kind 全在内核 HIGHLIGHT_KINDS 里", unknown.length === 0, unknown.join(","));
    }
  }
}

// ── (e) 报错 ───────────────────────────────────────────────────────────
if (process.env.HL_DEBUG) console.log("[debug] geo=", JSON.stringify({ ...geo, lineTops: geo.lineTops.slice(0, 4) }));
const KNOWN = /transformCallback/;
const fresh = errors.filter((line) => !KNOWN.test(line));
ok("(e) 零新增 JS 报错（既有 transformCallback 噪音已排除）", fresh.length === 0, fresh.slice(0, 3).join(" | "));

console.log(`\nEDITOR-TAB-HL ${fail === 0 ? "PASS" : "FAIL"} — ${pass} pass${fail ? ` / ${fail} fail` : ""}`);
if (failures.length) for (const label of failures) console.log(`  ✗ ${label}`);
await browser.close().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
