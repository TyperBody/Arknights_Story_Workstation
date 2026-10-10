/**
 * 插入向导（task-9 交付）：分类 → 可搜索的控制器 → 参数表单 → 预览 → 插入到光标。
 *
 * 由 `StoryEditorPage` 挂在 `.ed-wizard` 遮罩里的 `.ed-wizard-card` 中：
 * `<ControllerWizardPart model={model} open={open} onClose={onClose}
 *  onInsert={(line) => insertLineAtCaret(line)} initialCommand={wizardSeed} />`。
 *
 * `onInsert` 拿到的是一段**可直接插入的文本**（不带缩进、不带换行）；
 * `[Decision]` 之类需要成对写法的命令会一次给两行（`…\n[Predicate(…)]`）。
 * 字段/控件/滑杆范围都来自 `src/akstage/local/editorForms.js`。
 */
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import {
  assetsFor,
  buildLine,
  catalogByCategory,
  controllerOf,
  formFor,
  parseValues,
  presetsFor,
  type FormField,
  type Preset,
} from "../../../../src/akstage/local/editorForms.js";

/** 页面传过来的 props（与 `StoryEditorPage` 里的 `ControllerWizardProps` 对齐）。 */
export interface ControllerWizardProps {
  /** 编辑器模型（可空）。 */
  model?: unknown;
  /** 受控开合（缺省视为打开）；`false` 时渲染 null。 */
  open?: boolean;
  /** 关闭（Esc / 取消 / 遮罩点击 / 插入完成后都会调）。 */
  onClose?: () => void;
  /** 插入整段文本（多行用 `\n` 连接）。 */
  onInsert?: (line: string) => void;
  /** 打开时预选的控制器（例如光标处的 `[Cha`）。 */
  initialCommand?: string;
  /** 可选素材池。 */
  assets?: unknown;
  /** 可选素材缩略图 URL。 */
  resolveUrl?: (key: string) => string;
}

const S = {
  wrap: { display: "flex", flexDirection: "column", gap: 0, color: "var(--text-primary)" } as CSSProperties,
  head: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
  } as CSSProperties,
  title: { fontWeight: 600, fontSize: 14 } as CSSProperties,
  dim: { color: "var(--text-secondary)", fontSize: 11 } as CSSProperties,
  cols: { display: "grid", gridTemplateColumns: "300px 1fr", minHeight: 360, maxHeight: "62vh" } as CSSProperties,
  left: { borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 } as CSSProperties,
  right: { display: "flex", flexDirection: "column", minHeight: 0 } as CSSProperties,
  search: {
    margin: 10,
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "6px 9px",
    fontSize: 12,
  } as CSSProperties,
  list: { overflow: "auto", padding: "0 8px 10px", minHeight: 0 } as CSSProperties,
  catTitle: {
    color: "var(--text-secondary)",
    fontSize: 11,
    margin: "8px 4px 4px",
    letterSpacing: 1,
  } as CSSProperties,
  item: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    width: "100%",
    textAlign: "left",
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid transparent",
    borderRadius: 6,
    padding: "4px 7px",
    fontSize: 12,
    cursor: "pointer",
  } as CSSProperties,
  itemOn: { background: "var(--bg-tertiary)", borderColor: "var(--accent)" } as CSSProperties,
  body: { overflow: "auto", padding: "10px 14px", minHeight: 0, flex: 1 } as CSSProperties,
  row: { display: "grid", gridTemplateColumns: "140px 1fr", gap: 8, alignItems: "center", marginBottom: 7 } as CSSProperties,
  label: { color: "var(--text-secondary)", fontSize: 12 } as CSSProperties,
  input: {
    width: "100%",
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    padding: "4px 7px",
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  } as CSSProperties,
  select: {
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    padding: "4px 7px",
    fontSize: 12,
    maxWidth: 280,
  } as CSSProperties,
  field: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } as CSSProperties,
  slider: { flex: 1, minWidth: 60, accentColor: "var(--accent)" } as CSSProperties,
  chip: {
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "1px 7px",
    fontSize: 11,
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  } as CSSProperties,
  note: { color: "var(--text-secondary)", fontSize: 11, lineHeight: 1.55 } as CSSProperties,
  preview: {
    margin: 0,
    padding: "8px 10px",
    background: "var(--bg-primary)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.65,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  } as CSSProperties,
  foot: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    borderTop: "1px solid var(--border)",
  } as CSSProperties,
  btn: {
    background: "var(--accent)",
    color: "#1a1a1a",
    border: "none",
    borderRadius: 6,
    padding: "5px 14px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  } as CSSProperties,
  btnGhost: {
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "5px 10px",
    fontSize: 12,
    cursor: "pointer",
  } as CSSProperties,
} satisfies Record<string, CSSProperties>;

/** 值 → 输入框文本。 */
function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(";");
  return String(value);
}

/** 字段默认值（新建一条指令时的起点）。 */
function defaultOf(field: FormField): unknown {
  if (field.type === "number") return typeof field.default === "number" ? field.default : 0;
  if (field.type === "bool") return typeof field.default === "boolean" ? field.default : false;
  if (field.type === "enum") return String(field.default ?? field.options?.[0] ?? "");
  if (field.type === "vector") return String(field.default ?? "");
  return typeof field.default === "string" ? field.default : "";
}

/** 一个字段的控件（与检视器同一套映射：开关 / 滑杆 / 下拉 / 素材 / 多行）。 */
function WizardField(props: {
  field: FormField;
  value: unknown;
  assets?: unknown;
  onChange: (value: unknown) => void;
}): ReactNode {
  const { field, value, assets, onChange } = props;
  const disabled = !field.engineRead;
  const options = field.options ?? [];
  const pool = useMemo(
    () => (field.type === "path" ? assetsFor(field.name, assets, 200) : []),
    [field.name, field.type, assets],
  );
  const [picker, setPicker] = useState(false);

  if (field.type === "note") {
    return (
      <div style={{ ...S.note, marginBottom: 8 }}>
        <strong>{field.label}</strong>：{field.hint}
      </div>
    );
  }

  let control: ReactNode;
  if (field.type === "bool") {
    control = (
      <label style={{ ...S.field, cursor: disabled ? "not-allowed" : "pointer" }}>
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          style={{ width: 32, height: 16, accentColor: "var(--accent)" }}
        />
        <span style={S.dim}>{value === true ? "开" : "关"}</span>
      </label>
    );
  } else if (field.type === "number") {
    const numeric = typeof value === "number" ? value : Number(toText(value)) || 0;
    const range = field.range ?? null;
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
            onChange={(event) => onChange(Number(event.target.value))}
          />
        ) : null}
        <input
          type="number"
          style={{ ...S.input, width: 82 }}
          value={numeric}
          step={range && !field.integerish ? range[2] : 1}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === "" ? 0 : Number(event.target.value))}
        />
        <span style={S.chip} title="范围来自官方语料实测">
          {range ? `${range[0]}–${range[1]}` : field.constant !== undefined ? `恒为 ${field.constant}` : "手输"}
        </span>
      </div>
    );
  } else if (field.type === "enum" && options.length > 0) {
    const text = toText(value);
    control = (
      <div style={S.field}>
        <select
          style={S.select}
          value={options.includes(text) ? text : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">（未设置）</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input style={S.input} value={text} onChange={(event) => onChange(event.target.value)} />
      </div>
    );
  } else if (field.type === "path") {
    control = (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={S.field}>
          <input
            style={S.input}
            value={toText(value)}
            list={pool.length && !picker ? "ed-wizard-assets" : undefined}
            placeholder={field.hint}
            onChange={(event) => onChange(event.target.value)}
          />
          {pool.length > 0 && (
            <button type="button" style={S.btnGhost} onClick={() => setPicker((open) => !open)}>
              从素材里选
            </button>
          )}
        </div>
        {pool.length > 0 && !picker && (
          <datalist id="ed-wizard-assets">
            {pool.slice(0, 60).map((key) => (
              <option key={key} value={key} />
            ))}
          </datalist>
        )}
        {picker && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 110, overflow: "auto" }}>
            {pool.slice(0, 80).map((key) => (
              <button
                key={key}
                type="button"
                style={{ ...S.btnGhost, padding: "2px 7px", fontSize: 11 }}
                onClick={() => {
                  onChange(key);
                  setPicker(false);
                }}
              >
                {key}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  } else if (field.multiline) {
    control = (
      <textarea
        style={{ ...S.input, minHeight: 52, resize: "vertical" }}
        value={toText(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else {
    control = (
      <input
        style={S.input}
        value={toText(value)}
        placeholder={field.separator ? `多个值用 ${field.separator} 分隔` : field.hint}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <div style={S.row}>
      <div style={S.label} title={field.hint}>
        {field.label}
        {field.group === "optional" ? "" : " *"}
      </div>
      <div style={{ minWidth: 0 }}>
        {control}
        <div style={S.note}>
          <code>{field.name}</code>
          {field.engineRead ? "" : ` · ${field.reason ?? "引擎不读"}`}
          {field.corpusCount ? ` · 语料 ${field.corpusCount} 次` : ""}
        </div>
      </div>
    </div>
  );
}

/**
 * 向导：分类 → 指令 → 参数 → 预览 →「插入」。
 */
export default function ControllerWizard(props: ControllerWizardProps): ReactNode {
  const { model = null, open = true, onClose, onInsert, initialCommand, assets } = props;
  const groups = useMemo(() => catalogByCategory(model), [model]);
  const [query, setQuery] = useState("");

  /**
   * 打开时预选一条命令（渲染期求值，避免级联渲染）：
   * 光标处的半截命令（页面给的 `initialCommand`）→ `dialog` → 目录第一条。
   */
  const seed = useMemo(() => {
    if (!open) return "";
    const seeded = String(initialCommand ?? "").replace(/^\[/, "").toLowerCase();
    const all = groups.flatMap((group) => group.items);
    const hit = (seeded && all.find((item) => item.command === seeded || item.command.startsWith(seeded)))
      || all.find((item) => item.command === "dialog")
      || all[0];
    return hit ? hit.command : "";
  }, [open, initialCommand, groups]);
  const [picked, setPicked] = useState<string>("");
  const command = picked || seed;
  const category = useMemo(
    () => groups.find((group) => group.items.some((item) => item.command === command))?.category ?? "",
    [groups, command],
  );

  const form = useMemo(() => (command ? formFor(command, model) : null), [command, model]);
  const spec = useMemo(() => (command ? controllerOf(command, model) : null), [command, model]);
  const presets = useMemo(() => (command ? presetsFor(command, model) : []), [command, model]);

  /**
   * 值表的起点：**必填**字段给缺省值 → 再用 `spec.example` 里显式写出的键覆盖。
   * 可选字段一律留空（`formatLine` 不会写它们），这样预览就是"最小可用的一行"；
   * 想一次看全所有控件时点上面的「模板 → 全字段」。
   */
  const initialDraft = useCallback((target: string): Record<string, unknown> => {
    const targetForm = target ? formFor(target, model) : null;
    if (!targetForm) return {};
    /** @type {Record<string, unknown>} */
    const next: Record<string, unknown> = {};
    for (const field of targetForm.requiredFields) {
      if (field.name === "$note") continue;
      if (field.name === "text") { next.text = ""; continue; }
      next[field.name] = defaultOf(field);
    }
    if (targetForm.example.trim()) {
      const parsed = parseValues(targetForm.example, model);
      if (parsed.command === target) {
        const known = new Set(targetForm.fields.map((field) => field.name));
        for (const [key, value] of Object.entries(parsed.values)) {
          if (known.has(key)) next[key] = value;   // 含正文（`text`）
        }
      }
    }
    return next;
  }, [model]);

  /** 草稿绑定在"命令 + 打开状态"上：换命令/重新打开就重置（渲染期重置）。 */
  const [draftState, setDraftState] = useState<{ key: string; values: Record<string, unknown> }>(
    () => ({ key: command, values: initialDraft(command) }),
  );
  const [presetIndex, setPresetIndex] = useState(-1);
  if (draftState.key !== command) {
    setDraftState({ key: command, values: initialDraft(command) });
    if (presetIndex !== -1) setPresetIndex(-1);
  }
  const draft = draftState.values;
  const setDraft = useCallback(
    (next: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>)) => {
      setDraftState((prev) => ({ key: prev.key, values: typeof next === "function" ? next(prev.values) : next }));
    },
    [],
  );

  const applyPreset = useCallback((index: number) => {
    const preset: Preset | undefined = presets[index];
    if (!preset) return;
    const loaded = parseValues(preset.line.split("\n")[0] ?? "", model);
    setDraftState({ key: command, values: { ...loaded.values } });
    setPresetIndex(index);
  }, [presets, model, command]);

  /**
   * 预览（插入什么就显示什么）：
   * - 先按表单值建首行；
   * - 若当前选择的是"成对预设"（`Decision` → `Predicate`），把后续行补上；
   * - 首行建不出来（如必填为空）时，退化成预设原文。
   */
  const preview = useMemo(() => {
    if (!form) return "";
    /** @type {Record<string, unknown>} */
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (value === undefined || value === null) continue;
      if (value === "" && key !== "text" && key !== "values" && key !== "options") continue;
      values[key] = value;
    }
    const preset = presets[presetIndex];
    const built = buildLine(form.command, values, model);
    if (built && preset && preset.line.includes("\n")) return `${built}\n${preset.line.split("\n").slice(1).join("\n")}`;
    if (built) return built;
    return preset ? preset.line : "";
  }, [form, draft, model, presets, presetIndex]);

  const insert = useCallback(() => {
    if (!preview || !onInsert) return;
    onInsert(preview);
    if (onClose) onClose();
  }, [preview, onInsert, onClose]);

  const onKeyDown = useCallback(
    (event: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault: () => void }) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (onClose) onClose();
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        insert();
      }
    },
    [insert, onClose],
  );

  if (!open) return null;

  const wanted = query.trim().toLowerCase();
  const filtered = wanted
    ? { "搜索结果": groups.flatMap((group) => group.items).filter((item) => item.search.includes(wanted)) }
    : Object.fromEntries(groups.map((group) => [group.label, category && group.category !== category ? [] : group.items]));

  return (
    <div style={{ ...S.wrap, outline: "none" }} data-editor-part="wizard-body" tabIndex={-1} onKeyDown={onKeyDown}>
      <div style={S.head}>
        <span style={S.title}>插入控制器</span>
        <span style={S.dim}>分类 → 指令 → 参数 → 预览</span>
        <span style={{ flex: 1 }} />
        <span style={S.dim}>Ctrl+Enter 插入 · Esc 关闭</span>
        {onClose && (
          <button type="button" style={S.btnGhost} onClick={onClose}>
            关闭
          </button>
        )}
      </div>

      <div style={S.cols}>
        <div style={S.left}>
          <input
            autoFocus
            style={S.search}
            placeholder="搜索命令（如 character / 立绘 / delay）"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div style={S.list}>
            {Object.entries(filtered).map(([label, items]) =>
              items.length === 0 ? null : (
                <div key={label}>
                  <div style={S.catTitle}>{label}</div>
                  {items.map((item) => (
                    <button
                      key={item.command}
                      type="button"
                      style={{ ...S.item, ...(item.command === command ? S.itemOn : {}) }}
                      onClick={() => setPicked(item.command)}
                      onDoubleClick={() => onInsert && onInsert(buildLine(item.command, {}, model))}
                    >
                      <code style={{ fontSize: 12 }}>{item.canonical}</code>
                      <span style={S.dim}>
                        {item.requiredCount} 必填 · {item.optionalCount} 可选
                        {item.engineReadCount === 0 ? " · 运行时未注册" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ),
            )}
            {Object.values(filtered).every((items) => items.length === 0) && (
              <div style={S.note}>没有匹配的命令。</div>
            )}
          </div>
        </div>

        <div style={S.right}>
          <div style={S.body}>
            {!form && <div style={S.note}>左侧挑一条控制器。</div>}
            {form && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <code style={{ fontSize: 13, color: "var(--accent)" }}>{form.canonical}</code>
                  <span style={S.chip}>{form.category}</span>
                  <span style={{ ...S.note, flex: 1 }}>{form.summary}</span>
                  {presets.length > 0 && (
                    <select
                      style={S.select}
                      value={presetIndex}
                      onChange={(event) => applyPreset(Number(event.target.value))}
                      title="模板：参数取自真实语料行（含命名写法与高频写法）"
                    >
                      <option value={-1}>预设…</option>
                      {presets.map((preset, index) => (
                        <option key={preset.name} value={index}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {spec && spec.runtimeRegistered === false && (
                  <div style={{ ...S.note, color: "var(--error)", marginBottom: 6 }}>
                    运行时没有注册这条指令：写了会被 warn 跳过；用于离线编辑/占位。
                  </div>
                )}
                {form.fields.map((field) => (
                  <WizardField
                    key={field.name}
                    field={field}
                    value={draft[field.name]}
                    assets={assets}
                    onChange={(value) => setDraft((prev) => ({ ...prev, [field.name]: value }))}
                  />
                ))}
              </>
            )}
          </div>
          <div style={{ padding: "0 14px 10px" }}>
            <div style={{ ...S.note, marginBottom: 3 }}>预览：</div>
            <pre style={S.preview}>{preview || "（先选一条控制器）"}</pre>
          </div>
        </div>
      </div>

      <div style={S.foot}>
        <span style={{ ...S.note, flex: 1 }}>
          {form
            ? `${presetIndex >= 0 ? "按语料模板插入" : "按当前参数插入"}：${preview.split("\n").length} 行`
            : "未选择"}
        </span>
        <button type="button" style={S.btnGhost} onClick={onClose} disabled={!onClose}>
          取消
        </button>
        <button type="button" style={S.btn} onClick={insert} disabled={!onInsert || !form}>
          {presetIndex >= 0 ? "插入为模板" : "插入"}
        </button>
      </div>
    </div>
  );
}
