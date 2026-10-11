import { memo, useMemo } from "react";

/**
 * 语法着色层（task-7）：把 `tokenizeLine` 的 span 渲染成**与 textarea 逐像素
 * 对齐**的只读层。
 *
 * 对齐契约（`build/harness/_editor-tab-hl-check.mjs` 逐条断言）：
 * - 颜色全部靠 CSS：`browser.css` 的 `.ed-textarea` / `.ed-hl` / `.ed-anchor`
 *   三者的 `font-family / font-size / line-height / tab-size(8) / padding` 一致；
 *   组件这里**只做 DOM 结构**，不写任何行内 font/padding/height（行内样式会破坏
 *   对齐；行高由 CSS 的 `.ed-hl-line { height: 21px }` 给，= 页面常量 `LH`）。
 * - 行数 = `<textarea>` 的视觉行数（正文 `\n` 数 + 1）：空行也是一个
 *   `.ed-hl-line`，所以行 i 的 top 恒为 `i*21`，与 textarea 里的第 i 行重合。
 * - span 的 `from/to` 是**整行字符偏移**（行首空白 = `indent` span）；组件按
 *   `.slice()` 输出，与 textarea 里的字符一一对应。
 * - 本层在 `<textarea>` **之下**（`z-index: 0` vs `1`），`pointer-events: none`，
 *   鼠标事件全归 textarea；`overflow: visible`，宽度仍由 `.ed-code-lines` 的
 *   `min-width` / `.ed-anchor` 决定。
 */

export type HlKind =
  | "controller"
  | "argKey"
  | "string"
  | "number"
  | "bool"
  | "semicolon"
  | "speaker"
  | "text"
  | "comment"
  | "bracket"
  | "indent"
  | "bare";

/** `tokenizeLine` 的 span 形状（`kind` 收窄到契约集合，未知 kind 归 `bare`）。 */
export interface HlSpan {
  from: number;
  to: number;
  kind: HlKind;
}

export interface ScriptHighlightProps {
  /** 完整正文（与 textarea 的 `value` 同源 → 行数一致）。 */
  text: string;
  /** 模型就绪时的 tokenizer（`modelRef.current.tokenizeLine`）；缺省走降级。 */
  tokenizer?: ((raw: string) => Array<{ from: number; to: number; kind: string }>) | null;
  /** 行号（1 起）→ 严重级，用来给**整行**加 `data-hl-severity`（波浪线）。 */
  diagnosticsByLine?: ReadonlyMap<number, string> | null;
  /** 纯 Vite 只读演示态：textarea 自己出字（着色层隐藏，见 CSS）。 */
  readonly?: boolean;
}

const KINDS: readonly string[] = [
  "controller",
  "argKey",
  "string",
  "number",
  "bool",
  "semicolon",
  "speaker",
  "text",
  "comment",
  "bracket",
  "indent",
  "bare",
];

// ── 降级 tokenizer ─────────────────────────────────────────────────────────
// 模型没载入时（首帧 / 加载失败）用：**同 kind 集合**的轻量扫描，不是解析器。
// 规则：注释（整行）→ `[name="X"] 文本`（speaker + text）→ `[Cmd(k=v, …)]`
// （controller / bracket / argKey / string / number / bool）→ 裸文本（text）。
// 一切都按**整行**偏移、互不重叠。

/** 参数表扫描：`k=v` / `k="v"` / `k=v, `，返回 `)` 的位置（-1 = 行内没有）。 */
function scanArgs(
  line: string,
  from: number,
  push: (from: number, to: number, kind: HlKind) => void
): number {
  const n = line.length;
  let index = from;
  while (index < n) {
    const ws = index;
    while (index < n && (line[index] === " " || line[index] === "\t")) index += 1;
    if (line[index] === ")" || index >= n) {
      push(ws, index, "bare");
      return line[index] === ")" ? index : -1;
    }
    const name = /^[A-Za-z_]\w*/.exec(line.slice(index));
    if (name) {
      push(index, index + name[0].length, "argKey");
      index += name[0].length;
    }
    const gapAt = index;
    while (index < n && (line[index] === " " || line[index] === "\t")) index += 1;
    if (line[index] === "=") index += 1;
    push(gapAt, index, "bare");
    while (index < n && (line[index] === " " || line[index] === "\t")) index += 1;
    const quote = line[index];
    if (quote === '"' || quote === "'") {
      let end = index + 1;
      while (end < n && line[end] !== quote) {
        if (line[end] === "\\") end += 1;
        end += 1;
      }
      end = Math.min(n, end + 1);
      push(index, end, "string");
      index = end;
    } else {
      const literal = /^(-?\d+(?:\.\d+)?)\b|^(true|false)\b/.exec(line.slice(index));
      if (literal) {
        push(index, index + literal[0].length, literal[1] !== undefined ? "number" : "bool");
        index += literal[0].length;
      } else {
        const bare = /^[^,\s)\]]*/.exec(line.slice(index))?.[0] ?? "";
        push(index, index + bare.length, "bare");
        index += bare.length;
      }
    }
    const sep = index;
    while (index < n && (line[index] === " " || line[index] === "\t")) index += 1;
    if (line[index] === ",") {
      index += 1;
      push(sep, index, "bare");
    } else {
      push(sep, index, "bare");
    }
  }
  return -1;
}

/** 降级 tokenizer：`raw` = 整行（不含 `\n`）→ span（整行偏移、不重叠）。
 * 不 export（只在本文件用）：`react-refresh/only-export-components` 要求
 * 组件文件只导出组件（类型除外）。 */
function fallbackTokenizeLine(raw: string): HlSpan[] {
  const line = String(raw ?? "");
  const n = line.length;
  const out: HlSpan[] = [];
  const push = (from: number, to: number, kind: HlKind) => {
    if (to > from) out.push({ from, to, kind });
  };
  let index = 0;
  while (index < n && (line[index] === " " || line[index] === "\t")) index += 1;
  push(0, index, "indent");
  if (index >= n) return out;
  if (line.startsWith("//", index)) {
    push(index, n, "comment");
    return out;
  }
  if (line[index] !== "[") {
    push(index, n, "text");
    return out;
  }

  // `[name="X"]  正文`：说话人 + 正文（说话人行简写）。
  const dialog = /^\[\s*name\s*=\s*("[^"]*"|'[^']*')/.exec(line.slice(index));
  if (dialog) {
    const quoteAt = index + dialog[0].indexOf(dialog[1]);
    push(index, quoteAt, "bracket");
    push(quoteAt, quoteAt + dialog[1].length, "speaker");
    const afterQuote = quoteAt + dialog[1].length;
    const close = line.indexOf("]", afterQuote);
    push(afterQuote, close === -1 ? n : close + 1, "bracket");
    if (close !== -1) push(close + 1, n, "text");
    return out;
  }

  // `[Cmd(...)]tail`（`[End]` 这类无参数指令同路）。
  push(index, index + 1, "bracket");
  let cursor = index + 1;
  const name = /^\w*/.exec(line.slice(cursor))?.[0] ?? "";
  if (name) {
    push(cursor, cursor + name.length, "controller");
    cursor += name.length;
  } else {
    push(cursor, cursor + 1, "bare");
    cursor += 1;
  }
  const paren = line.indexOf("(", cursor);
  if (paren !== -1) {
    push(cursor, paren, "bare");
    push(paren, paren + 1, "bracket");
    const closeParen = scanArgs(line, paren + 1, push);
    const close = line.indexOf("]", closeParen === -1 ? paren + 1 : closeParen);
    if (closeParen !== -1) push(closeParen, close === -1 ? n : close, "bare");
    push(close, close === -1 ? n : close + 1, "bracket");
    if (close !== -1) push(close + 1, n, "text");
    return out;
  }
  const close = line.indexOf("]", cursor);
  if (close !== -1) {
    push(cursor, close, "bare");
    push(close, close + 1, "bracket");
    push(close + 1, n, "text");
  } else {
    push(cursor, n, "bare");
  }
  return out;
}

// ── 归一化 + 渲染 ────────────────────────────────────────────────────────

/** span → 行内合法区间；未知 kind 归 `bare`。 */
function normalizeSpan(raw: { from: number; to: number; kind: string }, length: number): HlSpan | null {
  const from = Math.max(0, Math.min(length, Math.trunc(Number(raw.from) || 0)));
  const to = Math.max(from, Math.min(length, Math.trunc(Number(raw.to) || 0)));
  if (to <= from) return null;
  const kind = (KINDS.includes(raw.kind) ? raw.kind : "bare") as HlKind;
  return { from, to, kind };
}

/** 逐行取 span：tokenizer 优先（模型就绪），失败/空 → 降级；再排序、去重叠、
 * 补空洞 —— 保证**每一列都有 kind**、且「span 文本拼起来 = 行原文」。 */
function buildRows(
  text: string,
  tokenizer: ScriptHighlightProps["tokenizer"]
): Array<{ raw: string; spans: HlSpan[] }> {
  return String(text ?? "")
    .split("\n")
    .map((raw) => {
      let spans: Array<{ from: number; to: number; kind: string }> = [];
      if (tokenizer) {
        try {
          const got = tokenizer(raw);
          if (Array.isArray(got)) spans = got;
        } catch {
          spans = [];
        }
      }
      if (!spans.length) spans = fallbackTokenizeLine(raw);
      const sorted: HlSpan[] = [];
      for (const span of spans) {
        const normalized = normalizeSpan(span, raw.length);
        if (normalized) sorted.push(normalized);
      }
      sorted.sort((a, b) => a.from - b.from || a.to - b.to);
      const drained: HlSpan[] = [];
      for (const span of sorted) {
        const last = drained[drained.length - 1];
        if (last && span.from < last.to) {
          if (span.to <= last.to) continue;             // 完全被前一个盖住
          drained.push({ from: last.to, to: span.to, kind: span.kind });
          continue;
        }
        drained.push(span);
      }
      const filled: HlSpan[] = [];
      let cursor = 0;
      for (const span of drained) {
        if (span.from > cursor) filled.push({ from: cursor, to: span.from, kind: "bare" });
        filled.push(span);
        cursor = span.to;
      }
      if (cursor < raw.length) filled.push({ from: cursor, to: raw.length, kind: "bare" });
      return { raw, spans: filled };
    });
}

function ScriptHighlightImpl({ text, tokenizer, diagnosticsByLine, readonly }: ScriptHighlightProps) {
  const rows = useMemo(() => buildRows(text, tokenizer), [text, tokenizer]);
  return (
    <pre
      className="ed-hl"
      data-script-highlight="1"
      data-hl-readonly={readonly ? "1" : "0"}
      aria-hidden="true"
    >
      {rows.map((row, index) => {
        const severity = diagnosticsByLine?.get(index + 1);
        return (
          <div
            className="ed-hl-line"
            key={index}
            data-hl-line={index + 1}
            data-hl-severity={severity || undefined}
          >
            {row.spans.map((span, spanIndex) => (
              <span
                className={`hl-${span.kind}`}
                key={`${span.from}-${spanIndex}`}
                data-hl-kind={span.kind}
                data-hl-span={`${span.from}-${span.to}`}
              >
                {row.raw.slice(span.from, span.to)}
              </span>
            ))}
            {/* 行尾占位：`pre` 里 `\n` 的宽度为 0（不参与排版），但保留它让
                「一行一个 div + 行尾 `\n`」的 DOM 语义与 textarea 的正文一致。 */}
            <span className="ed-hl-eol">{"\n"}</span>
          </div>
        );
      })}
    </pre>
  );
}

/** `memo`：正文 / tokenizer / 诊断不变时不做无谓重算（打字时每次 render 都会走到）。 */
const ScriptHighlight = memo(ScriptHighlightImpl);
export default ScriptHighlight;
