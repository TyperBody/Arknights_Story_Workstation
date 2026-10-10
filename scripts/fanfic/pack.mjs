#!/usr/bin/env node
/**
 * 同人剧本包离线打包器（pack）。
 *
 *   node scripts/fanfic/pack.mjs <packDir> [--upstream build/fanfic/upstream.json]
 *        [--out build/fanfic/<packId>.json] [--force] [--dry-run] [--json report.json]
 *
 * 步骤：
 *   0. 解析包：pack.json / script.txt（缺失时由 source/ 编译）/ patch/*.json；
 *   1. 先跑 `lintPack()`（scripts/fanfic/lint.mjs）：有 error 就中止（`--force` 继续）；
 *   2. 取上游快照：`--upstream` 指定 → 包内 build/runtime.json 自带 → 默认快照；
 *      用 `library.js::buildHook()` 组装应用要的 hook（= build/runtime.json 的内容）；
 *   3. 算素材计划：脚本引用的角色基名 / 背景键 / 图片键 → 按引擎的 URL 规则展开
 *      （character/background/images 三个家族、face_overlay 差分、音频键、脚本里的
 *      绝对 https URL），去重排序写 build/assets.json；
 *   4. 写 build/runtime.json（hook JSON：`{story:{script,title},bundle,revision}`）、
 *      build/assets.json、必要时编译 script.txt；`--out` 处的副本（默认
 *      build/fanfic/<packId>.json）供应用导入/核对。
 *
 * 纯 Node ESM、零依赖；输出确定性（URL 排序、无时间戳）。契约见
 * `.akskills/arkstage-fanfic/reference/package.md`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  arg,
  PACK_VERSION,
  parseCharacterRef,
  parseScript,
  stripControls,
} from "../../src/akstage/local/storyPack.js";
import { buildHook, CHARACTER_URL, VARIABLES_URL } from "../../src/akstage/local/library.js";
import { lintPack, resolvePackScript } from "./lint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（scripts/fanfic/ → ../..）。 */
export const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_UPSTREAM = join("build", "fanfic", "upstream.json");
const OUT_DIR = join("build", "fanfic");
/** 引擎的资源前缀（`engine/asset.ts` 的 TORAPPU_ORIGIN）。 */
const TORAPPU = "https://torappu.prts.wiki";

export const USAGE = `同人剧本包打包（pack.mjs）

用法：
  node scripts/fanfic/pack.mjs <packDir> [--upstream <snapshot.json>]
       [--out <path>] [--force] [--dry-run] [--json <report.json>]

参数：
  <packDir>                剧本包目录（含 script.txt + pack.json）
  --upstream <snapshot>    上游快照（fetch-upstream.mjs 的产物）；
                           缺省顺序：包内 build/runtime.json → build/fanfic/upstream.json
  --out <path>             hook 的对外副本（默认 build/fanfic/<packId>.json；传 "-" 不写）
  --force                  lint 有 error 也继续打包
  --dry-run                只打印将写入的文件，不落盘
  --json <report.json>     写出打包报告（输入摘要 + 素材统计）
  -h, --help               显示本帮助

产物：
  <packDir>/script.txt        缺省时由 source/{script.txt,probe.txt} 去 @tag 编译；
                             已存在但仍有 @tag 时会被就地去掉
  <packDir>/build/runtime.json  hook JSON: { story:{script,title}, bundle, revision }
  <packDir>/build/assets.json   { "urls": [ 排序去重的 https URL ] }
  <packDir>/build/chapters.json 仅当 source/chapters/*.txt ≥2 个文件时产出

退出码：0 成功；1 lint 有 error（未加 --force）或写入失败；2 用法错误。
`;

// ── 小工具 ───────────────────────────────────────────────────────────────

/** @returns {{ok: boolean, value: any, error: string|null}} */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return { ok: false, value: null, error: "文件不存在或不可读" };
  try {
    return { ok: true, value: JSON.parse(text), error: null };
  } catch (error) {
    return { ok: false, value: null, error: String(error?.message ?? error) };
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const lower = (text) => String(text ?? "").trim().toLowerCase();

/** 引擎 `asset.ts::encodePathSegments`（逐段 encodeURIComponent 后拼回）。 */
const encodePathSegments = (path) => String(path).split("/").map((part) => encodeURIComponent(part)).join("/");

/** `resolveStoryAssetByKey(key, "background"|"image")`（键小写折叠，不转义）。 */
const imageFamilyUrl = (family, familyFolder, key) => (key ? `${TORAPPU}/assets/avg/${familyFolder}/${key}.png` : null);

/** `resolveStoryCharacterAssetByKey`（逐段转义）。 */
const characterUrl = (key) => (key ? `${TORAPPU}/assets/avg/characters/${encodePathSegments(key)}.png` : null);

/** `asset.ts::audioUrlFromValue`：`Sound_Beta_2/` 换成 `assets/audio/`，再补 `.mp3`。 */
function audioValueUrl(value) {
  const assetsBase = `${TORAPPU}/assets/`;
  return `${String(value).toLowerCase().replace("sound_beta_2", `${assetsBase}audio`)}.mp3`;
}

/** `resolveStoryAudioByKey`：`$变量` / `@路径` / `https://` / 裸键。 */
function audioUrl(key, variables) {
  const raw = String(key ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("$")) {
    const value = variables?.[raw.slice(1).toLowerCase()];
    return typeof value === "string" ? audioValueUrl(value) : null;
  }
  if (raw.startsWith("@")) return `${TORAPPU}/assets/${raw.slice(1)}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  return audioValueUrl(raw);
}

// ── 包输入 ────────────────────────────────────────────────────────

/**
 * 组装 library.js 的 LocalPack 形状（`buildHook()` 只读 script/id/patches/runtime）。
 * `ignoreRuntime`：本次要重写 build/runtime.json 时置真，避免把自己的旧 bundle 当上游。
 * @param {string} packDir
 * @param {{ignoreRuntime?: boolean}} [options]
 */
function readPackInput(packDir, { ignoreRuntime = false } = {}) {
  const metaParsed = readJson(join(packDir, "pack.json"));
  const meta = metaParsed.ok && isPlainObject(metaParsed.value) ? metaParsed.value : {};
  const scriptSource = resolvePackScript(packDir);
  const readPatch = (rel) => {
    const parsed = readJson(join(packDir, rel));
    return parsed.ok && isPlainObject(parsed.value) ? parsed.value : null;
  };
  const metadata = readJson(join(packDir, "metadata.json"));
  const ownRuntime = ignoreRuntime ? { ok: true, value: null, error: null } : readJson(join(packDir, "build", "runtime.json"));
  const chapters = readJson(join(packDir, "build", "chapters.json"));

  const id = typeof meta.id === "string" && meta.id.trim() ? meta.id.trim() : basename(packDir);
  return {
    id,
    dir: packDir,
    meta: { ...meta, id },
    scriptSource,
    patches: {
      characters: readPatch("patch/characters.json"),
      resolutionRules: readPatch("patch/resolutionRules.json"),
      variables: readPatch("patch/story_variables.json"),
    },
    chapterMeta: metadata.ok && isPlainObject(metadata.value) ? metadata.value : {},
    chapters: chapters.ok ? chapters.value : null,
    ownRuntime: ownRuntime.ok && isPlainObject(ownRuntime.value) ? ownRuntime.value : null,
    ownRuntimeError: ownRuntime.ok ? null : ownRuntime.error,
  };
}

/** 上游快照：只取 bundle（+ 便于诊断的 source/story）。 */
function bundleFromSnapshot(value) {
  if (!isPlainObject(value)) return null;
  if (isPlainObject(value.bundle)) return value.bundle;
  if (value.entry || value.modules || value.data) return value;
  return null;
}

/**
 * 选上游快照：`--upstream` → 包自带 build/runtime.json → 默认
 * `build/fanfic/upstream.json`（CWD 优先，再仓库根）。
 * @returns {{bundle: object|null, path: string|null, origin: string, story: any}}
 */
function resolveUpstream({ packDir, explicitPath, ownRuntime }) {
  if (explicitPath) {
    const parsed = readJson(resolve(explicitPath));
    const bundle = parsed.ok ? bundleFromSnapshot(parsed.value) : null;
    return { bundle, path: resolve(explicitPath), origin: "upstream", story: parsed.ok ? parsed.value?.story ?? null : null, error: parsed.ok ? null : parsed.error };
  }
  const ownBundle = bundleFromSnapshot(ownRuntime);
  if (ownBundle) {
    return { bundle: ownBundle, path: join(packDir, "build", "runtime.json"), origin: "pack", story: ownRuntime.story ?? null, error: null };
  }
  for (const candidate of [resolve(process.cwd(), DEFAULT_UPSTREAM), resolve(REPO_ROOT, DEFAULT_UPSTREAM)]) {
    if (!existsSync(candidate)) continue;
    const parsed = readJson(candidate);
    const bundle = parsed.ok ? bundleFromSnapshot(parsed.value) : null;
    if (bundle) return { bundle, path: candidate, origin: "default", story: parsed.value?.story ?? null, error: null };
  }
  return { bundle: null, path: null, origin: "none", story: null, error: null };
}

/** patch 基名 → 合并后的条目（把 patch 覆盖到上游条目上；`null` = 删除）。 */
function lookupCharacter(patches, upstreamTable, base) {
  const key = base.toLowerCase();
  const patch = patches.characters && Object.prototype.hasOwnProperty.call(patches.characters, key) ? patches.characters[key] : undefined;
  const upstream = isPlainObject(upstreamTable?.[key]) ? upstreamTable[key] : undefined;
  if (patch === null) return { entry: null, source: "removed" };
  if (isPlainObject(patch)) {
    const merged = { ...(upstream ?? {}), ...patch };
    if (!("array" in patch) && Array.isArray(upstream?.array)) merged.array = upstream.array;
    if (!("groups" in patch) && Array.isArray(upstream?.groups)) merged.groups = upstream.groups;
    return { entry: merged, source: "patch" };
  }
  if (upstream) return { entry: upstream, source: "upstream" };
  return { entry: null, source: "missing" };
}

// ── 素材计划 ───────────────────────────────────────────────────

/**
 * 脚本引用的语义键：与 `storyPack.js::collectAssetKeys` 同一套规则
 * （background / image / gridbg·verticalbg·largebg 的 imagegroup / character·charslot 基名），
 * 另收集 playmusic·playsound 的音频键与脚本里的绝对 https URL。
 * storyPack.js 保持不动，这里是「小逻辑的复制」。
 */
export function collectScriptRefs(compiledScript) {
  const characters = new Set();
  const backgrounds = new Set();
  const images = new Set();
  const audioKeys = new Set();
  const literalUrls = new Set();
  const cutins = new Set();

  const add = (set, value) => {
    if (typeof value !== "string" || !value.trim()) return;
    set.add(value.trim());
  };

  for (const line of parseScript(compiledScript)) {
    if (line.kind !== "command") continue;
    const command = line.command;
    if (command === "background") add(backgrounds, arg(line.args, "image"));
    else if (command === "image") add(images, arg(line.args, "image"));
    else if (command === "gridbg" || command === "verticalbg" || command === "largebg") {
      for (const part of String(arg(line.args, "imagegroup") ?? "").split("/")) if (part.trim()) backgrounds.add(part.trim());
    } else if (command === "character" || command === "charslot") {
      for (const key of command === "charslot" ? ["name"] : ["name", "name2"]) {
        const value = arg(line.args, key);
        if (typeof value !== "string" || !value.trim()) continue;
        const base = parseCharacterRef(value).base.trim();
        if (base) characters.add(base);
      }
    } else if (command === "interlude") {
      const type = arg(line.args, "type");
      const name = arg(line.args, "name");
      if (typeof name === "string" && name.trim()) {
        if (type === "char" || type === 3) {
          const base = parseCharacterRef(name).base.trim();
          if (base) characters.add(base);
        } else if (type === "uichar" || type === 1) cutins.add(name.trim());
      }
    } else if (command === "playmusic" || command === "playsound") {
      for (const key of command === "playmusic" ? ["key", "intro"] : ["key"]) add(audioKeys, arg(line.args, key));
    }
    for (const match of line.raw.matchAll(/https?:\/\/[^\s"'`<>)\]}\\,;]+/g)) literalUrls.add(match[0]);
  }
  return { characters, backgrounds, images, audioKeys, literalUrls, cutins };
}

/**
 * 算素材 URL 计划。
 *   `urls`  = `https://host/...`（host 必须带点；按 URL 排序去重）；
 *   `localKeys` = 裸键形态的本地/非 https 引用（`local.arkstage.invalid/art/x.png`），
 *                给媒体仓 canonical_key 用（它两种都收；下载器只吃 http(s)）。
 * @returns {{urls: string[], localKeys: string[], byKind: Record<string, number>, missingCharacters: string[], unresolvedAudio: string[]}}
 */
export function buildAssetPlan({ refs, mergedCharacters, mergedVariables }) {
  /** @type {Map<string, Set<string>>} */
  const urls = new Map();
  /** @type {Map<string, Set<string>>} */
  const localKeys = new Map();
  const addUrl = (url, kind) => {
    if (typeof url !== "string") return;
    const raw = url.trim();
    if (!raw) return;
    if (/^https:\/\//i.test(raw)) {
      const host = raw.slice("https://".length).split("/")[0].replace(/:\d+$/, "").toLowerCase();
      if (!host.includes(".")) return; // 无点 host：媒体仓会拒（lint 已报 error）
      const kinds = urls.get(raw) ?? new Set();
      kinds.add(kind);
      urls.set(raw, kinds);
      return;
    }
    // 非 https：保留成「裸键」（媒体仓接受 host/path 形态，供核对/预下载脚本参考）。
    const bare = raw.replace(/^https?:\/\//i, "");
    if (!bare.includes("/")) return;
    const host = bare.split("/")[0].replace(/:\d+$/, "").toLowerCase();
    if (!host.includes(".")) return;
    const normalized = `${host}${bare.slice(bare.split("/")[0].length)}`;
    const kinds = localKeys.get(normalized) ?? new Set();
    kinds.add(kind);
    localKeys.set(normalized, kinds);
  };

  for (const key of refs.backgrounds) addUrl(imageFamilyUrl("background", "background", lower(key)), "background");
  for (const key of refs.images) addUrl(imageFamilyUrl("image", "images", lower(key)), "image");
  for (const key of refs.cutins) addUrl(`${TORAPPU}/assets/avg/cutin/${encodePathSegments(lower(key))}.png`, "cutin");
  for (const url of refs.literalUrls) addUrl(url, "literal");

  const missingCharacters = [];
  for (const base of refs.characters) {
    const { entry, source } = mergedCharacters(base);
    if (!entry) {
      if (source === "missing") missingCharacters.push(base);
      continue;
    }
    const items = Array.isArray(entry.array) ? entry.array : [];
    const groups = Array.isArray(entry.groups) ? entry.groups : [];
    const first = items[0];
    const image = typeof first?.image === "string" && first.image ? first.image : typeof entry.image === "string" && entry.image ? entry.image : "";
    if (image) addUrl(characterUrl(image), source === "patch" ? "character" : "character_upstream");
    for (const [index, group] of groups.entries()) {
      if (!isPlainObject(group) || group.mode !== "face_overlay") continue;
      if (typeof group.base === "string" && group.base) addUrl(characterUrl(group.base), "face_base");
      for (const item of items) {
        if (item?.group !== index) continue;
        if (typeof item.face === "string" && item.face) addUrl(characterUrl(item.face), "face");
      }
    }
  }

  const unresolvedAudio = [];
  for (const key of refs.audioKeys) {
    const url = audioUrl(key, mergedVariables);
    if (url) addUrl(url, "audio");
    else unresolvedAudio.push(key);
  }

  /** @type {Record<string, number>} */
  const byKind = {};
  for (const kinds of [...urls.values(), ...localKeys.values()]) for (const kind of kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
  return {
    urls: [...urls.keys()].sort(),
    localKeys: [...localKeys.keys()].sort(),
    byKind,
    missingCharacters,
    unresolvedAudio,
  };
}

// ── 产物写入 ───────────────────────────────────────────────────

/**
 * 编译 `script.txt`（编译产物 = 去 `@tag` 的作者脚本）：
 *   source/script.txt 优先，否则 source/probe.txt（再退回 lint 兜底选中的文件）；
 *   先 `stripControls()`；`build/probe.json`（--probe 可换路径）里的取景结果若属于
 *   同一个 source，则按 `@tag` 的执行时机插入「控制位注释」（行级偏移，不影响播放）。
 *   写回**仅当**仓库里没有 script.txt，或编译结果与现有内容不同（幂等）。
 * @returns {{file: string|null, action: "kept"|"written"|"missing", text: string, source: string|null, tags: Array<{command: string, tag: string, line: number}>}}
 */
function compileScriptFile(packDir, lintSource, { dryRun = false, probePath = null } = {}) {
  const candidates = ["source/script.txt", "source/probe.txt"];
  if (lintSource?.isFallback && lintSource.file && !candidates.includes(lintSource.file)) candidates.push(lintSource.file);
  let source = null;
  for (const rel of candidates) {
    const text = readText(join(packDir, rel));
    if (text !== null && text.trim()) {
      source = { rel, text };
      break;
    }
  }
  if (!source) {
    const existing = readText(join(packDir, "script.txt"));
    return { file: null, action: "missing", text: existing ?? "", source: null, tags: [] };
  }

  const cleaned = stripControls(source.text);
  const tags = collectControlTags(source.text);
  const offsets = probeOffsets(probePath ? resolve(probePath) : join(packDir, "build", "probe.json"), source.text);
  const compiled = offsets.size && tags.length ? applyTagOffsets(cleaned, tags, offsets) : cleaned;

  const existing = readText(join(packDir, "script.txt"));
  const hasTags = stripControls(existing ?? "") !== (existing ?? "");
  const warnings = [];
  if (!offsets.size && tags.length && existsSync(probePath ? resolve(probePath) : join(packDir, "build", "probe.json"))) {
    warnings.push(`build/probe.json 不属于 ${source.rel}（或没有 (命令, tag) → 行号 映射），未插入取景偏移`);
  }
  if (existing !== null && existing.trim() && existing === compiled) {
    return { file: "script.txt", action: "kept", text: existing, source: source.rel, tags, warnings };
  }
  if (!dryRun) writeFileSync(join(packDir, "script.txt"), compiled);
  const note = offsets.size && tags.length
    ? `由 ${source.rel} 编译（stripControls + build/probe.json 取景偏移）`
    : `由 ${source.rel} 编译（stripControls）`;
  return {
    file: "script.txt",
    action: "written",
    text: compiled,
    source: source.rel,
    tags,
    warnings,
    note: existing === null || !existing.trim() ? note : `${note}（替换旧 script.txt${hasTags ? "，其中仍有 @tag" : ""}）`,
  };
}

/** `[Cmd@tag(...)]` 控制位在**作者脚本**里的 (命令, tag, 行号)。 */
function collectControlTags(text) {
  const out = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /\[\s*([A-Za-z_]\w*)\s*@([A-Za-z0-9_-]+)\s*[(\]]/.exec(lines[i]);
    if (match) out.push({ command: match[1].toLowerCase(), tag: match[2], line: i + 1 });
  }
  return out;
}

/**
 * 从 `build/probe.json`（probe.mjs 的产物）读控制位 → 上游行号偏移。
 * 只认「属于本 source」的报告：`source`/`sourceFile` 一致，或报告脚本与作者脚本去 tag 后相同。
 * @returns {Map<string, number>} key = `<command>@<tag>`
 */
function probeOffsets(probePath, sourceText) {
  const parsed = readJson(probePath);
  if (!parsed.ok || !isPlainObject(parsed.value)) return new Map();
  const probe = parsed.value;
  const declared = typeof probe.source === "string" ? probe.source : typeof probe.sourceFile === "string" ? probe.sourceFile : null;
  const probeScript = typeof probe.script === "string" && probe.script.trim() ? stripControls(probe.script) : null;
  const matches = (declared !== null && basename(declared) === "probe.txt") || (probeScript !== null && probeScript === stripControls(sourceText));
  if (!matches) return new Map();

  const offsets = new Map();
  const plan = Array.isArray(probe.plan) ? probe.plan : Array.isArray(probe.nodes) ? probe.nodes : null;
  if (plan) {
    for (const node of plan) {
      if (!isPlainObject(node)) continue;
      const tag = typeof node.tag === "string" ? node.tag : null;
      const command = typeof node.command === "string" ? node.command.toLowerCase() : null;
      const offset = Number(node.offset ?? node.lineOffset ?? node.line ?? node.upstreamLine);
      if (!tag || !command || !Number.isFinite(offset)) continue;
      offsets.set(`${command}@${tag}`, offset);
    }
  }
  if (!offsets.size && Array.isArray(probe.tags)) {
    for (const node of probe.tags) {
      if (!isPlainObject(node) || typeof node.tag !== "string") continue;
      const offset = Number(node.offset ?? node.lineOffset ?? node.line);
      if (!Number.isFinite(offset)) continue;
      offsets.set(node.tag, offset);
    }
  }
  return offsets;
}

/**
 * 按 `@tag` 出现顺序把偏移写成**注释**插到控制位行之前
 * （注释在引擎里整行丢弃，故不会改变播放；probe.json 缺席时原样返回）。
 */
function applyTagOffsets(cleanedScript, tags, offsets) {
  /** @type {Map<string, number>} */
  const byPair = new Map();
  for (const entry of tags) {
    const offset = offsets.get(`${entry.command}@${entry.tag}`) ?? offsets.get(entry.tag);
    if (offset !== undefined) byPair.set(`${entry.command}@${entry.tag}:${entry.line}`, offset);
  }
  if (!byPair.size) return cleanedScript;

  const lines = cleanedScript.split("\n");
  const out = [];
  let remaining = tags.filter((entry) => byPair.has(`${entry.command}@${entry.tag}:${entry.line}`) || byPair.has(`${entry.command}@${entry.tag}`));
  for (const line of lines) {
    // 控制位在作者脚本里是 `[Cmd@tag(...)]`，去 tag 后变成 `[Cmd(...)]`：
    // 用「已消费的控制位顺序」找它落在哪一行，把偏移注释插在它前面。
    let commandName = null;
    if (remaining.length && (commandName = commandOfLine(line)) !== null) {
      const index = remaining.findIndex((entry) => entry.command === commandName);
      if (index !== -1) {
        const entry = remaining[index];
        const offset = byPair.get(`${entry.command}@${entry.tag}:${entry.line}`) ?? byPair.get(`${entry.command}@${entry.tag}`);
        out.push(`// [probe] @${entry.tag} → 上游控制位 #${offset}`);
        remaining = [...remaining.slice(0, index), ...remaining.slice(index + 1)];
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/** 取一行命令名（`[Cmd(...)]` → cmd；`[name="…"]` → dialog）。 */
function commandOfLine(line) {
  const match = /^\s*\[\s*([A-Za-z_]\w*)/.exec(line);
  return match ? match[1].toLowerCase() : null;
}

/** 章节清单（可选）：`source/chapters/*.txt` ≥2 个 → build/chapters.json。 */
function buildChapters(packDir) {
  const dir = join(packDir, "source", "chapters");
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".txt")).sort();
  } catch {
    return null;
  }
  if (names.length < 2) return null;
  return names.map((name) => {
    const script = readText(join(dir, name)) ?? "";
    return {
      id: name.replace(/\.txt$/, ""),
      title: name.replace(/\.txt$/, ""),
      script,
      cleanScript: stripControls(script),
    };
  });
}

// ── 主入口 ──────────────────────────────────────────────────────

/**
 * 打包一个剧本包。
 * @param {string} packDir
 * @param {{upstreamPath?: string|null, probePath?: string|null, force?: boolean, dryRun?: boolean, outPath?: string|null, outDisabled?: boolean}} [options]
 * @returns {{code: number, report: any, log: string[]}}
 */
export function packPack(packDir, options = {}) {
  const dir = resolve(packDir);
  const log = [];
  const say = (text) => log.push(text);
  const dryRun = Boolean(options.dryRun);
  const emptyResult = () => [];

  const lint = lintPack(dir);
  const firstScriptSource = resolvePackScript(dir);
  say(`lint：错误 ${lint.errors.length} · 警告 ${lint.warnings.length}（${lint.counts.lines} 行 / ${lint.counts.decisions} 决策）`);

  if (lint.errors.length && !options.force) {
    say(`lint 有 ${lint.errors.length} 个 error —— 中止打包（用 --force 可继续）`);
    for (const issue of lint.errors.slice(0, 10)) say(`  - ${issue.file}${issue.line ? `:${issue.line}` : ""} ${issue.message}`);
    return {
      code: 1,
      log,
      report: {
        ok: false,
        aborted: "lint",
        pack: lint.pack,
        lint: { errors: lint.errors, warnings: lint.warnings, counts: lint.counts, toc: lint.toc },
        upstream: null,
        revision: null,
        files: emptyResult(),
        assets: { urls: [], localKeys: [], counts: {}, missingCharacters: [], unresolvedAudio: [] },
      },
    };
  }
  if (lint.errors.length) say(`lint 有 ${lint.errors.length} 个 error，--force：继续打包`);

  // 1. script.txt（编译产物 = 去 @tag 的作者脚本，写回仅当内容有变化）
  const compiled = compileScriptFile(dir, firstScriptSource, { dryRun, probePath: options.probePath ?? null });
  if (compiled.action === "missing") say("缺少 script.txt，source/ 里也没有作者脚本 —— 剧本为空");
  else if (compiled.action === "written" && compiled.note) say(compiled.note);
  else if (compiled.action === "kept") say("script.txt 已是编译产物，无需改写");
  for (const message of compiled.warnings ?? []) say(`提示：${message}`);
  const script = stripControls(compiled.text || firstScriptSource?.compiled || "");

  // 2. 上游快照 + hook（忽略包内旧的 build/runtime.json，因为它就是我们马上要重写的产物）
  const input = readPackInput(dir, { ignoreRuntime: true });
  const upstream = resolveUpstream({ packDir: dir, explicitPath: options.upstreamPath ?? null, ownRuntime: input.ownRuntime });
  if (!upstream.bundle) {
    say(upstream.error
      ? `上游快照不可用（${upstream.path}）：${upstream.error}`
      : `没有上游快照（${options.upstreamPath ?? DEFAULT_UPSTREAM}）—— build/runtime.json 的 bundle 会是 null，应用需要包自带 bundle`);
  } else {
    const originLabel = upstream.origin === "upstream" ? "--upstream" : upstream.origin === "pack" ? "包自带" : "默认";
    say(`上游快照：${upstream.path}（${originLabel}，modules ${Object.keys(upstream.bundle.modules ?? {}).length} 个）`);
  }

  const localPack = {
    id: input.id,
    dir,
    title: typeof input.meta.title === "string" && input.meta.title.trim() ? input.meta.title.trim() : input.id,
    chapter: typeof input.meta.chapter === "string" && input.meta.chapter.trim() ? input.meta.chapter.trim() : input.id,
    author: typeof input.meta.author === "string" ? input.meta.author : "",
    description: typeof input.meta.description === "string" ? input.meta.description : "",
    branchPoints: Array.isArray(input.meta.branchPoints) ? input.meta.branchPoints : [],
    script,
    packMeta: input.meta,
    chapterMeta: input.chapterMeta,
    chapters: input.chapters,
    patches: input.patches,
    runtime: null,
    wikitext: null,
    assets: {},
  };

  // patch 先合并进上游表（与应用一致的逻辑），得到一个「合并后的原表」用于查 URL；
  // 盘上仍旧存上游原表 + patch/ 单独放（见 package.md §4.1）。
  const upstreamCharacters = upstream.bundle?.data?.[CHARACTER_URL];
  const upstreamVariables = upstream.bundle?.data?.[VARIABLES_URL];
  const mergedCharactersTable = mergeIntoTable(upstreamCharacters, input.patches.characters) ?? upstreamCharacters ?? null;
  const mergedVariablesTable = mergeIntoTable(upstreamVariables, input.patches.variables) ?? upstreamVariables ?? null;
  // 上游仍无这张表时才把 patch 单列进 data（例如只有 patch、没有 character.json 快照）。
  const dataForBundle = upstream.bundle?.data ? { ...upstream.bundle.data } : {};
  if (!isPlainObject(dataForBundle[CHARACTER_URL]) && isPlainObject(input.patches.characters)) dataForBundle[CHARACTER_URL] = input.patches.characters;
  if (!isPlainObject(dataForBundle[VARIABLES_URL]) && isPlainObject(input.patches.variables)) dataForBundle[VARIABLES_URL] = input.patches.variables;
  const mergedBundle = upstream.bundle ? { ...upstream.bundle, data: dataForBundle } : null;
  const hook = (mergedBundle ? buildHook(localPack, { bundle: mergedBundle }) : null) ?? {
    story: { script, title: input.id },
    bundle: upstream.bundle ?? null,
    revision: fallbackRevision(input.id, script),
  };

  // 3. 素材计划
  const refs = collectScriptRefs(script);
  const plan = buildAssetPlan({
    refs,
    mergedCharacters: (base) => lookupCharacter(input.patches, mergedCharactersTable, base),
    mergedVariables: mergedVariablesTable,
  });
  say(`素材引用：角色 ${refs.characters.size} · 背景 ${refs.backgrounds.size} · 图片 ${refs.images.size} · 音频 ${refs.audioKeys.size} · 绝对 URL ${refs.literalUrls.size}`);
  const kindSummary = Object.entries(plan.byKind).sort().map(([kind, count]) => `${kind} ${count}`).join(" · ");
  say(`素材 URL：${plan.urls.length} 条·https${plan.localKeys.length ? ` · 本地键 ${plan.localKeys.length} 条` : ""}${kindSummary ? `（${kindSummary}）` : ""}`);
  if (plan.missingCharacters.length) say(`缺角色条目：${plan.missingCharacters.join(", ")}`);
  if (plan.unresolvedAudio.length) say(`未解析音频键：${plan.unresolvedAudio.join(", ")}`);

  // 4. 写入（确定性：runtime 单行 JSON、assets/chapters 缩进 1 空格）
  const written = [];
  const onWrite = (path, note) => written.push({ file: path, note, dryRun });
  const skipPlan = [];
  const save = (path, text, note) => {
    const absolute = resolve(path);
    const previous = readText(absolute);
    if (previous === text) {
      skipPlan.push({ file: path, note: "内容未变化" });
      return;
    }
    if (!dryRun) {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    onWrite(path, note);
  };

  const runtimeJson = `${JSON.stringify(hook)}\n`;
  const probeReport = readJson(options.probePath ? resolve(options.probePath) : join(dir, "build", "probe.json"));
  const inspection = { source: compiled.source ?? firstScriptSource?.file ?? null, tags: compiled.tags, probe: probeReport.ok ? probeReport.value : null };
  const assetsJson = `${JSON.stringify({ urls: plan.urls, localKeys: plan.localKeys }, null, 1)}\n`;
  const chapters = buildChapters(dir);

  save(join(dir, "build", "runtime.json"), runtimeJson, `hook（bundle ${hook.bundle ? "含上游快照" : "null"}）`);
  save(join(dir, "build", "assets.json"), assetsJson, `${plan.urls.length} 条 URL${plan.localKeys.length ? ` + ${plan.localKeys.length} 条本地键` : ""}`);
  save(join(dir, "build", "inspection.json"), `${JSON.stringify(inspection, null, 1)}\n`, `取景/控制位摘要（${compiled.tags.length} 个 @tag）`);
  if (chapters) save(join(dir, "build", "chapters.json"), `${JSON.stringify(chapters, null, 1)}\n`, `${chapters.length} 章`);

  const outPath = options.outDisabled ? null : resolve(options.outPath || join(OUT_DIR, `${input.id}.json`));
  if (outPath) save(outPath, runtimeJson, "--out hook 副本");

  const files = [
    ...(compiled.action === "written" ? [{ file: join(dir, "script.txt"), note: compiled.note ?? "编译 script.txt", dryRun }] : []),
    ...written,
    ...skipPlan,
  ];

  return {
    code: 0,
    log,
    report: {
      ok: true,
      aborted: null,
      pack: { ...lint.pack, id: input.id, version: PACK_VERSION, title: localPack.title },
      lint: { errors: lint.errors, warnings: lint.warnings, counts: lint.counts, toc: lint.toc },
      upstream: { path: upstream.path, origin: upstream.origin, hasBundle: Boolean(hook.bundle) },
      revision: hook.revision,
      files,
      assets: { urls: plan.urls, localKeys: plan.localKeys, counts: plan.byKind, missingCharacters: plan.missingCharacters, unresolvedAudio: plan.unresolvedAudio },
    },
  };
}

/** `library.js::mergeTables` 的等价实现（本文件内联一份，避免依赖模块内部状态）。 */
function mergeIntoTable(upstreamTable, patchTable) {
  if (!isPlainObject(patchTable)) return isPlainObject(upstreamTable) ? upstreamTable : null;
  const out = { ...(isPlainObject(upstreamTable) ? upstreamTable : {}) };
  for (const [key, value] of Object.entries(patchTable)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      const merged = { ...current, ...value };
      if (!("array" in value) && Array.isArray(current.array)) merged.array = current.array;
      if (!("groups" in value) && Array.isArray(current.groups)) merged.groups = current.groups;
      if (!("pos" in value) && current.pos) merged.pos = current.pos;
      if (!("size" in value) && current.size) merged.size = current.size;
      out[key] = merged;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** bundle 缺失时沿用 library.js::buildHook 的 revision 形状（djb2）。 */
function fallbackRevision(id, script) {
  let hash = 5381;
  for (let i = 0; i < script.length; i += 1) hash = ((hash << 5) + hash + script.charCodeAt(i)) >>> 0;
  return `fan:${id}:${hash.toString(16).padStart(8, "0")}`;
}

// ── CLI ─────────────────────────────────────────────────────────

export function parsePackArgs(argv) {
  const options = { packDir: null, upstreamPath: null, outPath: null, outDisabled: false, force: false, dryRun: false, json: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} 需要一个值`);
      i += 1;
      return value;
    };
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--force") options.force = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--upstream") options.upstreamPath = next();
    else if (token === "--out") {
      const value = next();
      if (value === "-") options.outDisabled = true;
      else options.outPath = value;
    } else if (token === "--json") options.json = next();
    else if (token.startsWith("-") && token !== "-") throw new Error(`未知参数：${token}`);
    else if (!options.packDir) options.packDir = token;
    else throw new Error(`多余的参数：${token}`);
  }
  return options;
}

/** @returns {number} 退出码 */
export function runPackCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parsePackArgs(argv);
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
  if (options.upstreamPath && !existsSync(resolve(options.upstreamPath))) {
    stderr.write(`上游快照不存在：${resolve(options.upstreamPath)}\n`);
    return 2;
  }

  let result;
  try {
    result = packPack(dir, options);
  } catch (error) {
    stderr.write(`打包失败：${error?.stack ?? error}\n`);
    return 1;
  }
  const { report, log, code } = result;
  stdout.write(`同人剧本包打包  ${report.pack.dir}\n`);
  stdout.write(`  id=${report.pack.id}  title=${report.pack.title}\n`);
  for (const line of log) stdout.write(`  ${line}\n`);
  if (code === 0) {
    stdout.write("\n写入：\n");
    for (const entry of report.files) stdout.write(`  ${entry.dryRun ? "[dry-run] " : ""}${entry.file}  —  ${entry.note}\n`);
    stdout.write(`\nrevision: ${report.revision}\n`);
    stdout.write(`结论：打包完成（素材 ${report.assets.urls.length} 条，lint 错误 ${report.lint.errors.length}）\n`);
  } else {
    stdout.write(`\n结论：中止（lint 错误 ${report.lint.errors.length}）\n`);
  }
  if (options.json) {
    const outPath = resolve(options.json);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`);
    stdout.write(`报告已写入 ${outPath}\n`);
  }
  return code;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = runPackCli(process.argv.slice(2));
