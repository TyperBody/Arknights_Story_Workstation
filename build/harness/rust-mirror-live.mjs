// 「换源真的走镜像」的原生验证（不经 Tauri 命令，直接读 Rust 源码模板 + JS 展开对比，
// 并用真实 HTTP 探一次镜像 URL 形状是否与发布路径一致）。
//   node build/harness/rust-mirror-live.mjs
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const t = (l, ok, d = "") => { if (ok) { pass += 1; console.log(`ok   ${l}${d ? ` — ${d}` : ""}`); } else { fail += 1; console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); } };

const routes = await import(new URL("../../src/akstage/assetRouting.js", import.meta.url).href);
const { mirrorPathFor } = await import(new URL("../../tools/mirror/mirrorPath.mjs", import.meta.url).href);
const rust = readFileSync(new URL("../../src-tauri/src/media.rs", import.meta.url), "utf8");
const dl = readFileSync(new URL("../../src-tauri/src/download.rs", import.meta.url), "utf8");

t("Rust 有 MIRROR_TPL_JSD 常量", /MIRROR_TPL_JSD/.test(rust));
t("Rust 有 source_chain（源链）", /pub fn source_chain/.test(rust));
t("下载器用 source_chain（不再写死 prts_url）", /source_chain|mirror_url/.test(dl));
t("prts-cdn 协议也走源链", /mirror_url|source_chain/.test(readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8")));
t("镜像前缀唯一：mirror/prts", routes.MIRROR_PREFIX === "mirror/prts" && readFileSync(new URL("../../tools/mirror/mirrorPath.mjs", import.meta.url), "utf8").includes('MIRROR_PREFIX = "mirror/prts"'));

const key = "static.prts.wiki/widgets/production/StoryPlayer.BQgSL6Cy.js";
const jsd = routes.mirrorUrl("jsd", key);
t("jsd URL 落在发布路径上", jsd.endsWith("/" + mirrorPathFor(key)), jsd);
const ghp = routes.mirrorUrl("ghproxy", key);
t("ghproxy URL 落在发布路径上", ghp.endsWith("/" + mirrorPathFor(key)), ghp.slice(0, 96) + "…");
t("非镜像 host 回落", routes.mirrorUrl("jsd", "https://example.org/a.png") === null);
// 真实探一次（镜像仓未发布 → 404 是预期；只要有 HTTP 响应即证明 URL 形状可达）。
// jsDelivr 对 HEAD 可能 405；用 GET + Range 只取 1 字节；网络不通时**跳过**而不是失败
// （本 harness 的主旨是"URL 形状 + 源链接线"，不是连通性）。
let status = 0;
try {
  const res = await fetch(jsd, { headers: { Range: "bytes=0-0" } });
  status = res.status;
} catch { status = 0; }
if (status === 0) console.log("skip 镜像 URL 连通性（本机网络不可达；形状断言已在上方通过）");
else t("镜像 URL 可达（未发布仓 404 属预期）", [200, 206, 404, 403].includes(status), `HTTP ${status}`);
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
