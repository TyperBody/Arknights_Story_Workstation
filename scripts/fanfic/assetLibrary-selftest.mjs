#!/usr/bin/env node
/**
 * 素材库纯逻辑自检（task-B，≥40 断言）。
 *
 *   node scripts/fanfic/assetLibrary-selftest.mjs
 *
 * 只 import `frontend/src/lib/assetLibrary.ts`（**零依赖纯数据层**）——UI 只渲染，
 * 合并 / 过滤 / 分组 / 排序 / 脚本抽 key 只有这一份实现，避免「面板里的表」和
 * 「自检里的表」漂移。用裸 Node v22 的类型擦除（TS 直接 import），不起浏览器。
 *
 * 覆盖面：
 *   (1) `normalizeAssetKey` / `assetKindOf`：URL、canonical key、坏输入；
 *   (2) `parseScriptAssetKeys`：四类抽取、`$变量` 原样、Tab 缩进、`//` 注释、
 *       未知控制器、`name2`、缺 `key=`、CRLF；
 *   (3) `assetEntries`：四来源合并、去重、`uses` 聚合、`bundled`/`fromPack`、
 *       canvas 名 + `array[].image` **两条都在**、稳定排序；
 *   (4) `sortAssetEntries` / `filterAssetEntries` / `groupAssetEntries` /
 *       `assetKindCounts`：搜索、只看随包、收藏、排序稳定性、分组顺序；
 *   (5) `audioUrlFor`：引擎公式（`Sound_Beta_2` → `assets/audio/*.mp3`）、
 *       变量缺失 → 空串；
 *   (6) 异常输入：null / 数字 / 空表 / 坏 key —— 一律不抛。
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const LIB = `file://${resolve(REPO, "frontend/src/lib/assetLibrary.ts")}`;

let pass = 0;
const failures = [];
const ok = (label, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL ${label} — ${error?.message ?? error}`);
  }
};

const lib = await import(LIB);
const {
  ASSET_KIND_IDS,
  assetEntries,
  assetKindCounts,
  assetKindOf,
  assetLabelOf,
  audioUrlFor,
  filterAssetEntries,
  groupAssetEntries,
  normalizeAssetKey,
  parseScriptAssetKeys,
  sortAssetEntries,
} = lib;

// ── 夹具 ────────────────────────────────────────────────────────────────
const BACKGROUNDS = {
  bg_black: 100,
  "bg_room_2": 100,
  bg_rhodeslounge_2: 80,
  "71_g10_bottomruins": 100,
};
const CHARACTERS = {
  char_002_amiya_1: {
    pos: { x: 0, y: 100 },
    size: { x: 1024, y: 1024 },
    gridSize: 1.5,
    groups: [],
    array: [
      { name: "char_002_amiya_1$1", alias: "", group: -1, image: "char_002_amiya_1/char_002_amiya_1$1" },
      { name: "char_002_amiya_1$2", alias: "", group: -1, image: "char_002_amiya_1/char_002_amiya_1$2" },
    ],
  },
  avg_npc_757_1: {
    pos: { x: 0, y: 100 },
    size: { x: 1050, y: 1050 },
    groups: [],
    array: [{ name: "avg_npc_757_1$1", alias: "", group: -1, image: "avg_npc_757_1/avg_npc_757_1$1" }],
  },
};
const VARIABLES = {
  calm_loop: "Sound_Beta_2/Music/beta1_180603/m_dia_babel_loop",
  d_avg_radio: "Sound_Beta_2/Dialog/d_avg_radio",
  opendoor: "Sound_Beta_2/Dialog/d_avg_dooropen",
  axia_name: "小小小天使",
};
const KEYS = parseScriptAssetKeys(
  [
    '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
    '[Background(image="bg_black", fadetime=0.5, block=true)]',
    '\t[PlayMusic(key="$calm_loop", volume=0.6)]',
    '\t\t[PlaySound(key="$d_avg_radio")]',
    '  [charslot(slot="m", name="char_002_amiya_1", duration=0.5)]',
    '// [PlayMusic(key="$commented_out")]',
    '[PlayMusic(key="$calm_loop")]',
    '[wallpaper(name="x")]',
    '[name="阿米娅"]  这边走，博士。',
    '[Character(name="char_010_chen_1", name2="char_130_doberm_ex")]',
    '',
  ].join("\n")
);
const PACK_KEYS = {
  "torappu.prts.wiki/assets/avg/background/bg_black.png": "assets/bg_black.webp",
  "torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1$1.png":
    "assets/char_002_amiya_1__1.webp",
  "torappu.prts.wiki/assets/audio/Music/beta1_180603/m_dia_babel_loop.mp3": "assets/m_dia_babel_loop.mp3",
};
const BUNDLED = ["bg_black", "bg_room_2", "bg_forest", "char_002_amiya_1/char_002_amiya_1"];
const BASE = {
  backgrounds: BACKGROUNDS,
  characters: CHARACTERS,
  scriptKeys: KEYS,
  variables: VARIABLES,
  packKeys: PACK_KEYS,
  bundledKeys: BUNDLED,
};
const all = () => assetEntries(BASE);
const one = (key) => all().find((entry) => entry.key === key);

// ── (1) key 归一 / 分类 ──────────────────────────────────────────────
ok("① 官方背景 URL → bg_black", () => {
  assert.equal(normalizeAssetKey("https://torappu.prts.wiki/assets/avg/background/bg_black.png"), "bg_black");
});
ok("② 官方立绘 URL → 角色/贴图", () => {
  assert.equal(
    normalizeAssetKey("https://torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1$1.png"),
    "char_002_amiya_1/char_002_amiya_1$1"
  );
});
ok("③ canonical key（无 scheme）同样折得动", () => {
  assert.equal(normalizeAssetKey("torappu.prts.wiki/assets/avg/background/bg_room_2.png"), "bg_room_2");
});
ok("④ 音频 URL → audio/Music/…（不带扩展名）", () => {
  assert.equal(
    normalizeAssetKey("https://torappu.prts.wiki/assets/audio/Music/beta1_180603/m_dia_babel_loop.mp3"),
    "audio/Music/beta1_180603/m_dia_babel_loop"
  );
});
ok("⑤ 裸 key 原样保留（bg 前缀小写化）", () => {
  assert.equal(normalizeAssetKey("bg_Forest"), "bg_forest");
  assert.equal(normalizeAssetKey("$calm_loop"), "$calm_loop");
  assert.equal(normalizeAssetKey("char_002_amiya_1/char_002_amiya_1$1"), "char_002_amiya_1/char_002_amiya_1$1");
});
ok("⑥ 坏输入 → 空串，不抛", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   ", '""']) {
    assert.equal(normalizeAssetKey(bad), "", `bad=${String(bad)}`);
  }
});
ok("⑦ 分类：背景 / 立绘 / BGM / 音效 各自的判定", () => {
  assert.equal(assetKindOf("bg_black"), "background");
  assert.equal(assetKindOf("ui_speaker"), "background");
  assert.equal(assetKindOf("char_002_amiya_1/char_002_amiya_1"), "character");
  assert.equal(assetKindOf("$calm_loop"), "sound");
  assert.equal(assetKindOf("audio/Music/beta1/m_dia.mp3"), "music");
  assert.equal(assetKindOf("audio/Dialog/d_avg_radio"), "sound");
  assert.equal(assetKindOf("Sound_Beta_2/Music/x/y"), "music");
});
ok("⑧ 标签：立绘取角色名，音频带前缀", () => {
  assert.equal(assetLabelOf("char_002_amiya_1/char_002_amiya_1", "character"), "char_002_amiya_1");
  assert.equal(assetLabelOf("bg_black", "background"), "bg_black");
  assert.ok(assetLabelOf("audio/Music/a/b", "music").startsWith("BGM "));
  assert.ok(assetLabelOf("$x", "sound").startsWith("SFX "));
});

// ── (2) 脚本抽 key ─────────────────────────────────────────────────
ok("⑨ 四类各抽到正确的 key", () => {
  assert.deepEqual(KEYS.music.sort(), ["$calm_loop"]);
  assert.deepEqual(KEYS.sound.sort(), ["$d_avg_radio"]);
  assert.deepEqual(KEYS.images.sort(), ["bg_black"]);
  assert.deepEqual(KEYS.characters.sort(), ["char_002_amiya_1", "char_010_chen_1", "char_130_doberm_ex"]);
});
ok("⑩ `$变量` 原样保留（不去 `$`）", () => {
  assert.ok(KEYS.music.every((value) => value.startsWith("$")));
  assert.ok(KEYS.sound.every((value) => value.startsWith("$")));
});
ok("⑪ Tab / 多级缩进行照样抽得到", () => {
  const tabbed = parseScriptAssetKeys('\t\t[PlayMusic(key="$a_loop")]\n  [Background(image="bg_x")]');
  assert.deepEqual(tabbed.music, ["$a_loop"]);
  assert.deepEqual(tabbed.images, ["bg_x"]);
});
ok("⑫ `//` 注释行与裸旁白不算素材", () => {
  assert.ok(!KEYS.music.includes("$commented_out"));
  assert.equal(KEYS.counts["$commented_out"], undefined);
  assert.ok(!KEYS.images.includes("阿米娅"));
});
ok("⑬ 未知控制器（`[wallpaper]`）不抛、不改动结果", () => {
  const withUnknown = parseScriptAssetKeys('[wallpaper(name="x")]\n[PlaySound(key="$d")]');
  assert.deepEqual(withUnknown.sound, ["$d"]);
  assert.deepEqual(withUnknown.images, []);
});
ok("⑭ 重复出现去重 + counts 计次", () => {
  assert.equal(KEYS.music.filter((value) => value === "$calm_loop").length, 1);
  assert.equal(KEYS.counts["$calm_loop"], 2);
});
ok("⑮ `[Character(name=, name2=)]` 两条都收", () => {
  assert.ok(KEYS.characters.includes("char_010_chen_1"));
  assert.ok(KEYS.characters.includes("char_130_doberm_ex"));
});
ok("⑯ `[nameslot(name=)]` 与前缀命名空间（`[Battle.PlayMusic]`）", () => {
  const mixed = parseScriptAssetKeys('[nameslot(slot="m", name="avg_npc_1")]\n[Battle.PlayMusic(key="$a")]');
  assert.deepEqual(mixed.characters, ["avg_npc_1"]);
  assert.deepEqual(mixed.music, ["$a"]);
});
ok("⑰ 缺 `key=` / 空值 → 不进清单，不抛", () => {
  const mixed = parseScriptAssetKeys('[PlayMusic(volume=0.6)]\n[PlaySound(key="")]\n[Background(image=)]');
  assert.deepEqual(mixed.music, []);
  assert.deepEqual(mixed.sound, []);
  assert.deepEqual(mixed.images, []);
});
ok("⑱ CRLF 脚本可解析；空/非字符串 → 空结果", () => {
  const crlf = parseScriptAssetKeys('[PlaySound(key="$a")]\r\n[PlaySound(key="$b")]\r\n');
  assert.deepEqual(crlf.sound, ["$a", "$b"]);
  for (const bad of [null, undefined, 7, {}, ""]) {
    const out = parseScriptAssetKeys(bad);
    assert.deepEqual(out, { music: [], sound: [], images: [], characters: [], counts: {} });
  }
});
ok("⑲ `intro=` 也算一条 BGM", () => {
  const withIntro = parseScriptAssetKeys('[PlayMusic(key="$loop", intro="$intro")]');
  assert.deepEqual(withIntro.music.sort(), ["$intro", "$loop"].sort());
});

// ── (3) 合并 / 去重 / 聚合 ────────────────────────────────────────
ok("⑳ 四来源合并：背景表 + 角色表 + 脚本 + 包自带都在", () => {
  const entries = all();
  assert.ok(entries.length >= 10, `entries=${entries.length}`);
  assert.ok(entries.some((entry) => entry.key === "71_g10_bottomruins"), "引擎背景表");
  assert.ok(entries.some((entry) => entry.key === "avg_npc_757_1"), "角色 canvas 名");
  assert.ok(entries.some((entry) => entry.key === "avg_npc_757_1/avg_npc_757_1$1"), "array[].image 贴图名");
  assert.ok(entries.some((entry) => entry.key === "$calm_loop" && entry.kind === "music"), "脚本 BGM");
  assert.ok(entries.some((entry) => entry.sources.includes("pack")), "包自带");
});
ok("㉑ 同一个 base 的 canvas 名与贴图名是**两条**", () => {
  const keys = all().map((entry) => entry.key);
  assert.ok(keys.includes("avg_npc_757_1"));
  assert.ok(keys.includes("avg_npc_757_1/avg_npc_757_1$1"));
  assert.notEqual(keys.indexOf("avg_npc_757_1"), keys.indexOf("avg_npc_757_1/avg_npc_757_1$1"));
});
ok("㉒ 去重：同名 key 只出现一次", () => {
  const keys = all().map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length);
});
ok("㉓ `uses` 聚合（表权重 + 脚本出现次数），不是覆盖", () => {
  assert.equal(one("bg_black").uses, 101, "表 100 + 脚本 1");
  assert.equal(one("$calm_loop").uses, 2, "脚本出现 2 次");
  assert.equal(one("bg_room_2").uses, 100);
});
ok("㉔ `bundled`：覆盖层名单与内置样例都算；导入进包的也算", () => {
  assert.equal(one("bg_black").bundled, true);
  assert.equal(one("71_g10_bottomruins").bundled, false);
  assert.equal(one("bg_black").fromPack, true);
  assert.equal(one("char_002_amiya_1/char_002_amiya_1$1").fromPack, true);
});
ok("㉕ `sources` 记录来源（engine+script+pack 可叠加）", () => {
  assert.deepEqual(one("bg_black").sources.slice().sort(), ["engine", "pack", "script"]);
  assert.deepEqual(one("71_g10_bottomruins").sources, ["engine"]);
  assert.deepEqual(one("$d_avg_radio").sources, ["script"]);
});
ok("㉖ 稳定排序：随包优先 → 用量降序 → key 码点序", () => {
  const entries = all();
  for (let i = 1; i < entries.length; i += 1) {
    const a = entries[i - 1];
    const b = entries[i];
    assert.ok(a.bundled || !b.bundled, `bundled 顺序 @${i}`);
    if (a.bundled === b.bundled && a.uses === b.uses) assert.ok(a.key < b.key, `字典序 @${i}`);
    if (a.bundled === b.bundled) assert.ok(b.uses <= a.uses, `用量降序 @${i}`);
  }
  assert.equal(entries[0].bundled, true);
});
ok("㉗ 两次调用结果**逐条相同**（确定性）", () => {
  assert.deepEqual(all(), all());
});
ok("㉘ 只用 bundledKeys 也能成条目（表没就绪时退化）", () => {
  const only = assetEntries({ bundledKeys: BUNDLED });
  assert.equal(only.length, new Set(BUNDLED).size);
  assert.ok(only.every((entry) => entry.bundled));
});
ok("㉙ 传入 Set / 数组 / Map 形态的表也能吃", () => {
  const set = assetEntries({ backgrounds: new Set(["bg_a", "bg_b"]) });
  assert.deepEqual(set.map((entry) => entry.key).sort(), ["bg_a", "bg_b"]);
  const array = assetEntries({ charCandidates: undefined, characters: ["char_x/char_x"] });
  assert.deepEqual(array.map((entry) => entry.key), ["char_x/char_x"]);
  const map = assetEntries({ backgrounds: new Map([["bg_c", 7]]) });
  assert.equal(map[0].uses, 7);
});

// ── (4) 排序 / 过滤 / 分组 ────────────────────────────────────────
ok("㉚ `sort: \"name\"` 时同随包档内按 key 码点序", () => {
  const named = sortAssetEntries(all(), "name");
  for (let i = 1; i < named.length; i += 1) {
    const a = named[i - 1];
    const b = named[i];
    if (a.bundled === b.bundled) assert.ok(a.key < b.key, `@${i} ${a.key} / ${b.key}`);
  }
});
ok("㉛ 搜索：命中 key 片段（大小写不敏感）", () => {
  const hit = filterAssetEntries(all(), { query: "AMIYA" });
  assert.ok(hit.length >= 3, `hit=${hit.length}`);
  assert.ok(hit.every((entry) => entry.key.toLowerCase().includes("amiya")));
});
ok("㉜ 搜索：命中包内路径（`.webp`）", () => {
  const hit = filterAssetEntries(all(), { query: ".webp" });
  assert.ok(hit.length >= 1);
  assert.ok(hit.every((entry) => entry.fromPack));
});
ok("㉝ 类型过滤：只看背景 / 只看音效", () => {
  const backgrounds = filterAssetEntries(all(), { kind: "background" });
  assert.ok(backgrounds.length >= 4);
  assert.ok(backgrounds.every((entry) => entry.kind === "background"));
  const sounds = filterAssetEntries(all(), { kind: "sound" });
  assert.deepEqual(sounds.map((entry) => entry.key).sort(), ["$d_avg_radio"]);
});
ok("㉞ 「只看随包」把引擎目录里没随包的挡掉", () => {
  const bundledOnly = filterAssetEntries(all(), { onlyBundled: true });
  assert.ok(bundledOnly.every((entry) => entry.bundled));
  assert.ok(!bundledOnly.some((entry) => entry.key === "71_g10_bottomruins"));
});
ok("㉟ 收藏过滤（`favorites` + `onlyFavorites`）", () => {
  const favorites = ["bg_room_2", "$calm_loop"];
  const kept = filterAssetEntries(all(), { onlyFavorites: true, favorites });
  assert.deepEqual(kept.map((entry) => entry.key).sort(), favorites.slice().sort());
  assert.deepEqual(filterAssetEntries(all(), { favorites }).length, all().length);
});
ok("㊱ 组合过滤：查询 + 类型 + 只看随包（空结果也是空数组）", () => {
  assert.deepEqual(filterAssetEntries(all(), { query: "zzz", kind: "music", onlyBundled: true }), []);
  const hit = filterAssetEntries(all(), { query: "bg_", kind: "background", onlyBundled: true });
  assert.ok(hit.length >= 3);
  assert.ok(hit.every((entry) => entry.bundled && entry.kind === "background"));
});
ok("㊲ 分组（`kind`）：按 ASSET_KIND_IDS 顺序、空组丢掉", () => {
  const groups = groupAssetEntries(all(), "kind");
  assert.ok(groups.length >= 3);
  const order = groups.map((group) => group.kind);
  const wanted = ASSET_KIND_IDS.filter((kind) => order.includes(kind));
  assert.deepEqual(order, wanted);
  assert.ok(groups.every((group) => group.entries.length > 0));
  assert.ok(groups.every((group) => group.entries.every((entry) => entry.kind === group.kind)));
});
ok("㊳ 分组（`flat`）：一组、保序、数量守恒", () => {
  const flat = groupAssetEntries(all(), "flat");
  assert.equal(flat.length, 1);
  assert.equal(flat[0].kind, null);
  assert.deepEqual(flat[0].entries, all());
});
ok("㊴ 类型计数：all = 总数、各类之和 = 总数", () => {
  const counts = assetKindCounts(all());
  assert.equal(counts.all, all().length);
  const sum = ASSET_KIND_IDS.reduce((total, kind) => total + counts[kind], 0);
  assert.equal(sum, counts.all);
});

// ── (5) 音频 URL ────────────────────────────────────────────────
ok("㊵ `$var` → 引擎公式的 `assets/audio/*.mp3`", () => {
  assert.equal(
    audioUrlFor("$calm_loop", VARIABLES),
    "https://torappu.prts.wiki/assets/audio/Music/beta1_180603/m_dia_babel_loop.mp3"
  );
  assert.equal(
    audioUrlFor("$d_avg_radio", VARIABLES),
    "https://torappu.prts.wiki/assets/audio/Dialog/d_avg_radio.mp3"
  );
});
ok("㊶ 变量名大小写不敏感；未知变量 / 非音频值 → 空串", () => {
  assert.ok(audioUrlFor("$CALM_LOOP", VARIABLES).endsWith("/m_dia_babel_loop.mp3"));
  assert.equal(audioUrlFor("$nope", VARIABLES), "");
  assert.equal(audioUrlFor("$axia_name", VARIABLES), "");
  assert.equal(audioUrlFor("$calm_loop", null), "");
  assert.equal(audioUrlFor("", VARIABLES), "");
});
ok("㊷ 已是音频路径的 key 也走同一公式（包自带音频）", () => {
  assert.equal(
    audioUrlFor("audio/Music/beta1_180603/m_dia_babel_loop.mp3", VARIABLES),
    "https://torappu.prts.wiki/assets/audio/Music/beta1_180603/m_dia_babel_loop.mp3"
  );
  assert.equal(
    audioUrlFor("Sound_Beta_2/Dialog/d_avg_dooropen", VARIABLES),
    "https://torappu.prts.wiki/assets/audio/Dialog/d_avg_dooropen.mp3"
  );
});
ok("㊸ 条目带 `audioUrl`：音频条目有、图片条目没有", () => {
  assert.ok((one("$calm_loop").audioUrl ?? "").startsWith("https://torappu.prts.wiki/assets/audio/"));
  assert.equal(one("bg_black").audioUrl, undefined);
  assert.equal(one("char_010_chen_1").audioUrl, undefined);
});
ok("㊹ 包自带的音频（`packKeys` 的 `.mp3`）分类为 music/sound", () => {
  const packAudio = all().find((entry) => entry.key.startsWith("audio/Music/"));
  assert.ok(packAudio, "包自带音频条目应在");
  assert.equal(packAudio.kind, "music");
  assert.equal(packAudio.fromPack, true);
});

// ── (6) 异常输入 ─────────────────────────────────────────────
ok("㊺ 空 / null / 坏表输入不抛（返回空或只剩 bundled）", () => {
  assert.deepEqual(assetEntries(), []);
  assert.deepEqual(assetEntries({}), []);
  assert.deepEqual(
    assetEntries({ backgrounds: null, characters: null, scriptKeys: null, packKeys: null, bundledKeys: null }),
    []
  );
  assert.deepEqual(assetEntries({ backgrounds: new Map(), characters: [], packKeys: [], scriptKeys: undefined }), []);
  assert.deepEqual(assetEntries({ backgrounds: "" }), []);
  assert.deepEqual(assetEntries({ backgrounds: 0 }), []);
});
ok("㊻ 坏 key（数字 / 空串 / 怪异 URL）不会变成条目", () => {
  const entries = assetEntries({
    backgrounds: { "": 3, "   ": 3, 12: 3, "https://x.example/": 3 },
    characters: { "": { array: [{ image: "" }] } },
    packKeys: { "": "a.png", "https://torappu.prts.wiki/assets/avg/background/bg_ok.png": "b.png" },
  });
  assert.deepEqual(entries.map((entry) => entry.key), ["bg_ok"]);
  assert.equal(entries[0].fromPack, true);
});
ok("㊼ 坏 `scriptKeys`（字段缺失/非数组）不抛", () => {
  const a = assetEntries({ scriptKeys: { music: null, sound: undefined, images: "x", characters: 3, counts: {} } });
  assert.deepEqual(a, []);
  const b = assetEntries({ scriptKeys: parseScriptAssetKeys("garbage\n[PlayMusic(key=\"$z\")]") });
  assert.deepEqual(b.map((entry) => entry.key), ["$z"]);
});
ok("㊽ `uses` 非数字（NaN/负/字符串）不会 NaN 化", () => {
  const entries = assetEntries({ backgrounds: { bg_a: "oops", bg_b: Number.NaN, bg_c: -5 } });
  for (const entry of entries) assert.ok(Number.isFinite(entry.uses) && entry.uses >= 0, entry.key);
});
ok("㊾ `assetEntries` 不改写入参（纯函数）", () => {
  const backgrounds = { bg_keep: 3 };
  const characters = { char_keep: { array: [{ image: "char_keep/char_keep" }] } };
  const packKeys = { "torappu.prts.wiki/assets/avg/background/bg_keep.png": "assets/bg_keep.webp" };
  const snapshot = JSON.stringify([backgrounds, characters, packKeys]);
  assetEntries({ backgrounds, characters, packKeys, bundledKeys: ["bg_keep"] });
  assert.equal(JSON.stringify([backgrounds, characters, packKeys]), snapshot);
});
ok("㊿ 真实规模：1827 / 1055 条表能跑完且计数守恒", async () => {
  const snapshot = JSON.parse(
    (await import("node:fs")).readFileSync(resolve(REPO, "src-tauri/resources/engine/v1/snapshot.json"), "utf8")
  );
  const data = snapshot.data;
  const backgrounds = data["https://torappu.prts.wiki/assets/avg/background.json"];
  const characters = data["https://torappu.prts.wiki/assets/avg/character.json"];
  const variables = data["https://torappu.prts.wiki/gamedata/latest/story/story_variables.json"];
  const keys = parseScriptAssetKeys('[PlayMusic(key="$calm_loop")]\n[Background(image="bg_black")]');
  const entries = assetEntries({ backgrounds, characters, variables, scriptKeys: keys, bundledKeys: BUNDLED });
  assert.ok(Object.keys(backgrounds).length >= 1000, "背景表 ≥1000");
  assert.ok(Object.keys(characters).length >= 1800, "角色表 ≥1800");
  assert.ok(entries.length >= 3000, `合并条目 ${entries.length}`);
  const counts = assetKindCounts(entries);
  assert.equal(counts.all, entries.length);
  assert.ok(counts.character > Object.keys(characters).length, "canvas 名 + 贴图名 > 角色数");
  const first = all()[0];
  assert.ok(first.bundled, "随包条目排最前");
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const label of failures) console.log(`  ✗ ${label}`);
  process.exit(1);
}
