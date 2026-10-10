//! Bundled StoryPlayer engine snapshot (`src-tauri/resources/engine/v1/`).
//!
//! The snapshot is the exact shape `fetch_widget_bundle`/`fetch-upstream.mjs`
//! produce (`StoryPlayerSnapshot`: entry + prelude + modules + styles + data) and
//! is compiled into the binary with `include_bytes!`, so the engine can boot
//! **offline** on a fresh install:
//!
//!   1. `engine_snapshot_read()` → parse + validate → runtime `story_player`;
//!   2. validated disk cache (`widget-bundle-v7`);
//!   3. network (PRTS), promoted to that cache on success.
//!
//! `meta.json` carries the version/revision surface shown in the UI and read by
//! probes. Both files are generated, never hand-edited — the generator lives in
//! `build/ctx/NOTES-p6.md` (one `json.dump` over `build/fanfic/upstream.json`).

use serde::Serialize;
use std::sync::OnceLock;

/// The compiled-in snapshot JSON (3.4 MB; ~1.1 MB after release LTO).
static SNAPSHOT_JSON: &[u8] = include_bytes!("../resources/engine/v1/snapshot.json");
/// The compiled-in metadata sidecar (`{version, entry, revision, bytes, …}`).
static META_JSON: &[u8] = include_bytes!("../resources/engine/v1/meta.json");

/// `WidgetBundle.revision` used for the shipped snapshot (frontend mirrors this
/// shape in `enginePack.ts`: `bundled:<revision>`). Exposed for the probe/UI so
/// the prefix lives in exactly one place.
#[allow(dead_code)]
pub const BUNDLED_REVISION_PREFIX: &str = "bundled:";

/// Summary of the compiled-in pack. Mirrors `meta.json` plus live byte counts.
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotInfo {
    pub version: String,
    pub catalog_version: String,
    pub entry: String,
    pub revision: String,
    pub bytes: u64,
    pub built_at: String,
    pub files: usize,
    pub modules: usize,
    pub styles: usize,
    pub data: usize,
    /// Upstream module URLs shipped for completeness (metadata, not a filter).
    pub optional: Vec<String>,
}

fn snapshot_text() -> Result<&'static str, String> {
    std::str::from_utf8(SNAPSHOT_JSON).map_err(|e| format!("内置引擎快照不是 UTF-8: {e}"))
}

fn meta_value() -> Result<&'static serde_json::Value, String> {
    static META: OnceLock<Result<serde_json::Value, String>> = OnceLock::new();
    META.get_or_init(|| {
        serde_json::from_slice::<serde_json::Value>(META_JSON)
            .map_err(|e| format!("内置引擎快照元数据损坏: {e}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// Parse the built-in bundle into JSON. `Err` only when the shipped file is
/// corrupt, which makes the frontend fall through to cache → network.
pub fn snapshot_value() -> Result<serde_json::Value, String> {
    serde_json::from_slice(SNAPSHOT_JSON).map_err(|e| format!("内置引擎快照 JSON 无效: {e}"))
}

/// Compiled-in snapshot payload, verbatim (one big string).
#[tauri::command]
pub fn engine_snapshot_read() -> Result<String, String> {
    snapshot_text().map(str::to_string)
}

/// Metadata for the bundled pack — no I/O, usable offline.
#[tauri::command]
pub fn engine_snapshot_info() -> Result<SnapshotInfo, String> {
    let meta = meta_value()?;
    let text = snapshot_text()?;
    let snapshot: serde_json::Value = snapshot_value()?;
    let string_field = |name: &str| meta.get(name).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let modules = snapshot.get("modules").and_then(|v| v.as_object()).map_or(0, |m| m.len());
    let styles = snapshot.get("styles").and_then(|v| v.as_object()).map_or(0, |m| m.len());
    let data = snapshot.get("data").and_then(|v| v.as_object()).map_or(0, |m| m.len());
    Ok(SnapshotInfo {
        version: string_field("version"),
        catalog_version: string_field("catalogVersion"),
        entry: string_field("entry"),
        revision: string_field("revision"),
        // Live count: the file is the truth, `meta.json` is a hint.
        bytes: text.len() as u64,
        built_at: string_field("builtAt"),
        files: modules + styles + data,
        modules,
        styles,
        data,
        optional: meta
            .get("optional")
            .and_then(|v| v.as_array())
            .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
    })
}

/// Alias for the settings/mirror UI: what does the shipped pack contain?
/// Shape kept compatible with `frontend/src/lib/engineCatalog.ts::readEnginePack`.
#[derive(Debug, Clone, Serialize)]
pub struct EnginePackInfo {
    pub version: String,
    /// File names shipped in the pack (entry + dependency modules + style + data).
    pub keys: Vec<String>,
    pub files: usize,
    pub bytes: u64,
    pub revision: String,
    pub built_at: String,
}

#[tauri::command]
pub fn engine_pack_info() -> Result<EnginePackInfo, String> {
    let snapshot = snapshot_value()?;
    let mut keys: Vec<String> = Vec::new();
    for field in ["modules", "styles", "data"] {
        if let Some(map) = snapshot.get(field).and_then(|v| v.as_object()) {
            for url in map.keys() {
                keys.push(url.rsplit('/').next().unwrap_or(url).to_string());
            }
        }
    }
    keys.sort();
    keys.dedup();
    let size = engine_snapshot_info()?;
    Ok(EnginePackInfo {
        version: size.version,
        keys,
        files: size.files,
        bytes: size.bytes,
        revision: size.revision,
        built_at: size.built_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shipped_snapshot_is_complete_and_readable_offline() {
        let snapshot = snapshot_value().unwrap();
        let entry = snapshot["entry"].as_str().unwrap();
        assert!(entry.ends_with("StoryPlayer.BQgSL6Cy.js") || entry.contains("StoryPlayer."));
        assert!(snapshot["modules"].as_object().unwrap().contains_key(entry));
        assert!(snapshot["modules"].as_object().unwrap().len() >= 9);
        assert_eq!(snapshot["styles"].as_object().unwrap().len(), 1);
        assert_eq!(snapshot["data"].as_object().unwrap().len(), 3);
        // The three sidecars must be non-trivial (else validateStoryPlayer rejects).
        for (_url, table) in snapshot["data"].as_object().unwrap() {
            assert!(table.as_object().map_or(0, |t| t.len()) >= 100);
        }
        let text = engine_snapshot_read().unwrap();
        assert_eq!(text.len(), SNAPSHOT_JSON.len());
        let info = engine_snapshot_info().unwrap();
        assert_eq!(info.files, 13);
        assert!(info.bytes > 3_000_000);
        let pack = engine_pack_info().unwrap();
        assert!(pack.keys.iter().any(|k| k.starts_with("StoryPlayer.")));
        assert!(pack.keys.iter().any(|k| k.ends_with("character.json")));
    }
}
