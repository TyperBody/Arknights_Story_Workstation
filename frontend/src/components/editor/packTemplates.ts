/**
 * 新建剧本包的**纯逻辑**（task-11）：模板正文、id 校验、pack.json 文本。
 *
 * 单独放一个 `.ts`（不依赖 React / DOM）的原因：`scripts/fanfic/createPack-selftest.mjs`
 * 用**裸 Node**（v22 自带类型擦除）直接 import 这个文件，才能断言「三个模板
 * 正文都已是 Tab 缩进、`regionIndentPlan` 幂等、`stripIndentForEngine` 后与
 * 顶格版逐字节相等」。UI（`CreatePackDialog.tsx`）只做渲染与提交。
 *
 * 模板正文契约（task-6 的 `INDENT_UNIT = "\t"`）：
 * 行首缩进 = 每级一个 `\t`；`[Decision]` 顶格、`[Predicate]` 一级、线路体两级；
 * 送引擎前由 `storyPack.stripIndentForEngine` 去掉行首空白，所以**不影响播放**。
 */

/** 模板 id（`blank` 最小可播、`branch` 有 Decision、`stage` 有背景+立绘）。 */
export type PackTemplateId = "blank" | "branch" | "stage";

/** 模板列表（顺序 = 对话框里的展示顺序）；`labelKey` 走 i18n `editor.create.*`。 */
export const PACK_TEMPLATES: ReadonlyArray<{ id: PackTemplateId; labelKey: string }> = [
  { id: "blank", labelKey: "templateBlank" },
  { id: "branch", labelKey: "templateBranch" },
  { id: "stage", labelKey: "templateStage" },
];

/** 新建对话框的字段值（也是 `create_library_pack` 的入参形状）。 */
export interface PackDraft {
  id: string;
  title: string;
  chapter: string;
  description: string;
  template: PackTemplateId;
}

/** 包 ID 规则：字母、数字、下划线、短横线——与 Rust `validate_pack_id` 的
 * 超集里最保守的一条（目录名安全、跨平台安全、命令行可粘贴）。 */
export const PACK_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 校验包 ID。
 * @returns 空串 = 合法；否则返回 `editor.create.*` 的键（`invalidId` / `idRequired`）。
 */
export function validatePackId(id: string): string {
  const value = String(id ?? "");
  if (!value) return "idRequired";
  if (!PACK_ID_RE.test(value)) return "invalidId";
  return "";
}

/** 把 `defaultChapter`（缺省 = `editor.create.defaultChapter`）等占位值收敛成文本。 */
function chapterOrDefault(chapter: string, fallback: string): string {
  const value = String(chapter ?? "").trim();
  return value || fallback;
}

const DEFAULT_CHAPTER = "同人剧场";

/** 空白模板：`[HEADER]` + `[endtip]`（最小可播的一份脚本）。 */
function blankBody(id: string): string {
  return [`[HEADER(key="${id}", fit_mode="BLACK_MASK")]`, "[endtip(block=true)]"].join("\n");
}

/** 带分支：两条线路 + 一条合流 `[Predicate(references="1;2")]`（引擎的合并约定）。 */
function branchBody(id: string): string {
  return [
    `[HEADER(key="${id}", fit_mode="BLACK_MASK")]`,
    '[Decision(options="A;B", values="1;2")]',
    "\t[Predicate(references=\"1\")]",
    '\t\t[name="角色"]  选了 A。',
    "\t[Predicate(references=\"2\")]",
    '\t\t[name="角色"]  选了 B。',
    "\t[Predicate(references=\"1;2\")]",
    '\t\t[name="角色"]  两条线路在这里合流。',
    "[endtip(block=true)]",
  ].join("\n");
}

/** 带舞台：背景 + 立绘 + 对白（随包起步素材集里有 `bg_black` 与阿米娅立绘）。 */
function stageBody(id: string): string {
  return [
    `[HEADER(key="${id}", fit_mode="BLACK_MASK")]`,
    '[Background(image="bg_black", fadetime=0.5, block=true)]',
    '[charslot(slot="m", name="char_002_amiya_1", duration=0.5)]',
    '[name="阿米娅"]  这边走，博士。',
    "[endtip(block=true)]",
  ].join("\n");
}

/**
 * 模板正文。
 * @param template 模板 id（未知值回落 `blank`，不抛）
 * @param id 包 ID（写进 `[HEADER(key=…)]`；转义见 `escapeAttr`）
 * @returns 以 `\n` 结尾的脚本文本（`write_library_file` 原样落盘）
 */
export function packTemplateBody(template: PackTemplateId | string, id: string): string {
  const key = escapeAttr(String(id ?? ""));
  const body =
    template === "branch"
      ? branchBody(key)
      : template === "stage"
        ? stageBody(key)
        : blankBody(key);
  return `${body}\n`;
}

/** 值里的双引号/反斜杠转义（`[HEADER(key="…")]` 的属性值）。 */
export function escapeAttr(value: string): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** `pack.json` 文本：**只**写这 5 个字段（与 Rust 侧的 `CreatedPack` 一致）。 */
export function packJsonText(draft: PackDraft, fallbackChapter = DEFAULT_CHAPTER): string {
  const payload = {
    id: String(draft.id ?? ""),
    title: String(draft.title ?? ""),
    chapter: chapterOrDefault(draft.chapter, fallbackChapter),
    description: String(draft.description ?? ""),
    branchPoints: [] as string[],
  };
  return `${JSON.stringify(payload, null, 1)}\n`;
}

/** 决定模板名（`templateBranch` 之类）；未知模板回落 `templateBlank`。 */
export function templateLabelKey(template: PackTemplateId | string): string {
  return PACK_TEMPLATES.find((entry) => entry.id === template)?.labelKey ?? "templateBlank";
}
