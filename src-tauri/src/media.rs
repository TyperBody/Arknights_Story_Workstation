use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Resolve the content-addressed media store root: `$APPDATA/<identifier>/media`.
/// The protocol handler runs without an AppHandle, so the app data dir is passed in.
pub fn media_root(app_data: &Path) -> PathBuf {
    app_data.join("media")
}

/// Build the official prts.wiki URL for a canonical key (`{host}/{path}`):
/// https-prefix it and percent-encode each path segment (the host is already a
/// lowercase dotted domain). The `pack` / `prts` sources expand to exactly this
/// (same encoder: `mirror_url`).
#[allow(dead_code)]
pub fn prts_url(key: &str) -> String {
    let encoded = key
        .split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/");
    format!("https://{}", encoded)
}

// ---------------------------------------------------------------------------
// Mirror sources («设置 → 下载源»). The *parameterised* twin of
// `src/akstage/assetRouting.js::MIRRORS` (the JS table carries `{repo}`/`{ref}`,
// here they are expanded): single place the client builds a fetch URL, so the
// download engine and the `prts-cdn://` cache-through resolve a canonical key the
// exact same way the settings page previews it. A mirror-selftest assertion
// compares the two languages' expansion for the same key.
// ---------------------------------------------------------------------------

/// GitHub mirror repo of the engine/assets layer (assetRouting.js `MIRROR_REPO`).
/// Used by `mirror-selftest.mjs` (A2) to assert the two languages' templates.
#[allow(dead_code)]
pub const MIRROR_REPO: &str = "djkcyl/arkstage-mirror";
/// Branch/ref served by the mirror repo (assetRouting.js `MIRROR_REF`).
#[allow(dead_code)]
pub const MIRROR_REF: &str = "main";
/// Directory prefix inside the mirror repo (tools/mirror/mirrorPath.mjs).
#[allow(dead_code)]
pub const MIRROR_PREFIX: &str = "mirror/prts";
/// Template for the official direct link (assetRouting.js `MIRRORS.pack`/`.prts`).
pub const MIRROR_TPL_PRTS: &str = "https://{host}/{path}";
/// Template for the jsDelivr GitHub line (assetRouting.js `MIRRORS.jsd`).
pub const MIRROR_TPL_JSD: &str = concat!(
    "https://cdn.jsdelivr.net/gh/",
    "djkcyl/arkstage-mirror@main",
    "/mirror/prts/{host}/{path}"
);
/// Template for the jsDelivr Fastly line (assetRouting.js `MIRRORS.fastly`).
pub const MIRROR_TPL_FASTLY: &str = concat!(
    "https://fastly.jsdelivr.net/gh/",
    "djkcyl/arkstage-mirror@main",
    "/mirror/prts/{host}/{path}"
);
/// Template for gh-proxy + GitHub raw (assetRouting.js `MIRRORS.ghproxy`).
pub const MIRROR_TPL_GHPROXY: &str = concat!(
    "https://gh-proxy.com/https://raw.githubusercontent.com/",
    "djkcyl/arkstage-mirror/main",
    "/mirror/prts/{host}/{path}"
);

/// Hosts this mirror actually carries (assetRouting.js `MIRRORABLE_HOSTS`).
pub const MIRRORABLE_HOSTS: [&str; 4] = [
    "static.prts.wiki",
    "torappu.prts.wiki",
    "media.prts.wiki",
    "code.jquery.com",
];

/// Every source id, in settings-page order (assetRouting.js `SOURCE_IDS`).
pub const SOURCE_IDS: [&str; 6] = ["pack", "prts", "jsd", "fastly", "ghproxy", "custom"];

/// Try order for a key — the same list assetRouting.js `buildSourceOrder`
/// produces (compared verbatim in `mirror_custom_template_and_source_order` and in
/// the A2 block of tools/mirror/mirror-selftest.mjs). Unknown/empty
/// `preferred` → the default (`pack` first). `pack` / `prts` expand to the
/// same official URL, so only the later of the two stays at its slot.
pub fn source_order(preferred: &str) -> Vec<&'static str> {
    // Mirrors assetRouting.js: a bogus preferred source behaves like the default.
    let head = source_of(preferred).unwrap_or("pack");
    let mut order = vec![head];
    for id in ["custom", "pack", "prts", "jsd", "fastly", "ghproxy"] {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    // `pack` and `prts` expand to the same official URL (assetRouting.js
    // `buildSourceOrder`): the LATER of the two goes, wherever it sits. Only an
    // official first source actually collapses one of them (the others both keep
    // their default slots, `pack` before `prts`).
    let pack_at = order.iter().position(|id| *id == "pack");
    let prts_at = order.iter().position(|id| *id == "prts");
    if let (Some(pack_at), Some(prts_at)) = (pack_at, prts_at) {
        let dup = if pack_at < prts_at { "prts" } else { "pack" };
        order.retain(|id| *id != dup);
    }
    order
}

/// Expand a `{host}` / `{path}` (`{key}`) template. `{key}` is the canonical
/// key, one level deeper than `{path}`. Same substitution semantics as
/// assetRouting.js `fillTemplate`.
fn fill_mirror_template(tpl: &str, host: &str, path: &str, key: &str) -> String {
    tpl.replace("{host}", host)
        .replace("{path}", path)
        .replace("{key}", key)
}

/// Fetch URL of `key` for **one** mirror source; `None` = this source cannot
/// serve the key (caller falls back to the official link).
///
/// `mirror` ∈ `pack|prts|jsd|fastly|ghproxy|custom` (`pack` = official; the
/// in-pack hit is the engine's own snapshot overlay):
/// - `jsd` → `https://cdn.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/mirror/prts/{host}/{path}`
/// - `fastly` → `https://fastly.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/mirror/prts/{host}/{path}`
/// - `ghproxy` → `https://gh-proxy.com/https://raw.githubusercontent.com/djkcyl/arkstage-mirror/main/mirror/prts/{host}/{path}`
/// - `custom` → the caller's template (`{host}`/`{path}`/`{key}`); missing
///   template → `None`
///
/// The three CDN sources only serve `MIRRORABLE_HOSTS`; anything else → `None`.
fn fill_for_source(
    mirror: &str,
    host: &str,
    encoded_path: &str,
    canonical: &str,
    custom: Option<&str>,
) -> Option<String> {
    match mirror {
        "pack" | "prts" => Some(fill_mirror_template(MIRROR_TPL_PRTS, host, encoded_path, canonical)),
        "jsd" => mirrorable(host).then(|| fill_mirror_template(MIRROR_TPL_JSD, host, encoded_path, canonical)),
        "fastly" => {
            mirrorable(host).then(|| fill_mirror_template(MIRROR_TPL_FASTLY, host, encoded_path, canonical))
        }
        "ghproxy" => {
            mirrorable(host).then(|| fill_mirror_template(MIRROR_TPL_GHPROXY, host, encoded_path, canonical))
        }
        "custom" => {
            let tpl = custom?.trim();
            // Same contract as the JS side: the template must be a real URL with
            // at least one substitution placeholder.
            let has_placeholder = ["{url}", "{key}", "{host}", "{path}"]
                .iter()
                .any(|p| tpl.contains(p));
            if tpl.is_empty() || !has_placeholder {
                return None;
            }
            let rendered = tpl
                .replace("{url}", &format!("https://{host}/{encoded_path}"))
                .replace("{host}", host)
                .replace("{path}", encoded_path)
                .replace("{key}", canonical);
            let lower = rendered.to_ascii_lowercase();
            (lower.starts_with("http://") || lower.starts_with("https://"))
                .then_some(rendered)
                .filter(|url| !url.contains(char::is_whitespace))
        }
        _ => None,
    }
}

/// Fetch URL of `key` (URL or bare canonical key) for **one** mirror source.
/// The canonical key is split into `{host}` / `{path}`; `{path}` gets
/// percent-encoded per segment (byte-identical to `prts_url`).
pub fn mirror_url(key: &str, mirror: &str, custom: Option<&str>) -> Option<String> {
    let canonical = canonical_key(key)?;
    let at = canonical.find('/')?;
    let host = &canonical[..at];
    let encoded_path = canonical[at + 1..]
        .split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/");
    fill_for_source(mirror, host, &encoded_path, &canonical, custom)
}

/// Canonical key → `[(source, fetch_url)]` try chain: every applicable source,
/// preferred first, ending with the official link (`pack` or `prts`).
pub fn source_chain(key: &str, preferred: &str, custom: Option<&str>) -> Vec<(&'static str, String)> {
    let ordered = source_order(preferred);
    let pinned = pinned_sources(preferred, custom);
    pinned
        .unwrap_or(ordered)
        .into_iter()
        .filter_map(|id| mirror_url(key, id, custom).map(|u| (id, u)))
        .collect()
}

/// The explicit screenshot/demo path: sources listed in `preferred` (comma
/// separated), falling back to [`source_chain`] when the string isn't a bare
/// source list. Keeps the chain deterministic for a probe.
pub fn pinned_sources(preferred: &str, custom: Option<&str>) -> Option<Vec<&'static str>> {
    let s = preferred.trim().to_ascii_lowercase();
    if source_of(&s).is_some() {
        return None; // single source → the normal ordered chain (preferred first)
    }
    let mut pinned: Vec<&'static str> = Vec::new();
    for raw in s.split(',') {
        let id = raw.trim();
        if id.is_empty() {
            continue;
        }
        let id = source_of(id)?;
        if !pinned.contains(&id) {
            pinned.push(id);
        }
    }
    // `custom` without a template can never resolve; drop it (like `source_chain`
    // does via `mirror_url`).
    if custom.map(str::trim).unwrap_or("").is_empty() {
        pinned.retain(|id| *id != "custom");
    }
    (!pinned.is_empty()).then_some(pinned)
}

/// Look up a source id (assetRouting.js `SOURCE_IDS`); unknown → `None`.
fn source_of(text: &str) -> Option<&'static str> {
    SOURCE_IDS.iter().copied().find(|id| *id == text)
}

/// Is this host carried by the mirror? (assetRouting.js `MIRRORABLE_HOSTS`.)
pub fn mirrorable(host: &str) -> bool {
    MIRRORABLE_HOSTS.contains(&host)
}

/// Normalize EITHER a full `http(s)://host/path…` URL OR a bare `host/path…` key
/// into the canonical asset key `{host}/{path}` (query/fragment dropped). This is
/// the content-addressed store key, the cross-source dedup key, AND the basis for
/// building per-source fetch URLs — so it must be byte-identical to the old
/// `url_to_relpath` for ordinary ASCII lowercase-host URLs (the existing on-disk
/// cache must NOT be orphaned). Returns None for non-http(s)/schemed strings or
/// inputs without a real domain host + at least one path segment.
pub(crate) fn canonical_key(s: &str) -> Option<String> {
    let rest = if let Some(r) = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
    {
        r
    } else if s.contains(':') {
        // No scheme but a colon → some other scheme (data:/blob:/prts-cdn:/ftp:…).
        return None;
    } else {
        s
    };
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);

    let mut segs: Vec<String> = Vec::new();
    for raw in rest.split('/') {
        // Percent-decode once; on error keep the raw segment.
        let decoded = urlencoding::decode(raw)
            .map(|c| c.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        // A `%2F`/`%5C` that decoded to a separator must not introduce new path
        // levels (anti-traversal) — collapse them to `_`.
        let seg = decoded.replace(['/', '\\'], "_");
        // Skip empties and traversal segments AFTER decoding.
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        segs.push(seg);
    }

    if segs.len() < 2 {
        return None;
    }
    // Lowercase the host (first) segment only; require it to be a real domain.
    segs[0] = segs[0].to_lowercase();
    if !segs[0].contains('.') {
        return None;
    }
    Some(segs.join("/"))
}

/// Map a URL or bare key to a relative store path `{host}/{path}`, sanitized so it
/// cannot escape the store root. Returns None for unmappable inputs.
pub fn url_to_relpath(url: &str) -> Option<PathBuf> {
    canonical_key(url).map(|k| k.split('/').collect::<PathBuf>())
}

/// Absolute path inside the media store for a given URL, or None if URL is unmappable.
pub fn store_path(media_root: &Path, url: &str) -> Option<PathBuf> {
    url_to_relpath(url).map(|rel| media_root.join(rel))
}

/// Read bytes from the store if present.
#[cfg(test)]
pub fn read_local(media_root: &Path, url: &str) -> Option<Vec<u8>> {
    let p = store_path(media_root, url)?;
    std::fs::read(&p).ok()
}

/// Read only a plausible asset. Interrupted writes and CDN error pages used to be
/// cached forever under `.png`/CG keys; remove those so the protocol can refetch.
pub fn read_local_validated(media_root: &Path, url: &str) -> Option<Vec<u8>> {
    let p = store_path(media_root, url)?;
    recover_previous(&p);
    let bytes = std::fs::read(&p).ok()?;
    if validate_asset_bytes(url, &bytes).is_ok() {
        Some(bytes)
    } else {
        let _ = std::fs::remove_file(p);
        None
    }
}

/// Reject successful HTTP responses that are actually HTML error/challenge pages,
/// and verify image magic independently of the extension (PNG keys may hold WebP
/// after local compression).
pub fn validate_asset_bytes(url: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("empty response".into());
    }
    let prefix = &bytes[..bytes.len().min(256)];
    let prefix_text = String::from_utf8_lossy(prefix).to_ascii_lowercase();
    if prefix_text.contains("<!doctype html") || prefix_text.contains("<html") {
        return Err("upstream returned HTML instead of media".into());
    }

    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    let image_key = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]
        .iter()
        .any(|ext| path.ends_with(ext));
    if image_key {
        let is_png = bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        let is_jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
        let is_gif = bytes.starts_with(b"GIF8");
        let is_webp = bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
        let is_bmp = bytes.starts_with(b"BM");
        let is_avif = bytes.len() >= 12 && &bytes[4..8] == b"ftyp";
        if !(is_png || is_jpeg || is_gif || is_webp || is_bmp || is_avif) {
            return Err("invalid image signature".into());
        }
    }
    Ok(())
}

/// Write bytes to the store, creating parent dirs.
pub fn write_local(media_root: &Path, url: &str, bytes: &[u8]) -> Result<(), String> {
    let p = store_path(media_root, url).ok_or_else(|| "unmappable url".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = p.with_extension(format!("part-{}-{seq}", std::process::id()));
    let backup = p.with_extension("previous");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&backup);
    let had_old = p.exists();
    if had_old {
        std::fs::rename(&p, &backup).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &p).map_err(|e| {
        if had_old {
            let _ = std::fs::rename(&backup, &p);
        }
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    if had_old {
        let _ = std::fs::remove_file(backup);
    }
    Ok(())
}

fn recover_previous(path: &Path) {
    let backup = path.with_extension("previous");
    if !path.exists() && backup.exists() {
        let _ = std::fs::rename(backup, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Mirror sources («设置 → 下载源») --------------------------------
    // 逐字断言两侧模板：JS 侧同一组期望写在 tools/mirror/mirror-selftest.mjs
    // (A2)，改动这里必须同步改那边。

    const CSS: &str = "https://static.prts.wiki/assets/scenario/arknights-scenario.css";
    const HERO: &str =
        "https://torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png";

    #[test]
    fn mirror_url_matches_asset_routing_templates() {
        // 4 个源 × 2 个 host 的逐字期望（= assetRouting.js 的展开结果）。
        assert_eq!(
            mirror_url(CSS, "jsd", None).unwrap(),
            "https://cdn.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/mirror/prts/static.prts.wiki/assets/scenario/arknights-scenario.css"
        );
        assert_eq!(
            mirror_url(CSS, "fastly", None).unwrap(),
            "https://fastly.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/mirror/prts/static.prts.wiki/assets/scenario/arknights-scenario.css"
        );
        assert_eq!(
            mirror_url(CSS, "ghproxy", None).unwrap(),
            "https://gh-proxy.com/https://raw.githubusercontent.com/djkcyl/arkstage-mirror/main/mirror/prts/static.prts.wiki/assets/scenario/arknights-scenario.css"
        );
        assert_eq!(mirror_url(CSS, "pack", None).unwrap(), CSS);
        assert_eq!(mirror_url(CSS, "prts", None).unwrap(), CSS);
        assert_eq!(
            mirror_url(HERO, "jsd", None).unwrap(),
            "https://cdn.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/mirror/prts/torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png"
        );
        assert_eq!(
            mirror_url(HERO, "ghproxy", None).unwrap(),
            "https://gh-proxy.com/https://raw.githubusercontent.com/djkcyl/arkstage-mirror/main/mirror/prts/torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png"
        );
        // 可镜像 host 之外 → None（调用方回落官方）。
        assert_eq!(mirror_url("https://example.org/a/b.png", "jsd", None), None);
        assert_eq!(mirror_url("https://example.org/a/b.png", "ghproxy", None), None);
        // `code.jquery.com` 是可镜像 host（引擎依赖）。
        assert_eq!(
            mirror_url("https://code.jquery.com/jquery-3.7.1.min.js", "jsd", None).unwrap(),
            "https://cdn.jsdelivr.net/gh/djkcyl/arkstage-mirror@main/mirror/prts/code.jquery.com/jquery-3.7.1.min.js"
        );
        // 坏输入 / 未知源。
        assert_eq!(mirror_url("data:text/javascript;base64,AA", "jsd", None), None);
        assert_eq!(mirror_url(CSS, "nowhere", None), None);
    }

    #[test]
    fn mirror_custom_template_and_source_order() {
        // custom：{url}/{key}/{host}/{path} 展开；缺模板 → None。
        assert_eq!(
            mirror_url(CSS, "custom", Some("https://my.cdn/{key}?u={url}")).unwrap(),
            format!(
                "https://my.cdn/static.prts.wiki/assets/scenario/arknights-scenario.css?u={CSS}"
            )
        );
        assert_eq!(mirror_url(CSS, "custom", None), None);
        assert_eq!(mirror_url(CSS, "custom", Some("   ")), None);
        assert_eq!(mirror_url(CSS, "custom", Some("https://my.cdn/plain")), None);
        // 单段 key / 无点 host → None（canonical_key 的契约）。
        assert_eq!(mirror_url("pack:vendor/x.js", "jsd", None), None);
        assert_eq!(mirror_url("localhost/a/b", "prts", None), None);

        // 源顺序：与 assetRouting.js `buildSourceOrder` 的**逐项**输出一致
        // （下面这 6 条就是 node 跑 JS 得到的原样结果）。
        assert_eq!(
            source_order("pack"),
            vec!["pack", "custom", "jsd", "fastly", "ghproxy"]
        );
        assert_eq!(
            source_order("prts"),
            vec!["prts", "custom", "jsd", "fastly", "ghproxy"]
        );
        assert_eq!(
            source_order("custom"),
            vec!["custom", "pack", "jsd", "fastly", "ghproxy"]
        );
        assert_eq!(
            source_order("jsd"),
            vec!["jsd", "custom", "pack", "fastly", "ghproxy"]
        );
        assert_eq!(
            source_order("fastly"),
            vec!["fastly", "custom", "pack", "jsd", "ghproxy"]
        );
        assert_eq!(
            source_order("ghproxy"),
            vec!["ghproxy", "custom", "pack", "jsd", "fastly"]
        );
        assert_eq!(source_order("bogus"), source_order("pack"));
        assert_eq!(source_order(""), source_order("pack"));
    }

    #[test]
    fn source_chain_starts_preferred_and_ends_official() {
        // jsd 首选：jsd 第一；官方兜底排在 `pack` 的槽位（不是链尾——与 JS
        // `routeFor` 同序：#19 / 验收「链里有官方」而不是「官方在最后」）。
        let chain = source_chain(CSS, "jsd", None);
        // 与 JS `routeFor(CSS, "jsd")` 的源列表逐项一致（无 custom 模板时
        // custom 不进链；`pack` 占官方槽位）。
        let ids: Vec<&str> = chain.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, vec!["jsd", "pack", "fastly", "ghproxy"]);
        assert_eq!(chain.iter().filter(|(_, u)| *u == CSS).count(), 1);
        // 换源后 URL 变了，但链里始终有官方直链兜底。
        let torch = source_chain(HERO, "fastly", None);
        assert_eq!(torch[0].0, "fastly");
        assert!(torch.iter().any(|(_, u)| u == HERO));
        // 不可镜像 host → 只有官方一条。
        let plain = source_chain("https://example.org/a/b.png", "jsd", None);
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].0, "pack");
        assert_eq!(plain[0].1, "https://example.org/a/b.png");
        // 显式逗号链（探针用）：严格按给的顺序。
        let pinned = source_chain(CSS, "jsd,prts", None);
        assert_eq!(
            pinned.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec!["jsd", "prts"]
        );
        let pinned_custom = source_chain(CSS, "ghproxy,custom,pack", Some("https://m/{url}"));
        assert_eq!(
            pinned_custom.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec!["ghproxy", "custom", "pack"]
        );
        // 有模板的 custom 走顺序链时也在（排第一）。
        let with_custom = source_chain(CSS, "custom", Some("https://m/{host}/{path}"));
        assert_eq!(with_custom[0].0, "custom");
        assert_eq!(
            with_custom[0].1,
            "https://m/static.prts.wiki/assets/scenario/arknights-scenario.css"
        );
        assert!(with_custom.iter().any(|(_, u)| u == CSS));
    }

    #[test]
    fn mirror_url_keeps_canonical_key_across_sources() {
        // 落盘键与源无关：字节从 jsd 取回后仍写在 `key` 下，所以之后按官方 URL
        // 读缓存 / 去重都能命中（「换源不改 key」的回归）。
        let root = std::env::temp_dir().join(format!("prts_media_mirror_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        write_local(&root, CSS, &png).unwrap();
        assert_eq!(read_local(&root, CSS).unwrap(), png);
        assert!(mirror_url(CSS, "jsd", None).unwrap().starts_with("https://cdn.jsdelivr.net/"));
        assert!(store_path(&root, CSS).unwrap().ends_with("assets/scenario/arknights-scenario.css"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn maps_media_url_to_host_path() {
        assert_eq!(
            url_to_relpath("https://media.prts.wiki/1/10/Avg_071_mini01.png").unwrap(),
            PathBuf::from("media.prts.wiki/1/10/Avg_071_mini01.png")
        );
    }

    #[test]
    fn drops_query_and_blocks_traversal() {
        assert_eq!(
            url_to_relpath("https://static.prts.wiki/a/../../etc/passwd?x=1").unwrap(),
            PathBuf::from("static.prts.wiki/a/etc/passwd")
        );
    }

    #[test]
    fn rejects_non_http() {
        assert!(url_to_relpath("ftp://x/y").is_none());
        assert!(url_to_relpath("prts-cdn://localhost/a").is_none());
    }

    #[test]
    fn http_and_https_yield_the_same_key() {
        assert_eq!(
            canonical_key("http://media.prts.wiki/a/b.png"),
            canonical_key("https://media.prts.wiki/a/b.png")
        );
    }

    #[test]
    fn host_is_lowercased_but_path_case_preserved() {
        assert_eq!(
            canonical_key("https://Media.PRTS.Wiki/A/Avg_X.png").unwrap(),
            "media.prts.wiki/A/Avg_X.png"
        );
    }

    #[test]
    fn percent_encoded_and_literal_traversal_blocked() {
        // %2e%2e decodes to ".." which is dropped, not used to climb out.
        assert_eq!(
            canonical_key("https://media.prts.wiki/a/%2e%2e/b.png").unwrap(),
            "media.prts.wiki/a/b.png"
        );
        assert_eq!(
            canonical_key("https://media.prts.wiki/a/../b.png").unwrap(),
            "media.prts.wiki/a/b.png"
        );
        // %2F inside a segment must NOT introduce a new path level.
        assert_eq!(
            canonical_key("https://media.prts.wiki/a%2Fevil/b.png").unwrap(),
            "media.prts.wiki/a_evil/b.png"
        );
    }

    #[test]
    fn bare_key_is_accepted() {
        assert_eq!(
            canonical_key("media.prts.wiki/a/b.png").unwrap(),
            "media.prts.wiki/a/b.png"
        );
    }

    #[test]
    fn data_uri_is_rejected() {
        assert!(canonical_key("data:image/png;base64,xx").is_none());
    }

    #[test]
    fn single_segment_or_dotless_host_rejected() {
        assert!(canonical_key("https://x").is_none()); // single segment
        assert!(canonical_key("localhost/a/b").is_none()); // dotless host
    }

    #[test]
    fn write_then_read_roundtrip() {
        let root = std::env::temp_dir().join(format!("prts_media_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let url = "https://media.prts.wiki/a/ab/Test.png";
        write_local(&root, url, b"hello").unwrap();
        assert_eq!(read_local(&root, url).unwrap(), b"hello");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_html_cached_as_cg_and_removes_it() {
        let root = std::env::temp_dir().join(format!("prts_media_bad_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let url = "https://media.prts.wiki/a/ab/CG.png";
        write_local(&root, url, b"<!doctype html><title>rate limited</title>").unwrap();
        assert!(read_local_validated(&root, url).is_none());
        assert!(!store_path(&root, url).unwrap().exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recovers_previous_file_after_interrupted_replace() {
        let root = std::env::temp_dir().join(format!("prts_media_recover_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let url = "https://media.prts.wiki/a/ab/CG.png";
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        write_local(&root, url, &png).unwrap();
        let path = store_path(&root, url).unwrap();
        std::fs::rename(&path, path.with_extension("previous")).unwrap();
        assert_eq!(read_local_validated(&root, url).unwrap(), png);
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
