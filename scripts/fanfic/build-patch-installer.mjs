// 把「素材 / 音频补丁」打成**自解压安装器**（.run）：`sh Arkstage-<ver>-assets-<kind>-setup.run`。
//
//   node scripts/fanfic/build-patch-installer.mjs                    # assets + audio
//   node scripts/fanfic/build-patch-installer.mjs assets             # 只打一个
//
// 产物（`build/artifacts/`）：
//   `Arkstage-<ver>-assets-assets-setup.run`  —— UI + 背景 + 立绘全部差分 + CG
//   `Arkstage-<ver>-assets-audio-setup.run`   —— 音频
// **找到本体才装**：装到 `<资源目录>/assets/starter/`（只补缺失，不覆盖）；
// 找不到本体 → 打印「没有找到 Arkstage 本体」并 exit 2（语义见 `install.sh`）。
//
// 载荷 = 已有的 zip（`build/artifacts/Arkstage-<ver>-assets-<kind>.zip`），
// 零网络、零压缩（zip 已是压缩态）→ 只是 `cat shim zip`。
import { readFileSync, writeFileSync, existsSync, statSync, chmodSync, openSync, closeSync, readSync, writeSync, mkdirSync, rmSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..", "..");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const outDir = join(ROOT, "build", "artifacts");
const shim = join(ROOT, "scripts", "fanfic", "patch-installer", "install.sh");
const wanted = (process.argv[2] ?? "both").toLowerCase();

const KINDS = [
  { kind: "assets", label: "素材补丁（UI / 背景 / 立绘全差分 / CG）", zip: `Arkstage-${version}-assets-assets.zip`, out: `Arkstage-${version}-assets-assets-setup.run` },
  { kind: "audio", label: "音频补丁（音乐 / 音效）", zip: `Arkstage-${version}-assets-audio.zip`, out: `Arkstage-${version}-assets-audio-setup.run` },
];
const human = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

let made = 0;
for (const item of KINDS) {
  if (wanted !== "both" && wanted !== item.kind) continue;
  const zip = join(outDir, item.zip);
  if (!existsSync(zip) || statSync(zip).size === 0) {
    console.log(`skip ${item.kind}：缺 ${item.zip}（先跑 npm run assets:patch:${item.kind === "assets" ? "assets" : "audio"}）`);
    continue;
  }
  // 载荷起点用**字节偏移**（`tail -c +N`）：zip 是二进制，行号会切歪。
  // `printf %12d` 定宽 → 替换后 header 长度稳定，一次算准。
  const body = readFileSync(shim, "utf8").replace("__KIND__", item.label).replace("__VERSION__", version);
  const draft = body.replace("__PAYLOAD_OFFSET__", "0           ");
  const trailing = draft.endsWith("\n") ? "" : "\n";
  const headerLength = Buffer.byteLength(draft + trailing, "utf8");
  // 变量靠左 + 右侧补空格（`PAYLOAD_OFFSET=3146   ` 在 sh 里合法，且长度恒定）。
  const text = body.replace("__PAYLOAD_OFFSET__", String(headerLength).padEnd(12, " "));
  const header = Buffer.from(text.endsWith("\n") ? text : `${text}\n`, "utf8");
  if (header.length !== headerLength) throw new Error(`偏移算错：${header.length} ≠ ${headerLength}`);
  // ⚠️ `Buffer.concat` 在 >2 GiB 时会抛 ERR_FS_FILE_TOO_LARGE（素材包 2.4 GB）。
  // 所以**流式**拼：先写 shim，再把 zip 追加进去（`copyFileSync` 到已存在的 fd 不
  // 好使 → 用 `openSync` + `appendFileSync` 分块）。
  const target = join(outDir, item.out);
  writeFileSync(target, header);
  // 分块追加（`readFileSync` 在 >2 GiB 的 zip 上会抛 ERR_FS_FILE_TOO_LARGE）。
  const CHUNK = 64 * 1024 * 1024;
  const total = statSync(zip).size;
  const src = openSync(zip, "r");
  const fd = openSync(target, "a");
  try {
    for (let at = 0; at < total; at += CHUNK) {
      const len = Math.min(CHUNK, total - at);
      const buf = Buffer.allocUnsafe(len);
      const got = readSync(src, buf, 0, len, at);
      writeSync(fd, buf, 0, got);
    }
  } finally {
    closeSync(fd);
    closeSync(src);
  }
  chmodSync(target, 0o755);
  console.log(`${item.out}  ${human(header.length + total)}（shim ${header.length} B + 载荷 ${human(total)}）`);
  // 顺手留一份"仅 Linux/macOS"的 tar 版本（有些用户更愿意 `tar xf`）。
  made += 1;
}
console.log(made ? "\n自解压安装器已生成：build/artifacts/*-setup.run（`sh <file>` 安装；找不到本体 → exit 2）" : "\n没有可打的补丁（先备好 zip）。");

// ── Windows（NSIS）────────────────────────────────────────────────────────
// 用 `patch-installer/install.nsi` 模板：装到 Arkstage 本体目录的
// `assets/starter/`（只补缺失），**没有本体 → MessageBox + Abort**。
async function buildWindows(item, zipPath) {
  const nsiTemplate = join(ROOT, "scripts", "fanfic", "patch-installer", "install.nsi");
  /** NSIS 用 32 位偏移：单个安装器载荷 **必须 < 2 GiB**（2.6 GB 实测 `makensis`
   *  直接 SIGBUS）。所以按体积**切卷**：每卷 ≤ 1.4 GB，文件名带 `-1of3`。 */
  const VOLUME_BYTES = 1400 * 1024 * 1024;
  const outName = `Arkstage-${version}-assets-${item.kind}-setup.exe`;
  const tmpDir = join(ROOT, "build", "patch-installer-win");
  mkdirSync(tmpDir, { recursive: true });
  // NSIS 的 `File /r` 要一个目录；zip 里有 4,900 个文件，先解到临时目录。
  const payload = join(outDir, "arkstage-patch-payload");
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  console.log(`解压 ${item.zip} → NSIS 载荷目录…`);
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", payload], { stdio: "inherit" });

  // 切卷：按**体积**把文件分进多个目录（保持 < 2 GiB 卷）。
  const files = readdirSync(payload).sort();
  const volumes = [];
  let current = { names: [], bytes: 0 };
  for (const name of files) {
    const size = statSync(join(payload, name)).size;
    if (current.names.length && current.bytes + size > VOLUME_BYTES) {
      volumes.push(current);
      current = { names: [], bytes: 0 };
    }
    current.names.push(name);
    current.bytes += size;
  }
  if (current.names.length) volumes.push(current);
  console.log(`载荷 ${human(statSync(payload).size)} → ${volumes.length} 卷（每卷 ≤ ${human(VOLUME_BYTES)}）`);

  for (let index = 0; index < volumes.length; index += 1) {
    const volume = volumes[index];
    const partDir = join(payload, `__part${index + 1}`);
    mkdirSync(partDir, { recursive: true });
    for (const name of volume.names) renameSync(join(payload, name), join(partDir, name));
    const suffix = volumes.length > 1 ? `-${index + 1}of${volumes.length}` : "";
    const outFile = outName.replace(/-setup\.exe$/, `${suffix}-setup.exe`);
    const kindLabel = `${item.kind === "assets" ? "素材补丁" : "音频补丁"}${suffix ? `（第 ${index + 1} / ${volumes.length} 卷）` : ""}`;
    const nsi = readFileSync(nsiTemplate, "utf8")
      .replace("__KIND__", kindLabel)
      .replace("__VERSION__", version)
      .replace("__PAYLOAD__", partDir)
      .replace("__OUT__", join(outDir, outFile));
    const nsiPath = join(tmpDir, `patch-${item.kind}-${index + 1}.nsi`);
    writeFileSync(nsiPath, nsi);
    console.log(`makensis ${outFile} …`);
    execFileSync("makensis", ["-V2", nsiPath], { stdio: "inherit" });
    const out = join(outDir, outFile);
    console.log(`${outFile}  ${human(statSync(out).size)}（${volume.names.length} 个文件）`);
  }
  rmSync(payload, { recursive: true, force: true });
}

if (process.argv.includes("--win")) {
  for (const item of KINDS) {
    if (wanted !== "both" && wanted !== item.kind) continue;
    const zip = join(outDir, item.zip);
    if (!existsSync(zip) || statSync(zip).size === 0) { console.log(`skip win ${item.kind}：缺 ${item.zip}`); continue; }
    await buildWindows(item, zip);
  }
}
