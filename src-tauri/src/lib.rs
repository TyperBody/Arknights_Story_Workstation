mod android_service;
mod commands;
mod compress;
mod data_root;
mod download;
mod engine_snapshot;
mod media;
mod models;
mod net;
mod parser;

use commands::{assets, cache, wiki};
use tauri::Manager;

/// Build a small error response with permissive CORS.
fn respond_err(responder: tauri::UriSchemeResponder, status: u16, msg: String) {
    let r = tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(msg.into_bytes())
        .unwrap();
    responder.respond(r);
}

/// Content-type from the file's magic bytes, falling back to the extension. Needed
/// because the compression feature stores WebP bytes under the original `.png`
/// key, so the extension can lie. `<img>` sniffs anyway, but a correct header is
/// the robust choice (and matters for any non-`<img>` consumer).
fn sniff_content_type(bytes: &[u8], path: &str) -> &'static str {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        guess_content_type(path)
    }
}

/// Guess content-type from file extension.
fn guess_content_type(path: &str) -> &'static str {
    if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".mp3") {
        "audio/mpeg"
    } else if path.ends_with(".ogg") {
        "audio/ogg"
    } else if path.ends_with(".wav") {
        "audio/wav"
    } else if path.ends_with(".mp4") {
        "video/mp4"
    } else if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".js") {
        "application/javascript"
    } else if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".ttf") {
        "font/ttf"
    } else if path.ends_with(".woff") {
        "font/woff"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    }
}

/// Open a URL in the system browser (Android intent / desktop default browser).
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// One cache-through step: `chain` order, first 2xx wins. Returns the bytes and
/// the source id that served them. Validation mirrors the per-source download
/// engine (`media::validate_asset_bytes`): an HTML error page from a mirror is not
/// an asset and must fall through to the next source.
async fn fetch_from_chain(
    client: &reqwest::Client,
    key: &str,
    mirror: &str,
    custom: Option<&str>,
) -> Result<(Vec<u8>, &'static str), String> {
    let chain = media::source_chain(key, mirror, custom);
    if chain.is_empty() {
        return Err(format!("no applicable source: {key}"));
    }
    let mut last = String::from("no attempt");
    for (source, url) in &chain {
        if !net::allow_online() {
            return Err("offline".to_string());
        }
        log::debug!("[prts-cdn] source={source} key={key}");
        match client
            .get(url)
            .header("Referer", "https://prts.wiki/")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.bytes().await {
                    Ok(bytes) => {
                        if !status.is_success() {
                            last = format!("HTTP {status} from {source}");
                            continue;
                        }
                        match media::validate_asset_bytes(key, &bytes) {
                            Ok(()) => {
                                // Real-time compression (same as the offline store
                                // path): WebP bytes go under the `.png` key.
                                let bytes = compress::maybe_transcode_image(key, bytes.to_vec());
                                return Ok((bytes, source));
                            }
                            Err(error) => {
                                last = format!("{source}: invalid upstream asset ({error})");
                            }
                        }
                    }
                    Err(e) => last = format!("{source}: read error: {e}"),
                }
            }
            Err(e) => last = format!("{source}: fetch error: {e}"),
        }
    }
    Err(last)
}

/// Local-only convenience so the match arm above stays readable (and a future
/// offline-specific error mapping has one place to live).
fn attributes_offline(err: &str) -> bool {
    err == "offline"
}

/// First hit of the bundled sample-asset overlay: read
/// `<data root>/assets/sample/bundles.json` (canonical key → filename) and return
/// the file's bytes when `key` is bundled. This lets the built-in sample (and any
/// pack sharing those keys) play with **zero network**: the engine's canonical URL
/// resolves to the shipped art before the media store or PRTS is consulted.
fn bundled_sample_asset(key: &str) -> Option<Vec<u8>> {
    for dir in overlay_dirs() {
        log::debug!("[prts-cdn] overlay lookup key={key} dir={}", dir.display());
        let Ok(manifest) = std::fs::read_to_string(dir.join("bundles.json")) else {
            continue;
        };
        let Ok(table) = serde_json::from_str::<std::collections::HashMap<String, String>>(&manifest)
        else {
            continue;
        };
        let Some(name) = table.get(key) else { continue };
        // The manifest ships with the app; still refuse anything that isn't a bare
        // file name so a tampered copy can't escape the overlay dir.
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return None;
        }
        let bytes = std::fs::read(dir.join(name)).ok();
        // `info!`：自带素材的供给是「离线可播」的关键事实，原生自检要按行统计。
        log::info!(
            "[prts-cdn] overlay hit key={key} name={name} dir={} bytes={}",
            dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            bytes.as_ref().map(Vec::len).unwrap_or(0)
        );
        return bytes;
    }
    None
}

/// Overlay lookup order: the curated starter set (P9 — the assets a fan-fic is
/// most likely to reference) first, then the 8-asset sample pack.
fn overlay_dirs() -> [std::path::PathBuf; 2] {
    let assets = data_root::data_root().join("assets");
    [assets.join("starter"), assets.join("sample")]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("prts-cdn", |_app, request, responder| {
            // Make sure the process-wide mirror settings exist before the first hit.
            let _ = download::mirror_settings();
            // URL format:
            //   macOS/Linux: prts-cdn://localhost/{host}/{path}
            //   Windows:     http://prts-cdn.localhost/{host}/{path}
            // Extract path after host to build target URL.
            let uri = request.uri().clone();
            let path = uri.path().trim_start_matches('/');

            if path.is_empty() {
                let r = tauri::http::Response::builder()
                    .status(400)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(b"Empty path".to_vec())
                    .unwrap();
                responder.respond(r);
                return;
            }

            let query = uri.query().map(|q| format!("?{}", q)).unwrap_or_default();
            let target_url = format!("https://{}{}", path, query);
            log::debug!("[prts-cdn] {} {}", uri.scheme_str().unwrap_or("?"), path);

            let media_root = media::media_root(&data_root::data_root());

            // 1) Pack-local / bundled sample art (self-contained packs). Checked
            // BEFORE the media store: the shipped copy is the intended source and
            // must never be shadowed by a stale cache entry. The strip query keeps
            // `canonical_key`'s contract (query/fragment dropped).
            if let Some(bytes) = media::canonical_key(&target_url).and_then(|key| bundled_sample_asset(&key)) {
                let ct = sniff_content_type(&bytes, path);
                let r = tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", ct)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap();
                responder.respond(r);
                return;
            }

            log::debug!("[prts-cdn] overlay+store miss url={target_url}");
            // 2) Serve from local content-addressed store if present (offline).
            if let Some(bytes) = media::read_local_validated(&media_root, &target_url) {
                // Sniff: a `.png` key may hold WebP bytes after compression.
                let ct = sniff_content_type(&bytes, path);
                let r = tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", ct)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap();
                responder.respond(r);
                return;
            }

            // 3) Not cached and offline mode: refuse with a marker the frontend detects.
            if !net::allow_online() {
                let r = tauri::http::Response::builder()
                    .status(503)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("X-PRTS-Offline", "1")
                    .body(b"offline: asset not cached".to_vec())
                    .unwrap();
                responder.respond(r);
                return;
            }

            // 4) Online: fetch through the SAME source chain the download engine
            // uses (preferred mirror → the other mirrors → official fallback),
            // persist to the store under the canonical key (cache-through), serve.
            // Own the path for the async block (the borrowed `uri` doesn't live
            // to 'static).
            let path = path.to_string();
            let mirror_key = media::canonical_key(&target_url);
            tauri::async_runtime::spawn(async move {
                let path = path.as_str();
                let client = net::client();
                let (mirror, custom) = download::mirror_settings().effective();
                match mirror_key {
                    None => respond_err(responder, 502, format!("Unmappable key: {target_url}")),
                    Some(key) => {
                        match fetch_from_chain(client, &key, &mirror, custom.as_deref()).await {
                            Ok((bytes, hit_source)) => {
                                media::write_local(&media_root, &key, &bytes).ok();
                                log::info!("[prts-cdn] source={hit_source} key={key}");
                                download::note_protocol_source(hit_source);
                                let ct = sniff_content_type(&bytes, path);
                                let r = tauri::http::Response::builder()
                                    .status(200)
                                    .header("Content-Type", ct)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(bytes)
                                    .unwrap();
                                responder.respond(r);
                            }
                            Err(e) if attributes_offline(&e) => respond_err(responder, 502, e),
                            Err(e) => respond_err(
                                responder,
                                502,
                                format!("Chain exhausted for {key}: {e}"),
                            ),
                        }
                    }
                }
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            {
                // App-private external storage (spec §2). Fall back to internal
                // app-data if external is somehow unavailable so the app still runs.
                match data_root::android_external_files_dir() {
                    Ok(dir) => {
                        log::info!("[data_root] android external files dir: {}", dir.display());
                        data_root::init_fixed(dir);
                    }
                    Err(e) => {
                        log::warn!("[data_root] external dir unavailable ({e}); using internal app_data");
                        if let Ok(dir) = app.path().app_data_dir() {
                            data_root::init_fixed(dir);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "android"))]
            {
                if let Ok(dir) = app.path().app_data_dir() {
                    data_root::init(dir);
                }
            }
            // 日志：debug 构建全开；release 只在 `RUST_LOG` 设了 debug/trace 时开
            // （原生自检脚本据此统计 `prts-cdn://` 覆盖层命中）。**只对本 crate**
            // 提级——`scraper`/`html5ever` 的 DEBUG 会淹掉一切（实测 29 万行/趟）。
            let log_env = std::env::var("RUST_LOG").unwrap_or_default();
            let app_level = if log_env.contains("trace") {
                log::LevelFilter::Trace
            } else if log_env.contains("debug") || cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            if cfg!(debug_assertions) || log_env.contains("debug") || log_env.contains("trace") {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .level_for("app_lib", app_level)
                        .build(),
                )?;
            }
            // Asset protocol scope: the packs' own art lives under the (movable)
            // data root, and `asset://` must be allowed to serve it (Tauri's
            // configured scope covers $APPDATA only, so a custom data dir would
            // 403 otherwise).
            {
                use tauri::Manager;
                let scope = app.asset_protocol_scope();
                // The data root moves with the user's setting, and packages may
                // live under it on the very first run — `canonicalize` needs the
                // directory to exist, so create it first (seeding fills it later).
                let dir = crate::data_root::data_root().join("assets");
                let _ = std::fs::create_dir_all(&dir);
                match std::fs::canonicalize(&dir) {
                    Ok(assets) => match scope.allow_directory(&assets, true) {
                        Ok(()) => log::info!("[asset-scope] allowed {}", assets.display()),
                        Err(error) => log::warn!("[asset-scope] failed: {error}"),
                    },
                    Err(error) => log::warn!("[asset-scope] {}: {error}", dir.display()),
                }
            }
            // Register the managed download engine (bulk predownload jobs).
            download::init(app.handle());
            // The selected download source lives process-wide (MirrorSettings), so
            // the engine and the `prts-cdn://` handler read the same value as
            // soon as one exists (default `pack` until the frontend pushes).
            let _ = download::mirror_settings();
            // Restore compression mode + resume an interrupted batch if any.
            compress::init(app.handle());
            // First run: drop the bundled fan-fiction sample pack into
            // `<data root>/assets/library/` so 同人剧场 isn't empty. Only seeds an
            // untouched library (no `.seeded` marker yet); failures are logged,
            // never fatal.
            match assets::seed_library_sync() {
                Ok(info) => log::info!(
                    "[library] seed check: seeded={} pack_count={} ({})",
                    info.seeded,
                    info.pack_count,
                    info.library_dir
                ),
                Err(error) => log::warn!("[library] seed failed: {error}"),
            }
            // Bundled starter asset set (P9): copy the shipped files into the data
            // root on every boot (idempotent) so upgrades get them too.
            match assets::seed_starter_sync(app.handle()) {
                Ok(copied) if copied > 0 => log::info!("[starter] boot sync copied={copied}"),
                Ok(_) => {}
                Err(error) => log::warn!("[starter] boot sync failed: {error}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Wiki fetching
            wiki::fetch_story_index,
            wiki::fetch_story_page,
            wiki::fetch_widget_bundle,
            wiki::fetch_story_runtime,
            wiki::fetch_page_revisions,
            // Cache management
            cache::save_to_cache,
            cache::load_from_cache,
            // Bundled engine snapshot (offline first boot; see engine_snapshot.rs)
            engine_snapshot::engine_snapshot_info,
            engine_snapshot::engine_pack_info,
            engine_snapshot::engine_snapshot_read,
            cache::delete_from_cache,
            cache::list_cached_stories,
            cache::get_cache_status,
            cache::clear_cache,
            cache::delete_chapter_cache,
            // Asset management
            assets::download_asset,
            assets::get_asset_path,
            assets::read_asset_text,
            assets::refresh_engine_asset,
            assets::get_library_dir,
            assets::open_library_dir,
            assets::import_library_pack,
            assets::list_library,
            assets::seed_library,
            assets::delete_library_pack,
            // In-app story editor: 读/写剧本包内的文本文件（script.txt / pack.json）
            assets::read_library_file,
            assets::write_library_file,
            assets::pack_asset_path,
            assets::bundled_asset_keys,
            assets::seed_sample_assets_cmd,
            // Bundled starter asset set (P9): 起步素材集概况 + 补齐
            assets::starter_set_info,
            assets::starter_set_sync,
            // Managed bulk downloads
            download::download_start,
            download::download_add,
            download::download_feed_cached,
            download::download_close,
            download::download_pause,
            download::download_resume,
            download::download_cancel,
            download::download_status,
            download::download_settings_get,
            download::download_settings_set,
            // Mirror-source probes (settings page / native scripts)
            download::mirror_probe_url,
            download::mirror_probe_chain,
            download::system_counts,
            download::keepalive_set_reading,
            download::keepalive_set_manifest,
            // Network policy
            net::set_allow_online,
            net::get_allow_online,
            // Client-side image compression (资源压缩)
            compress::compress_estimate,
            compress::compress_get_config,
            compress::compress_start,
            compress::compress_pause,
            compress::compress_resume,
            compress::compress_cancel,
            compress::compress_status,
            compress::compress_disable_realtime,
            // Screen orientation (player forces landscape; elsewhere free) +
            // immersive system-bar hiding (player only)
            android_service::set_orientation,
            android_service::set_immersive,
            // Resource directory
            data_root::get_resource_dir,
            data_root::set_resource_dir,
            data_root::reset_resource_dir,
            // External links (About page)
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
