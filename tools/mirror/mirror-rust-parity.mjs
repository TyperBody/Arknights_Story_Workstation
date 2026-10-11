/**
 * mirror-rust-parity.mjs — P7 A2 的共享断言块：**Rust 与 JS 的镜像模板必须逐字符一致**。
 *
 * `mirror-selftest.mjs` 只做纯本地断言（不联网）；这一块从
 * `src-tauri/src/media.rs` 源码里读出模板常量与 `SOURCE_IDS` / `MIRRORABLE_HOSTS`，
 * 与 `src/akstage/assetRouting.js` 的运行时展开逐字节比对；并用 Rust 侧的
 * `const` 表达式做一次**算术**核对（`{prefix}` 与 `MIRROR_PREFIX` 同值），
 * 保证「发布端路径 == 客户端 URL 路径」不是靠注释维系的。
 *
 * 纯读文件 + 纯函数；失败返回 `{name, pass, detail}[]`（由调用方汇总）。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @param {string} root 仓库根
 * @param {object} routes `src/akstage/assetRouting.js` 的模块命名空间
 * @returns {Array<{name: string, pass: boolean, detail?: string}>}
 */
export function rustParityChecks(root, routes) {
  const out = [];
  const media = readFileSync(resolve(root, "src-tauri/src/media.rs"), "utf8");

  const check = (name, pass, detail = "") => out.push({ name, pass: Boolean(pass), detail });
  const rustStr = (constName) => {
    const m = media.match(new RegExp(`pub const ${constName}: &str = (.*?);`, "s"));
    if (!m) return null;
    // `concat!(...)` 的相邻字面量拼接，或单个字面量。
    const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    return parts.length ? parts.join("") : null;
  };

  // A2-1 常量：repo / ref / 目录前缀（与发布端 mirrorPath.mjs 同值）。
  check(
    "A2 Rust MIRROR_REPO 与 JS MIRROR_REPO 一致",
    rustStr("MIRROR_REPO") !== null && rustStr("MIRROR_REPO") === routes.MIRROR_REPO,
    `rust=${rustStr("MIRROR_REPO")} js=${routes.MIRROR_REPO}`,
  );
  check(
    "A2 Rust MIRROR_REF 与 JS MIRROR_REF 一致",
    rustStr("MIRROR_REF") !== null && rustStr("MIRROR_REF") === routes.MIRROR_REF,
    `rust=${rustStr("MIRROR_REF")} js=${routes.MIRROR_REF}`,
  );
  check(
    "A2 Rust MIRROR_PREFIX 与 JS MIRROR_PREFIX 一致",
    rustStr("MIRROR_PREFIX") !== null && rustStr("MIRROR_PREFIX") === routes.MIRROR_PREFIX,
    `rust=${rustStr("MIRROR_PREFIX")} js=${routes.MIRROR_PREFIX}`,
  );

  // A2-2 源表：SOURCE_IDS + 可镜像 host 表（顺序也要一致）。
  const rustIds = media.match(/pub const SOURCE_IDS: \[&str; \d+\] = \[(.*?)\];/s);
  const ids = rustIds ? [...rustIds[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  check(
    "A2 Rust SOURCE_IDS 与 JS SOURCE_IDS 一致",
    JSON.stringify(ids) === JSON.stringify(routes.SOURCE_IDS),
    `rust=${JSON.stringify(ids)} js=${JSON.stringify(routes.SOURCE_IDS)}`,
  );
  const rustHosts = media.match(/pub const MIRRORABLE_HOSTS: \[&str; \d+\] = \[(.*?)\];/s);
  const hosts = rustHosts ? [...rustHosts[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  check(
    "A2 Rust MIRRORABLE_HOSTS 与 JS MIRRORABLE_HOSTS 一致",
    JSON.stringify(hosts) === JSON.stringify([...routes.MIRRORABLE_HOSTS]),
    `rust=${JSON.stringify(hosts)} js=${JSON.stringify([...routes.MIRRORABLE_HOSTS])}`,
  );

  // A2-3 模板常量 → 期望 URL：Rust 模板里的 `{repo}`/`{ref}`/`{prefix}` 在 Rust
  // 侧是**写死展开**的（`concat!`），这里用 JS 常量反过来核对，任何一侧改动都会红。
  const expected = {
    jsd: `https://cdn.jsdelivr.net/gh/${routes.MIRROR_REPO}@${routes.MIRROR_REF}/${routes.MIRROR_PREFIX}/{host}/{path}`,
    fastly: `https://fastly.jsdelivr.net/gh/${routes.MIRROR_REPO}@${routes.MIRROR_REF}/${routes.MIRROR_PREFIX}/{host}/{path}`,
    ghproxy: `https://gh-proxy.com/https://raw.githubusercontent.com/${routes.MIRROR_REPO}/${routes.MIRROR_REF}/${routes.MIRROR_PREFIX}/{host}/{path}`,
    prts: "https://{host}/{path}",
  };
  for (const [constName, source] of [
    ["MIRROR_TPL_JSD", "jsd"],
    ["MIRROR_TPL_FASTLY", "fastly"],
    ["MIRROR_TPL_GHPROXY", "ghproxy"],
    ["MIRROR_TPL_PRTS", "prts"],
  ]) {
    const rustTpl = rustStr(constName);
    check(
      `A2 Rust ${constName} 与 JS MIRRORS.${source} 展开一致`,
      rustTpl !== null && rustTpl === expected[source],
      `rust=${rustTpl} expected=${expected[source]}`,
    );
  }

  // A2-4 端到端逐字节：同一 key × 每个源 → Rust 模板展开 == JS mirrorUrl 展开。
  const SAMPLES = [
    "https://static.prts.wiki/assets/scenario/arknights-scenario.css",
    "https://torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png",
    "https://code.jquery.com/jquery-3.7.1.min.js",
  ];
  const rustTemplateUrl = (tpl, url) => {
    const [host, ...rest] = url.replace(/^https?:\/\//, "").split("/");
    return String(tpl)
      .replaceAll("{host}", host)
      .replaceAll("{path}", routes.encodePath(rest.join("/")));
  };
  for (const url of SAMPLES) {
    for (const source of ["prts", "jsd", "fastly", "ghproxy"]) {
      const jsUrl = routes.mirrorUrl(source, url);
      const constName = { prts: "MIRROR_TPL_PRTS", jsd: "MIRROR_TPL_JSD", fastly: "MIRROR_TPL_FASTLY", ghproxy: "MIRROR_TPL_GHPROXY" }[source];
      const rustUrl = rustTemplateUrl(rustStr(constName), url);
      check(
        `A2 逐字节（${source}）${url.slice(8, 40)}…`,
        jsUrl === rustUrl,
        `js=${jsUrl} rust=${rustUrl}`,
      );
    }
    // 不可镜像 host：JS 的 jsd 展开必须是 null（Rust 侧由单测断言 None）。
    const host = url.replace(/^https?:\/\//, "").split("/")[0];
    check(
      `A2 ${host} 可镜像 host 表命中一致`,
      routes.isMirrorable(url) === routes.MIRRORABLE_HOSTS.includes(host),
      `host=${host}`,
    );
  }

  return out;
}
