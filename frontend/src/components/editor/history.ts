/**
 * 编辑器的撤销/重做**纯逻辑**（无 DOM、无 React），供 StoryEditorPage 与
 * `scripts/fanfic/editorUndo-selftest.mjs`（node 直跑）共用。
 *
 * 设计（对齐 task-15 交付 A）：
 * - 单栈 `undo` / `redo`，条目 `{ text, sel:[from,to] }`，上限默认 200；
 * - **只有 text 变了才入栈**（`snapshot` 里做相等判断）；
 * - **打字合并**：距上次入栈 < `mergeMs`（默认 500ms）、插入内容不含 `\n`、
 *   且插入点在文档里的位置是"就地前进"（`to === from`，即纯插入）→ 替换栈顶
 *   （而不是每敲一个字符一条）；
 * - `undo()` 返回**当前应显示的** `{ text, sel }`；`redo()` 同理。
 *   历史栈的"当前状态"永远是 `present`，不是栈顶——这样 undo/redo 交替
 *   不会丢位置（`undo` 把 `present` 推进 redo，`redo` 反向）。
 *
 * 这个模块是**纯函数式**的：`createHistory()` 返回的对象里没有任何 DOM 依赖，
 * 可以在 node 里直接断言（见 selftest）。
 */

/** 一条历史记录：文本 + 光标区间（`sel` 是 textarea 的 selectionStart/End）。 */
export interface HistoryEntry {
  text: string;
  sel: [number, number];
}

export interface HistoryOptions {
  /** 栈上限，默认 200（超出裁掉最旧的一条）。 */
  limit?: number;
  /** 打字合并窗口，默认 500ms。 */
  mergeMs?: number;
  /** 时间源（测试可注入，保证确定性）。 */
  now?: () => number;
}

export interface History {
  /** 记录"改之前"的状态（调用点在**当前仍是旧文本**时调用）。 */
  snapshot(previous: HistoryEntry, next: HistoryEntry): void;
  /**
   * 记录一次"已发生"的改动：`before` = 改动前，`after` = 改动后。
   * `source` 区分来源：`"typing"`（textarea onChange，可合并）、
   * `"edit"`（applyEdit：表单/模板/补全/拖拽，永不合并且**结束当前打字串**）。
   */
  commit(entry: {
    before: HistoryEntry;
    after: HistoryEntry;
    insert?: string;
    source?: "typing" | "edit";
  }): void;
  /** 撤销。返回撤销后应显示的 `{text, sel}`；没得撤返回 null。 */
  undo(present: HistoryEntry): HistoryEntry | null;
  /** 重做。 */
  redo(present: HistoryEntry): HistoryEntry | null;
  /** 只读快照（测试/状态栏计数用）。 */
  sizes(): { undo: number; redo: number };
  /** 清空（重新载入剧本包时用）。 */
  clear(): void;
  /** 当前合并候选的元信息（测试用）。 */
  debug(): { limit: number; mergeMs: number; lastAt: number };
}

const clone = (entry: HistoryEntry): HistoryEntry => ({ text: entry.text, sel: [entry.sel[0], entry.sel[1]] });

/**
 * 两段文本的最小差异块（公共前缀 / 后缀之外的区间）。
 * textarea 的 `onChange` 只给"新值"，靠它还原出"插入/替换了什么"，
 * 打字合并（不含 `\n`、纯插入）与 sel 归位都要用。
 */
export function diffOf(before: string, after: string): { from: number; to: number; insert: string } {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

/** 创建历史栈（纯逻辑，可在 node 里跑）。 */
export function createHistory(options: HistoryOptions = {}): History {
  const limit = Math.max(1, Math.trunc(options.limit ?? 200));
  const mergeMs = Math.max(0, options.mergeMs ?? 500);
  const now = options.now ?? (() => Date.now());

  /** 已撤销的历史（越靠后越新）。 */
  let undo: HistoryEntry[] = [];
  /** 已撤掉的、可重做的历史。 */
  let redo: HistoryEntry[] = [];
  /** 上次入栈时间（用于打字合并）。 */
  let lastAt = 0;
  /**
   * 「打字串」是否还开着：上一次提交是 onChange 的**纯插入**（含单个 `\n`）时
   * 为真。开着时，紧随其后的普通字符才能并进同一条——这样
   * 「`\n` 单独成条 + 该行后续字符并进这一条」，一次输入行 = 一次撤销。
   */
  let burstOpen = false;

  const trim = (stack: HistoryEntry[]) => {
    if (stack.length > limit) stack.splice(0, stack.length - limit);
  };

  const clearRedo = () => {
    redo = [];
  };

  return {
    snapshot(previous: HistoryEntry, next: HistoryEntry): void {
      if (previous.text === next.text) return;
      undo.push(clone(previous));
      trim(undo);
      clearRedo();
      lastAt = now();
      burstOpen = false;
    },

    commit({ before, after, insert, source = "edit" }): void {
      if (before.text === after.text) return; // text 相等不入栈
      const at = now();
      const typing = source === "typing";
      // 纯插入（没替换选中区间）= 「串」可以延续（换行也算，它自己成条）。
      const insertOnly = typeof insert === "string" && before.sel[0] === before.sel[1];
      // 能不能并进上一条：当前是打字、上一发也是打字且在合并窗口内、且本发不含 `\n`。
      const mergeable =
        typing &&
        burstOpen &&
        typeof insert === "string" &&
        !insert.includes("\n") &&
        at - lastAt < mergeMs &&
        undo.length > 0;
      if (mergeable) {
        // 合并：栈顶仍是这一串打字开始前的状态；只更新时间戳。
        lastAt = at;
      } else {
        undo.push(clone(before));
        trim(undo);
        lastAt = at;
      }
      burstOpen = typing && insertOnly;
      clearRedo();
    },

    undo(present: HistoryEntry): HistoryEntry | null {
      const previous = undo.pop();
      if (!previous) return null;
      // 把"当前位置"推进 redo，才能原路回来。
      redo.push(clone(present));
      trim(redo);
      lastAt = 0;
      burstOpen = false;
      return clone(previous);
    },

    redo(present: HistoryEntry): HistoryEntry | null {
      const next = redo.pop();
      if (!next) return null;
      undo.push(clone(present));
      trim(undo);
      lastAt = 0;
      burstOpen = false;
      return clone(next);
    },

    sizes: () => ({ undo: undo.length, redo: redo.length }),

    clear(): void {
      undo = [];
      redo = [];
      lastAt = 0;
      burstOpen = false;
    },

    debug: () => ({ limit, mergeMs, lastAt }),
  };
}
