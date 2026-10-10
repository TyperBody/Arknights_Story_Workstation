// PRTS 已发布剧情目录的抓取/解析（Node 侧，供 skill 打包脚本使用）。
// 与 Rust 的 parser/story_index.rs + parser/story_page.rs 同契约：
// 目录页「剧情一览」→ 分类/章节/书目；每章页 → 标题与章节名。
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UA = "Arkstage/1.2.0 (+https://github.com/djkcyl/arkstage)";
const INDEX_PAGE = "剧情一览";

async function fetchRaw(page) {
  const url = `https://prts.wiki/w/${encodeURIComponent(page)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://prts.wiki/" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

const strip = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&amp;/g, "&")
  .trim();

/** 返回 { categories:[{name, chapters:[{name, activity_name, stories:[{title,page_title}]}]}] } */
export async function fetchStoryIndex() {
  const html = await fetchRaw(INDEX_PAGE);
  const tables = [...html.matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  const categories = [];
  for (const table of tables) {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    let categoryName = "";
    let currentChapter = null;
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => strip(m[1]));
      const links = [...row.matchAll(/<a[^>]*href="\/w\/([^"#?]+)"[^>]*title="([^"]*)"/gi)]
        .map((m) => ({ page_title: decodeURIComponent(m[1]).replace(/_/g, " "), title: strip(m[2]) }));
      if (cells.length <= 1) {
        const name = cells[0] || "";
        if (name && !currentChapter) categoryName = categoryName || name;
        else if (name) { currentChapter = null; categoryName = name; } else currentChapter = null;
        continue;
      }
      const storyCells = links.filter((link) => !/^(分类|模板|Widget|模块|帮助|PRTS):/i.test(link.page_title));
      if (!storyCells.length) continue;
      const label = cells[0] || cells[1] || "";
      if (!currentChapter || currentChapter.name !== label) {
        currentChapter = { name: label, activity_name: null, stories: [] };
        const list = categories.find((category) => category.name === categoryName);
        if (list) list.chapters.push(currentChapter);
        else categories.push({ name: categoryName || "剧情", chapters: [currentChapter] });
      }
      for (const link of storyCells) {
        if (!currentChapter.stories.some((story) => story.page_title === link.page_title)) currentChapter.stories.push(link);
      }
    }
  }
  return { categories: categories.filter((category) => category.chapters.length) };
}

/** 章节页：拿章节名（用于「剧情分组」与导出 wikitext）。 */
export async function fetchChapterName(pageTitle) {
  const html = await fetchRaw(pageTitle);
  const heading = html.match(/<h1[^>]*id="firstHeading"[^>]*>([\s\S]*?)<\/h1>/);
  const candidates = [strip(heading?.[1] ?? "")];
  for (const m of html.matchAll(/剧情分组\s*[=＝]\s*([^|\n}<]+)/g)) candidates.push(strip(m[1]));
  return candidates.find((value) => value && !/^剧情/.test(value)) ?? "";
}

export function loadCachedIndex(path = "build/fanfic/story-index.json") {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    return null;
  }
}

export function saveIndex(index, path = "build/fanfic/story-index.json") {
  const out = resolve(path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(index, null, 1));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  fetchStoryIndex()
    .then((index) => {
      const file = saveIndex(index);
      const chapters = index.categories.flatMap((category) => category.chapters);
      const stories = chapters.flatMap((chapter) => chapter.stories);
      console.log(`categories=${index.categories.length} chapters=${chapters.length} stories=${stories.length} -> ${file}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
