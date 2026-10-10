/**
 * `BranchGraph` 的演示挂载（只给 `/branch-demo.html` 用）。
 *
 * props 与编辑器页完全一致：
 *   `{text, caretLine, onJumpToLine, onPatch, height, onClose}`。
 * 这里带一个可编辑 textarea + 若干「光标跳行」按钮，方便截图时切到不同分支；
 * `onPatch` 走与编辑器页相同的语义（整篇替换 + 光标定位）。
 */
import { useEffect, useState } from "react";
import BranchGraph from "./components/editor/BranchGraph";

/** 与内置样例同形的两分支脚本（无 `[Character]` 素材依赖，纯文本即可）。 */
const DEMO_SAMPLE = [
  '[HEADER(key="fanfic_demo")]',
  '[Blocker(a=1, r=0, g=0, b=0, fadetime=0, block=true)]',
  '[Dialog]',
  '[Background(image="bg_black", fadetime=0, block=true)]',
  '[name="杜宾"]  这里是……？',
  '[Decision(options="跟着她走;先问清楚", values="1;2")]',
  '[Predicate(references="1")]',
  '[name="阿米娅"]  这边走，博士。',
  '[Predicate(references="2")]',
  '[name="阿米娅"]  先别急，我把情况说清楚。',
  '[Predicate(references="1;2")]',
  '[name="陈"]  都到齐了。',
  '[Blocker(a=1, r=0, g=0, b=0, fadetime=1.5, block=true)]',
].join("\n");

const CARET_STOPS = [5, 7, 9, 12];

export default function BranchDemoPage() {
  const [text, setText] = useState(DEMO_SAMPLE);
  const [caret, setCaret] = useState(9);
  const [sampleLoaded, setSampleLoaded] = useState(false);

  // `?sample=<绝对路径>` → 用磁盘上的真脚本（截图更贴近实际）；失败就保持内置样例。
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("sample");
    if (!wanted) return;
    let alive = true;
    void fetch(`/@fs${wanted.startsWith("/") ? wanted : `/${wanted}`}`)
      .then((response) => (response.ok ? response.text() : ""))
      .then((value) => {
        if (!alive || !value.trim()) return;
        setText(value);
        setSampleLoaded(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div style={{ padding: "12px 14px", display: "grid", gap: 10, background: "#0f1115", color: "#e8e8e8" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
        <strong>BranchGraph 演示</strong>
        <span style={{ opacity: 0.7 }}>{`光标行 ${caret} · 文本 ${text.split("\n").length} 行`}</span>
        {sampleLoaded ? <span style={{ color: "#7ee787" }}>已载入磁盘样例</span> : null}
        {CARET_STOPS.map((line) => (
          <button key={line} type="button" style={buttonStyle} onClick={() => setCaret(line)}>
            {`光标 → 第 ${line} 行`}
          </button>
        ))}
      </div>
      <textarea
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        style={{
          width: "100%",
          minHeight: 220,
          background: "#14161c",
          color: "#e8e8e8",
          border: "1px solid #2a2d36",
          borderRadius: 6,
          padding: 8,
          font: "12px/1.45 ui-monospace, monospace",
        }}
      />
      <BranchGraph
        text={text}
        caretLine={caret}
        height={340}
        onJumpToLine={(line) => setCaret(line)}
        onPatch={(next, nextCaret) => {
          setText(next);
          if (typeof nextCaret === "number") setCaret(nextCaret);
        }}
        onClose={() => setCaret(Math.max(1, caret - 1))}
      />
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "#22262f",
  color: "#e8e8e8",
  border: "1px solid #333846",
  borderRadius: 5,
  padding: "3px 9px",
  cursor: "pointer",
};
