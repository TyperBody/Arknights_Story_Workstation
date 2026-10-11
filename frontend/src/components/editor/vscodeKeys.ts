/**
 * VSCode 式的**缩进键位语义**（task-7 的纯函数，不碰 DOM；单测/harness 直接
 * `import` 对拍）。
 *
 * 与 UI 的 `tab-size: 8`（`browser.css` 的 `.ed-textarea` / `.ed-hl` /
 * `.ed-anchor`）配套：
 *   1. `Tab` 键在页面里插**一个 `\t` 字符**——浏览器按 8 列跳到下一个 tab stop，
 *      `.ed-anchor` 同值测量，所以 Tab 行的像素宽度不错位。
 *   2. `Enter` = 沿用缩进（`editor.autoIndent`），见 `autoIndentOnEnter`。
 *   3. `Backspace` 在「左边只有空白」时按 8 列网格回退一格（VSCode 的 outdent），
 *      见 `outdentOnBackspace`。
 */

/** 一个 tab 的显示宽度（与 CSS 的 `tab-size` 严格一致）。 */
export const TAB_SIZE = 8;

/** 区间 `[start, offset)` 的**视觉列**：Tab 跳 `tabSize` 网格、CJK 记 2 ——
 * 与 `.ed-anchor`（真实 DOM 实测）同一套宽度，Tab 行按 8 列对齐。 */
function visualColumn(text: string, start: number, offset: number, tabSize: number): number {
  let column = 0;
  for (let index = start; index < offset; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    if (code === 9) column += tabSize - (column % tabSize);
    else column += code > 0x2e80 ? 2 : 1;
  }
  return column;
}

/** 行首（`\n` 之后）在 `text` 里的偏移。 */
function lineStartAt(text: string, offset: number): number {
  return text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** 行尾（不含 `\n`）在 `text` 里的偏移。 */
function lineEndAt(text: string, offset: number): number {
  const at = text.indexOf("\n", offset);
  return at === -1 ? text.length : at;
}

/** `[Cmd(...)]` 的行首命令名（去 `@tag`、去行首空白）；旁白/非指令 = `null`。 */
export function lineHeadCommand(line: string): string | null {
  const bare = String(line ?? "").replace(/^[ \t]+/, "");
  if (!bare.startsWith("[")) return null;
  const close = bare.indexOf("]");
  if (close === -1) return null;
  const head = bare.slice(1, close);
  if (/^\s*name\s*=/.test(head)) return "dialog";
  const open = head.indexOf("(");
  const name = (open === -1 ? head : head.slice(0, open)).split("@")[0].trim();
  return /^[A-Za-z_]\w*$/.test(name) ? name.toLowerCase() : null;
}

/**
 * `Enter` 的自动缩进（VSCode `editor.autoIndent: "full"` 的简化版，只处理
 * 行首空白）：
 * - `[Decision]` → 新行**多一级**（1 个 `\t`：它的 `[Predicate]` 处于其区域
 *   内一级）；
 * - `[Predicate]` → 新行**多一级**（= 线路体）；
 * - **下一行**已存在且是 `[Predicate]`/`[End]`/`[endtip]` → 新行**与其同级**
 *   （在下一行前回车 = 补一条同级线路头 / 收尾，而不是缩进到线路体里）；
 * - 其余 → 沿用当前行的**完整行首缩进**（逐字符照抄，Tab/空格混合不失真）。
 *
 * @param text 全文
 * @param offset 光标偏移（`selectionStart === selectionEnd`）
 * @returns 要插到 `offset` 处的文本（`"\n"` + 缩进；无缩进时就是 `"\n"`）
 */
export function autoIndentOnEnter(text: string, offset: number): string {
  const src = String(text ?? "");
  const at = Math.max(0, Math.min(src.length, Math.trunc(Number(offset) || 0)));
  const start = lineStartAt(src, at);
  const end = lineEndAt(src, at);
  const line = src.slice(start, end);
  const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
  const command = lineHeadCommand(line);

  let nextLead = "";
  let nextCommand: string | null = null;
  if (end < src.length) {
    const nextStart = end + 1;
    nextLead = /^[ \t]*/.exec(src.slice(nextStart, lineEndAt(src, nextStart)))?.[0] ?? "";
    nextCommand = lineHeadCommand(src.slice(nextStart, lineEndAt(src, nextStart)));
  }
  const atRouteGate = nextCommand === "predicate" || nextCommand === "end" || nextCommand === "endtip";

  let indent: string;
  if (command === "decision" || command === "predicate") {
    indent = `${lead}\t`;                  // 新行多一级（线路头 / 线路体）
  } else if (atRouteGate) {
    // 与下一行**同级**：`Predicate` = 线路头一级；`End`/`endtip` 顶格。
    indent = nextCommand === "predicate" ? nextLead || "\t" : nextLead;
  } else {
    indent = lead;                          // 沿用当前行的完整行首缩进
  }
  if (line.trim() === "") indent = lead;    // 空行：只沿用已有空白，不多加
  return `\n${indent}`;
}

/**
 * `Backspace` 的「跳 tab stop」：光标左边**只有空白**（直到行首）时，把这段
 * 空白删到**上一个 8 列 tab stop**——在行首空白里取「累计视觉宽 ≤ 上一格列号」
 * 的最靠右位置（Tab 一次跳满一格、空格逐列）。删完光标正好落在 8 列网格上，
 * 下一次 `Backspace` 会再去上一格。
 *
 * 光标左边有非空白（正常打字），或光标已在行首（让浏览器删换行）时返回 `null`
 * ——交回浏览器原生 Backspace。
 *
 * @returns `{from, to}`（删 `[from, to)`，光标落在 `from`）或 `null`（原生）
 */
export function outdentOnBackspace(
  text: string,
  offset: number,
  tabSize: number = TAB_SIZE
): { from: number; to: number } | null {
  const src = String(text ?? "");
  const to = Math.max(0, Math.min(src.length, Math.trunc(Number(offset) || 0)));
  const start = lineStartAt(src, to);
  if (to === start) return null;                       // 行首：原生（删换行）
  if (/[^ \t]/.test(src.slice(start, to))) return null; // 左边有非空白：原生
  const size = Math.max(1, Math.trunc(Number(tabSize) || TAB_SIZE));
  const column = visualColumn(src, start, to, size);
  const stop = column - (column % size || size);       // 上一个 tab stop 的列号
  let from = start;
  for (let index = start; index < to; index += 1) {
    if (visualColumn(src, start, index + 1, size) <= stop) from = index + 1;
    else break;
  }
  if (from >= to) return null;
  return { from, to };
}
