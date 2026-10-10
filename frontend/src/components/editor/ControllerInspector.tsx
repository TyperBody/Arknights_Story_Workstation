/**
 * 控制器检视器（task-9 交付）：把光标所在的那一行读成**表单**，改完写回整行。
 *
 * 由 `StoryEditorPage` 挂载（`import.meta.glob` + lazy + Suspense）：
 * `<ControllerInspectorPart model={model} line={caretLineText} lineIndex={caretLineIndex}
 *  onApply={onInspectorApply} height={190} />`。`onApply(next)` 拿到的是
 * **完整整行**（含 `]` 之后的台词正文）。
 *
 * 字段、控件类型、滑杆范围、下拉候选、灰掉原因全部来自
 * `src/akstage/local/editorForms.js`（`CONTROLLERS` 的派生结果 + 语料实测表），
 * 这里只负责画控件与收集值；`model` 缺省/为 null 时 `editorForms` 会退回内置表。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import {
  applyForm,
  assetsFor,
  controllerOf,
  formFor,
  parseValues,
  presetsFor,
  type FormField,
  type Preset,
} from "../../../../src/akstage/local/editorForms.js";

/** 页面传过来的 props（与 `StoryEditorPage` 里的 `ControllerInspectorProps` 对齐）。 */
export interface ControllerInspectorProps {
  /** 编辑器模型（可空；空则用 editorForms 的内置 `CONTROLLERS`）。 */
  model?: unknown;
  /** 光标所在行的**原文**。 */
  line: string;
  /** 行下标（页面传 `caret.line - 1`，**0 起**；仅用于显示）。 */
  lineIndex?: number;
  /** 应用整行（含尾随正文）。 */
  onApply?: (next: string) => void;
  /** 初始高度（超出滚动）。 */
  height?: number;
  /** 可选素材池 `{images,backgrounds,characters,music,sounds}`（给了就能在候选里排前面）。 */
  assets?: unknown;
  /** 可选：素材缩略图 URL（给了才显示缩略图）。 */
  resolveUrl?: (key: string) => string;
  /** 可选：预览态变化回调（`null` = 未改动）。 */
  onDirty?: (preview: string | null) => void;
}

// ── 样式（沿用页面调色板；只用行内样式，避免动 browser.css） ──────────────

const S = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    minHeight: 120,
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-secondary)",
    overflow: "hidden",
  } as CSSProperties,
  head: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    padding: "6px 10px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-tertiary)",
    fontSize: 12,
  } as CSSProperties,
  title: { color: "var(--text-primary)", fontWeight: 600 } as CSSProperties,
  dim: { color: "var(--text-secondary)", fontSize: 11 } as CSSProperties,
  body: { display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px", overflow: "auto", flex: 1 } as CSSProperties,
  row: { display: "grid", gridTemplateColumns: "132px 1fr", gap: 8, alignItems: "center" } as CSSProperties,
  label: { color: "var(--text-secondary)", fontSize: 12, lineHeight: "18px", overflow: "hidden", textOverflow: "ellipsis" } as CSSProperties,
  field: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } as CSSProperties,
  input: {
    flex: 1,
    minWidth: 0,
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    padding: "3px 6px",
    fontSize: 12,
    fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  } as CSSProperties,
  select: {
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    padding: "3px 6px",
    fontSize: 12,
    maxWidth: 168,
  } as CSSProperties,
  slider: { flex: 1, minWidth: 60, accentColor: "var(--accent)" } as CSSProperties,
  num: { width: 74, ...({} as CSSProperties) } as CSSProperties,
  btn: {
    whiteSpace: "nowrap",
    background: "var(--accent)",
    color: "#1a1a1a",
    border: "none",
    borderRadius: 5,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  } as CSSProperties,
  btnGhost: {
    whiteSpace: "nowrap",
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    padding: "4px 8px",
    fontSize: 12,
    cursor: "pointer",
  } as CSSProperties,
  preview: {
    margin: 0,
    padding: "6px 8px",
    background: "var(--bg-primary)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-primary)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    maxHeight: 96,
    overflow: "auto",
  } as CSSProperties,
  note: { color: "var(--text-secondary)", fontSize: 11, lineHeight: 1.5 } as CSSProperties,
  chip: {
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "1px 7px",
    fontSize: 11,
    color: "var(--text-secondary)",
  } as CSSProperties,
} satisfies Record<string, CSSProperties>;

/** 值 → 表单里的字符串（数字/布尔/数组都能放进 input）。 */
function toInputText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(";");
  return String(value);
}

/** 「从素材里选」下拉：可搜索、点一下填进输入框。 */
function AssetPicker(props: {
  keys: string[];
  resolveUrl?: (key: string) => string;
  onPick: (key: string) => void;
  onClose: () => void;
}): ReactNode {
  const { keys, resolveUrl, onPick, onClose } = props;
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    const list = wanted ? keys.filter((key) => key.toLowerCase().includes(wanted)) : keys;
    return list.slice(0, 60);
  }, [keys, query]);
  return (
    <div style={{ ...S.field, flexDirection: "column", alignItems: "stretch", gap: 4, marginTop: 4 }}>
      <div style={S.field}>
        <input
          autoFocus
          style={{ ...S.input, fontFamily: "inherit" }}
          placeholder="搜索素材 key（如 bg_ / char_）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && shown[0]) onPick(shown[0]);
          }}
        />
        <button type="button" style={S.btnGhost} onClick={onClose}>
          收起
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 132, overflow: "auto" }}>
        {shown.length === 0 && <span style={S.note}>没有匹配的素材（可以直接手输 key）</span>}
        {shown.map((key) => (
          <button
            key={key}
            type="button"
            title={key}
            style={{ ...S.btnGhost, padding: "2px 6px", display: "inline-flex", alignItems: "center", gap: 5 }}
            onClick={() => onPick(key)}
          >
            {resolveUrl ? <img src={resolveUrl(key)} alt="" style={{ width: 18, height: 18, objectFit: "cover", borderRadius: 3 }} /> : null}
            <span style={{ fontSize: 11 }}>{key}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 一个字段的控件。 */
function FieldRow(props: {
  field: FormField;
  value: unknown;
  model: unknown;
  assets?: unknown;
  resolveUrl?: (key: string) => string;
  onChange: (name: string, value: unknown) => void;
}): ReactNode {
  const { field, value, model, assets, resolveUrl, onChange } = props;
  const [picker, setPicker] = useState(false);
  const disabled = !field.engineRead;
  const options = field.options ?? [];
  const pool = useMemo(
    () => (field.type === "path" ? assetsFor(field.name, assets, 200) : []),
    [field.name, field.type, assets],
  );

  if (field.type === "note") {
    return (
      <div style={{ ...S.row, gridTemplateColumns: "1fr" }}>
        <div style={S.note}>
          <strong style={{ color: "var(--text-secondary)" }}>{field.label}</strong>：{field.hint}
        </div>
      </div>
    );
  }

  /** 值的类型归一：布尔 / 数字 / 字符串。 */
  const set = (next: unknown) => onChange(field.name, next);

  let control: ReactNode = null;
  if (field.type === "bool") {
    control = (
      <label style={{ ...S.field, gap: 8, cursor: disabled ? "not-allowed" : "pointer" }}>
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => set(event.target.checked)}
          style={{ width: 32, height: 16, accentColor: "var(--accent)" }}
        />
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{value === true ? "开" : "关"}</span>
      </label>
    );
  } else if (field.type === "number") {
    const numeric = typeof value === "number" ? value : Number(toInputText(value)) || 0;
    const range = field.range;
    control = (
      <div style={S.field}>
        {range ? (
          <input
            type="range"
            style={S.slider}
            min={range[0]}
            max={range[1]}
            step={field.integerish ? 1 : range[2]}
            value={numeric}
            disabled={disabled}
            onChange={(event) => set(Number(event.target.value))}
          />
        ) : null}
        <input
          type="number"
          style={{ ...S.input, flex: "none", width: 78 }}
          value={Number.isFinite(numeric) ? numeric : 0}
          step={range && !field.integerish ? range[2] : 1}
          disabled={disabled}
          onChange={(event) => set(event.target.value === "" ? 0 : Number(event.target.value))}
        />
        {flatRange(range ?? null, field)}
      </div>
    );
  } else if (field.type === "enum" && options.length > 0) {
    const text = toInputText(value);
    const known = options.includes(text);
    control = (
      <div style={S.field}>
        <select
          style={S.select}
          value={known ? text : ""}
          disabled={disabled}
          onChange={(event) => set(event.target.value)}
        >
          <option value="">（未设置）</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input
          style={{ ...S.input, maxWidth: 160 }}
          placeholder="或手输"
          value={text}
          disabled={disabled}
          onChange={(event) => set(event.target.value)}
        />
      </div>
    );
  } else if (field.type === "path") {
    control = (
      <div style={{ flexDirection: "column", ...S.field, alignItems: "stretch" }}>
        <div style={S.field}>
          <input
            style={S.input}
            value={toInputText(value)}
            disabled={disabled}
            list={pool.length && !picker ? `ed-assets-${field.name}` : undefined}
            placeholder={pool.length ? "输入 key，或点右侧挑选" : "输入 key"}
            onChange={(event) => set(event.target.value)}
          />
          {pool.length > 0 && (
            <button type="button" style={S.btnGhost} disabled={disabled} onClick={() => setPicker((open) => !open)}>
              从素材里选
            </button>
          )}
        </div>
        {pool.length > 0 && !picker && (
          <datalist id={`ed-assets-${field.name}`}>
            {pool.slice(0, 60).map((key) => (
              <option key={key} value={key} />
            ))}
          </datalist>
        )}
        {picker && (
          <AssetPicker
            keys={pool}
            resolveUrl={resolveUrl}
            onPick={(key) => {
              set(key);
              setPicker(false);
            }}
            onClose={() => setPicker(false)}
          />
        )}
      </div>
    );
  } else if (field.multiline) {
    control = (
      <textarea
        style={{ ...S.input, minHeight: field.tail ? 58 : 46, resize: "vertical" }}
        value={toInputText(value)}
        disabled={disabled}
        title={field.hint}
        onChange={(event) => set(event.target.value)}
      />
    );
  } else {
    control = (
      <div style={S.field}>
        <input
          style={S.input}
          value={toInputText(value)}
          disabled={disabled}
          placeholder={field.separator ? `多个值用 ${field.separator} 分隔` : ""}
          onChange={(event) => set(event.target.value)}
        />
        {field.separator ? <span style={S.chip}>{field.separator}</span> : null}
      </div>
    );
  }

  void model;
  return (
    <>
      <div style={S.row}>
        <div style={S.label} title={field.hint}>
          {field.label}
          <span style={{ color: "var(--accent)" }}>{field.group === "optional" ? "" : " *"}</span>
        </div>
        <div style={{ minWidth: 0 }}>
          {control}
          <div style={S.note}>
            <code style={{ color: "var(--text-secondary)" }}>{field.name}</code>
            {field.type !== "bool" ? ` · ${field.type === "path" ? "素材 key" : field.type === "number" ? "数值" : field.type === "enum" ? "枚举" : "文本"}` : ""}
            {field.engineRead ? "" : ` · ${field.reason ?? "引擎不读"}`}
            {field.constant !== undefined ? ` · 语料里恒为 ${field.constant}` : ""}
            {field.corpusCount ? ` · 语料 ${field.corpusCount} 次` : ""}
          </div>
        </div>
      </div>
      {picker ? null : null}
    </>
  );
}

/** 范围提示：`[min, max, step]`。 */
function flatRange(range: [number, number, number] | null, field: FormField): ReactNode {
  if (!range) return <span style={S.chip}>{field.constant !== undefined ? `恒为 ${field.constant}` : "手输"}</span>;
  return (
    <span style={S.chip} title="范围来自官方语料实测">
      {range[0]}–{range[1]}
    </span>
  );
}

/**
 * 检视器：读光标行 → 表单 → 预览 →「应用」（或 Ctrl+Enter）。
 */
export default function ControllerInspector(props: ControllerInspectorProps): ReactNode {
  const { model = null, line, lineIndex, onApply, height, assets, resolveUrl, onDirty } = props;
  const parsed = useMemo(() => parseValues(line, model), [line, model]);
  const command = parsed.command;
  const spec = useMemo(() => (command ? controllerOf(command, model) : null), [command, model]);
  const form = useMemo(() => (spec ? formFor(spec.command, model) : null), [spec, model]);
  const presets = useMemo(() => (spec ? presetsFor(spec.command, model) : []), [spec, model]);

  /**
   * 草稿状态：**绑定在源行上**。外部编辑（换行/撤销/保存后重载）改了 `line`，
   * 渲染期就把草稿重置回源行的值 —— 比 `useEffect` 少一次级联渲染，
   * 也避免"用户刚输一半就被外部刷新覆盖"的竞态。
   */
  const [draft, setDraft] = useState<{ src: string; values: Record<string, unknown> }>(
    () => ({ src: line, values: { ...parsed.values } }),
  );
  if (draft.src !== line) setDraft({ src: line, values: { ...parsed.values } });
  const values = draft.values;
  const setValues = useCallback((next: Record<string, unknown>) => {
    setDraft((prev) => ({ src: prev.src, values: next }));
  }, []);

  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(parsed.values), [values, parsed]);
  const preview = useMemo(() => applyForm(line, values, { model }), [line, values, model]);

  useEffect(() => {
    if (onDirty) onDirty(dirty ? preview : null);
  }, [dirty, preview, onDirty]);

  const apply = useCallback(() => {
    if (!onApply) return;
    onApply(preview);
  }, [onApply, preview]);

  const onKeyDown = useCallback(
    (event: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault: () => void }) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        apply();
      }
    },
    [apply],
  );

  const setValue = useCallback(
    (name: string, value: unknown) => {
      setDraft((prev) => ({ src: prev.src, values: { ...prev.values, [name]: value } }));
    },
    [],
  );

  const reset = useCallback(() => setValues({ ...parsed.values }), [parsed, setValues]);

  /** 预设：整行（可能两行，如 Decision + Predicate）→ 值表 + 预填预览。 */
  const applyPreset = useCallback(
    (preset: Preset) => {
      const first = (preset.line.split("\n")[0] ?? "").trim();
      const loaded = parseValues(first, model);
      setValues({ ...parsed.values, ...loaded.values });
    },
    [model, parsed, setValues],
  );

  // 没有控制器的一行：旁白（含裸旁白）也给一个**正文框**，注释/空行只读。
  if (!parsed.command) {
    /** 裸旁白：整行就是正文（`parseValues` 已把它放进 `values.text`）。 */
    const body = parsed.tail;
    const editable = parsed.kind === "narration" && line.trim() !== "" && !line.trim().startsWith("//");
    return (
      <div style={S.wrap} data-editor-part="inspector-body" onKeyDown={onKeyDown}>
        <div style={S.head}>
          <span style={S.title}>{parsed.kind === "dialogue" ? "对白" : parsed.kind === "comment" ? "注释" : "旁白"}</span>
          <span style={{ flex: 1 }} />
          {editable ? (
            <button type="button" style={S.btn} onClick={apply} disabled={!onApply || !dirty} title="Ctrl+Enter">
              应用
            </button>
          ) : null}
          {editable ? (
            <button type="button" style={S.btnGhost} onClick={reset} disabled={!dirty}>
              还原
            </button>
          ) : null}
          {lineIndex !== undefined ? <span style={S.dim}>第 {lineIndex + 1} 行</span> : null}
        </div>
        <div style={S.body}>
          {editable ? (
            <>
              <div style={S.note}>旁白行：只改正文（`]` 之后的部分逐字节保留）。</div>
              <textarea
                style={{ ...S.input, minHeight: 64, resize: "vertical" }}
                value={toInputText(values.text ?? body.replace(/^\s+/, ""))}
                onChange={(event) => setValue("text", event.target.value)}
              />
            </>
          ) : (
            <div style={S.note}>
              {parsed.kind === "blank" ? "空行（没有可改的控制器）。" : "这一行是注释；用「插入」向导加一条控制器。"}
            </div>
          )}
          <pre style={S.preview}>{preview || line || "（空行）"}</pre>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ ...S.wrap, maxHeight: height && height > 120 ? height : undefined }}
      data-editor-part="inspector-body"
      onKeyDown={onKeyDown}
    >
      <div style={S.head}>
        <span style={S.title}>{form?.canonical ?? parsed.canonical ?? command}</span>
        {form ? <span style={S.chip}>{form.category}</span> : null}
        {spec && spec.runtimeRegistered === false ? <span style={{ ...S.chip, color: "var(--error)" }}>运行时未注册</span> : null}
        <span style={{ flex: 1 }} />
        {dirty ? <span style={{ ...S.chip, color: "var(--accent)" }}>已修改</span> : null}
        <button type="button" style={S.btn} onClick={apply} disabled={!onApply || !dirty} title="Ctrl+Enter">
          应用
        </button>
        <button type="button" style={S.btnGhost} onClick={reset} disabled={!dirty}>
          还原
        </button>
        <select
          style={S.select}
          value=""
          onChange={(event) => {
            const found = presets[Number(event.target.value)];
            if (found) applyPreset(found);
            event.target.value = "";
          }}
          title="模板（预设）：参数取自真实语料行；选中即填入表单，再点「应用」写回"
        >
          <option value="">预设…</option>
          {presets.map((preset, index) => (
            <option key={preset.name} value={index}>
              {preset.name}
            </option>
          ))}
        </select>
        {lineIndex !== undefined ? <span style={S.dim}>第 {lineIndex + 1} 行</span> : null}
      </div>

      <div style={S.body}>
        {form ? (
          form.fields.map((field) => (
            <FieldRow
              key={field.name}
              field={field}
              model={model}
              assets={assets}
              resolveUrl={resolveUrl}
              value={values[field.name]}
              onChange={setValue}
            />
          ))
        ) : (
          <div style={S.note}>这条命令不在字段表里（未知指令）——只能原样编辑。</div>
        )}
        <div>
          <div style={{ ...S.note, marginBottom: 3 }}>预览（Ctrl+Enter 应用）：</div>
          <pre style={S.preview}>{preview}</pre>
        </div>
        {form?.hint ? <div style={S.note}>{form.hint}</div> : null}
        {form?.engineRef ? (
          <div style={S.note}>
            引擎实现：
            <code>{form.engineRef}</code>
          </div>
        ) : null}
      </div>
    </div>
  );
}
