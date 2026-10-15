import { useCallback, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t, useT } from "../../i18n/index.ts";
import {
  PACK_TEMPLATES,
  packTemplateBody,
  templateLabelKey,
  validatePackId,
  type PackDraft,
  type PackTemplateId,
} from "./packTemplates";

/**
 * 「新建剧本…」对话框（task-11）。列表页与编辑器空态共用**同一个**组件。
 *
 * 只做两件事：收集字段（id/标题/分类/简介/模板）与调用 Rust `create_library_pack`
 * （`<资源目录>/assets/library/<id>/{pack.json,script.txt}`，`.tmp` + rename）。
 * 模板正文与 id 校验在 `packTemplates.ts`（纯逻辑，Node selftest 直接 import）。
 *
 * DOM 契约（harness `_layout-create-check.mjs` 断言，**只增不改**）：
 * `[data-create-pack="1"]` / `[data-create-field="id|title|chapter|description|template"]`
 * / `[data-create-submit="1"]` / `[data-create-cancel="1"]` / `[data-create-error="1"]`。
 */

export interface CreatedPack {
  id: string;
  dir: string;
  created: boolean;
  scriptBytes: number;
}

export interface CreatePackDialogProps {
  /** 取消 / 创建完成后的收尾（创建成功时先给 `onCreated`）。 */
  onCancel?: () => void;
  /** 创建成功：页面据此刷新列表或跳到编辑器 `/editor/<id>`。 */
  onCreated?: (pack: CreatedPack, draft: PackDraft) => void;
  /** 预填的包 ID（编辑器空态里由当前 packId 带过来）。 */
  defaultId?: string;
  /** 打开对话框前就知道要开哪个模板。 */
  defaultTemplate?: PackTemplateId;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function CreatePackDialog({
  onCancel,
  onCreated,
  defaultId = "",
  defaultTemplate = "blank",
}: CreatePackDialogProps) {
  const tr = useT();
  const [draft, setDraft] = useState<PackDraft>({
    id: defaultId,
    title: "",
    chapter: "",
    description: "",
    template: defaultTemplate,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const idRef = useRef<HTMLInputElement>(null);

  const idError = useMemo(() => validatePackId(draft.id), [draft.id]);
  /** 实时校验提示（有内容才显示，避免刚打开就一片红）+ 提交失败的提示。 */
  const liveError = useMemo(() => {
    if (!idError || !draft.id) return "";
    const key = `editor.create.${idError}`;
    return tr(key, undefined, idError === "idRequired" ? "请填写包 ID。" : "包 ID 只能用字母、数字、下划线、短横线。");
  }, [draft.id, idError, tr]);
  const desktop = inTauri();

  const patch = useCallback(<K extends keyof PackDraft>(key: K, value: PackDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError("");
  }, []);

  /** 惰性取一次焦点（`autoFocus` 在弹层里偶发不生效）。 */
  const focusId = useCallback((node: HTMLInputElement | null) => {
    if (node && idRef.current !== node) {
      idRef.current = node;
      node.focus();
    }
  }, []);

  const cancel = useCallback(() => onCancel?.(), [onCancel]);

  const submit = useCallback(async () => {
    const code = validatePackId(draft.id);
    if (code) {
      setError(tr(`editor.create.${code}`, undefined, code === "idRequired" ? "请填写包 ID。" : "包 ID 只能用字母、数字、下划线、短横线。"));
      return;
    }
    if (!desktop) {
      setError(tr("editor.create.needDesktop", undefined, "新建剧本需要桌面版（Tauri）。"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const script = packTemplateBody(draft.template, draft.id);
      const created = await invoke<CreatedPack>("create_library_pack", {
        id: draft.id,
        title: draft.title,
        chapter: draft.chapter,
        description: draft.description,
        script,
      });
      onCreated?.({ ...created, id: created.id || draft.id }, draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [desktop, draft, onCreated, tr]);

  // `id` 变化时把标题留空 → 标题字段给了个"人话"缺省（`我的剧本`）。
  const titlePlaceholder = useMemo(
    () => (draft.id ? draft.id : t("editor.create.title", undefined, "新建剧本")),
    [draft.id]
  );

  return (
    <div className="create-pack-layer" data-create-pack="1" role="dialog" aria-modal="true"
      aria-label={tr("editor.create.title", undefined, "新建剧本")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div className="create-pack">
        <div className="create-pack-head">
          <h2>{tr("editor.create.title", undefined, "新建剧本")}</h2>
          <button className="create-pack-x" type="button" onClick={cancel} aria-label={tr("editor.create.cancel", undefined, "取消")}>
            ✕
          </button>
        </div>

        <label className="create-pack-row">
          <span>{tr("editor.create.id", undefined, "包 ID")}</span>
          <input
            ref={focusId}
            data-create-field="id"
            value={draft.id}
            spellCheck={false}
            placeholder="my_pack"
            onChange={(event) => patch("id", event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          <small>{tr("editor.create.idHint", undefined, "字母、数字、下划线；= 资源目录里的文件夹名")}</small>
        </label>

        <label className="create-pack-row">
          <span>{tr("editor.create.name", undefined, "标题")}</span>
          <input
            data-create-field="title"
            value={draft.title}
            placeholder={titlePlaceholder}
            onChange={(event) => patch("title", event.target.value)}
          />
        </label>

        <label className="create-pack-row">
          <span>{tr("editor.create.chapter", undefined, "分类")}</span>
          <input
            data-create-field="chapter"
            value={draft.chapter}
            placeholder={tr("editor.create.chapter", undefined, "分类")}
            onChange={(event) => patch("chapter", event.target.value)}
          />
        </label>

        <label className="create-pack-row">
          <span>{tr("editor.create.description", undefined, "简介")}</span>
          <textarea
            data-create-field="description"
            value={draft.description}
            rows={2}
            onChange={(event) => patch("description", event.target.value)}
          />
        </label>

        <div className="create-pack-row">
          <span>{tr("editor.create.template", undefined, "模板")}</span>
          <div className="create-pack-templates" data-create-field="template">
            {PACK_TEMPLATES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`create-pack-tpl${draft.template === entry.id ? " on" : ""}`}
                data-create-template={entry.id}
                aria-pressed={draft.template === entry.id}
                onClick={() => patch("template", entry.id)}
              >
                {tr(`editor.create.${templateLabelKey(entry.id)}`, undefined, entry.id)}
              </button>
            ))}
          </div>
        </div>

        {(liveError || error) && (
          <div className="create-pack-error" data-create-error="1" role="alert">
            {error || liveError}
          </div>
        )}

        <div className="create-pack-foot">
          <button className="nav-btn" type="button" data-create-cancel="1" onClick={cancel}>
            {tr("editor.create.cancel", undefined, "取消")}
          </button>
          <button
            className="btn-primary"
            type="button"
            data-create-submit="1"
            disabled={busy || !desktop || idError !== ""}
            title={desktop ? undefined : tr("editor.create.needDesktop", undefined, "新建剧本需要桌面版（Tauri）。")}
            onClick={() => void submit()}
          >
            {busy ? tr("editor.create.creating", undefined, "创建中…") : tr("editor.create.confirm", undefined, "创建并编辑")}
          </button>
        </div>
      </div>
    </div>
  );
}
