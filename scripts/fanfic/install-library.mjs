// 把 `<packDir>`（或整个 library 目录）镜像成 `<dataRoot>/assets/library/` 的布局：
//   assets/library/index.json          —— 列出每个包的文件名
//   assets/library/<packId>/<file>    —— 原样复制
// 这是应用**零 Rust 改动**的读取路径：`frontend/src/lib/localStories.ts` 在
// `list_library` 命令不存在时，用既有的 `read_asset_text(category="library", …)`
// 读同一份布局。`list_library` 上线后本镜像仍然可用（它只是另一种分发方式）。
//
//   node scripts/fanfic/install-library.mjs <packDir|libraryDir> [--data-root <dir>] [--dry-run]
//
// 不带 `--data-root` 时写到 `build/fanfic/assets-library/`，由使用者整体拷进资源目录。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";

const argv = process.argv.slice(2);
const positional = argv.filter((value) => !value.startsWith("--"));
const flag = (name) => argv.includes(name);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);

const input = resolve(positional[0] ?? "example/library");
const dataRoot = option("--data-root", null);
const outRoot = dataRoot ? join(resolve(dataRoot), "assets", "library") : resolve("build/fanfic/assets-library");
const dryRun = flag("--dry-run");

const SKIP = /\.(png|jpg|jpeg|mp3|ogg|wav|ttf|otf|webp|mp4)$/i;

/** 找包目录：目录本身是包，或其子目录是包。 */
function findPacks(root) {
  const hasPack = (dir) => existsSync(join(dir, "script.txt")) || existsSync(join(dir, "source", "probe.txt"));
  if (hasPack(join(root, "source")) || existsSync(join(root, "script.txt"))) return [root];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .map((name) => join(root, name))
    .filter((dir) => hasPack(join(dir, "source")) || existsSync(join(dir, "script.txt")));
}

function packId(dir) {
  const meta = existsSync(join(dir, "pack.json")) ? JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) : {};
  return String(meta.id || dir.split("/").pop());
}

function listFiles(dir) {
  const files = [];
  const walk = (base, prefix = "") => {
    for (const name of readdirSync(join(dir, base))) {
      const path = join(dir, base, name);
      if (statSync(path).isDirectory()) walk(join(base, name), `${prefix}${name}/`);
      else if (!SKIP.test(name)) files.push(`${prefix}${name}`);
    }
  };
  walk(".");
  return files.sort();
}

const packs = findPacks(input);
if (!packs.length) {
  console.error(`没有找到剧本包：${input}`);
  process.exit(2);
}

const listing = { schemaVersion: 1, packs: packs.map((dir) => ({ id: packId(dir), files: listFiles(dir) })) };
const copies = [];
for (const dir of packs) {
  const id = packId(dir);
  for (const name of listFiles(dir)) copies.push({ from: join(dir, name), to: join(outRoot, id, name) });
}
copies.push({ from: null, to: join(outRoot, "index.json"), content: `${JSON.stringify(listing, null, 1)}\n` });

if (dryRun) {
  console.log(JSON.stringify({ outRoot, packs: listing.packs, copies: copies.map((item) => relative(process.cwd(), item.to)) }, null, 1));
  process.exit(0);
}

for (const item of copies) {
  mkdirSync(dirname(item.to), { recursive: true });
  if (item.from) copyFileSync(item.from, item.to);
  else writeFileSync(item.to, item.content, "utf8");
}

console.log(JSON.stringify({
  outRoot: relative(process.cwd(), outRoot) || ".",
  packs: listing.packs.map((pack) => `${pack.id}(${pack.files.length})`),
  copied: copies.length,
  hint: dataRoot ? "已写入所选资源目录；重启应用后书架会出现「同人剧场」。" : "把该目录整体拷贝到 <资源目录>/assets/library/ 即可（或用 --data-root 指定）。",
}, null, 1));
