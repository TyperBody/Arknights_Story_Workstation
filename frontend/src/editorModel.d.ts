/**
 * `src/akstage/local/editorModel.js` 的编辑器侧类型契约（task-6 交付，纯 ESM）。
 *
 * 页面用**动态 import** 加载它（vite.config 的别名 `@editor-model` → 绝对
 * 路径；失败再回退相对说明符），并且自己持有一套结构化类型
 * （见 StoryEditorPage.tsx 顶部的 `EditorModel`），这里只声明形状、不做结构
 * 校验——文件缺失/加载失败时页面退回降级模式。
 *
 * 通配符模块名让 tsc 也命中相对路径那种写法。
 */
declare module "@editor-model" {
  export const CONTROLLERS: unknown[];
  export const CATEGORIES: string[];
  export const CATEGORY_LABELS: Record<string, string>;
  export const DIAGNOSTIC_CODES: Record<string, number>;
  export const HOVER: Record<string, unknown>;
  export function parseLine(line: string, lineNumber?: number): unknown;
  export function lintDocument(text: string): unknown;
  export function completions(prefix: string, context: unknown): unknown[];
  export function formatLine(controller: string, values: Record<string, unknown>): string;
  export function hoverFor(text: string, offset: number): unknown;
  export function missingMerge(text: string): unknown;
}

declare module "*/editorModel.js" {
  export const CONTROLLERS: unknown[];
  export const CATEGORIES: string[];
  export const CATEGORY_LABELS: Record<string, string>;
  export const DIAGNOSTIC_CODES: Record<string, number>;
  export const HOVER: Record<string, unknown>;
  export function parseLine(line: string, lineNumber?: number): unknown;
  export function lintDocument(text: string): unknown;
  export function completions(prefix: string, context: unknown): unknown[];
  export function formatLine(controller: string, values: Record<string, unknown>): string;
  export function hoverFor(text: string, offset: number): unknown;
  export function missingMerge(text: string): unknown;
}
