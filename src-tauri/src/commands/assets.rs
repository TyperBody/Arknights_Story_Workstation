use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Get the assets directory path (under the configurable data root).
fn assets_dir() -> Result<PathBuf, String> {
    let assets_dir = crate::data_root::data_root().join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets dir: {}", e))?;
    Ok(assets_dir)
}

/// Download an asset file (image/audio) and save it locally.
/// Returns the local file path.
///
/// Note: the font (`NotoSans.ttf`, `static.prts.wiki`) and the other engine deps
/// are mirrorable — they go through `refresh_engine_asset` / the source chain. This
/// legacy single-URL command is only used as a fallback with an explicit URL, so it
/// keeps the caller's URL as-is.
#[tauri::command]
pub async fn download_asset(
    url: String,
    category: String,
    filename: String,
) -> Result<String, String> {
    let dir = assets_dir()?;
    let category_dir = dir.join(&category);
    std::fs::create_dir_all(&category_dir)
        .map_err(|e| format!("Failed to create category dir: {}", e))?;

    let path = category_dir.join(&filename);

    // Skip if already cached
    if path.exists() {
        return path
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid path".to_string());
    }

    // Offline gate: refuse to fetch a missing asset when networking is off.
    crate::net::ensure_online()?;
    let resp = crate::net::client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download asset: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading: {}", resp.status(), url));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read asset bytes: {}", e))?;

    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write asset file: {}", e))?;

    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSnapshot {
    pub path: String,
    pub sha256: String,
    /// False means the online refresh failed and a validated last-known-good file
    /// was retained. The caller may surface the warning without losing playback.
    pub fresh: bool,
    pub warning: Option<String>,
    /// Source that actually served the fresh bytes (`pack`/`prts`/`jsd`/`fastly`/
    /// `ghproxy`); `None` when the cached copy was kept (refresh failed).
    pub source: Option<String>,
}

/// Fresh-first update for executable engine dependencies. New bytes are validated
/// and atomically replaced; a failed/HTML/truncated response can never overwrite
/// the previous working copy.
#[tauri::command]
pub async fn refresh_engine_asset(url: String, filename: String) -> Result<AssetSnapshot, String> {
    let dir = assets_dir()?.join("engine");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    recover_previous(&path);

    let cached = std::fs::read(&path)
        .ok()
        .filter(|bytes| validate_engine_asset(&filename, bytes).is_ok());
    if cached.is_none() && path.exists() {
        let _ = std::fs::remove_file(&path);
    }

    // Engine deps live on mirrorable hosts (`static.prts.wiki`, `code.jquery.com`):
    // try the selected source first, then the other mirrors, official last — same
    // chain as the media downloader / `prts-cdn://`. A 404 from an empty mirror
    // repo simply moves on to the next candidate.
    let refreshed = async {
        crate::net::ensure_online()?;
        let (mirror, custom) = crate::download::mirror_settings().effective();
        let mut last = format!("Failed to refresh {filename}");
        for (source, candidate) in crate::media::source_chain(&url, &mirror, custom.as_deref()) {
            let resp = match crate::net::client()
                .get(&candidate)
                .header("Referer", "https://prts.wiki/")
                .send()
                .await
            {
                Ok(resp) => resp,
                Err(e) => {
                    last = format!("Failed to refresh {filename}: {e}");
                    continue;
                }
            };
            if !resp.status().is_success() {
                last = format!("HTTP {} refreshing {candidate}", resp.status());
                continue;
            }
            let bytes = match resp.bytes().await {
                Ok(bytes) => bytes.to_vec(),
                Err(e) => {
                    last = format!("Failed to read {filename}: {e}");
                    continue;
                }
            };
            validate_engine_asset(&filename, &bytes)?;
            atomic_write(&path, &bytes)?;
            if source != "pack" && source != "prts" {
                log::debug!("[engine-update] source={source} url={candidate}");
            }
            return Ok::<(Vec<u8>, &'static str), String>((bytes, source));
        }
        Err(last)
    }
    .await;

    let (bytes, fresh, warning, source) = match refreshed {
        Ok((bytes, source)) => (bytes, true, None, Some(source.to_string())),
        Err(error) => match cached {
            Some(bytes) => (bytes, false, Some(error), None),
            None => return Err(error),
        },
    };
    let path_string = path
        .to_str()
        .ok_or_else(|| "Invalid path".to_string())?
        .to_string();
    Ok(AssetSnapshot {
        path: path_string,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        fresh,
        warning,
        source,
    })
}

fn validate_engine_asset(filename: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 64 {
        return Err(format!("{filename} is truncated ({} bytes)", bytes.len()));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| format!("{filename} is not UTF-8 text"))?;
    let lower = filename.to_ascii_lowercase();
    let valid = if lower.contains("jquery") {
        text.contains("jQuery")
    } else if lower.contains("preload") {
        text.contains("createjs") && text.contains("LoadQueue")
    } else if lower.contains("toolbox") {
        text.contains("TimerManager")
    } else if lower.ends_with(".css") {
        text.contains("#sys_main") || text.contains("#sys_fullscreen")
    } else {
        false
    };
    if !valid
        || text.trim_start().starts_with("<!DOCTYPE html")
        || text.contains("<title>Internal Server Error")
    {
        return Err(format!("{filename} failed engine integrity markers"));
    }
    Ok(())
}

fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("part-{}", std::process::id()));
    let backup = path.with_extension("previous");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&backup);
    let had_old = path.exists();
    if had_old {
        std::fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        if had_old {
            let _ = std::fs::rename(&backup, path);
        }
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    let _ = std::fs::remove_file(backup);
    Ok(())
}

fn recover_previous(path: &std::path::Path) {
    let backup = path.with_extension("previous");
    if !path.exists() && backup.exists() {
        let _ = std::fs::rename(backup, path);
    }
}

/// Check if an asset is cached locally and return its path.
#[tauri::command]
pub async fn get_asset_path(category: String, filename: String) -> Result<Option<String>, String> {
    let dir = assets_dir()?;
    let path = dir.join(&category).join(&filename);
    recover_previous(&path);

    if path.exists() {
        if category == "engine" {
            let valid = std::fs::read(&path)
                .ok()
                .is_some_and(|bytes| validate_engine_asset(&filename, &bytes).is_ok());
            if !valid {
                let _ = std::fs::remove_file(&path);
                return Ok(None);
            }
        }
        Ok(path.to_str().map(|s| s.to_string()))
    } else {
        Ok(None)
    }
}

/// Read a cached text asset and return its content as a string.
#[tauri::command]
pub async fn read_asset_text(category: String, filename: String) -> Result<Option<String>, String> {
    let dir = assets_dir()?;
    let path = dir.join(&category).join(&filename);
    recover_previous(&path);

    if path.exists() {
        if category == "engine" {
            let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read asset: {e}"))?;
            if validate_engine_asset(&filename, &bytes).is_err() {
                let _ = std::fs::remove_file(&path);
                return Ok(None);
            }
        }
        std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("Failed to read asset: {}", e))
    } else {
        Ok(None)
    }
}
// Bulk media downloading moved to the managed `download` module (job model with
// concurrency, pause/resume, cancel, progress events, bandwidth limit). See
// `download_start` and friends; the old `batch_download_assets` was removed.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_summary_matches_the_shipped_manifest() {
        let (files, bytes, groups) = starter_summary();
        assert!(files >= 200, "起步素材集条目太少：{files}");
        assert!(bytes > 8 * 1024 * 1024, "起步素材集太小：{bytes}");
        // 预算以**清单自己声明**的 `budgetBytes` 为准（策展脚本 `--budget` 写进来）：
        // 起步集从 25 MB 的「尝鲜」档扩到过「几百 MB」的全量档，硬编码就会过期。
        let budget = starter_budget_bytes();
        assert!(budget > 0, "清单缺 budgetBytes（策展脚本应写入）");
        assert!(bytes <= budget, "起步素材集超预算：{bytes} > {budget}");
        // 分组和 = 总条目数：**逐组相加**（2026-10-17 起起步集也带少量 `cg`，
        // 只加 core/background/portrait 三项会在扩档后误报）。
        let grouped: usize = groups.values().map(|n| *n).sum();
        assert_eq!(grouped, files, "分组计数之和 ≠ 条目数：{groups:?} vs {files}");
        assert!(groups.get("background").copied().unwrap_or(0) >= 60);
        assert!(groups.get("portrait").copied().unwrap_or(0) >= 80);
    }

    #[test]
    fn bundled_keys_merge_starter_then_sample() {
        let keys = bundled_asset_keys_at(&std::env::temp_dir().join("prts-starter-keys-none"));
        // 目录不存在 → 回落随包内置清单（starter + sample 合并）。
        assert!(keys.contains(&"torappu.prts.wiki/assets/avg/background/bg_black.png".to_string()));
        assert!(keys.iter().any(|k| k.starts_with("torappu.prts.wiki/assets/avg/background/")));
        assert!(keys.len() > 250, "合并后的 key 数不足：{}", keys.len());
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(sorted, keys, "key 列表应有序");
        assert_eq!(sorted.len(), {
            let mut dedup = sorted.clone();
            dedup.dedup();
            dedup.len()
        });
    }

    #[test]
    fn starter_seed_copies_files_and_reports_presence() {
        let root = std::env::temp_dir().join(format!("prts_starter_{}", std::process::id()));
        let source = root.join("bundle-resources");
        let data = root.join("data");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        // 一张「安装包里的」图 + 一个不该被复制的非图片文件。
        std::fs::write(source.join("bg_black.webp"), b"RIFF____WEBP").unwrap();
        std::fs::write(source.join("notes.txt"), b"skip me").unwrap();
        let copied = seed_starter_assets_at(&data, &source).unwrap();
        assert_eq!(copied, 1);
        let info = starter_set_info_at(&data);
        assert!(info.present);
        assert_eq!(info.installed, 1);
        assert!(info.files > 200);
        assert!(data.join("assets/starter/bg_black.webp").is_file());
        assert!(!data.join("assets/starter/notes.txt").exists());
        assert!(data.join("assets/starter/bundles.json").is_file());
        // 幂等：第二次不再复制。
        assert_eq!(seed_starter_assets_at(&data, &source).unwrap(), 0);
        // 缺资源的目录 → 报告「只有清单」。
        let empty = starter_set_info_at(&root.join("no-such-data"));
        assert!(!empty.present);
        assert_eq!(empty.installed, 0);
        assert!(empty.files > 200);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn engine_integrity_rejects_html_and_accepts_expected_markers() {
        assert!(validate_engine_asset(
            "krliov.toolbox.js",
            b"class TimerManager { constructor() {} }                                             "
        )
        .is_ok());
        assert!(validate_engine_asset(
            "krliov.toolbox.js",
            b"<!DOCTYPE html><html><title>Internal Server Error</title></html>          "
        )
        .is_err());
    }

    /// Opt-in real network smoke test for the hot-update transport.
    #[tokio::test]
    async fn live_engine_asset_refresh_when_requested() {
        if std::env::var("PRTS_LIVE_NETWORK").ok().as_deref() != Some("1") {
            return;
        }
        let result = refresh_engine_asset(
            "https://static.prts.wiki/assets/scenario/krliov.toolbox.js".to_string(),
            "krliov.toolbox.js".to_string(),
        )
        .await
        .unwrap();
        assert!(result.fresh);
        assert_eq!(result.sha256.len(), 64);
        assert!(result.source.is_some(), "fresh bytes must report their source");
    }
}

/// 本地二创剧本包的安装目录（`<资源目录>/assets/library/`）：Windows 资源管理器可
/// 直接打开，`localStories.ts` 的回退读取器也用它（category="library"）。
#[derive(Serialize)]
pub struct LibraryDirInfo {
    /// `.../assets/library` 绝对路径。
    pub library_dir: String,
    /// 已安装的剧本包数量。
    pub pack_count: usize,
}

#[tauri::command]
pub async fn get_library_dir() -> Result<LibraryDirInfo, String> {
    let dir = assets_dir()?.join("library");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create library dir: {}", e))?;
    let pack_count = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().join("script.txt").is_file())
                .count()
        })
        .unwrap_or(0);
    Ok(LibraryDirInfo {
        library_dir: dir.to_string_lossy().to_string(),
        pack_count,
    })
}

/// 用系统文件管理器打开本地剧本包目录（Windows 资源管理器 / macOS Finder / Linux 文件管理器）。
#[tauri::command]
pub fn open_library_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = assets_dir()?.join("library");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create library dir: {}", e))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 把一个**已在磁盘上的**剧本包目录复制进 `<资源目录>/assets/library/<packId>/`。
/// 供设置页「安装剧本包…」用：用户在文件管理器里选包目录，这里做校验 + 复制。
#[derive(Serialize)]
pub struct InstalledPack {
    pub library_dir: String,
    pub installed: String,
    pub pack_count: usize,
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let target = to.join(&name);
        let path = entry.path();
        if path.is_dir() {
            copy_tree(&path, &target)?;
        } else {
            std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn import_library_pack(source: String) -> Result<InstalledPack, String> {
    let src = PathBuf::from(&source);
    if !src.is_dir() {
        return Err(format!("不是目录：{}", src.display()));
    }
    let script = src.join("script.txt");
    let nested = src.join("source").join("probe.txt");
    if !script.is_file() && !nested.is_file() {
        return Err("目录里找不到 script.txt（或 source/probe.txt），不是剧本包".into());
    }
    let meta: Option<serde_json::Value> = std::fs::read_to_string(src.join("pack.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let fallback = src
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "pack".into());
    let id = meta
        .as_ref()
        .and_then(|value| value.get("id"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&fallback)
        .to_string();
    let library = assets_dir()?.join("library");
    let dest = library.join(&id);
    copy_tree(&src, &dest)?;
    let pack_count = std::fs::read_dir(&library)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().join("script.txt").is_file())
                .count()
        })
        .unwrap_or(0);
    Ok(InstalledPack {
        library_dir: library.to_string_lossy().to_string(),
        installed: id,
        pack_count,
    })
}

/// 一次列目录：`<资源目录>/assets/library/<packId>/` 下的所有**文本**文件。
/// 这是前端 `localStories.ts` 的首选来源（`index.json` 只是兼容旧布局的补充），
/// 所以用户把包目录拷进来即可，无需清单。
#[derive(Serialize)]
pub struct LibraryPack {
    pub id: String,
    /// 相对包目录的路径 → 文本内容（媒体文件跳过；单文件上限 8 MiB）。
    pub files: std::collections::BTreeMap<String, String>,
}

fn read_pack_files(root: &std::path::Path) -> std::collections::BTreeMap<String, String> {
    const MAX_FILE: u64 = 8 * 1024 * 1024;
    const SKIP: [&str; 9] = [
        "png", "jpg", "jpeg", "webp", "gif", "mp3", "ogg", "wav", "ttf",
    ];
    let mut files = std::collections::BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    let mut guard = 0;
    while let Some(dir) = stack.pop() {
        guard += 1;
        if guard > 4000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                // 跳过隐藏目录（.git 等）与图片/音频目录
                let hidden = entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.');
                if !hidden && path.file_name().map(|n| n != "assets" && n != "media").unwrap_or(true) {
                    stack.push(path);
                }
                continue;
            }
            let ext = path
                .extension()
                .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if SKIP.contains(&ext.as_str()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            if let Ok(rel) = path.strip_prefix(root) {
                files.insert(rel.to_string_lossy().replace('\\', "/"), text);
            }
        }
    }
    files
}

#[tauri::command]
pub async fn list_library() -> Result<Vec<LibraryPack>, String> {
    log::debug!("[library] list_library");
    let library = assets_dir()?.join("library");
    let Ok(entries) = std::fs::read_dir(&library) else {
        return Ok(Vec::new());
    };
    let mut packs = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let files = read_pack_files(&dir);
        // 至少要有一份剧本（编译产物或在 source/ 里的作者脚本）。
        if !files.contains_key("script.txt") && !files.contains_key("source/probe.txt") {
            continue;
        }
        packs.push(LibraryPack {
            id: entry.file_name().to_string_lossy().to_string(),
            files,
        });
    }
    packs.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(packs)
}

/// 剧本包根目录：`root/assets/library/`（不存在则创建）——`root` 是资源目录。
fn resolve_library_dir(root: &std::path::Path) -> Result<PathBuf, String> {
    let dir = root.join("assets").join("library");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create library dir: {}", e))?;
    Ok(dir)
}

/// 一个目录里的**可播放**剧本包数量：有 `script.txt`（编译产物）或
/// `source/probe.txt`（作者脚本）才算。
fn count_packs(library: &std::path::Path) -> usize {
    std::fs::read_dir(library)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    let dir = entry.path();
                    dir.is_dir() && (dir.join("script.txt").is_file() || dir.join("source").join("probe.txt").is_file())
                })
                .count()
        })
        .unwrap_or(0)
}

/// 首次启动时把**内置样例包**写进 `<资源目录>/assets/library/`：
/// 仅当目录里还没有任何剧本包、且 `.seeded` 标记不存在时才写，用户之后删掉
/// 样例包也不会被重新塞回来（标记仍在）。写成功后留下空的 `.seeded` 标记。
#[derive(Debug, Serialize)]
pub struct SeededInfo {
    /// `.../assets/library` 绝对路径。
    pub library_dir: String,
    /// 本次写入的剧本包数量（0 或 1）。
    pub seeded: usize,
    /// 写入后的剧本包总数。
    pub pack_count: usize,
}

/// 内置样例包的目录名（与 `include_str!` 的两个文件、`pack.json.id` 保持一致）。
const SAMPLE_PACK_ID: &str = "sample-fanfic";

#[tauri::command]
pub async fn seed_library() -> Result<SeededInfo, String> {
    let library = resolve_library_dir(&crate::data_root::data_root())?;
    seed_library_at(&library)
}

/// `seed_library` 的核心（可测）：`library` 就是 `<资源目录>/assets/library/`。
fn seed_library_at(library: &std::path::Path) -> Result<SeededInfo, String> {
    let marker = library.join(".seeded");
    let mut seeded = 0;
    if !marker.is_file() && count_packs(library) == 0 {
        let dest = library.join(SAMPLE_PACK_ID);
        std::fs::create_dir_all(&dest)
            .map_err(|e| format!("Failed to create sample pack dir: {}", e))?;
        // `include_str!` 的路径相对**本源文件**（`src-tauri/src/commands/`）。
        std::fs::write(
            dest.join("pack.json"),
            include_str!("../../resources/library/sample-fanfic/pack.json"),
        )
        .map_err(|e| format!("Failed to write sample pack.json: {}", e))?;
        std::fs::write(
            dest.join("script.txt"),
            include_str!("../../resources/library/sample-fanfic/script.txt"),
        )
        .map_err(|e| format!("Failed to write sample script.txt: {}", e))?;
        // 内置样例自带一份已验证的引擎快照（约 3.4 MB），断网首启也能直接播；
        // 用户把 runtime.json 删掉也能播——那时会用应用启动时抓到的共享快照。
        std::fs::create_dir_all(dest.join("build"))
            .map_err(|e| format!("Failed to create sample build dir: {}", e))?;
        std::fs::write(
            dest.join("build").join("runtime.json"),
            include_str!("../../resources/library/sample-fanfic/build/runtime.json"),
        )
        .map_err(|e| format!("Failed to write sample runtime.json: {}", e))?;
        // 自带素材：`<pack>/assets/*.webp` + 映射表 `build/assets.local.json`。
        // 有它们，样例包断网首次播放也不必等 PRTS（`pack_asset_path` 直接命中）。
        std::fs::create_dir_all(dest.join("assets"))
            .map_err(|e| format!("Failed to create sample assets dir: {}", e))?;
        for (name, bytes) in SAMPLE_ASSET_FILES {
            std::fs::write(dest.join("assets").join(name), bytes)
                .map_err(|e| format!("Failed to write sample asset {name}: {}", e))?;
        }
        std::fs::write(dest.join("build").join("assets.local.json"), SAMPLE_LOCAL_MAP)
            .map_err(|e| format!("Failed to write assets.local.json: {}", e))?;
        std::fs::write(&marker, b"").map_err(|e| format!("Failed to write .seeded: {}", e))?;
        // 顺带落一份「资源目录」可见的样例素材（`<root>/assets/sample/`，含 SOURCES.md）。
        if let Some(root) = library.parent().and_then(|p| p.parent()) {
            let _ = seed_sample_assets(root);
        }
        seeded = 1;
    }
    Ok(SeededInfo {
        library_dir: library.to_string_lossy().to_string(),
        seeded,
        pack_count: count_packs(library),
    })
}

/// `.setup`（启动线程）里的同步 seed：直接调核心，不必起 async runtime。
pub fn seed_library_sync() -> Result<SeededInfo, String> {
    let library = resolve_library_dir(&crate::data_root::data_root())?;
    seed_library_at(&library)
}

/// 启动时的**起步素材集**同步（P9）：把安装包 resources 里的文件复制进
/// `<资源目录>/assets/starter/`。**每次启动都跑**（幂等：同大小即跳过），
/// 这样老用户升级到带起步素材集的版本也会自动拿到，而不只是首启。
/// 随包资源缺失（开发运行 / 未按 `bundle.resources` 打包）→ 返回 0，不报错。
pub fn seed_starter_sync(app: &tauri::AppHandle) -> Result<usize, String> {
    let root = crate::data_root::data_root();
    let source = starter_resource_dir(app).or_else(assets_resource_dir);
    let copied = seed_starter_assets(&root, source.as_deref())?;
    if copied > 0 {
        log::info!(
            "[starter] seeded {copied} file(s) → {}",
            root.join("assets").join("starter").display()
        );
    }
    Ok(copied)
}

/// 内置样例自带的 8 份素材（文件名 → 字节）。编译期内置（`include_bytes!`），
/// seed 时写到磁盘；`sha256`/出处见 `src-tauri/resources/assets/sample/SOURCES.md`
/// （由 `scripts/fanfic/fetch-sample-assets.mjs --check` 离线校验）。
const SAMPLE_ASSET_FILES: [(&str, &[u8]); 8] = [
    ("bg_black.webp", include_bytes!("../../resources/assets/sample/bg_black.webp")),
    ("bg_room_2.webp", include_bytes!("../../resources/assets/sample/bg_room_2.webp")),
    ("bg_forest.webp", include_bytes!("../../resources/assets/sample/bg_forest.webp")),
    ("bg_rhodeslounge_2.webp", include_bytes!("../../resources/assets/sample/bg_rhodeslounge_2.webp")),
    ("char_002_amiya_1.webp", include_bytes!("../../resources/assets/sample/char_002_amiya_1.webp")),
    ("char_002_amiya_3.webp", include_bytes!("../../resources/assets/sample/char_002_amiya_3.webp")),
    ("char_130_doberm_ex.webp", include_bytes!("../../resources/assets/sample/char_130_doberm_ex.webp")),
    ("char_010_chen_1.webp", include_bytes!("../../resources/assets/sample/char_010_chen_1.webp")),
];

/// 包内自带素材表（canonical key → 包内相对路径），与素材一起内置。
const SAMPLE_LOCAL_MAP: &str =
    include_str!("../../resources/library/sample-fanfic/build/assets.local.json");

/// 自带素材的落盘流程：把 `resources/assets/sample/**` 复制进资源目录
/// `<资源目录>/assets/sample/`（应用可在文件管理器里看到，也让「资源目录」语义
/// 完整）；包内副本 `library/<pack>/assets/**` 由协议处理器直接读，无需复制。
/// 覆盖层清单（canonical key → 文件名）：seed 与 `bundled_asset_keys_at` 共用。
const SAMPLE_BUNDLES: &str = include_str!("../../resources/assets/sample/bundles.json");

/// 起步素材集（P9）的清单：**只内置清单**（`include_str!`），文件本身随安装包
/// resources 发布（`tauri.conf.json::bundle.resources`）——几百张图不能逐个
/// `include_bytes!`（会把二进制撑爆）。seed 时从**安装包资源目录**复制到
/// `<资源目录>/assets/starter/`；资源目录缺失（开发运行 / 老安装包）时退化为
/// 「只有清单、没有文件」：覆盖层查不到就照常走网络 + 缓存（不会回归）。
const STARTER_BUNDLES: &str = include_str!("../../resources/assets/starter/bundles.json");
const STARTER_CURATED: &str = include_str!("../../resources/assets/starter/curated.json");
/// 随包资源的相对目录名（与 `tauri.conf.json` 的 `bundle.resources` 对应）。
const STARTER_RESOURCE_DIR: &str = "resources/assets/starter";

/// 起步素材集的概况（设置页「随包素材」那一行）。serde camelCase。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StarterSetInfo {
    /// 清单里的条目数（= 随包 key 数；不等于磁盘上的文件数）。
    pub files: usize,
    /// 清单里的总字节数（`curated.json` 的 `bytes`）。
    pub bytes: u64,
    /// 三类各多少：`{"background": 120, "core": 7, "portrait": 160}`。
    pub groups: std::collections::BTreeMap<String, usize>,
    /// 磁盘上实际可供给的文件数（资源目录里 `assets/starter/**` 的图）。
    pub installed: usize,
    /// 资源目录里有没有起步素材集（false = 只有清单，缺失走网络）。
    pub present: bool,
    /// 资源目录位置（便于用户排查「为什么没有随包素材」）。
    pub dir: String,
}

/// 清单里声明的**预算**（`budgetBytes`，策展脚本写进来的；缺 → 0）。
/// 只给测试用（`starter_summary_matches_the_shipped_manifest` 断言总量 ≤ 预算）。
fn starter_budget_bytes() -> u64 {
    serde_json::from_str::<serde_json::Value>(STARTER_CURATED)
        .ok()
        .and_then(|v| v.get("budgetBytes").and_then(|b| b.as_u64()))
        .unwrap_or(0)
}

/// 读清单（内置的那份）：`(条目数, 字节, 每组条目数)`。坏清单 → 全 0（不抛）。
/// `StarterSetInfo.bytes` 直接给总量；预算见 `starter_budget_bytes`。
fn starter_summary() -> (usize, u64, std::collections::BTreeMap<String, usize>) {
    let mut groups: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(STARTER_CURATED) else {
        return (0, 0, groups);
    };
    let entries = value
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for entry in &entries {
        if let Some(group) = entry.get("group").and_then(|v| v.as_str()) {
            *groups.entry(group.to_string()).or_insert(0) += 1;
        }
    }
    let bytes = value.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
    (entries.len(), bytes, groups)
}

/// 起步素材集的文件白名单：图片（PNG/WebP/JPEG）+ 音频（MP3/Ogg）。
/// 音频是"补足预算"的主力（≈0.3 MB/条），命中覆盖层后播放器不必联网。
fn is_starter_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".webp")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".mp3")
        || lower.ends_with(".ogg")
}

/// 起步素材集的概况（`starter_set_info` 命令的核心，可测）。
pub(crate) fn starter_set_info_at(root: &std::path::Path) -> StarterSetInfo {
    let (files, bytes, groups) = starter_summary();
    let dir = root.join("assets").join("starter");
    let installed = match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| e.path().is_file() && is_starter_image(&e.file_name().to_string_lossy()))
            .count(),
        Err(_) => 0,
    };
    StarterSetInfo {
        files,
        bytes,
        groups,
        installed,
        present: installed > 0,
        dir: dir.to_string_lossy().to_string(),
    }
}

/// 把随包的起步素材集复制进资源目录（幂等：同名同大小即跳过）。
///
/// `source` = 安装包 resources 里的 `<...>/resources/assets/starter`。找不到
/// （开发运行 / 老安装包）→ `Ok(0)`，仅记一条 debug：**不是错误**，缺失的素材
/// 照旧「首次播放时下载并缓存」。
fn seed_starter_assets(
    root: &std::path::Path,
    source: Option<&std::path::Path>,
) -> Result<usize, String> {
    let Some(source) = source else { return Ok(0) };
    if !source.is_dir() {
        log::debug!("[starter] 随包资源目录缺失：{}", source.display());
        return Ok(0);
    }
    let dir = root.join("assets").join("starter");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create starter dir: {e}"))?;
    let mut copied = 0usize;
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_starter_image(&name) {
            continue;
        }
        let target = dir.join(&name);
        let same = std::fs::metadata(&target)
            .ok()
            .zip(std::fs::metadata(&path).ok())
            .is_some_and(|(a, b)| a.len() == b.len());
        if same {
            continue;
        }
        std::fs::copy(&path, &target)
            .map_err(|e| format!("Failed to copy starter {name}: {e}"))?;
        copied += 1;
    }
    // 清单/出处也复制一份：用户在「资源目录」里能看到来源，协议处理器也能读。
    let _ = std::fs::write(dir.join("SOURCES.md"), include_str!("../../resources/assets/starter/SOURCES.md"));
    let _ = std::fs::write(dir.join("curated.json"), STARTER_CURATED);
    let _ = std::fs::write(dir.join("bundles.json"), STARTER_BUNDLES);
    Ok(copied)
}

/// 起步素材集概况（设置 →「随包素材」那一行）。
#[tauri::command]
pub async fn starter_set_info() -> Result<StarterSetInfo, String> {
    Ok(starter_set_info_at(&crate::data_root::data_root()))
}

/// 「补齐随包素材」：把安装包里的起步素材集复制进资源目录（幂等）。
/// 返回复制/更新的文件数；随包资源缺失时返回 0（调用方按 `present` 展示）。
#[tauri::command]
pub async fn starter_set_sync(app: tauri::AppHandle) -> Result<usize, String> {
    let root = crate::data_root::data_root();
    let source = starter_resource_dir(&app);
    let copied = seed_starter_assets(&root, source.as_deref())?;
    log::info!(
        "[starter] sync copied={copied} installed={}",
        starter_set_info_at(&root).installed
    );
    Ok(copied)
}

/// 安装包 resources 里的起步素材集目录（`…/resources/assets/starter`）。
fn starter_resource_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let base = app.path().resource_dir().ok()?;
    let dir = base.join(STARTER_RESOURCE_DIR);
    dir.is_dir().then_some(dir)
}

/// 无 `AppHandle` 的启动路径（`seed_library_sync`）用的 resources 目录探测：
/// 依次试 exe 旁的 `resources/`（Windows/Linux 打包布局）、`../Resources/`
/// （macOS .app）、exe 同级的 `resources/assets/starter`。找不到 → None。
pub(crate) fn assets_resource_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidates = [
        dir.join(STARTER_RESOURCE_DIR),
        dir.join("..").join("Resources").join(STARTER_RESOURCE_DIR),
        dir.join("resources").join("resources").join("assets").join("starter"),
    ];
    candidates.into_iter().find(|p| p.is_dir())
}

/// 自检/测试用：起步素材集 seed 的入口（显式给 source 目录）。
#[cfg(test)]
pub(crate) fn seed_starter_assets_at(
    root: &std::path::Path,
    source: &std::path::Path,
) -> Result<usize, String> {
    seed_starter_assets(root, Some(source))
}

fn seed_sample_assets(root: &std::path::Path) -> Result<usize, String> {
    const FILES: [(&str, &[u8]); 8] = SAMPLE_ASSET_FILES;
    let dir = root.join("assets").join("sample");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sample asset dir: {e}"))?;
    for (name, bytes) in FILES {
        // 已存在且字节一致 → 不重写（减少首启 IO，也保留用户可能的替换）。
        if std::fs::read(dir.join(name)).map(|old| old == bytes).unwrap_or(false) {
            continue;
        }
        std::fs::write(dir.join(name), bytes).map_err(|e| format!("Failed to write {name}: {e}"))?;
    }
    // 出处/许可说明：随资源目录一起给用户看。
    const SOURCES: &str = include_str!("../../resources/assets/sample/SOURCES.md");
    let _ = std::fs::write(dir.join("SOURCES.md"), SOURCES);
    // 键 → 文件 映射（canonical key，与 `scripts/fanfic/fetch-sample-assets.mjs` 一致）：
    // 包的自带素材表（`build/assets.local.json`）之外的**公共**兜底——同一份
    // 素材在任意包里命中，且换过资源目录也还能解析。
    let _ = std::fs::write(dir.join("bundles.json"), SAMPLE_BUNDLES);
    Ok(FILES.len())
}

/// `seed_library` 的**自带素材**部分（可测）：把仓库内置的 8 份样例素材写进
/// `<资源目录>/assets/sample/`，并返回写/校验过的文件数。
#[tauri::command]
pub async fn seed_sample_assets_cmd() -> Result<usize, String> {
    seed_sample_assets(&crate::data_root::data_root())
}

/// Rust 覆盖层（`prts-cdn://` 协议第 1 步）能直接命中的 canonical key 列表。
///
/// 前端据此决定「这个 key 走 `prts-cdn://` 还是 `asset://`」：覆盖层里有的 key
/// **必须**留在 `prts-cdn://`——`asset://` 是自定义协议，Pixi 解码用的图片 Worker
/// （独立 realm）在 WebKitGTK/WKWebView 上取不到（`TypeError: Load failed`）；
/// `prts-cdn://` 由 Rust 供给，主线程与 Worker 都能取。判定是**数据驱动**的：
/// 读的就是协议处理器同一份 `<资源目录>/assets/sample/bundles.json`。
#[tauri::command]
pub async fn bundled_asset_keys() -> Result<Vec<String>, String> {
    Ok(bundled_asset_keys_at(&crate::data_root::data_root()))
}

/// `bundled_asset_keys` 的核心（可测）：目录里没有 bundles.json（例如用户从没
/// 启动过 seed）时回落到随包内置的那份——判定结果与首次 seed 之后一致。
pub(crate) fn bundled_asset_keys_at(root: &std::path::Path) -> Vec<String> {
    // `starter`（P9 起步素材集）在前、`sample` 在后：两侧都有同一个 key 时，
    // 前端只需知道「这个 key 归覆盖层」，实际取字节由协议处理器按同一顺序查。
    let mut keys = Vec::new();
    for (dir, fallback) in [("starter", STARTER_BUNDLES), ("sample", SAMPLE_BUNDLES)] {
        let manifest = root.join("assets").join(dir).join("bundles.json");
        let text = std::fs::read_to_string(&manifest).unwrap_or_else(|_| fallback.to_string());
        let Ok(table) = serde_json::from_str::<std::collections::HashMap<String, String>>(&text)
        else {
            continue;
        };
        keys.extend(
            table
                .into_iter()
                // 与协议处理器同一套「裸文件名」校验：畸形的表项不算命中。
                .filter(|(_, name)| {
                    !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
                })
                .map(|(key, _)| key),
        );
    }
    keys.sort();
    keys.dedup();
    keys
}

/// 已装剧本包**自带素材**的绝对路径解析：`pack_asset_path(packId, name)`。
/// `name` 是包内相对路径（如 `assets/bg_black.webp`）——两侧都校验（不许走出包目录），
/// 文件不存在直接报错（前端据此回退网络/缓存）。
///
/// 顺带把该文件加进 `asset://` 协议的 scope：资源目录可由用户改到任意位置
/// （甚至外置盘），Tauri 配置里的 scope 只覆盖默认 $APPDATA，不加会在
/// `<img>/fetch` 时拿到 403。
#[tauri::command]
pub async fn pack_asset_path(
    app: tauri::AppHandle,
    pack_id: String,
    name: String,
) -> Result<String, String> {
    let path = pack_asset_path_at(&resolve_library_dir(&crate::data_root::data_root())?, &pack_id, &name)?;
    log::debug!("[pack-assets] pack_asset_path {pack_id}/{name} -> {path}");
    {
        use tauri::Manager;
        if let Err(error) = app.asset_protocol_scope().allow_file(std::path::Path::new(&path)) {
            log::warn!("[asset-scope] allow {path}: {error}");
        }
    }
    Ok(path)
}

/// `pack_asset_path` 的核心（可测）：`library` 就是 `<资源目录>/assets/library/`。
fn pack_asset_path_at(library: &std::path::Path, pack_id: &str, name: &str) -> Result<String, String> {
    let id = validate_pack_id(pack_id)?;
    let name = validate_pack_path(name)?;
    let dir = library.join(&id);
    if !dir.is_dir() {
        return Err(format!("剧本包不存在：{id}"));
    }
    let path = dir.join(&name);
    if !path.is_file() {
        return Err(format!("包内素材不存在：{id}/{name}"));
    }
    Ok(path.to_string_lossy().to_string())
}

/// 校验剧本包 id：**单个目录名**（不含路径分隔符、不是 `.`/`..`）。
/// 与 `delete_library_pack_at` 同一条规则——两个命令共享同一道目录穿越闸门。
fn validate_pack_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains(':')
        || id == "."
        || id == ".."
    {
        return Err(format!("非法剧本包 id：{id}"));
    }
    Ok(id.to_string())
}

/// 校验包内**相对**路径（例如 `script.txt`、`script/ch1.txt`）：拒绝绝对路径、
/// 盘符、反斜杠与 `.`/`..` 段——写命令据此绝不可能走出包目录。
fn validate_pack_path(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("文件名不能为空".into());
    }
    if name.starts_with('/') || name.starts_with('\\') || name.contains(':') || name.contains('\\') {
        return Err(format!("非法文件名（必须是包内相对路径）：{name}"));
    }
    if name
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(format!("非法文件名（含空路径段或 `..`）：{name}"));
    }
    Ok(name.to_string())
}

/// 读一个剧本包内的文本文件：`<资源目录>/assets/library/<id>/<name>`。
/// 包或文件不存在时返回 `Ok(None)`——前端据此回退 `source/probe.txt`；
/// id/name 非法才报错（调用方页面直接展示消息）。
#[tauri::command]
pub async fn read_library_file(id: String, name: String) -> Result<Option<String>, String> {
    read_library_file_at(&resolve_library_dir(&crate::data_root::data_root())?, &id, &name)
}

/// `read_library_file` 的核心（可测）：`library` 就是 `<资源目录>/assets/library/`。
fn read_library_file_at(
    library: &std::path::Path,
    id: &str,
    name: &str,
) -> Result<Option<String>, String> {
    log::debug!("[library] read_library_file {id}/{name}");
    let id = validate_pack_id(id)?;
    // 空名字 = "没这个文件"（页面据此回退 `source/probe.txt`），不进校验错误分支。
    if name.trim().is_empty() {
        return Ok(None);
    }
    let name = validate_pack_path(name)?;
    let dir = library.join(&id);
    if !dir.is_dir() {
        return Ok(None);
    }
    let path = dir.join(&name);
    if !path.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))
}

/// 写命令的返回：绝对路径 + 写入字节数（前端用它显示「已保存 N 字节」）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenLibraryFile {
    /// 落盘后的绝对路径。
    pub path: String,
    /// 包内相对路径（回显，便于前端核对）。
    pub name: String,
    /// 写入的 UTF-8 字节数。
    pub bytes: usize,
}

/// 原子写一个剧本包内的文本文件（写 `<name>.tmp` 再 rename，避免半截文件）。
/// `create_dirs` 为真时先建父目录（例如首次写 `source/probe.txt`）。
#[tauri::command]
pub async fn write_library_file(
    id: String,
    name: String,
    content: String,
    create_dirs: Option<bool>,
) -> Result<WrittenLibraryFile, String> {
    write_library_file_at(
        &resolve_library_dir(&crate::data_root::data_root())?,
        &id,
        &name,
        &content,
        create_dirs.unwrap_or(false),
    )
}

/// `write_library_file` 的核心（可测）。包目录必须已存在（不隐式创建新包），
/// `name` 必须是包内相对路径——见 `validate_pack_path`。
fn write_library_file_at(
    library: &std::path::Path,
    id: &str,
    name: &str,
    content: &str,
    create_dirs: bool,
) -> Result<WrittenLibraryFile, String> {
    let id = validate_pack_id(id)?;
    let name = validate_pack_path(name)?;
    let dir = library.join(&id);
    if !dir.is_dir() {
        return Err(format!("剧本包不存在：{id}"));
    }
    let path = dir.join(&name);
    let parent = path
        .parent()
        .ok_or_else(|| format!("无效路径：{}", path.display()))?;
    if !parent.is_dir() {
        if !create_dirs {
            return Err(format!(
                "目录不存在：{}（createDirs=true 可自动创建）",
                parent.display()
            ));
        }
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| format!("无效路径：{}", path.display()))?;
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Failed to write tmp file: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to replace {}: {e}", path.display())
    })?;
    Ok(WrittenLibraryFile {
        path: path.to_string_lossy().to_string(),
        name,
        bytes: content.len(),
    })
}

/// 新建剧本包的返回（task-11）：新建的包 id/目录、是否**真的**新建过、
/// 以及 `script.txt` 落盘后的字节数。`created=false` 表示同名包已存在、
/// 本次只补齐了缺失的文件（**不覆盖**用户已有的内容）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPack {
    pub id: String,
    /// `.../assets/library/<id>` 绝对路径。
    pub dir: String,
    /// 本次是否新建了包目录。
    pub created: bool,
    /// `script.txt` 的字节数（新建 = 传入文本长度；已存在 = 磁盘上的长度）。
    pub script_bytes: usize,
}

/// 新建一个剧本包：`<资源目录>/assets/library/<id>/{pack.json,script.txt}`。
///
/// 与 `write_library_file` 的分工：后者要求包**已存在**（`create_dirs` 只建
/// 包内子目录），所以「第一次建包」需要这条命令。
/// - `id` 走 `validate_pack_id`（单个目录名、无路径分隔符）；
/// - 目录不存在才建；两个文件都是 `.tmp` + rename 的原子写；
/// - **已存在**：不覆盖 `pack.json`；`script.txt` 只在非空**且缺失**时补写。
#[tauri::command]
pub async fn create_library_pack(
    id: String,
    title: Option<String>,
    chapter: Option<String>,
    description: Option<String>,
    script: Option<String>,
) -> Result<CreatedPack, String> {
    create_library_pack_at(
        &resolve_library_dir(&crate::data_root::data_root())?,
        &id,
        title.as_deref().unwrap_or(""),
        chapter.as_deref().unwrap_or(""),
        description.as_deref().unwrap_or(""),
        script.as_deref().unwrap_or(""),
    )
}

/// `create_library_pack` 的核心（可测）：`library` = `<资源目录>/assets/library/`。
fn create_library_pack_at(
    library: &std::path::Path,
    id: &str,
    title: &str,
    chapter: &str,
    description: &str,
    script: &str,
) -> Result<CreatedPack, String> {
    let id = validate_pack_id(id)?;
    let dir = library.join(&id);
    let existed = dir.is_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create pack dir: {e}"))?;
    log::info!("[library] create_library_pack {id} created={}", !existed);

    // `pack.json`：只写 5 个字段（与 `library.js::toPack` 对齐）。
    // 已存在的包不动它——用户/命令行安装的元信息更权威。
    let pack_path = dir.join("pack.json");
    if !pack_path.is_file() {
        let meta = serde_json::json!({
            "id": id,
            "title": title,
            "chapter": chapter,
            "description": description,
            "branchPoints": [],
        });
        let mut text = serde_json::to_string_pretty(&meta)
            .map_err(|e| format!("Failed to serialize pack.json: {e}"))?;
        text.push('\n');
        write_text_atomic(&pack_path, &text)?;
    }

    // `script.txt`：`toPack` 要求它存在且是字符串（空包也至少这份）。
    let script_path = dir.join("script.txt");
    if !script_path.is_file() && !script.is_empty() {
        write_text_atomic(&script_path, script)?;
    }
    let script_bytes = std::fs::read(&script_path).map(|b| b.len()).unwrap_or(0);

    Ok(CreatedPack {
        id,
        dir: dir.to_string_lossy().to_string(),
        created: !existed,
        script_bytes,
    })
}

/// 原子写文本：`<name>.tmp` 再 rename（与 `write_library_file` 同一手法，
/// 但**会**建父目录——`create_library_pack` 的目录可能刚建好）。
fn write_text_atomic(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
        }
    }
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| format!("无效路径：{}", path.display()))?;
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Failed to write tmp file: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to replace {}: {e}", path.display())
    })
}

/// 导入结果（task-9）：落盘的包内相对路径、写入字节、映射表位置与**当前条目数**。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAsset {
    /// 写入 `build/assets.local.json` 的 canonical key（`canonical_key` 或推导）。
    pub key: String,
    /// 包内相对路径（`assets/<文件名>`）——前端展示 / `asset://` 取用。
    pub file: String,
    /// 复制后的字节数。
    pub bytes: usize,
    /// `.../build/assets.local.json` 的绝对路径。
    pub map_path: String,
    /// 合并后映射表里的条目总数（前端据此提示）。
    pub asset_count: usize,
}

/// 把一个**本地文件**复制进剧本包的素材目录，并登记到 `build/assets.local.json`。
///
/// 语义（`<资源目录>/assets/library/<id>/`）：
/// - `id` 走 `validate_pack_id`，**包目录必须已存在**（用 `create_library_pack` 建）；
/// - 文件名做安全化（去目录、控制字符 → `_`），重名加 `-1`/`-2` 后缀（**不覆盖**已有素材）；
/// - `.tmp` + rename 原子落盘；
/// - 映射表：读旧 JSON（坏 JSON → 新建）→ 合并 `key → assets/<file>` → pretty 写回。
#[tauri::command]
pub async fn import_pack_asset(
    id: String,
    source: String,
    canonical_key: Option<String>,
) -> Result<ImportedAsset, String> {
    import_pack_asset_at(
        &resolve_library_dir(&crate::data_root::data_root())?,
        &id,
        &source,
        canonical_key.as_deref(),
    )
}

/// `import_pack_asset` 的核心（可测）：`library` = `<资源目录>/assets/library/`。
fn import_pack_asset_at(
    library: &std::path::Path,
    id: &str,
    source: &str,
    canonical_key: Option<&str>,
) -> Result<ImportedAsset, String> {
    let id = validate_pack_id(id)?;
    let dir = library.join(&id);
    if !dir.is_dir() {
        return Err(format!("剧本包不存在：{id}"));
    }
    let src = std::path::Path::new(source);
    if !src.is_file() {
        return Err(format!("待导入的文件不存在：{source}"));
    }
    let assets = dir.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| format!("Failed to create assets dir: {e}"))?;

    // 目标文件名：只取原文件名 + 安全化；重名加后缀（不覆盖既有素材）。
    let raw_name = src
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .ok_or_else(|| format!("无效路径：{source}"))?;
    let safe: String = raw_name
        .chars()
        .map(|c| if c.is_control() || c == '/' || c == '\\' || c == ':' { '_' } else { c })
        .collect();
    let safe = if safe.trim().is_empty() { "asset.bin".to_string() } else { safe };
    let (stem, ext) = match safe.rfind('.') {
        Some(at) if at > 0 => (safe[..at].to_string(), safe[at..].to_string()),
        _ => (safe.clone(), String::new()),
    };
    let mut name = safe.clone();
    let mut suffix = 0;
    while assets.join(&name).exists() {
        suffix += 1;
        name = format!("{stem}-{suffix}{ext}");
        if suffix > 999 {
            return Err(format!("同名素材太多，放弃：{safe}"));
        }
    }

    let dest = assets.join(&name);
    std::fs::copy(src, &dest).map_err(|e| format!("Failed to copy asset: {e}"))?;
    let bytes = std::fs::metadata(&dest).map(|m| m.len() as usize).unwrap_or(0);

    // 映射表：bad JSON → 新建（用户手改坏了也照常可用）。
    let build = dir.join("build");
    std::fs::create_dir_all(&build).map_err(|e| format!("Failed to create build dir: {e}"))?;
    let map_path = build.join("assets.local.json");
    let mut map: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&map_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let key = canonical_key
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        // 带 scheme 的 URL（用户从上游复制的）→ 归一成 canonical `host/path`；
        // 归一不了（本来就没 scheme / 不是 http）→ 原样，别把用户的 key 弄丢。
        .map(|v| crate::media::canonical_key(&v).unwrap_or(v))
        .unwrap_or_else(|| infer_asset_key(&name));
    map.insert(key.clone(), serde_json::Value::String(format!("assets/{name}")));
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone()))
        .map_err(|e| format!("Failed to serialize asset map: {e}"))?;
    write_text_atomic(&map_path, &format!("{text}\n"))?;

    Ok(ImportedAsset {
        key,
        file: format!("assets/{name}"),
        bytes,
        map_path: map_path.to_string_lossy().to_string(),
        asset_count: map.len(),
    })
}

/// 推导 canonical key：没给 `canonical_key` 时的兜底。
///
/// ⚠️ 必须是 **`host/path`** 形态——`assets.local.json` 的键与 `media::canonical_key`
/// 同域（引擎拼出来的 URL 去掉 scheme），裸 `bg_x` 在播放期对不上。
/// 常见上游形状（`bg_*.png` / `char_*|avg_*` 贴图 / `*.mp3`）→ 官方路径；
/// 其余落到 `imported.local/assets/<file>`（永远是两段式，`canonical_key` 认）。
fn infer_asset_key(file_name: &str) -> String {
    let stem = file_name.rsplit_once('.').map(|(a, _)| a).unwrap_or(file_name);
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".mp3") || lower.ends_with(".ogg") || lower.ends_with(".wav") {
        return format!("torappu.prts.wiki/assets/audio/{file_name}");
    }
    if stem.to_ascii_lowercase().starts_with("bg") {
        return format!("torappu.prts.wiki/assets/avg/background/{stem}.png");
    }
    if stem.to_ascii_lowercase().starts_with("char_") || stem.to_ascii_lowercase().starts_with("avg_") {
        return format!("torappu.prts.wiki/assets/avg/characters/{stem}/{stem}.png");
    }
    if stem.to_ascii_lowercase().starts_with("ui_") {
        return format!("static.prts.wiki/assets/scenario/ui/{stem}.png");
    }
    format!("imported.local/assets/{file_name}")
}

/// 删除一个已安装的剧本包目录：`<资源目录>/assets/library/<id>/`。/// id 必须是**单个目录名**（不含路径分隔符、不是 `.`/`..`），目录里还得有
/// `script.txt` 或 `source/probe.txt`——避免误删用户放在 library/ 下的别的东西。
#[derive(Debug, Serialize)]
pub struct DeletedPack {
    /// `.../assets/library` 绝对路径。
    pub library_dir: String,
    /// 被删掉的剧本包 id。
    pub removed: String,
    /// 删除后剩余的剧本包数量。
    pub pack_count: usize,
}

#[tauri::command]
pub async fn delete_library_pack(id: String) -> Result<DeletedPack, String> {
    delete_library_pack_at(&resolve_library_dir(&crate::data_root::data_root())?, &id)
}

/// `delete_library_pack` 的核心（可测）：`library` 就是 `<资源目录>/assets/library/`。
fn delete_library_pack_at(library: &std::path::Path, id: &str) -> Result<DeletedPack, String> {
    let id = validate_pack_id(id)?;
    let dir = library.join(&id);
    if !dir.is_dir() {
        return Err(format!("剧本包不存在：{id}"));
    }
    if !dir.join("script.txt").is_file() && !dir.join("source").join("probe.txt").is_file() {
        return Err(format!("目录里找不到 script.txt（或 source/probe.txt），不是剧本包：{id}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete pack {id}: {e}"))?;
    Ok(DeletedPack {
        library_dir: library.to_string_lossy().to_string(),
        removed: id.to_string(),
        pack_count: count_packs(library),
    })
}

#[cfg(test)]
mod library_tests {
    use super::*;

    /// 一份临时「资源目录」；`Drop` 时清理，测试可并发跑。
    struct TempRoot {
        dir: PathBuf,
    }

    impl TempRoot {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "arkstage-library-test-{}-{}-{name}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn library(&self) -> PathBuf {
            self.dir.join("assets").join("library")
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn write_pack(library: &std::path::Path, id: &str, script: Option<&str>) {
        let dir = library.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(text) = script {
            std::fs::write(dir.join("script.txt"), text).unwrap();
        }
    }

    fn seed(root: &TempRoot) -> Result<SeededInfo, String> {
        seed_library_at(&resolve_library_dir(&root.dir)?)
    }

    fn delete(root: &TempRoot, id: &str) -> Result<DeletedPack, String> {
        delete_library_pack_at(&resolve_library_dir(&root.dir)?, id)
    }

    fn read_file(root: &TempRoot, id: &str, name: &str) -> Result<Option<String>, String> {
        read_library_file_at(&resolve_library_dir(&root.dir)?, id, name)
    }

    fn write_file(
        root: &TempRoot,
        id: &str,
        name: &str,
        content: &str,
        create_dirs: bool,
    ) -> Result<WrittenLibraryFile, String> {
        write_library_file_at(&resolve_library_dir(&root.dir)?, id, name, content, create_dirs)
    }

    fn create(
        root: &TempRoot,
        id: &str,
        title: &str,
        chapter: &str,
        description: &str,
        script: &str,
    ) -> Result<CreatedPack, String> {
        create_library_pack_at(
            &resolve_library_dir(&root.dir)?,
            id,
            title,
            chapter,
            description,
            script,
        )
    }

    fn import_asset(
        root: &TempRoot,
        id: &str,
        source: &str,
        key: Option<&str>,
    ) -> Result<ImportedAsset, String> {
        import_pack_asset_at(&resolve_library_dir(&root.dir)?, id, source, key)
    }

    fn source_file(root: &TempRoot, name: &str, bytes: &[u8]) -> String {
        let dir = root.dir.join("sources");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    fn read_map(root: &TempRoot, id: &str) -> serde_json::Value {
        let path = root.library().join(id).join("build").join("assets.local.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// task-9：导入 → 文件进 `<pack>/assets/`、映射合并进 `build/assets.local.json`、
    /// **已存在的表不丢条目**（两次导入 → 两条共存）。
    #[test]
    fn import_asset_copies_the_file_and_merges_the_map() {
        let root = TempRoot::new("import-merge");
        write_pack(&root.library(), "pack_a", Some("[End]\n"));
        // 先有一份**用户手写**的旧表：合并必须保它。
        let build = root.library().join("pack_a").join("build");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(
            build.join("assets.local.json"),
            "{\n \"torappu.prts.wiki/assets/avg/background/bg_black.png\": \"assets/bg_black.webp\"\n}\n",
        )
        .unwrap();

        let png = source_file(&root, "bg_forest.png", b"PNGDATA");
        let first = import_asset(&root, "pack_a", &png, None).unwrap();
        assert_eq!(first.file, "assets/bg_forest.png");
        assert_eq!(first.bytes, 7);
        assert!(first.key.starts_with("torappu.prts.wiki/assets/avg/background/bg_forest"));
        assert!(first.asset_count >= 2);
        let target = root.library().join("pack_a").join("assets").join("bg_forest.png");
        assert_eq!(std::fs::read(&target).unwrap(), b"PNGDATA");
        assert!(!root
            .library()
            .join("pack_a")
            .join("assets")
            .join("bg_forest.png.tmp")
            .exists());
        let table = read_map(&root, "pack_a");
        assert!(table.get("torappu.prts.wiki/assets/avg/background/bg_black.png").is_some());
        assert_eq!(table[&first.key], "assets/bg_forest.png");

        // 显式 canonicalKey 优先（带 scheme 的 URL 也归一成 host/path）。
        let mp3 = source_file(&root, "m_calm.mp3", b"ID3DATA");
        let second = import_asset(
            &root,
            "pack_a",
            &mp3,
            Some("https://torappu.prts.wiki/assets/audio/Music/m_calm.mp3"),
        )
        .unwrap();
        assert_eq!(second.key, "torappu.prts.wiki/assets/audio/Music/m_calm.mp3");
        assert_eq!(read_map(&root, "pack_a").as_object().unwrap().len(), 3);
    }

    /// 同名文件 → `-1`/`-2` 后缀（**不覆盖**已有素材），映射指向新文件。
    #[test]
    fn import_asset_suffixes_duplicate_names() {
        let root = TempRoot::new("import-suffix");
        write_pack(&root.library(), "dupes", Some("[End]\n"));
        let a = source_file(&root, "shot.png", b"one");
        let first = import_asset(&root, "dupes", &a, Some("a.example/x/shot.png")).unwrap();
        assert_eq!(first.file, "assets/shot.png");
        // 同名不同内容再次导入 → `shot-1.png`。
        let dir = root.dir.join("sources2");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("shot.png"), b"two").unwrap();
        let second = import_asset(
            &root,
            "dupes",
            &dir.join("shot.png").to_string_lossy(),
            Some("a.example/x/shot2.png"),
        )
        .unwrap();
        assert_eq!(second.file, "assets/shot-1.png");
        assert_eq!(
            std::fs::read(root.library().join("dupes").join("assets").join("shot.png")).unwrap(),
            b"one"
        );
        assert_eq!(
            std::fs::read(root.library().join("dupes").join("assets").join("shot-1.png")).unwrap(),
            b"two"
        );
        assert_eq!(second.asset_count, 2);
    }

    /// 坏 JSON 回退成新表；`imported.local/…` 的派生 key 仍是 `host/path`。
    #[test]
    fn import_asset_recovers_from_a_broken_map() {
        let root = TempRoot::new("import-badjson");
        write_pack(&root.library(), "broken", Some("[End]\n"));
        let build = root.library().join("broken").join("build");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("assets.local.json"), "{ not json").unwrap();
        let src = source_file(&root, "weird-name.dat", b"xyz");
        let result = import_asset(&root, "broken", &src, None).unwrap();
        assert_eq!(result.key, "imported.local/assets/weird-name.dat");
        assert!(crate::media::canonical_key(&result.key).is_some());
        let table = read_map(&root, "broken");
        assert_eq!(table.as_object().unwrap().len(), 1);
        assert_eq!(table[&result.key], "assets/weird-name.dat");
    }

    /// 闸门：包不存在 / id 非法 / 源不是文件 → 报错，且**不留**垃圾文件。
    #[test]
    fn import_asset_validates_ids_and_sources() {
        let root = TempRoot::new("import-guard");
        write_pack(&root.library(), "ok", Some("[End]\n"));
        let good = source_file(&root, "ok.png", b"x");

        for bad in ["", "  ", ".", "..", "a/b", r"a\b", "C:"] {
            let error = import_asset(&root, bad, &good, None).unwrap_err();
            assert!(error.contains("非法剧本包 id"), "id {bad:?} → {error}");
        }
        let error = import_asset(&root, "ghost", &good, None).unwrap_err();
        assert!(error.contains("剧本包不存在"), "{error}");
        for bad_source in ["", "   ", "file:///nope/never.png"] {
            let error = import_asset(&root, "ok", bad_source, None).unwrap_err();
            assert!(error.contains("不存在") || error.contains("不是文件"), "source {bad_source:?} → {error}");
        }
        // 目录不是文件（`is_file()` 为假）。
        let error = import_asset(&root, "ok", &root.dir.to_string_lossy(), None).unwrap_err();
        assert!(error.contains("不存在") || error.contains("不是文件"), "{error}");
        assert!(!root.library().join("ok").join("assets").exists());
    }

    /// 派生 key 的三种常见形状（背景 / 立绘 / 音频）。
    #[test]
    fn derived_keys_follow_the_upstream_layout() {
        assert_eq!(
            infer_asset_key("bg_forest.png"),
            "torappu.prts.wiki/assets/avg/background/bg_forest.png"
        );
        assert_eq!(
            infer_asset_key("char_002_amiya_1.png"),
            "torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png"
        );
        assert_eq!(
            infer_asset_key("m_calm.mp3"),
            "torappu.prts.wiki/assets/audio/m_calm.mp3"
        );
        assert_eq!(infer_asset_key("ui_speaker.png"), "static.prts.wiki/assets/scenario/ui/ui_speaker.png");
        // 派生的 key 必须能被 `media::canonical_key` 认（否则播放期对不上）。
        for name in ["bg_forest.png", "char_002_amiya_1.png", "m_calm.mp3", "weird-name.dat"] {
            let key = infer_asset_key(name);
            assert!(crate::media::canonical_key(&key).is_some(), "{name} → {key}");
        }
    }

    /// task-11：新建包 → 两个文件都在、`pack.json` 字段可被 `toPack` 读出；
    /// 再建同名包**不覆盖**用户内容（`created=false`、脚本字节数 = 磁盘值）。
    #[test]
    fn create_pack_writes_both_files_and_never_overwrites() {
        let root = TempRoot::new("create-pack");
        let script = "[HEADER(key=\"x\")]\n[endtip(block=true)]\n";
        let first = create(&root, "my_pack", "我的剧本", "同人剧场", "一句简介", script).unwrap();
        assert!(first.created);
        assert_eq!(first.id, "my_pack");
        assert_eq!(first.script_bytes, script.len());
        assert!(first.dir.ends_with("assets/library/my_pack"));
        let dir = root.library().join("my_pack");
        assert!(dir.join("script.txt").is_file() && dir.join("pack.json").is_file());
        assert_eq!(
            std::fs::read_to_string(dir.join("script.txt")).unwrap(),
            script
        );
        // 原子写不留 `.tmp`。
        assert!(!dir.join("script.txt.tmp").exists() && !dir.join("pack.json.tmp").exists());

        // `pack.json` 的字段形状 = `library.js::toPack` 期望的那几个。
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("pack.json")).unwrap()).unwrap();
        assert_eq!(meta["id"], "my_pack");
        assert_eq!(meta["title"], "我的剧本");
        assert_eq!(meta["chapter"], "同人剧场");
        assert_eq!(meta["description"], "一句简介");
        assert_eq!(meta["branchPoints"].as_array().unwrap().len(), 0);

        // 已存在：`pack.json` 与 `script.txt` 都不被覆盖（用户手改的内容留着）。
        std::fs::write(dir.join("pack.json"), "{\"id\":\"my_pack\",\"title\":\"手改\"}\n").unwrap();
        let second = create(&root, "my_pack", "另一个标题", "", "", "[End]\n").unwrap();
        assert!(!second.created);
        assert_eq!(second.script_bytes, script.len());
        assert_eq!(
            std::fs::read_to_string(dir.join("script.txt")).unwrap(),
            script
        );
        assert!(std::fs::read_to_string(dir.join("pack.json"))
            .unwrap()
            .contains("手改"));
    }

    /// 目录已存在但 `script.txt` **缺失**时补写；`script` 为空则只建目录。
    #[test]
    fn create_pack_fills_a_missing_script_only() {
        let root = TempRoot::new("create-fill");
        std::fs::create_dir_all(root.library().join("half-pack")).unwrap();
        let filled = create(&root, "half-pack", "T", "C", "D", "abc\n").unwrap();
        assert!(!filled.created);
        assert_eq!(filled.script_bytes, 4);
        assert!(root.library().join("half-pack").join("script.txt").is_file());

        // 空 script：目录建出来，但**不**写 script.txt（前端可后补）。
        let empty = create(&root, "no_script", "", "", "", "").unwrap();
        assert!(empty.created);
        assert_eq!(empty.script_bytes, 0);
        let dir = root.library().join("no_script");
        assert!(dir.is_dir() && dir.join("pack.json").is_file());
        assert!(!dir.join("script.txt").is_file());
    }

    /// 坏 id 走与 read/write/delete 同一道闸门；`.tmp` 命名不串台（`x.tmp` vs `x.part-1`）。
    #[test]
    fn create_pack_validates_the_id_and_ignores_bad_names() {
        let root = TempRoot::new("create-guard");
        for bad in ["", "  ", ".", "..", "a/b", r"a\b", "C:"] {
            let error = create(&root, bad, "", "", "", "x").unwrap_err();
            assert!(error.contains("非法剧本包 id"), "id {bad:?} → {error}");
        }
        // 两个不同 id 并发/连续建：互不影响；包计数 = 2。
        create(&root, "one", "", "", "", "a\n").unwrap();
        create(&root, "two", "", "", "", "b\n").unwrap();
        assert_eq!(count_packs(&root.library()), 2);
    }

    /// 计时器之外的守门：新命令返回的 `dir` 必须是**包目录本身**，
    /// 且 `read_library_file` 能立刻读到刚写的脚本（页面跳进编辑器就要用）。
    #[test]
    fn create_pack_dir_is_immediately_readable() {
        let root = TempRoot::new("create-readback");
        let script = "// fresh\n[HEADER(key=\"r\")]\n[endtip(block=true)]\n";
        let made = create(&root, "readback", "", "", "", script).unwrap();
        assert!(made.dir.ends_with("library/readback"));
        assert_eq!(
            read_file(&root, "readback", "script.txt").unwrap().as_deref(),
            Some(script)
        );
        // 建完就能被 write_library_file 继续编辑（说明目录/校验都对得上）。
        assert_eq!(write_file(&root, "readback", "pack.json", "{}", false).unwrap().bytes, 2);
    }

    #[test]
    fn sample_seed_is_written_once_and_delete_removes_it() {
        let root = TempRoot::new("seed-once");

        let first = seed(&root).unwrap();
        assert_eq!(first.seeded, 1);
        assert_eq!(first.pack_count, 1);
        let pack = root.library().join(SAMPLE_PACK_ID);
        let script = std::fs::read_to_string(pack.join("script.txt")).unwrap();
        // 两分支 Decision、一条合流 Predicate[1;2]，且没有 @tag 控制位
        // （script.txt 是编译产物）。行数随示例版本变化，这里只要求「有内容」。
        assert!(script.lines().count() >= 20);
        // 自带素材：8 个 webp + 映射表都必须 seed 进包，否则离线首播会漏网。
        for (name, bytes) in SAMPLE_ASSET_FILES {
            let written = std::fs::read(pack.join("assets").join(name)).unwrap();
            assert_eq!(written, bytes, "样例自带素材不一致：{name}");
        }
        let local_map: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(pack.join("build").join("assets.local.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(local_map.as_object().unwrap().len(), SAMPLE_ASSET_FILES.len());
        assert_eq!(
            local_map["torappu.prts.wiki/assets/avg/background/bg_black.png"],
            "assets/bg_black.webp"
        );
        // 资源目录可见的一份（含 SOURCES.md）。
        assert!(root.dir.join("assets").join("sample").join("SOURCES.md").is_file());
        // 只使用自带 key（背景 4 张全在包内；立绘用 character.json 的已知基名）。
        for key in ["bg_black", "bg_room_2", "bg_forest", "bg_rhodeslounge_2"] {
            assert!(script.contains(&format!("image=\"{key}\"")), "脚本未用自带背景 {key}");
        }
        // 收尾必须是 [Blocker(a=1 …)] 或 [endtip]：引擎的允许表里没有 [End]。
        assert!(script.contains("[Blocker(a=1"));
        // 注释里可以提到 `[End]`（作为反例），**指令行**里不能有。
        assert!(!script
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .any(|line| line.contains("[End]")));
        assert!(script.contains(r#"[Decision(options="跟着她走;先问清楚", values="1;2")]"#));
        assert!(script.contains(r#"[Predicate(references="1;2")]"#));
        assert!(!script.contains('@'));
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(pack.join("pack.json")).unwrap()).unwrap();
        assert_eq!(meta["id"], SAMPLE_PACK_ID);
        assert_eq!(meta["title"], "同人样例：初次见面");
        assert_eq!(meta["chapter"], "同人剧场");
        assert_eq!(meta["branchPoints"][0], "pick");
        assert!(root.library().join(".seeded").is_file());

        // 第二次是 no-op（标记已存在）。
        let second = seed(&root).unwrap();
        assert_eq!(second.seeded, 0);
        assert_eq!(second.pack_count, 1);

        // pack_asset_path：自带素材能解析成包内绝对路径；越界/缺失都报错。
        let resolved = pack_asset_path_at(
            &resolve_library_dir(&root.dir).unwrap(),
            SAMPLE_PACK_ID,
            "assets/bg_black.webp",
        )
        .unwrap();
        assert!(resolved.ends_with("assets/bg_black.webp") && std::path::Path::new(&resolved).is_file());
        assert!(pack_asset_path_at(&resolve_library_dir(&root.dir).unwrap(), SAMPLE_PACK_ID, "assets/nope.webp").is_err());
        assert!(pack_asset_path_at(&resolve_library_dir(&root.dir).unwrap(), SAMPLE_PACK_ID, "../pack.json").is_err());
        assert!(pack_asset_path_at(&resolve_library_dir(&root.dir).unwrap(), "no-such-pack", "assets/bg_black.webp").is_err());

        // 删除：目录消失，计数归零。
        let deleted = delete(&root, SAMPLE_PACK_ID).unwrap();
        assert_eq!(deleted.removed, SAMPLE_PACK_ID);
        assert_eq!(deleted.pack_count, 0);
        assert!(!pack.is_dir());

        // 删掉后重启也不再重塞（`.seeded` 还在）。
        let third = seed(&root).unwrap();
        assert_eq!(third.seeded, 0);
        assert_eq!(third.pack_count, 0);
    }

    #[test]
    fn seed_skips_when_a_pack_exists_and_marker_alone_blocks() {
        let root = TempRoot::new("existing-pack");
        let library = root.library();
        std::fs::create_dir_all(&library).unwrap();
        write_pack(&library, "user-pack", Some("[End]\n"));

        // 已有包 → 不 seed，也不写标记（用户之后删光仍会补样例）。
        let info = seed(&root).unwrap();
        assert_eq!(info.seeded, 0);
        assert_eq!(info.pack_count, 1);

        // `source/probe.txt` 布局也算一个包。
        write_pack(&library, "author-pack", None);
        std::fs::create_dir_all(library.join("author-pack").join("source")).unwrap();
        std::fs::write(
            library.join("author-pack").join("source").join("probe.txt"),
            "[End]\n",
        )
        .unwrap();
        assert_eq!(seed(&root).unwrap().pack_count, 2);

        // 只有标记、没有包：不再写样例（用户主动删光的场景）。
        std::fs::remove_dir_all(library.join("user-pack")).unwrap();
        std::fs::remove_dir_all(library.join("author-pack")).unwrap();
        std::fs::write(library.join(".seeded"), b"").unwrap();
        assert_eq!(seed(&root).unwrap().seeded, 0);
        assert_eq!(seed(&root).unwrap().pack_count, 0);
    }

    #[test]
    fn delete_validates_the_id_and_requires_a_real_pack() {
        let root = TempRoot::new("delete-guard");
        let library = root.library();
        std::fs::create_dir_all(&library).unwrap();
        write_pack(&library, "good-pack", Some("[End]\n"));
        // 普通目录（没有剧本）不能被删。
        std::fs::create_dir_all(library.join("just-files")).unwrap();

        for bad in [
            "", "  ", ".", "..", "a/b", r"a\b", "C:", "../x", "nested/pack", "good-pack/",
        ] {
            let error = delete(&root, bad).unwrap_err();
            assert!(error.contains("非法剧本包 id"), "id {bad:?} → {error}");
        }
        let error = delete(&root, "missing").unwrap_err();
        assert!(error.contains("剧本包不存在"), "{error}");
        let error = delete(&root, "just-files").unwrap_err();
        assert!(error.contains("不是剧本包"), "{error}");
        assert!(library.join("good-pack").is_dir());
        assert!(library.join("just-files").is_dir());

        // 删除 path 布局的包也允许（source/probe.txt）。
        let layout = library.join("probe-only");
        std::fs::create_dir_all(layout.join("source")).unwrap();
        std::fs::write(layout.join("source").join("probe.txt"), "[End]\n").unwrap();
        assert_eq!(delete(&root, "probe-only").unwrap().removed, "probe-only");
        assert!(!layout.exists());
    }

    /// 编辑器读写命令：id/相对路径校验、缺失即 None、原子替换不留 .tmp。
    #[test]
    fn library_read_write_validates_paths_and_replaces_atomically() {
        let root = TempRoot::new("read-write");
        let library = root.library();
        std::fs::create_dir_all(&library).unwrap();
        write_pack(&library, "good-pack", Some("[End]\n"));

        // read / write 与 delete 共用同一道 id 校验。
        for bad in ["", "  ", ".", "..", "a/b", r"a\b", "C:", "../x"] {
            let error = read_file(&root, bad, "script.txt").unwrap_err();
            assert!(error.contains("非法剧本包 id"), "id {bad:?} → {error}");
            let error = write_file(&root, bad, "script.txt", "x", true).unwrap_err();
            assert!(error.contains("非法剧本包 id"), "id {bad:?} → {error}");
        }
        // 空文件名 = "没有这个文件"（前端 read → null 后回退 source/probe.txt）。
        assert_eq!(read_file(&root, "good-pack", "").unwrap(), None);
        // 包内路径不得逃出包目录。
        for bad in ["..", "../x.txt", "/abs.txt", "a/../b.txt", r"a\b.txt", "C:/x.txt"] {
            let error = read_file(&root, "good-pack", bad).unwrap_err();
            assert!(error.contains("非法文件名"), "name {bad:?} → {error}");
            let error = write_file(&root, "good-pack", bad, "x", true).unwrap_err();
            assert!(error.contains("非法文件名"), "name {bad:?} → {error}");
        }
        // 包或文件不存在 → None（前端据此回退 source/probe.txt）。
        assert_eq!(read_file(&root, "missing", "script.txt").unwrap(), None);
        assert_eq!(read_file(&root, "good-pack", "nope.txt").unwrap(), None);
        assert_eq!(
            read_file(&root, "good-pack", "script.txt").unwrap().as_deref(),
            Some("[End]\n")
        );

        // 写：新建子目录（createDirs=true）、原子替换（不留 .tmp）、字节数。
        let written = write_file(&root, "good-pack", "source/probe.txt", "abc\n", true).unwrap();
        assert_eq!(written.bytes, 4);
        assert_eq!(written.name, "source/probe.txt");
        assert!(written.path.ends_with("probe.txt"));
        assert_eq!(
            read_file(&root, "good-pack", "source/probe.txt").unwrap().as_deref(),
            Some("abc\n")
        );
        let probe = library.join("good-pack").join("source").join("probe.txt");
        assert!(!probe.with_file_name("probe.txt.tmp").exists());

        // 覆写：旧内容整体替换，临时文件已 rename 掉。
        let second = write_file(&root, "good-pack", "source/probe.txt", "defg\n", false).unwrap();
        assert_eq!(second.bytes, 5);
        assert_eq!(
            read_file(&root, "good-pack", "source/probe.txt").unwrap().as_deref(),
            Some("defg\n")
        );
        assert!(!probe.with_file_name("probe.txt.tmp").exists());

        // 目录不存在且没开 createDirs → 报错；不存在的包目录不隐式创建。
        let error = write_file(&root, "good-pack", "missing-dir/x.txt", "x", false).unwrap_err();
        assert!(error.contains("目录不存在"), "{error}");
        assert!(write_file(&root, "ghost", "script.txt", "x", true)
            .unwrap_err()
            .contains("剧本包不存在"));
    }
}
