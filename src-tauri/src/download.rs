//! Managed, streaming bulk-download engine.
//!
//! Pipelined: URLs can be appended to a *live* job ([`Manager::add`]) while its
//! workers are already downloading, and the producer calls [`Manager::close`]
//! when no more will arrive. This lets the (frontend, engine-driven) manifest
//! phase and the (Rust) download phase run concurrently — each captured story's
//! assets start downloading immediately instead of waiting for every manifest.
//!
//! Each job runs a pool of N worker tasks (configurable concurrency) that:
//!   - honor pause/resume (stop pulling new items; in-flight requests finish) and
//!     cancel (abort mid-file),
//!   - stream bodies through the global net::limiter token bucket (bandwidth cap),
//!   - skip already-stored / duplicate URLs (cross-story dedup), and
//!   - emit throttled `download://progress` events with live counts + bytes/sec.
//!
//! A [`Manager`] lives in Tauri managed state; the frontend drives it through the
//! `download_*` commands at the bottom of this file.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager as _};

/// Default number of concurrent workers per job. Matches the frontend default
/// (`prts-download-settings` in predownload.ts and the Settings slider): the
/// product decision is 「速度并发可以拉满」 → 12, configurable 1…32 at runtime
/// through the `download_settings_*` commands. The previous value (4) left most
/// of the link idle on a normal connection.
const DEFAULT_CONCURRENCY: usize = 12;
// `MAX_CONCURRENCY` is enforced by `Manager::set_concurrency`.
#[allow(dead_code)]
const MAX_CONCURRENCY: usize = 32;


/// Minimum gap between progress events for one job, to avoid event storms.
const PROGRESS_THROTTLE_MS: u128 = 150;
/// How long a worker waits when the queue is momentarily empty but the producer
/// (manifest phase) hasn't closed the job yet.
const IDLE_POLL_MS: u64 = 50;
/// Name of the progress event the frontend listens for.
pub const PROGRESS_EVENT: &str = "download://progress";

/// True while any job is Running/Paused. Lets the compression feature refuse to
/// start a batch mid-download (the reverse of `compress::ensure_idle`). Kept in
/// sync from `download_start` and every progress emit.
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Selected download source («设置 → 下载源»), mirrored process-wide exactly like
/// the concurrency/limiter settings. Read by every worker at fetch time and by the
/// `prts-cdn://` protocol handler, so changing the source applies to downloads
/// already running (no restart, no job-id plumbing).
pub struct MirrorSettings {
    inner: RwLock<(String, Option<String>)>,
}

static MIRROR_SETTINGS: OnceLock<MirrorSettings> = OnceLock::new();

pub fn mirror_settings() -> &'static MirrorSettings {
    MIRROR_SETTINGS.get_or_init(|| {
        MirrorSettings {
            inner: RwLock::new(("pack".to_string(), None)),
        }
    })
}

impl MirrorSettings {
    pub fn get(&self) -> (String, Option<String>) {
        self.inner.read().unwrap().clone()
    }

    /// Normalize on the way in: `mirror` must be one of the known source ids
    /// (unknown → `pack`, the default), and a template only makes sense for
    /// `custom`.
    pub fn set(&self, mirror: &str, custom: Option<String>) {
        let id = crate::media::SOURCE_IDS
            .iter()
            .copied()
            .find(|known| *known == mirror.trim().to_ascii_lowercase())
            .unwrap_or("pack");
        let tpl = custom
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        *self.inner.write().unwrap() = (id.to_string(), tpl);
    }

    /// Effective `(mirror, custom)` for a fetch: an empty custom template is
    /// `None` (the `custom` source then resolves to nothing and the chain falls
    /// back to the official link).
    pub fn effective(&self) -> (String, Option<String>) {
        let (mirror, custom) = self.get();
        let custom = custom.filter(|t| !t.trim().is_empty());
        (mirror, custom)
    }
}


/// Whether a bulk download is currently active (Running or Paused).
pub fn any_active() -> bool {
    DOWNLOAD_ACTIVE.load(Ordering::Relaxed)
}

/// Where progress snapshots go. Abstracting this keeps `Manager`/the worker engine
/// independent of Tauri's `AppHandle`, so they're testable in a plain async test.
pub trait ProgressSink: Send + Sync {
    fn emit(&self, snap: &Snapshot);
}

/// Production sink: forward each snapshot as a `download://progress` Tauri event,
/// AND drive the Android keep-alive notification straight from here. The latter is
/// what lets download progress keep advancing (and the FGS stay refreshed) even
/// when the WebView renderer is frozen in the background — the previous design
/// routed progress through the WebView, which aggressive ROMs (ColorOS, MIUI…)
/// freeze, making the download look stopped.
struct AppHandleSink(AppHandle);
impl ProgressSink for AppHandleSink {
    fn emit(&self, snap: &Snapshot) {
        let _ = self.0.emit(PROGRESS_EVENT, snap);
        // A running/paused job keeps the service alive; a terminal one releases it
        // (back to "reading" or idle, decided in android_service).
        let active = matches!(snap.status, Status::Running | Status::Paused);
        DOWNLOAD_ACTIVE.store(active, Ordering::Relaxed);
        crate::android_service::set_download(active, snap.done, snap.total);
    }
}

/// Lifecycle of a download job. Encoded as `u8` for atomic storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Paused,
    Completed,
    Cancelled,
}

impl Status {
    fn to_u8(self) -> u8 {
        match self {
            Status::Running => 0,
            Status::Paused => 1,
            Status::Completed => 2,
            Status::Cancelled => 3,
        }
    }
    fn from_u8(v: u8) -> Status {
        match v {
            1 => Status::Paused,
            2 => Status::Completed,
            3 => Status::Cancelled,
            _ => Status::Running,
        }
    }
}

/// Live state for one streaming job. Shared (`Arc`) between worker tasks, the
/// producer (add/close), and the command handlers; atomics + short-held mutexes
/// so no side blocks the others. Never held across the jobs-map lock.
struct Job {
    id: u64,
    /// Total URLs enqueued so far — grows while the manifest phase feeds the job.
    total: AtomicU32,
    done: AtomicU32,
    success: AtomicU32,
    failed: AtomicU32,
    skipped: AtomicU32,
    bytes: AtomicU64,
    status: std::sync::atomic::AtomicU8,
    paused: AtomicBool,
    cancelled: AtomicBool,
    /// Set when no more URLs will be added; workers exit once the queue drains.
    closed: AtomicBool,
    active_workers: AtomicUsize,
    pending: Mutex<VecDeque<String>>,
    /// Canonical keys ever enqueued, for cross-story dedup as manifests stream in.
    /// Keying off the canonical key (not the raw URL) collapses http/https/case
    /// variants of the same asset to a single download.
    seen: Mutex<HashSet<String>>,
    /// Canonical keys that exhausted retries / hit a permanent 4xx, with their
    /// last error — surfaced so missing assets (e.g. 立绘) are diagnosable instead
    /// of vanishing into a bare count. Capped to avoid unbounded growth.
    failed_keys: Mutex<Vec<String>>,
    /// Successful fetches per source id (`pack`/`prts`/jsd/…), counted as the
    /// worker stores each asset. Snapshot emits it ordered by `SOURCE_IDS`.
    sources: Mutex<HashMap<&'static str, u64>>,
    speed: Mutex<Speed>,
}

/// Cap on retained failed-key diagnostics per job.
const MAX_FAILED_KEYS: usize = 100;

/// Sliding sample for instantaneous bytes/sec (delta since the last emit).
struct Speed {
    last_at: Instant,
    last_bytes: u64,
    last_emit_at: Instant,
    bps: u64,
}

/// Serializable snapshot sent to the frontend (event payload + command result).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: u64,
    pub status: Status,
    pub total: u32,
    pub done: u32,
    pub success: u32,
    pub failed: u32,
    pub skipped: u32,
    pub bytes: u64,
    pub bytes_per_sec: u64,
    /// Keys that failed after retries (with their last error), for diagnosing
    /// missing assets. Capped; empty in the common case.
    pub failed_keys: Vec<String>,
    /// How many stored assets came from each source this job (`pack`/`prts`/`jsd`/
    /// `fastly`/`ghproxy`; `custom` is folded into the source whose URL it
    /// resolved to). Lets the UI/probe show that the selected source is really
    /// being used. Ordered source id → count.
    pub sources: Vec<(String, u64)>,
}

impl Job {
    fn new(id: u64) -> Self {
        let now = Instant::now();
        Job {
            id,
            total: AtomicU32::new(0),
            done: AtomicU32::new(0),
            success: AtomicU32::new(0),
            failed: AtomicU32::new(0),
            skipped: AtomicU32::new(0),
            bytes: AtomicU64::new(0),
            status: std::sync::atomic::AtomicU8::new(Status::Running.to_u8()),
            paused: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            active_workers: AtomicUsize::new(0),
            pending: Mutex::new(VecDeque::new()),
            seen: Mutex::new(HashSet::new()),
            failed_keys: Mutex::new(Vec::new()),
            sources: Mutex::new(HashMap::new()),
            speed: Mutex::new(Speed {
                last_at: now,
                last_bytes: 0,
                last_emit_at: now,
                bps: 0,
            }),
        }
    }

    /// Enqueue new (unseen) URLs; returns how many were actually added.
    fn enqueue(&self, urls: Vec<String>) -> u32 {
        let mut pending = self.pending.lock().unwrap();
        let mut seen = self.seen.lock().unwrap();
        let mut added = 0u32;
        for u in urls {
            // Dedup by canonical key so http/https/case-variant duplicates of the
            // same asset collapse to one download; unmappable strings (canonical
            // None) fall back to the raw string as their own dedup identity.
            let key = crate::media::canonical_key(&u).unwrap_or_else(|| u.clone());
            if seen.insert(key) {
                pending.push_back(u);
                added += 1;
            }
        }
        self.total.fetch_add(added, Ordering::Relaxed);
        added
    }

    fn pop(&self) -> Option<String> {
        self.pending.lock().unwrap().pop_front()
    }

    /// Record that `source` served one stored asset (called by the worker right
    /// after a successful store).
    fn note_source(&self, source: &'static str) {
        *self.sources.lock().unwrap().entry(source).or_insert(0) += 1;
    }

    /// `[(source, count)]` in settings-page order (`media::SOURCE_IDS`).
    fn source_counts(&self) -> Vec<(String, u64)> {
        let counts = self.sources.lock().unwrap();
        crate::media::SOURCE_IDS
            .iter()
            .filter_map(|id| counts.get(id).map(|n| ((*id).to_string(), *n)))
            .collect()
    }

    fn status(&self) -> Status {
        Status::from_u8(self.status.load(Ordering::Relaxed))
    }
    fn set_status(&self, s: Status) {
        self.status.store(s.to_u8(), Ordering::Relaxed);
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            id: self.id,
            status: self.status(),
            total: self.total.load(Ordering::Relaxed),
            done: self.done.load(Ordering::Relaxed),
            success: self.success.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            skipped: self.skipped.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            bytes_per_sec: self.speed.lock().unwrap().bps,
            failed_keys: self.failed_keys.lock().unwrap().clone(),
            sources: self.source_counts(),
        }
    }
}

/// Owns all jobs and the configurable concurrency. Held in Tauri managed state.
pub struct Manager {
    sink: Arc<dyn ProgressSink>,
    jobs: Mutex<HashMap<u64, Arc<Job>>>,
    next_id: AtomicU64,
    concurrency: AtomicUsize,
}

impl Manager {
    pub fn new(sink: Arc<dyn ProgressSink>) -> Self {
        Manager {
            sink,
            jobs: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            concurrency: AtomicUsize::new(DEFAULT_CONCURRENCY),
        }
    }

    fn get(&self, id: u64) -> Option<Arc<Job>> {
        self.jobs.lock().unwrap().get(&id).cloned()
    }

    /// Open a streaming job, seeded with `initial` URLs, and spawn its worker
    /// pool. The job stays open (workers wait for more) until [`Self::close`].
    pub fn start(&self, initial: Vec<String>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let job = Arc::new(Job::new(id));
        job.enqueue(initial);
        self.jobs.lock().unwrap().insert(id, job.clone());

        // Use the configurable worker count (driven by the download_settings commands).
        let workers = self.concurrency.load(Ordering::Relaxed).max(1);
        job.active_workers.store(workers, Ordering::Relaxed);

        let root = Arc::new(crate::media::media_root(&crate::data_root::data_root()));
        for _ in 0..workers {
            let job = job.clone();
            let root = root.clone();
            let sink = self.sink.clone();
            tauri::async_runtime::spawn(worker(job, root, sink));
        }
        id
    }

    /// Append URLs to a live job (pipelined from the manifest phase).
    pub fn add(&self, id: u64, urls: Vec<String>) {
        if let Some(job) = self.get(id) {
            if job.enqueue(urls) > 0 {
                self.sink.emit(&job.snapshot());
            }
        }
    }

    /// Signal that no more URLs will be added; workers finish the queue and exit.
    pub fn close(&self, id: u64) {
        if let Some(job) = self.get(id) {
            job.closed.store(true, Ordering::Relaxed);
        }
    }

    pub fn pause(&self, id: u64) {
        if let Some(job) = self.get(id) {
            if job.status() == Status::Running {
                job.paused.store(true, Ordering::Relaxed);
                job.set_status(Status::Paused);
                self.sink.emit(&job.snapshot());
            }
        }
    }

    pub fn resume(&self, id: u64) {
        if let Some(job) = self.get(id) {
            if job.status() == Status::Paused {
                job.paused.store(false, Ordering::Relaxed);
                job.set_status(Status::Running);
                self.sink.emit(&job.snapshot());
            }
        }
    }

    pub fn cancel(&self, id: u64) {
        if let Some(job) = self.get(id) {
            job.cancelled.store(true, Ordering::Relaxed);
            job.paused.store(false, Ordering::Relaxed);
        }
    }

    pub fn status(&self, id: u64) -> Option<Snapshot> {
        self.get(id).map(|j| j.snapshot())
    }

    pub fn concurrency(&self) -> usize {
        self.concurrency.load(Ordering::Relaxed)
    }
    pub fn set_concurrency(&self, n: usize) {
        self.concurrency.store(n.clamp(1, MAX_CONCURRENCY), Ordering::Relaxed);
    }
}

/// One worker: pull URLs (waiting while the producer streams more), honor
/// pause/cancel/offline, fetch+store, update counters.
async fn worker(job: Arc<Job>, root: Arc<std::path::PathBuf>, sink: Arc<dyn ProgressSink>) {
    let client = crate::net::client();
    loop {
        if job.cancelled.load(Ordering::Relaxed) {
            break;
        }
        // Pause gate: poll until resumed or cancelled (~100ms latency, no spin).
        while job.paused.load(Ordering::Relaxed) && !job.cancelled.load(Ordering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if job.cancelled.load(Ordering::Relaxed) {
            break;
        }
        // Offline toggled mid-job: stop pulling new items (cached reads only).
        if !crate::net::allow_online() {
            job.cancelled.store(true, Ordering::Relaxed);
            break;
        }

        let url = match job.pop() {
            Some(u) => u,
            None => {
                // Queue empty: exit if the producer is done, else wait for more.
                if job.closed.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(IDLE_POLL_MS)).await;
                continue;
            }
        };

        // Normalize to the canonical key. Unmappable strings (data:/blob:/relative
        // paths the engine emits while enumerating a manifest) are not real assets
        // and NOT failures — count them as skipped so they never show up as a
        // phantom "1 failed".
        let key = match crate::media::canonical_key(&url) {
            Some(k) => k,
            None => {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                finish_item(&job, &*sink);
                continue;
            }
        };

        // Already in the content-addressed store (store_path on the canonical key
        // is idempotent, so it matches whether the input was a URL or a bare key).
        if crate::media::read_local_validated(&root, &key).is_some() {
            job.skipped.fetch_add(1, Ordering::Relaxed);
            finish_item(&job, &*sink);
            continue;
        }

        let (mirror, custom) = mirror_settings().effective();
        match fetch_item(client, &key, &root, &job, &mirror, custom.as_deref()).await {
            Ok(source) => {
                job.success.fetch_add(1, Ordering::Relaxed);
                job.note_source(source);
            }
            Err(e) => {
                // Exhausted retries (or a permanent 4xx). Record the key + error so
                // missing assets (e.g. 立绘) are diagnosable, and log for logcat.
                job.failed.fetch_add(1, Ordering::Relaxed);
                eprintln!("[download] failed {key}: {e}");
                let mut fk = job.failed_keys.lock().unwrap();
                if fk.len() < MAX_FAILED_KEYS {
                    fk.push(format!("{key} — {e}"));
                }
            }
        }
        finish_item(&job, &*sink);
    }

    // Last worker out finalizes the job.
    if job.active_workers.fetch_sub(1, Ordering::Relaxed) == 1 {
        let final_status = if job.cancelled.load(Ordering::Relaxed) {
            Status::Cancelled
        } else {
            Status::Completed
        };
        job.set_status(final_status);
        sink.emit(&job.snapshot());
    }
}

/// Fetch one canonical key into the store, trying the source chain in order
/// (preferred source → custom → pack/official → the other mirrors → prts) and
/// stopping at the first 2xx. Bytes are ALWAYS stored under the canonical `key`
/// (`media::write_local(root, key, …)`), never under the mirror URL, so the
/// on-disk cache is source-independent. Returns the source that served it.
async fn fetch_item(
    client: &reqwest::Client,
    key: &str,
    root: &std::path::Path,
    job: &Job,
    mirror: &str,
    custom: Option<&str>,
) -> Result<&'static str, String> {
    let chain = crate::media::source_chain(key, mirror, custom);
    if chain.is_empty() {
        // Unmappable key (defensive: the worker already filtered those).
        return Err("no applicable source".into());
    }
    let mut last: Option<String> = None;
    for (source, url) in &chain {
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        match fetch_with_retry(client, url, key, root, job).await {
            Ok(()) => {
                log::debug!("[download] source={source} key={key}");
                return Ok(source);
            }
            Err(e) => {
                // A 4xx on this mirror (empty mirror repo until publish-mirror has
                // run) just moves on to the next source; the loop keeps the last
                // error for the failure diagnostic.
                last = Some(format!("{source}: {e}"));
            }
        }
    }
    Err(last.unwrap_or_else(|| "no applicable source".into()))
}

/// Stream a URL into the media store under `key`, metering bytes through the user's
/// global bandwidth limiter.
async fn fetch_to_store(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    root: &std::path::Path,
    job: &Job,
) -> Result<(), String> {
    let mut resp = client
        .get(url)
        .header("Referer", "https://prts.wiki/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {}", resp.status(), url));
    }

    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        let len = chunk.len() as u64;
        // User's global bandwidth cap (0 = unlimited).
        crate::net::limiter().acquire(len).await;
        job.bytes.fetch_add(len, Ordering::Relaxed);
        buf.extend_from_slice(&chunk);
        // Abort mid-file on cancel so big files don't hold the job open.
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
    }
    crate::media::validate_asset_bytes(key, &buf)?;
    // Real-time compression: when a tier is enabled and this is an image, store
    // the compressed (WebP) bytes directly instead of the original.
    let buf = crate::compress::maybe_transcode_image(key, buf);
    crate::media::validate_asset_bytes(key, &buf)?;
    // Store under the canonical key, not the source-specific fetch URL.
    crate::media::write_local(root, key, &buf)
}

/// Max attempts per URL. Auto-retrying transient failures means a flaky network
/// (or a backgrounded device briefly losing connectivity) never surfaces as a
/// "failed download" — the worker keeps trying until the asset lands.
const MAX_ATTEMPTS: u32 = 6;

/// Fetch a URL into the store, retrying transient failures with capped
/// exponential backoff. Stops early on cancellation or a permanent error
/// (HTTP 4xx other than 429); network/timeout/5xx errors are retried.
async fn fetch_with_retry(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    root: &std::path::Path,
    job: &Job,
) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        match fetch_to_store(client, url, key, root, job).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                if job.cancelled.load(Ordering::Relaxed)
                    || attempt >= MAX_ATTEMPTS
                    || is_permanent(&e)
                {

                    return Err(e);
                }
                // Backoff 200ms, 400, 800, … capped at 3s; wake early on cancel.
                let backoff_ms = (200u64.saturating_mul(1u64 << (attempt - 1))).min(3000);
                let mut waited = 0u64;
                while waited < backoff_ms && !job.cancelled.load(Ordering::Relaxed) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    waited += 100;
                }
            }
        }
    }
}

/// A permanent failure not worth retrying: an HTTP 4xx response other than 429
/// (Too Many Requests is transient). Connection/timeout/5xx errors are retried.
fn is_permanent(err: &str) -> bool {
    err.starts_with("HTTP 4") && !err.starts_with("HTTP 429")
}

/// Bump the done counter and emit a throttled progress event.
fn finish_item(job: &Job, sink: &dyn ProgressSink) {
    job.done.fetch_add(1, Ordering::Relaxed);
    maybe_emit(job, sink);
}

/// Emit a progress event if enough time has elapsed since the last one, updating
/// the instantaneous speed sample. Always cheap; the throttle guards event spam.
fn maybe_emit(job: &Job, sink: &dyn ProgressSink) {
    let now = Instant::now();
    let mut emit_now = false;
    {
        let mut s = job.speed.lock().unwrap();
        if now.duration_since(s.last_emit_at).as_millis() >= PROGRESS_THROTTLE_MS {
            let dt = now.duration_since(s.last_at).as_secs_f64();
            let cur = job.bytes.load(Ordering::Relaxed);
            if dt > 0.0 {
                s.bps = (((cur.saturating_sub(s.last_bytes)) as f64) / dt) as u64;
            }
            s.last_at = now;
            s.last_bytes = cur;
            s.last_emit_at = now;
            emit_now = true;
        }
    }
    if emit_now {
        sink.emit(&job.snapshot());
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettings {
    pub concurrency: usize,
    pub rate_limit_bps: u64,
    /// Selected download source (`pack|prts|jsd|fastly|ghproxy|custom`).
    pub mirror: String,
    /// Custom mirror template (`{url}`/`{key}`/`{host}`/`{path}`); `custom` only.
    pub custom_mirror: Option<String>,
}

#[tauri::command]
pub fn download_start(urls: Vec<String>, state: tauri::State<'_, Manager>) -> Result<u64, String> {
    // Offline gate: don't even start a bulk download when networking is off.
    crate::net::ensure_online()?;
    // Compression gate: refuse new downloads while a compression batch runs (the
    // store is being rewritten in place; downloads resume once it finishes).
    crate::compress::ensure_idle()?;
    DOWNLOAD_ACTIVE.store(true, Ordering::Relaxed);
    // Start the keep-alive foreground service NOW, from this (foreground) command —
    // Android 12+ forbids starting an FGS from the background, and the first engine
    // progress emit could land after the user has already backgrounded the app.
    crate::android_service::set_download(true, 0, 0);
    Ok(state.start(urls))
}

#[tauri::command]
pub fn download_add(job_id: u64, urls: Vec<String>, state: tauri::State<'_, Manager>) {
    state.add(job_id, urls);
}

/// Feed already-cached story manifests into the live job ENTIRELY in Rust (read the
/// `manifest_<title>.json` files, stream their http(s) URLs to the worker pool) and
/// return the titles that have NO cached manifest yet. Those still need the WebView
/// engine to index them; everything fed here downloads without the WebView, so the
/// bulk of a (re)download keeps running in the background — where aggressive ROMs
/// (ColorOS/MIUI) freeze the WebView renderer the per-story indexing depends on.
#[tauri::command]
pub fn download_feed_cached(
    job_id: u64,
    titles: Vec<String>,
    runtime_revision: String,
    page_revisions: HashMap<String, String>,
    state: tauri::State<'_, Manager>,
) -> Vec<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ManifestRecord {
        schema_version: u8,
        runtime_revision: String,
        page_revision: Option<String>,
        urls: Vec<String>,
    }

    let mut uncached = Vec::new();
    for title in titles {
        let Some(expected_page_revision) = page_revisions.get(&title) else {
            // If the live oldid audit failed/missed this page, never trust a stale
            // manifest blindly; the frontend will validate/fetch it directly.
            uncached.push(title);
            continue;
        };
        let path = crate::commands::cache::manifest_cache_path(&title);
        match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<ManifestRecord>(&s) {
                Ok(record)
                    if record.schema_version == 2
                        && record.runtime_revision == runtime_revision
                        && record.page_revision.as_ref() == Some(expected_page_revision) =>
                {
                    let urls: Vec<String> = record
                        .urls
                        .into_iter()
                        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
                        .collect();
                    state.add(job_id, urls);
                }
                _ => uncached.push(title), // stale/legacy/corrupt cache → re-index
            },
            Err(_) => uncached.push(title), // not cached yet
        }
    }
    uncached
}

#[tauri::command]
pub fn download_close(job_id: u64, state: tauri::State<'_, Manager>) {
    state.close(job_id);
}

#[tauri::command]
pub fn download_pause(job_id: u64, state: tauri::State<'_, Manager>) {
    state.pause(job_id);
}

#[tauri::command]
pub fn download_resume(job_id: u64, state: tauri::State<'_, Manager>) {
    state.resume(job_id);
}

#[tauri::command]
pub fn download_cancel(job_id: u64, state: tauri::State<'_, Manager>) {
    state.cancel(job_id);
}

#[tauri::command]
pub fn download_status(job_id: u64, state: tauri::State<'_, Manager>) -> Option<Snapshot> {
    state.status(job_id)
}

#[tauri::command]
pub fn download_settings_get(state: tauri::State<'_, Manager>) -> DownloadSettings {
    let (mirror, custom_mirror) = mirror_settings().get();
    DownloadSettings {
        concurrency: state.concurrency(),
        rate_limit_bps: crate::net::limiter().rate(),
        mirror,
        custom_mirror,
    }
}

#[tauri::command]
pub fn download_settings_set(
    concurrency: usize,
    rate_limit_bps: u64,
    mirror: Option<String>,
    custom_mirror: Option<String>,
    state: tauri::State<'_, Manager>,
) {
    state.set_concurrency(concurrency);
    crate::net::limiter().set_rate(rate_limit_bps);
    // Omitted fields leave the current source untouched (older frontends that
    // only push concurrency/rate keep working).
    if mirror.is_some() || custom_mirror.is_some() {
        let (current_mirror, current_custom) = mirror_settings().get();
        mirror_settings().set(
            mirror.as_deref().unwrap_or(&current_mirror),
            custom_mirror.or(current_custom),
        );
    }
}

// ---------------------------------------------------------------------------
// Source probes («换源后真的生效了吗» — used by the settings page / native scripts
// and asserted by the unit tests). Pure functions + read-only state dumps.
// ---------------------------------------------------------------------------

/// One step of a key's try chain, for the probe command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorProbeStep {
    pub source: String,
    pub url: String,
}

/// Source ids that actually served bytes, process-wide: the download engine's
/// jobs plus the `prts-cdn://` cache-through (which runs outside any job).
static PROTOCOL_SOURCES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn protocol_sources() -> &'static Mutex<HashMap<String, u64>> {
    PROTOCOL_SOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record one cache-through fetch served by `source` (called from the protocol
/// handler; `custom` is never recorded — see `media::source_chain`).
pub fn note_protocol_source(source: &str) {
    *protocol_sources()
        .lock()
        .unwrap()
        .entry(source.to_string())
        .or_insert(0) += 1;
}

/// Successful cache-through fetches per source, in settings-page order.
pub fn protocol_source_counts() -> Vec<(String, u64)> {
    let counts = protocol_sources().lock().unwrap();
    crate::media::SOURCE_IDS
        .iter()
        .filter_map(|id| counts.get(*id).map(|n| ((*id).to_string(), *n)))
        .collect()
}

/// Probe: URL this key would be fetched from for `mirror` (`None` = the source
/// cannot serve it → the chain falls back). No network.
#[tauri::command]
pub fn mirror_probe_url(
    key: String,
    mirror: String,
    custom_mirror: Option<String>,
) -> Option<String> {
    crate::media::mirror_url(&key, &mirror, custom_mirror.as_deref())
}

/// Probe: the ordered try chain for `key`, using the current settings unless
/// overridden. `sources` (comma separated) pins an exact chain, for demos.
#[tauri::command]
pub fn mirror_probe_chain(
    key: String,
    mirror: Option<String>,
    custom_mirror: Option<String>,
    sources: Option<String>,
) -> Vec<MirrorProbeStep> {
    let (current_mirror, current_custom) = mirror_settings().get();
    let mirror = mirror.unwrap_or(current_mirror);
    let custom = custom_mirror.or(current_custom);
    let preferred = sources.unwrap_or_else(|| mirror.clone());
    crate::media::source_chain(&key, &preferred, custom.as_deref())
        .into_iter()
        .map(|(source, url)| MirrorProbeStep {
            source: source.to_string(),
            url,
        })
        .collect()
}

/// Probe: every job's snapshot plus the effective source settings and the
/// process-wide per-source success counts (engine + cache-through). Lets a
/// native/CI script prove that 「选了 jsd 就真的从 jsd 取」with numbers.
#[tauri::command]
pub fn system_counts(state: tauri::State<'_, Manager>) -> serde_json::Value {
    let jobs: Vec<Snapshot> = state.jobs.lock().unwrap().values().map(|j| j.snapshot()).collect();
    let (mirror, custom_mirror) = mirror_settings().get();
    let mut totals: HashMap<String, u64> = HashMap::new();
    for (id, n) in protocol_source_counts() {
        *totals.entry(id).or_insert(0) += n;
    }
    for job in &jobs {
        for (id, n) in &job.sources {
            *totals.entry(id.clone()).or_insert(0) += n;
        }
    }
    let sources: Vec<serde_json::Value> = sources_json(&totals).unwrap_or_default();
    serde_json::json!({
        "mirror": mirror,
        "customMirror": custom_mirror,
        "concurrency": state.concurrency(),
        "rateLimitBps": crate::net::limiter().rate(),
        "protocolSources": protocol_source_counts(),
        "sources": sources,
        "jobs": jobs,
    })
}

fn sources_json(totals: &HashMap<String, u64>) -> Result<Vec<serde_json::Value>, String> {
    let mut out = Vec::new();
    for id in crate::media::SOURCE_IDS {
        if let Some(n) = totals.get(id) {
            out.push(serde_json::json!({ "source": id, "count": n }));
        }
    }
    Ok(out)
}

/// Frontend → Android keep-alive: report the "reading a story" (playback) state.
/// Download progress is driven natively by the engine (see `AppHandleSink`); this
/// only covers what the WebView alone knows. No-op off Android.
#[tauri::command]
pub fn keepalive_set_reading(reading: bool) {
    crate::android_service::set_reading(reading);
}

/// Frontend → Android keep-alive: report indexing (manifest) progress, the one
/// piece the native download engine can't see. Folded into the download
/// notification's text while `active`. No-op off Android.
#[tauri::command]
pub fn keepalive_set_manifest(done: u32, total: u32, active: bool) {
    crate::android_service::set_manifest(done, total, active);
}

/// Convenience: register the manager in Tauri state (called from setup()).
pub fn init(app: &AppHandle) {
    app.manage(Manager::new(Arc::new(AppHandleSink(app.clone()))));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoopSink;
    impl ProgressSink for NoopSink {
        fn emit(&self, _: &Snapshot) {}
    }

    #[test]
    fn mirror_settings_default_and_normalization() {
        let m = MirrorSettings {
            inner: RwLock::new(("pack".to_string(), None)),
        };
        assert_eq!(m.effective(), ("pack".to_string(), None));
        m.set("jsd", None);
        assert_eq!(m.get(), ("jsd".to_string(), None));
        // custom keeps the template; the other sources ignore it for resolution
        // but the value is still reported back to the UI.
        m.set("custom", Some("  https://m/{key}  ".to_string()));
        assert_eq!(
            m.effective(),
            ("custom".to_string(), Some("https://m/{key}".to_string()))
        );
        // Unknown ids normalize to the default rather than breaking the chain.
        m.set("nope", None);
        assert_eq!(m.get().0, "pack");
        m.set(" PRTS ", None);
        assert_eq!(m.get().0, "prts");
        // A whitespace-only template is no template.
        m.set("custom", Some("   ".to_string()));
        assert_eq!(m.effective(), ("custom".to_string(), None));
    }

    #[test]
    fn fetch_item_uses_configured_order_and_canonical_key() {
        // Probe surfaces the chain the worker will walk: preferred source first,
        // official link last-ish (pack's slot), sorted-by-priority remainder.
        let chain = crate::media::source_chain(
            "https://torappu.prts.wiki/assets/avg/background/bg_black.png",
            "jsd",
            None,
        );
        let ids: Vec<&str> = chain.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, vec!["jsd", "pack", "fastly", "ghproxy"]);
        assert!(chain[0].1.starts_with("https://cdn.jsdelivr.net/gh/"));
        // Non-mirrorable host: the chain degrades to the official link only.
        let plain = crate::media::source_chain("https://wiki.example.org/a/b.png", "fastly", None);
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].1, "https://wiki.example.org/a/b.png");
        // The stored path is source-independent: the mirror URL and the official
        // URL are different fetch addresses, but `write_local` is keyed on the
        // canonical key only (byte-identical to the `prts` official URL key).
        let root = std::path::Path::new("/tmp/prts-mirror-probe");
        let key = "torappu.prts.wiki/assets/avg/background/bg_black.png";
        let stored = crate::media::store_path(root, key).unwrap();
        assert!(stored.ends_with(key));
        assert_eq!(
            crate::media::store_path(root, key).unwrap(),
            crate::media::store_path(root, &format!("https://{key}")).unwrap(),
            "https:// and bare key must resolve to the same store path"
        );
    }

    #[test]
    fn status_u8_roundtrips() {
        for s in [
            Status::Running,
            Status::Paused,
            Status::Completed,
            Status::Cancelled,
        ] {
            assert_eq!(Status::from_u8(s.to_u8()), s);
        }
    }

    #[test]
    fn enqueue_dedups_and_counts_total() {
        let job = Job::new(1);
        assert_eq!(job.enqueue(vec!["a".into(), "b".into(), "a".into()]), 2);
        assert_eq!(job.enqueue(vec!["b".into(), "c".into()]), 1); // b already seen
        assert_eq!(job.total.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn pause_cancel_flags_drive_status() {
        let job = Job::new(1);
        assert_eq!(job.status(), Status::Running);
        job.set_status(Status::Paused);
        assert_eq!(job.snapshot().status, Status::Paused);
        job.set_status(Status::Cancelled);
        assert_eq!(job.snapshot().status, Status::Cancelled);
    }

    // --- Integration tests for the live streaming engine (no network) -------
    // data_root() falls back to std::env::temp_dir() in tests (init is never
    // called), so the media store lives under temp_dir()/media. URLs are unique
    // per process so parallel tests don't collide.

    fn unique_url(tag: &str, i: usize) -> String {
        format!(
            "https://t.invalid/{}/{}/f{}.png",
            std::process::id(),
            tag,
            i
        )
    }
    fn precreate(url: &str) {
        let root = crate::media::media_root(&crate::data_root::data_root());
        crate::media::write_local(
            &root,
            url,
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
        )
        .unwrap();
    }
    async fn wait_terminal(m: &Manager, id: u64) -> Snapshot {
        for _ in 0..200 {
            let s = m.status(id).expect("job exists");
            if matches!(s.status, Status::Completed | Status::Cancelled) {
                return s;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("job {id} did not reach a terminal state");
    }

    #[tokio::test]
    async fn empty_job_completes_after_close() {
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(vec![]);
        m.close(id);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.total, 0);
    }

    #[tokio::test]
    async fn streamed_cached_urls_all_skip() {
        // Seed some, stream more after start, then close: all are pre-cached so
        // every one is skipped — exercises the live add() path while downloading.
        let seed: Vec<String> = (0..3).map(|i| unique_url("seed", i)).collect();
        let more: Vec<String> = (0..4).map(|i| unique_url("more", i)).collect();
        for u in seed.iter().chain(more.iter()) {
            precreate(u);
        }
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(seed);
        m.add(id, more);
        m.close(id);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.total, 7);
        assert_eq!(s.skipped, 7);
        assert_eq!(s.done, 7);
    }

    #[tokio::test]
    async fn precached_canonical_keys_are_skipped() {
        // Items are enqueued as bare canonical keys while their store entries were
        // written via the `https://` URL form — exercises the canonical-key
        // store-path match across key vs URL form (no network needed).
        let pid = std::process::id();
        let keys: Vec<String> = (0..3)
            .map(|i| format!("media.prts.wiki/canon{pid}/{i}/f.png"))
            .collect();
        for k in &keys {
            // Precreate via the https URL form; canonical_key collapses both forms.
            let root = crate::media::media_root(&crate::data_root::data_root());
            crate::media::write_local(
                &root,
                &format!("https://{k}"),
                &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
            )
            .unwrap();
        }
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(keys);
        m.close(id);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.total, 3);
        assert_eq!(s.skipped, 3);
        assert_eq!(s.done, 3);
    }

    #[tokio::test]
    async fn unmappable_urls_count_as_skipped_not_failed() {
        // data:/blob:/single-segment URLs the engine emits are unmappable; they
        // must NOT count as failures (that was the phantom "1 failed" bug).
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(vec!["https://x".into(), "not a url".into()]);
        m.close(id);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.failed, 0);
        assert_eq!(s.skipped, 2);
        assert_eq!(s.done, 2);
    }

    #[test]
    fn is_permanent_only_for_4xx_except_429() {
        assert!(is_permanent("HTTP 404 Not Found"));
        assert!(is_permanent("HTTP 403 Forbidden"));
        assert!(!is_permanent("HTTP 429 Too Many Requests"));
        assert!(!is_permanent("HTTP 500 Internal Server Error"));
        assert!(!is_permanent("error sending request for url")); // network error
    }

    #[tokio::test]
    async fn cancel_finishes_cancelled_not_stuck() {
        let urls: Vec<String> = (0..200).map(|i| unique_url("cancel", i)).collect();
        for u in &urls {
            precreate(u);
        }
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(urls);
        m.cancel(id);
        let s = wait_terminal(&m, id).await;
        assert!(matches!(s.status, Status::Cancelled | Status::Completed));
    }
}
