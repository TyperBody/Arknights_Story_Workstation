#!/usr/bin/env node
/**
 * 同人剧本包离线校验器（lint）。
 *
 *   node scripts/fanfic/lint.mjs <packDir> [--json out.json] [--strict]
 *
 * 行语法 / 指令分级 / 拼写漂移 / Decision-Predicate 配对来自
 * `src/akstage/local/storyPack.js` 的 `lintScript()` —— 与应用（前端）共用同一份实现；
 * 本文件只补「包级」检查：
 *   - `pack.json`：存在、id 非空（与目录名不一致时 warn）、title / chapter；
 *   - `[Cmd@tag(...)]` 控制位：tag 形状合法、同一命令内唯一、成对出现或登记在 `branchPoints`；
 *   - 角色基名：`patch/characters.json` 已声明 → 放过；否则打印基名（info），
 *     有上游快照时再判断该基名是否真的借得到（warning）；
 *   - 素材 URL：host 必须带点（error，媒体仓 `canonical_key` 的硬要求）；
 *     `*.invalid`（自备素材）需要有 `assets/<...>` 文件或 `patch/resolutionRules.json` 条目（warning）；
 *   - 分支形状（error）：Decision 后必须先出片段 Predicate；片段 references 并集 == values；
 *     合流 Predicate 覆盖全部 values 且其后（下一个 Decision 之前）必须有正文。
 *
 * 纯 Node ESM、零依赖。退出码：0 = 通过；1 = 有 error（`--strict` 下 warning 也算）；
 * 2 = 用法错误。契约见 `.akskills/arkstage-fanfic/reference/package.md`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  arg,
  lintScript,
  parseCharacterRef,
  stripControls,
} from "../../src/akstage/local/storyPack.js";
import { CHARACTER_URL } from "../../src/akstage/local/library.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（scripts/fanfic/ → ../..）。 */
export const REPO_ROOT = resolve(HERE, "..", "..");

const SCRIPT_FILE = "script.txt";
const PACK_FILE = "pack.json";
const FALLBACK_SCRIPTS = ["source/script.txt", "source/probe.txt"];
/** 可选 patch：相对路径 → 说明。 */
const PATCH_FILES = {
  "patch/characters.json": "character.json 增量",
  "patch/resolutionRules.json": "background.json 增量",
  "patch/story_variables.json": "story_variables.json 增量",
};
const DEFAULT_UPSTREAM = join("build", "fanfic", "upstream.json");
/** 自备素材的约定假 host（见 reference/assets.md §4）。 */
export const LOCAL_HOST = "local.arkstage.invalid";

export const USAGE = `同人剧本包校验（lint.mjs）

用法：
  node scripts/fanfic/lint.mjs <packDir> [--json out.json] [--strict]

参数：
  <packDir>          剧本包目录（script.txt + pack.json）
  --json <out.json>  额外把完整报告写成 JSON
  --strict           warning 也算失败（退出码 1）
  -h, --help         显示本帮助

退出码：
  0  没有 error（--strict 下也没有 warning）
  1  存在 error（或 --strict 下存在 warning）
  2  用法错误（参数非法 / 目录不存在）

说明：
  - script.txt 缺失时，按 source/script.txt → source/probe.txt → source/*.txt 兜底，
    并先按 stripControls 去掉 \`@tag\` 再校验（等价于 pack.mjs 的编译产物）；
  - 规则清单见 .akskills/arkstage-fanfic/reference/{package,branching,assets}.md。
`;

// ── 小工具 ───────────────────────────────────────────────────────────────

/** @returns {{ok: boolean, value: any, error: string|null}} */
function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")), error: null };
  } catch (error) {
    return { ok: false, value: null, error: String(error?.message ?? error) };
  }
}

/** 文本里第 index 个字符所在的行号（1 基）。 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** 键名小写折叠（引擎建 linkMap 时就是这么做的）。 */
function foldKeys(table) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!table || typeof table !== "object" || Array.isArray(table)) return out;
  for (const [key, value] of Object.entries(table)) out[key.toLowerCase()] = value;
  return out;
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ── 输入发现 ──────────────────────────────────────────────────────────

/**
 * 解析包的「当前剧本」：script.txt 优先；缺失/为空时按 source/ 兜底并去 `@tag`。
 * @param {string} packDir
 * @returns {{file: string, raw: string, compiled: string, isFallback: boolean, empty: boolean}|null}
 */
export function resolvePackScript(packDir) {
  const read = (rel) => {
    try {
      const path = join(packDir, rel);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    } catch {
      return null;
    }
  };

  const primary = read(SCRIPT_FILE);
  if (primary !== null && primary.trim()) {
    return { file: SCRIPT_FILE, raw: primary, compiled: stripControls(primary), isFallback: false, empty: false };
  }
  const candidates = [...FALLBACK_SCRIPTS];
  try {
    for (const name of readdirSync(join(packDir, "source")).sort()) {
      if (name.endsWith(".txt") && !candidates.includes(`source/${name}`)) candidates.push(`source/${name}`);
    }
  } catch {
    /* 没有 source/ 目录：正常 */
  }
  for (const rel of candidates) {
    const text = read(rel);
    if (text !== null && text.trim()) {
      return { file: rel, raw: text, compiled: stripControls(text), isFallback: true, empty: false };
    }
  }
  if (primary !== null) {
    return { file: SCRIPT_FILE, raw: primary, compiled: stripControls(primary), isFallback: false, empty: true };
  }
  return null;
}

/** 三个 patch（解析失败的已在 add 里报 error，这里返回 null）。 */
function readPatches(packDir, add) {
  /** @type {{characters: any, resolutionRules: any, variables: any}} */
  const patches = { characters: null, resolutionRules: null, variables: null };
  const names = { characters: "patch/characters.json", resolutionRules: "patch/resolutionRules.json", variables: "patch/story_variables.json" };
  for (const [key, rel] of Object.entries(names)) {
    const path = join(packDir, rel);
    if (!existsSync(path)) continue;
    const parsed = readJsonFile(path);
    if (!parsed.ok) {
      add("errors", rel, 0, `${rel} 不是合法 JSON（应用会静默忽略这个 patch）：${parsed.error}`);
      continue;
    }
    if (!isPlainObject(parsed.value)) {
      add("errors", rel, 0, `${rel} 必须是「上游表键 → 条目」的 JSON 对象`);
      continue;
    }
    patches[key] = parsed.value;
  }
  return patches;
}

/** 上游 character.json（包自带 build/runtime.json 优先，其次仓库/工作目录的默认快照）。 */
function readUpstreamCharacters(packDir) {
  const candidates = [
    join(packDir, "build", "runtime.json"),
    resolve(process.cwd(), DEFAULT_UPSTREAM),
    resolve(REPO_ROOT, DEFAULT_UPSTREAM),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = readJsonFile(path);
    const table = parsed.ok ? parsed.value?.bundle?.data?.[CHARACTER_URL] : null;
    if (isPlainObject(table)) return { table, path };
  }
  return null;
}

// ── 检查：pack.json ────────────────────────────────────────────────

function checkPackJson(packDir, add) {
  const file = join(packDir, PACK_FILE);
  /** @type {{meta: Record<string, any>, values: {id: string, title: string, chapter: string, branchPoints: string[]}}} */
  const result = { meta: {}, values: { id: "", title: "", chapter: "", branchPoints: [] } };
  if (!existsSync(file)) {
    add("errors", PACK_FILE, 0, `缺少 ${PACK_FILE}（必填：至少要有 { "id": "<包 id>" }）`);
    return result;
  }
  const parsed = readJsonFile(file);
  if (!parsed.ok) {
    add("errors", PACK_FILE, 0, `${PACK_FILE} 不是合法 JSON：${parsed.error}`);
    return result;
  }
  if (!isPlainObject(parsed.value)) {
    add("errors", PACK_FILE, 0, `${PACK_FILE} 必须是 JSON 对象`);
    return result;
  }
  const meta = parsed.value;
  result.meta = meta;

  const dirName = basename(packDir);
  const id = typeof meta.id === "string" ? meta.id.trim() : "";
  if (!id) add("errors", PACK_FILE, 0, `${PACK_FILE} 缺少非空字符串字段 id（= page_title = 缓存键后缀）`);
  else if (id !== dirName) add("warnings", PACK_FILE, 0, `id "${id}" 与目录名 "${dirName}" 不一致（应用按目录/包 id 装载，建议改成一致）`);

  for (const key of ["title", "chapter"]) {
    const value = meta[key];
    if (typeof value !== "string" || !value.trim()) {
      const fallback = key === "title" ? "id" : "title → id";
      add("warnings", PACK_FILE, 0, `${PACK_FILE} 缺少字段 ${key}（书架会回退显示 ${fallback}；建议补全）`);
    }
  }

  let branchPoints = [];
  if (meta.branchPoints !== undefined) {
    if (!Array.isArray(meta.branchPoints) || meta.branchPoints.some((item) => typeof item !== "string")) {
      add("warnings", PACK_FILE, 0, "branchPoints 应为字符串数组（分支点 tag 列表，给 UI/工具用）");
    } else {
      branchPoints = meta.branchPoints.map((tag) => String(tag).replace(/^@/, ""));
    }
  }

  const text = (value, fallback) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  result.values = {
    id: id || dirName,
    title: text(meta.title, id || dirName),
    chapter: text(meta.chapter, text(meta.title, id || dirName)),
    branchPoints,
  };
  return result;
}

// ── 检查：`[Cmd@tag(...)]` 控制位 ─────────────────────────────────

/**
 * @returns {{tags: Array<{command: string, tag: string, line: number}>, counts: Map<string, number>}}
 */
export function checkControlTags(scriptFile, scriptText, branchPoints, add) {
  const AT = /\[\s*([A-Za-z_]\w*)\s*@/;
  const OK = /\[\s*([A-Za-z_]\w*)\s*@([A-Za-z0-9_-]+)\s*([(\]])/;
  /** @type {Map<string, {command: string, tag: string, line: number}>} */
  const pairs = new Map();
  /** @type {Array<{command: string, tag: string, line: number}>} */
  const tags = [];
  /** @type {Map<string, number>} */
  const counts = new Map();

  const lines = String(scriptText ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes("@") || !AT.test(line)) continue;
    const lineNumber = i + 1;
    const match = OK.exec(line);
    if (!match) {
      const raw = /\[\s*[A-Za-z_]\w*\s*@([^\]\s(]*)/.exec(line);
      add(
        "errors",
        scriptFile,
        lineNumber,
        `控制位 tag 非法："@${raw?.[1] ?? ""}" —— tag 只允许 [A-Za-z0-9_-]+，且必须紧跟 ( 或 ]`,
      );
      continue;
    }
    const command = match[1].toLowerCase();
    const tag = match[2];
    const key = `${command}@${tag}`;
    const previous = pairs.get(key);
    if (previous) {
      add("errors", scriptFile, lineNumber, `控制位 [${match[1]}@${tag}] 重复（第 ${previous.line} 行已出现）——取景器按 (命令, tag) 定位，必须唯一`);
    } else {
      pairs.set(key, { command, tag, line: lineNumber });
    }
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
    if (counts.get(tag) === 1) tags.push({ command, tag, line: lineNumber });
  }

  const referenced = new Set(branchPoints);
  for (const entry of tags) {
    if ((counts.get(entry.tag) ?? 0) >= 2 || referenced.has(entry.tag)) continue;
    add(
      "warnings",
      scriptFile,
      entry.line,
      `控制位 @${entry.tag} 只出现 1 次，也没登记在 pack.json.branchPoints —— 控制位建议成对（起止）出现，或把分支点写进 branchPoints`,
    );
  }
  return { tags, counts };
}

// ── 检查：角色基名 ────────────────────────────────────────────────

function checkCharacters({ packDir, scriptFile, parsedLines, patches, add }) {
  const patched = foldKeys(patches.characters);
  const upstream = readUpstreamCharacters(packDir);
  const upstreamTable = upstream ? foldKeys(upstream.table) : null;

  /** @type {Map<string, {line: number, raw: string}>} */
  const refs = new Map();
  for (const line of parsedLines) {
    if (line.kind !== "command") continue;
    if (line.command !== "charslot" && line.command !== "character") continue;
    const keys = line.command === "charslot" ? ["name"] : ["name", "name2"];
    for (const key of keys) {
      const value = arg(line.args, key);
      if (typeof value !== "string" || !value.trim()) continue;
      const base = parseCharacterRef(value).base.trim();
      if (!base) continue;
      const folded = base.toLowerCase();
      if (!refs.has(folded)) refs.set(folded, { line: line.lineNumber, raw: value });
    }
  }

  for (const [base, info] of refs) {
    const declared = Object.prototype.hasOwnProperty.call(patched, base) && patched[base] !== null;
    if (declared) {
      add("info", scriptFile, info.line, `本地角色条目：${info.raw}（patch/characters.json 已声明基名 ${base}，assets.json 会列出自备贴图）`);
      continue;
    }
    const removed = Object.prototype.hasOwnProperty.call(patched, base) && patched[base] === null;
    if (!upstreamTable) {
      add("info", scriptFile, info.line, `角色基名 ${base} 未在 patch/characters.json 声明（打包时按上游 character.json 借用；未找到上游快照，暂不判断存在性）`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(upstreamTable, base)) {
      add("info", scriptFile, info.line, `借用上游立绘：${info.raw}（基名 ${base}；assets.json 会列出 PRTS 贴图 URL）`);
    } else {
      add(
        "warnings",
        scriptFile,
        info.line,
        `角色基名 ${base} 既不在 patch/characters.json${removed ? "（被显式置 null 删除）" : ""}，也不在上游 character.json（${upstream.path}）—— 播放时立绘缺失，请补 patch 条目`,
      );
    }
  }
}

// ── 检查：素材 URL ──────────────────────────────────────────────

/** `assets/<urlPath>` 是否存在（解码后仍防目录穿越）。 */
function assetFileExists(packDir, urlPath) {
  let decoded = urlPath;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    /* 保持原样 */
  }
  const rel = decoded.replace(/^\/+/, "");
  if (!rel) return false;
  const root = resolve(packDir, "assets");
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}/`)) return false;
  return existsSync(target);
}

/** `patch/resolutionRules.json` 是否有条目提到这个本地素材路径（键或值）。 */
function coveredByResolutionRules(rules, urlPath) {
  if (!isPlainObject(rules)) return false;
  let decoded = urlPath;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    /* 保持原样 */
  }
  const rel = decoded.replace(/^\/+/, "").toLowerCase();
  const file = rel.split("/").pop() ?? "";
  const tokens = [...new Set([rel, rel.replace(/\.[a-z0-9]+$/, ""), file, file.replace(/\.[a-z0-9]+$/, "")])].filter(Boolean);
  for (const [key, value] of Object.entries(rules)) {
    const needle = String(key).toLowerCase();
    if (needle && tokens.some((token) => token === needle || token.includes(needle) || needle.includes(token))) return true;
    if (typeof value !== "string") continue;
    const text = value.toLowerCase();
    if (tokens.some((token) => text.includes(token))) return true;
  }
  return false;
}

/** URL 检查（script.txt 与 patch/*.json 共用同一套规则）。 */
function checkUrls({ text, file, patches, packDir, add }) {
  const seen = new Set();
  for (const match of String(text).matchAll(/https?:\/\/[^\s"'`<>)\]}\\,;]+/g)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const line = lineAt(text, match.index ?? 0);
    const scheme = url.slice(0, url.indexOf("://"));
    const rest = url.slice(scheme.length + 3);
    const slash = rest.indexOf("/");
    const authority = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    const host = authority.replace(/:\d+$/, "");
    if (!host) {
      add("errors", file, line, `URL 缺少 host：${url}`);
      continue;
    }
    if (!host.includes(".")) {
      add("errors", file, line, `URL 的 host "${host}" 不含点（媒体仓 canonical_key 会拒绝；自备素材请用 ${LOCAL_HOST}）：${url}`);
      continue;
    }
    if (scheme === "http") add("warnings", file, line, `URL 用了 http（建议 https）：${url}`);
    if (host === LOCAL_HOST || host.endsWith(".invalid")) {
      const urlPath = slash === -1 ? "" : rest.slice(slash);
      if (assetFileExists(packDir, urlPath)) continue;
      if (coveredByResolutionRules(patches.resolutionRules, urlPath)) continue;
      const rel = urlPath.replace(/^\/+/, "") || "<path>";
      add("warnings", file, line, `自备素材 ${url} 没有对应的 assets/${rel} 文件，也没有 patch/resolutionRules.json 条目 —— 离线时本地缓存命中不了`);
    }
  }
  // 单 host 不带 scheme 的写法也查一遍（脚本里出现 local.arkstage.invalid/... 时）。
  for (const match of String(text).matchAll(/(?<![\w.@/-])(local\.arkstage\.invalid\/[^\s"'`<>)\]}\\,;]+)/g)) {
    const urlPath = match[1].slice(LOCAL_HOST.length);
    if (assetFileExists(packDir, urlPath)) continue;
    if (coveredByResolutionRules(patches.resolutionRules, urlPath)) continue;
    add("warnings", file, lineAt(text, match.index ?? 0), `自备素材 ${match[1]} 没有对应的 assets/${urlPath.replace(/^\/+/, "")} 文件，也没有 patch/resolutionRules.json 条目`);
  }
}

// ── 检查：Decision / Predicate 分支形状 ────────────────────────

function decisionValues(line) {
  const options = arg(line.args, "options");
  const values = arg(line.args, "values");
  const vals = String(values ?? "").split(";").map((item) => item.trim()).filter(Boolean);
  if (vals.length) return vals;
  return options === undefined ? [] : String(options).split(";").map((_, index) => String(index + 1));
}

/** null = 缺 references（引擎语义：结束分支模式 = 全放行）。 */
function predicateRefs(line) {
  const raw = arg(line.args, "references");
  if (raw === undefined) return null;
  return String(raw).split(";").map((item) => item.trim()).filter(Boolean);
}

function describeLine(line) {
  if (line.kind === "dialogue") return `[name="${line.speaker ?? ""}"]`;
  if (line.kind === "narration") return "裸文本行";
  return `[${line.commandRaw ?? line.command}]`;
}

function checkBranches(scriptFile, lines, add) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.kind !== "command" || line.command !== "decision") continue;
    const values = decisionValues(line);
    if (!values.length) continue; // 缺 options：lintScript 已报 error
    const valueSet = new Set(values);

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].kind === "command" && lines[j].command === "decision") {
        end = j;
        break;
      }
    }
    const region = lines.slice(i + 1, end);
    const first = region[0];
    if (!first) {
      add("errors", scriptFile, line.lineNumber, "Decision 之后没有任何内容（缺分支片段与合流 Predicate）");
      continue;
    }
    if (!(first.kind === "command" && first.command === "predicate")) {
      add("errors", scriptFile, first.lineNumber, `Decision 之后必须先出现片段头 [Predicate(references=…)]，这里是 ${describeLine(first)} —— 否则这段内容会被未选中的分支一起渲染`);
    }

    const predicates = region
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.kind === "command" && item.command === "predicate");
    const coversAll = ({ item }) => {
      const refs = predicateRefs(item);
      return refs === null || values.every((value) => refs.includes(value));
    };
    const covering = predicates.filter(coversAll);
    if (!covering.length) {
      add("errors", scriptFile, line.lineNumber, `Decision(values="${values.join(";")}") 缺少覆盖全部 values 的合流 [Predicate(references="${values.join(";")}")]`);
      continue;
    }
    const closing = covering[covering.length - 1];
    let fragments = predicates.filter(({ index }) => index < closing.index);
    if (!fragments.length) fragments = [closing]; // 形状 A：合流 Predicate 兼作片段头

    const union = new Set();
    for (const fragment of fragments) {
      const refs = predicateRefs(fragment.item);
      if (refs === null) for (const value of values) union.add(value);
      else for (const ref of refs) union.add(ref);
    }
    const missing = values.filter((value) => !union.has(value));
    const extra = [...union].filter((value) => !valueSet.has(value));
    if (missing.length) {
      add("errors", scriptFile, line.lineNumber, `分支片段的 references 并集没有覆盖 Decision 的 values：缺 ${missing.join(";")}（每个 value 至少要有一条片段头 Predicate）`);
    }
    if (extra.length) {
      add("errors", scriptFile, closing.item.lineNumber, `分支片段引用了 Decision 之外的值：${extra.join(";")}（这些片段永远不会执行）`);
    }
    if (region.slice(closing.index + 1).length === 0) {
      // end === lines.length → 合流点是脚本最后一行；end < lines.length 表示后面
      // 紧跟下一个 Decision（嵌套形状：官方语料里 527 次，`act10d5/st06` 通篇如此）。
      const because = end < lines.length
        ? "（下一条 Decision 紧随其后）"
        : "（直到脚本结尾）";
      add("errors", scriptFile, closing.item.lineNumber, `合流 [Predicate(references="${values.join(";")}")] 之后没有任何正文${because}——合流点后必须还有内容`);
    }
  }
}

// ── 主入口 ───────────────────────────────────────────────────────

/**
 * 校验一个剧本包目录。
 * @param {string} packDir
 * @returns {{ok: boolean, errors: any[], warnings: any[], info: any[], toc: any[], counts: {commands: number, decisions: number, combos: number, lines: number}, pack: any}}
 */
export function lintPack(packDir) {
  const dir = resolve(packDir);
  const errors = [];
  const warnings = [];
  const info = [];
  let seq = 0;
  const add = (level, file, line, message) => {
    const list = level === "errors" ? errors : level === "warnings" ? warnings : info;
    list.push({ file, line: Number(line) || 0, message, seq: seq++ });
  };

  const { meta, values } = checkPackJson(dir, add);
  const patches = readPatches(dir, add);
  const scriptSource = resolvePackScript(dir);

  let toc = [];
  let counts = { commands: 0, decisions: 0, combos: 1, lines: 0 };
  let parsedLines = [];

  if (!scriptSource) {
    add("errors", SCRIPT_FILE, 0, `缺少 ${SCRIPT_FILE}（必填；作者脚本也可放 source/script.txt，由 pack.mjs 编译）`);
  } else {
    const file = scriptSource.file;
    if (scriptSource.isFallback) {
      add("info", file, 0, `没有 ${SCRIPT_FILE}，回退校验 ${file}（按 stripControls 去 @tag 后校验；pack.mjs 会编译出 ${SCRIPT_FILE}）`);
    } else if (/\{\s*[A-Za-z_]\w*\s*@[A-Za-z0-9_-]+\s*[(\]]/.test(scriptSource.raw)) {
      add("warnings", SCRIPT_FILE, 0, `${SCRIPT_FILE} 里仍有 \`@tag\` 控制位（引擎按字面分发；作者脚本建议放 source/，由 pack.mjs 去掉）`);
    }
    if (!scriptSource.raw.trim()) add("errors", file, 0, "剧本为空");

    const result = lintScript(scriptSource.compiled);
    for (const issue of result.errors) add("errors", file, issue.line, issue.message);
    for (const issue of result.warnings) add("warnings", file, issue.line, issue.message);
    toc = result.toc;
    parsedLines = result.lines;
    counts = {
      commands: result.lines.filter((item) => item.kind === "command").length,
      decisions: result.decisions,
      combos: result.combos,
      lines: result.lines.length,
    };

    checkControlTags(file, scriptSource.raw, values.branchPoints, add);
    checkBranches(file, parsedLines, add);
    checkCharacters({ packDir: dir, scriptFile: file, parsedLines, patches, add });
  }

  checkUrls({ text: scriptSource?.compiled ?? "", file: scriptSource?.file ?? SCRIPT_FILE, patches, packDir: dir, add });
  for (const rel of Object.keys(PATCH_FILES)) {
    const path = join(dir, rel);
    if (!existsSync(path)) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    checkUrls({ text, file: rel, patches, packDir: dir, add });
  }

  // 稳定排序：剧本 → pack.json → 其它（patch 等）；同文件按行号、再按发现顺序。
  const rank = (file) => (file === (scriptSource?.file ?? SCRIPT_FILE) ? 0 : file === PACK_FILE ? 1 : 2);
  const sorted = (list) => list.slice().sort((a, b) => rank(a.file) - rank(b.file) || a.line - b.line || a.seq - b.seq);
  const strip = ({ file, line, message }) => ({ file, line, message });
  const dirName = basename(dir);

  return {
    ok: errors.length === 0,
    errors: sorted(errors).map(strip),
    warnings: sorted(warnings).map(strip),
    info: sorted(info).map(strip),
    toc,
    counts,
    pack: {
      id: values.id,
      title: values.title,
      chapter: values.chapter,
      author: typeof meta.author === "string" ? meta.author : "",
      description: typeof meta.description === "string" ? meta.description : "",
      branchPoints: values.branchPoints,
      dir,
      dirName,
      match: values.id === dirName,
      script: scriptSource?.file ?? SCRIPT_FILE,
      fallback: Boolean(scriptSource?.isFallback),
    },
  };
}

// ── 人类可读输出 ─────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof lintPack>} report
 * @param {{strict?: boolean}} [options]
 */
export function formatReport(report, { strict = false } = {}) {
  const out = [];
  const pack = report.pack;
  out.push(`同人剧本包校验  ${pack.dir}`);
  out.push(`  id=${pack.id}  title=${pack.title}  chapter=${pack.chapter}${pack.match ? "" : "  （⚠ id 与目录名不一致）"}`);
  out.push(`  剧本：${pack.script}${pack.fallback ? "（作者脚本，已去 @tag）" : ""}`);

  const group = (title, list, mark) => {
    if (!list.length) return;
    out.push("");
    out.push(`${title}（${list.length}）`);
    let current = null;
    for (const issue of list) {
      if (issue.file !== current) {
        current = issue.file;
        out.push(`  ${current}`);
      }
      out.push(`    ${mark} ${issue.line > 0 ? `L${issue.line}` : "--"}  ${issue.message}`);
    }
  };
  group("错误", report.errors, "x");
  group("警告", report.warnings, "!");
  group("信息", report.info, "-");

  out.push("");
  if (!report.errors.length && !report.warnings.length && !report.info.length) out.push("未发现问题。");
  out.push(
    `统计：行 ${report.counts.lines} · 命令 ${report.counts.commands} · 决策 ${report.counts.decisions} · 组合 ${report.counts.combos} · 错误 ${report.errors.length} · 警告 ${report.warnings.length} · 信息 ${report.info.length}`,
  );
  if (report.errors.length) out.push(`结论：失败（${report.errors.length} 个 error）`);
  else if (strict && report.warnings.length) out.push(`结论：失败（--strict：${report.warnings.length} 个 warning）`);
  else out.push(`结论：通过${report.warnings.length ? `（${report.warnings.length} 个 warning；未加 --strict 不影响退出码）` : ""}`);
  return out.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────

export function parseLintArgs(argv) {
  const options = { packDir: null, json: null, strict: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--strict") options.strict = true;
    else if (token === "--json") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--json 需要一个输出路径");
      options.json = value;
      i += 1;
    } else if (token.startsWith("-") && token !== "-") throw new Error(`未知参数：${token}`);
    else if (!options.packDir) options.packDir = token;
    else throw new Error(`多余的参数：${token}`);
  }
  return options;
}

/**
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function runLintCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseLintArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help || !options.packDir) {
    stdout.write(USAGE);
    return options.help ? 0 : 2;
  }
  const dir = resolve(options.packDir);
  if (!existsSync(dir)) {
    stderr.write(`包目录不存在：${dir}\n`);
    return 2;
  }
  const report = lintPack(dir);
  stdout.write(`${formatReport(report, { strict: options.strict })}\n`);
  if (options.json) {
    const outPath = resolve(options.json);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`);
    stdout.write(`报告已写入 ${outPath}\n`);
  }
  if (report.errors.length) return 1;
  if (options.strict && report.warnings.length) return 1;
  return 0;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = runLintCli(process.argv.slice(2));
