// 同人剧本包（fan story pack）：格式定义、解析与校验。
// 纯 ESM、零依赖 —— 应用（前端 / 校验器）与打包脚本（Node）共用同一份实现，
// 契约见 .akskills/arkstage-fanfic/reference/package.md。
//
//   <dataRoot>/library/<id>/
//     pack.json            可选元信息 { id, title, chapter, author, description, branchPoints }
//     script.txt          剧本（PRTS datas_txt 语法）
//     patch/characters.json   可选 —— character.json 的增量/覆盖
//     patch/resolutionRules.json 可选 —— background.json 的增量
//     metadata.json        可选，PRTS 剧情模拟器模板参数（导出 wikitext 用）
//     build/chapters.json  可选，分章导出

/**
 * @typedef {object} ParsedLine
 * @property {number} lineNumber
 * @property {string} raw
 * @property {"command"|"dialogue"|"narration"} kind
 * @property {string|null} command
 * @property {Record<string, unknown>} args
 * @property {string} tail
 * @property {string} text
 * @property {string} [commandRaw]
 * @property {string} [speaker]
 * @property {string} [malformed]
 *
 * @typedef {object} LintIssue
 * @property {number} line
 * @property {string} message
 *
 * @typedef {object} LintResult
 * @property {LintIssue[]} errors
 * @property {LintIssue[]} warnings
 * @property {Array<{line:number,text:string}>} toc
 * @property {ParsedLine[]} lines
 * @property {number} decisions
 * @property {number} combos
 *
 * @typedef {object} CharacterRef
 * @property {string} base
 * @property {number|null} index
 * @property {number|null} group
 * @property {string|null} alias
 */

export const PACK_VERSION = 1;

const NAME_RE = /^name\s*=\s*"((?:\\.|[^"])*)"$/;

/**
 * 与上游 StoryPlayer 的 parser.ts 同形：`[Cmd(args)]tail` / `[name="X"] tail`。
 * 参数键在引擎里大小写敏感（`Delay` 与 `delay` 在语料中都出现过），
 * 所以这里保留原样，只在查表时提供大小写不敏感的回退。
 *
 * @param {string} script
 * @returns {ParsedLine[]}
 */
export function parseScript(script) {
  const raw = String(script ?? "").replace(/\r\n?/g, "\n").split("\n");
  const lines = [];
  for (let i = 0; i < raw.length; i += 1) {
    let text = raw[i];
    // 行尾 "\" 续行：与上游 `for(;o.endsWith('\\')…)` 一致。
    while (text.endsWith("\\") && i + 1 < raw.length) {
      text = text.slice(0, -1) + raw[i + 1];
      i += 1;
    }
    const lineNumber = i + 1;
    if (!text.trim() || /^\s+$/.test(text) || /^\s*\/\//.test(text)) continue;
    lines.push(parseLine(text, lineNumber));
  }
  return lines;
}

/** @param {string} text @param {number} [lineNumber] @returns {ParsedLine} */
export function parseLine(text, lineNumber = 0) {
  const base = { lineNumber, raw: text, text: "", command: null, args: {}, tail: "" };
  if (text[0] !== "[") return { ...base, kind: "narration" };
  const close = text.lastIndexOf("]");
  if (close === -1) return { ...base, kind: "narration", malformed: "缺少 ]" };
  const head = text.slice(1, close);
  const tail = text.slice(close + 1);
  if (tail.startsWith("(") || tail.trimStart().startsWith("(")) {
    return { ...base, kind: "narration", malformed: "“]” 后有残留的 “(”——参数必须写在 ] 之内" };
  }
  const open = head.indexOf("(");
  const name = (open === -1 ? head : head.slice(0, open)).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    const dialogue = head.match(NAME_RE);
    if (dialogue) {
      // 捕获组本身已不含引号：这里要**直接**转义，不能再交给
      // `unescapeString`（它按 `"…"` 切片，会把 `阿米娅` 削成 `米`）。
      return { ...base, kind: "dialogue", command: "dialog", speaker: unescapeBody(dialogue[1]), text: tail.trimStart() };
    }
    if (head.includes("=")) {
      // `[name=…]`（引号不合法）之外的裸 `[key=value]` 也当成 dialog（上游同款兜底）。
      return { ...base, kind: "command", command: "dialog", args: parseArgs(head), tail, text: tail };
    }
    return { ...base, kind: "narration", malformed: `无法解析的指令头: ${head}` };
  }
  const args = open === -1 ? {} : parseArgs(head.slice(open + 1, head.endsWith(")") ? -1 : head.length));
  return { ...base, kind: "command", command: name.toLowerCase(), commandRaw: name, args, tail, text: tail.trimStart() };
}

/** 顶层逗号切分 + key=value（值支持 "…"/'…'/true/false/数字/裸串）。 */
/** @param {string} params @returns {Record<string, unknown>} */
export function parseArgs(params) {
  /** @type {Record<string, unknown>} */
  const args = {};
  for (const seg of splitTopLevel(params)) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const key = seg.slice(0, eq).trim();
    if (!key) continue;
    args[key] = parseValue(seg.slice(eq + 1).trim());
  }
  return args;
}

/** @param {string} params @returns {string[]} */
export function splitTopLevel(params) {
  const out = [];
  let buf = "";
  let quote = null;
  let depth = 0;
  let escaped = false;
  for (const ch of params) {
    if (escaped) { buf += ch; escaped = false; continue; }
    if (ch === "\\" && quote) { buf += ch; escaped = true; continue; }
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) { if (buf.trim()) out.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseValue(trimmed) {
  if (trimmed.length >= 2 && /^("|')/.test(trimmed) && trimmed.endsWith(trimmed[0])) {
    return unescapeString(trimmed);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function unescapeString(quoted) {
  return unescapeBody(quoted.slice(1, -1));
}

/** 转义**已去引号**的正文（`\\n`/`\\t`/`\\"` 等）。 */
function unescapeBody(body) {
  return body.replace(/\\(.)/g, (all, ch) => (ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch));
}

/** 参数键大小写不敏感读取（保留原始 key 供诊断）。 */
/** @param {Record<string, unknown>} args @param {string} key @returns {unknown} */
export function arg(args, key) {
  if (key in args) return args[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(args)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** 角色引用：`base[#index][$group][@alias]`，从右往左剥离（与上游一致）。 */
/** @param {string} raw @returns {CharacterRef} */
export function parseCharacterRef(raw) {
  let rest = String(raw ?? "").trim();
  const ref = { base: "", index: null, group: null, alias: null };
  const cut = (mark) => {
    const at = rest.lastIndexOf(mark);
    if (at === -1) return null;
    const value = rest.slice(at + 1);
    if (!/^\d+$/.test(value)) return null;
    rest = rest.slice(0, at);
    return Number(value);
  };
  const aliasAt = rest.lastIndexOf("@");
  if (aliasAt !== -1) { ref.alias = rest.slice(aliasAt + 1); rest = rest.slice(0, aliasAt); }
  const group = cut("$");
  if (group !== null) ref.group = group;
  const index = cut("#");
  if (index !== null) ref.index = index;
  ref.base = rest;
  return ref;
}

// ── 指令分级（A：转换器主力；B：可用需标注；C：游戏内/需运行时信号） ──────────
export const TIER_A = new Set([
  "header", "background", "image", "charslot", "character", "dialog", "delay", "blocker",
  "playmusic", "playsound", "stopmusic", "stopsound", "musicvolume", "soundvolume",
  "decision", "predicate", "subtitle", "multiline", "camerashake", "cameraeffect",
  "curtain", "focusout", "focusparam", "gridbg", "verticalbg", "largebg", "video", "end",
]);
export const TIER_B = new Set([
  "imagetween", "backgroundtween", "largebgtween", "imagerotate", "characteraction",
  "charactercutin", "interlude", "cgitem", "hidecgitem", "showitem", "hideitem", "theater",
  "avgdisplay", "bgeffect", "sticker", "stickertween", "stickerclear",
  "animtext", "animtextclean", "skipnode", "skiptothis", "narration",
]);
export const TIER_C = new Set([
  "tutorial", "popupdialog", "condition", "setconditionprogress", "inputblocker", "additem",
  "deliveritem", "withdraw", "obtain", "summonenemy", "summontrap", "startbattle",
  "gotopage", "goto", "save", "sandboxv3openshop", "sandboxv3summontrap",
  "sandboxv3activepredefine", "executearray", "executeactionarray", "ememoji", "emoji",
  "voicewithin", "playanim", "createeffect", "finisheffect", "entertouristmode", "warp",
  "setposition", "orderrift", "foginview", "fognotinview", "uioperation", "assault",
]);

/** 已退役/罕见拼写 → 规范名（官方语料中确实存在，见 reference/commands.md）。 */
export const SPELLING_FIX = {
  delat: "delay", dealy: "delay", delau: "delay", daley: "delay", delya: "delay",
  delayt: "delay", palysound: "playsound", stopmucis: "stopmusic", dialo: "dialog",
  dialogs: "dialog", musicvolune: "musicvolume", charslsot: "charslot", chaa: "character",
  duration: "delay",
};

// ── 校验 ─────────────────────────────────────────────────────────────────────
/** @param {string} script @param {{maxDecisions?: number, maxCombos?: number}} [options] @returns {LintResult} */
export function lintScript(script, { maxDecisions = 8, maxCombos = 64 } = {}) {
  const lines = parseScript(script);
  const errors = [];
  const warnings = [];
  const toc = [];
  const push = (list, line, message) => list.push({ line: line.lineNumber, message });

  let decisions = 0;
  let combos = 1;
  let current = null;

  for (const line of lines) {
    if (line.malformed) push(errors, line, line.malformed);
    if (line.kind === "narration" && !line.malformed && line.raw.trim()) push(warnings, line, "裸文本行：只会作为旁白出现，建议写成 [name=\"\"] 或 [Dialog]");
    if (line.raw.endsWith(" ")) push(warnings, line, "行尾有空白（日志/对照时会显示差异）");
    if (line.kind === "dialogue" && !line.text) push(warnings, line, "空对白（引擎会隐藏对话框，常用于分节）");

    if (line.kind !== "command") continue;
    const cmd = line.command;
    if (SPELLING_FIX[cmd]) push(warnings, line, `拼写漂移：${cmd} → ${SPELLING_FIX[cmd]}（引擎按字面分发，官方语料里也有漂移，建议改正）`);
    if (!TIER_A.has(cmd) && !TIER_B.has(cmd) && !TIER_C.has(cmd) && cmd !== "endtip") {
      push(warnings, line, `未知指令：${cmd}（引擎会 warn 并跳过）`);
    }
    if (TIER_C.has(cmd)) push(warnings, line, `C 级指令（游戏内/依赖运行时信号）：${cmd}`);

    if (cmd === "header" || cmd === "name") toc.push({ line: line.lineNumber, text: String(line.tail || arg(line.args, "key") || "").slice(0, 40) });

    if (cmd === "decision") {
      const options = arg(line.args, "options");
      const values = arg(line.args, "values");
      if (options === undefined) { push(errors, line, "Decision 缺少 options"); continue; }
      const labels = String(options).split(";");
      const vals = String(values ?? "").split(";").map((s) => s.trim()).filter(Boolean);
      if (labels.length > 1 && vals.length !== labels.length) {
        push(errors, line, `Decision 的 values 数量(${vals.length})与 options 数量(${labels.length})不一致`);
      }
      decisions += 1;
      combos *= Math.max(1, labels.length);
      current = { values: vals.length ? vals : labels.map((_, i) => String(i + 1)), merged: false, line: line.lineNumber };
      continue;
    }

    if (cmd === "predicate") {
      const refs = arg(line.args, "references");
      if (!current) { push(warnings, line, "Predicate 前没有（未合流的）Decision"); continue; }
      if (refs === undefined) { push(errors, line, "Predicate 缺少 references（空 references 会结束分支模式）"); continue; }
      const wanted = String(refs).split(";").map((s) => s.trim()).filter(Boolean);
      const available = new Set(current.values);
      for (const value of wanted) if (!available.has(value)) push(warnings, line, `Predicate 引用了 Decision 中不存在的值 ${value}`);
      if (current.values.every((value) => wanted.includes(value))) {
        if (current.values.length < 2) push(warnings, line, "单选项 Decision 的合流 Predicate（可用，但冗余）");
        current.merged = true;
        current = null;
      }
      continue;
    }

    for (const key of ["image", "imagegroup", "name", "name2"]) {
      const value = arg(line.args, key);
      if (typeof value !== "string" || !value.trim()) continue;
      if (key === "name" || key === "name2") {
        const ref = parseCharacterRef(value);
        if (!ref.base) push(errors, line, `角色引用缺少基名: ${value}`);
      }
    }
  }

  if (current && !current.merged) {
    errors.push({ line: current.line, message: "Decision 结束后没有合流 Predicate（references 覆盖全部 values）——后续内容会只属于最后一条 fragment" });
  }
  if (decisions > maxDecisions) warnings.push({ line: 0, message: `决策数 ${decisions} > ${maxDecisions}：LOG ALL 的状态数会指数增长，建议拆章` });
  if (combos > maxCombos) warnings.push({ line: 0, message: `分支组合 ${combos} > ${maxCombos}：超过引擎 1e4 状态上限会退化为「全量文本」` });
  const endsWithEnd = lines.some((line) => line.command === "endtip" || line.command === "end" || (line.command === "blocker" && Number(arg(line.args, "a")) === 1));
  if (!endsWithEnd) warnings.push({ line: 0, message: "没有收尾：StoryPlayer 只认 [endtip]（[End] 会 warn 成 unknown_command）；建议最后用 [Blocker(a=1, block=true)] 淡出，或显式 [endtip(block=true)]" });

  return { errors, warnings, toc, lines, decisions, combos };
}

// ── runtime.json（导入用的缓存键内容） ──────────────────────────────────────
/** @param {string} scriptA @param {string} scriptB @returns {string[]} */
export function overlappingKeys(scriptA, scriptB) {
  const keys = collectAssetKeys(scriptA);
  const out = [];
  for (const key of collectAssetKeys(scriptB)) if (keys.has(key)) out.push(key);
  return out;
}

/** @param {string} script @returns {Set<string>} */
export function collectAssetKeys(script) {
  const keys = new Set();
  for (const line of parseScript(script)) {
    if (line.kind !== "command") continue;
    const cmd = line.command;
    if (cmd === "background") addKey(keys, "bg", arg(line.args, "image"));
    else if (cmd === "image") addKey(keys, "", arg(line.args, "image"));
    else if (cmd === "gridbg" || cmd === "verticalbg" || cmd === "largebg") {
      for (const part of String(arg(line.args, "imagegroup") ?? "").split("/")) addKey(keys, "bg", part);
    }
    else if (cmd === "character" || cmd === "charslot") keys.add(parseCharacterRef(String(arg(line.args, "name") ?? "")).base);
  }
  return keys;
}

/**
 * @param {Set<string>} set
 * @param {string} prefix
 * @param {unknown} raw
 */
function addKey(set, prefix, raw) {
  if (typeof raw !== "string" || !raw.trim()) return;
  set.add(prefix ? `${prefix}_${raw.trim().toLowerCase()}` : raw.trim().toLowerCase());
}

/** 给一个 script，产出 cache/story-runtime-v6_<sanitized title>.json 的内容。 */
/** @param {{title:string, script:string, bundle:unknown, previousScript?:string|null, previousBundle?:unknown}} input */
export function buildRuntimeRecord({ title, script, bundle, previousScript = null, previousBundle = null }) {
  const tables = /** @type {{data?: unknown}} */ (bundle)?.data;
  const revision = `fan:${hash32(script)}:${hash32(JSON.stringify(tables ?? {}).slice(0, 4096))}`;
  const shared = overlappingKeys(previousScript ?? "", script);
  const offsetKey = resolveSharedCapture(script, previousScript, shared);
  return { story: { script, title }, bundle, revision, __capture: { parentKeys: shared, sequential: offsetKey } };
}

function resolveSharedCapture(script, previousScript, shared) {
  if (!previousScript || !script) return 1;
  const previous = parseScript(previousScript);
  for (const line of parseScript(script)) {
    if (line.kind !== "command" || line.command !== "subtitle") continue;
    const text = String(arg(line.args, "text") ?? "");
    if (!text) continue;
    const index = previous[0] === undefined ? 1 : Math.max(1, previous.filter((p) => p.kind === "command" && p.command === "subtitle").findIndex((p) => String(arg(p.args, "text") ?? "") === text) + 1);
    if (index > 0) return index;
  }
  return 1;
}

/** @param {string} text @returns {string} */
export function hash32(text) {
  let hash = 5381;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** @param {Array<{script:string, cleanScript?:string}>} chapters @returns {string} */
export const combinedScript = (chapters) => chapters
  .map((chapter) => String(chapter.cleanScript ?? stripControls(chapter.script)).trim())
  .filter(Boolean)
  .join("\n");

/** 去掉 `[Cmd@tag(...)]` 里的 `@tag`，得到引擎直接可播的文本。 */
/** @param {string} script @returns {string} */
export function stripControls(script) {
  return String(script ?? "").replace(/\[\s*([A-Za-z_]\w*)@[A-Za-z0-9_-]+\s*(?=[\](])/g, "[$1");
}
