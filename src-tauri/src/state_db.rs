//! 轻量键值存储（SQLite / `state.db`）——**本机"记忆"的唯一后端**。
//!
//! 为什么要它：工作台的排版、面板开关/浮动窗、播放器底栏、语言、书架已读……
//! 这些"下次打开还要在"的东西原来散落在 `localStorage`（WebView 的 session 存储，
//! 清缓存/换 WebView 就丢）。SQLite 放在 `<资源目录>/state.db`：
//! - **清「缓存」不会清它**（`cache/`+`media/`+`assets/` 是缓存，state.db 是用户状态）；
//! - 与"资源目录可搬"一致：换盘/换机带上 `state.db` 即带走全部记忆；
//! - 单文件、无服务、备份即拷贝。
//!
//! 形状（**有意极简**，便于以后换后端）：
//! ```sql
//! CREATE TABLE kv (
//!   scope TEXT NOT NULL,   -- "workspace" / "app-settings" / "player" / "library" / "i18n" / "ui" ...
//!   key   TEXT NOT NULL,   -- 该 scope 内的键（例："default" / "playerChrome"）
//!   value TEXT NOT NULL,   -- 字符串；结构化数据由调用方自行 JSON 序列化
//!   updated_at INTEGER NOT NULL,
//!   PRIMARY KEY (scope, key)
//! );
//! ```
//! 写入 `UPSERT`、读取按 `(scope,key)`；另有 `state_db_snapshot`（一次拿整个 scope，
//! 供前端 hydrate：**一次 IPC**，避免 30 次往返）。
//!
//! 兼容与降级：`localStorage` 仍是**读**的兜底（老用户首次升级时用
//! `state_db_import` 把旧值搬进来，见 `docs/dev/state-db.md`）；无 Tauri 的
//! 纯浏览器（dev）由前端 `stateStore` 自动落回 `localStorage`。
//! 数据库损坏 → 重命名成 `.corrupt-<ts>` 再建新库（**永不因状态库损坏而启动失败**）。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// 单条 KV。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEntry {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

fn db_path() -> PathBuf {
    crate::data_root::data_root().join("state.db")
}

/// 进程级连接（`rusqlite::Connection` 不是 `Sync`；用 `Mutex` 串行化）。
static DB: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();

fn cell() -> &'static Mutex<Option<Connection>> {
    DB.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn apply_pragmas(conn: &Connection) {
    // WAL：写状态不阻塞读；`busy_timeout` 防并发写撞锁；`synchronous=NORMAL`
    // 对"记忆"这类数据足够（极断电最多丢最后一次写，不损坏）。
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.busy_timeout(std::time::Duration::from_millis(3000));
}

fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (
            scope      TEXT    NOT NULL,
            key        TEXT    NOT NULL,
            value      TEXT    NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, key)
         );
         CREATE INDEX IF NOT EXISTS kv_scope ON kv (scope);",
    )
}

/// 打开（或重建）连接。`path` 已存在但打不开 → 备份成 `.corrupt-<ts>` 再建。
fn open_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建状态目录失败: {e}"))?;
    }
    let attempt = |p: &Path| -> rusqlite::Result<Connection> {
        let conn = Connection::open(p)?;
        apply_pragmas(&conn);
        create_schema(&conn)?;
        Ok(conn)
    };
    match attempt(path) {
        Ok(conn) => Ok(conn),
        Err(first) => {
            let backup = path.with_extension(format!("corrupt-{}", now_ms()));
            let _ = std::fs::rename(path, &backup);
            log::warn!(
                "[state] {} 打不开（{first}）→ 备份到 {} 并重建",
                path.display(),
                backup.display()
            );
            attempt(path).map_err(|e| format!("状态库重建失败: {e}"))
        }
    }
}

/// 拿连接（必要时打开）。**失败不返回 Err**：调用方按"无状态库"降级。
fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let mut guard = cell().lock().map_err(|e| format!("状态库锁失败: {e}"))?;
    if guard.is_none() {
        // 环境变量逃生口：`PRTS_DB=path`（原生测试/多 profile 用；空串 = 用默认）。
        let path = std::env::var("PRTS_DB")
            .ok()
            .filter(|p| !p.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(db_path);
        *guard = Some(open_at(&path)?);
    }
    f(guard.as_ref().expect("刚填过"))
}

/// 冒烟自检：库能打开、能建表、能读。`init` 失败**不阻断** `run()`（只 warn）。
pub fn report() -> Result<String, String> {
    let path = std::env::var("PRTS_DB")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(db_path);
    let n: i64 = with_conn(|conn| {
        conn.query_row("SELECT COUNT(*) FROM kv", [], |row| row.get(0))
            .map_err(|e| e.to_string())
    })?;
    Ok(format!("{} ({} 条)", path.display(), n))
}

// ── 命令 ───────────────────────────────────────────────────────────────

/// 读一个键；没有 → `None`。
#[tauri::command]
pub async fn state_db_get(scope: String, key: String) -> Result<Option<String>, String> {
    log::debug!("[state] get scope={scope} key={key}");
    with_conn(|conn| {
        conn.query_row(
            "SELECT value FROM kv WHERE scope = ?1 AND key = ?2",
            params![scope, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    })
}

/// 写一个键（UPSERT）。
#[tauri::command]
pub async fn state_db_set(scope: String, key: String, value: String) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute(
            "INSERT INTO kv (scope, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![scope, key, value, now_ms()],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
}

/// 删一个键。
#[tauri::command]
pub async fn state_db_del(scope: String, key: String) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute("DELETE FROM kv WHERE scope = ?1 AND key = ?2", params![scope, key])
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
}

/// 整个 scope 的快照（**一次 IPC** 完成 hydrate）。
#[tauri::command]
pub async fn state_db_snapshot(scope: String) -> Result<Vec<StateEntry>, String> {
    let rows = with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT key, value, updated_at FROM kv WHERE scope = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![scope], |row| {
                Ok(StateEntry {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
    })?;
    // 计数进日志（原生自检据此断言"这一启动确实从 state.db 读到了东西"）。
    log::debug!("[state] snapshot scope={scope} n={}", rows.len());
    Ok(rows)
}

/// 批量写（**一次 IPC 写多键**：`[(key, value)]`）。
#[tauri::command]
pub async fn state_db_set_many(scope: String, entries: Vec<(String, String)>) -> Result<usize, String> {
    log::debug!("[state] set_many scope={scope} n={}", entries.len());
    with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "INSERT INTO kv (scope, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            )
            .map_err(|e| e.to_string())?;
        let ts = now_ms();
        let mut n = 0usize;
        for (key, value) in entries {
            stmt.execute(params![scope, key, value, ts])
                .map_err(|e| e.to_string())?;
            n += 1;
        }
        Ok(n)
    })
}

/// `localStorage` → DB 的一次性迁移（**老用户升级**用；前端调一次即可）。
/// `entries` 里已存在的键**不覆盖**（DB 优先，避免回滚覆盖新值）。
#[tauri::command]
pub async fn state_db_import(scope: String, entries: Vec<(String, String)>) -> Result<usize, String> {
    with_conn(|conn| {
        let ts = now_ms();
        let mut n = 0usize;
        for (key, value) in entries {
            let changed = conn
                .execute(
                    "INSERT INTO kv (scope, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(scope, key) DO NOTHING",
                    params![scope, key, value, ts],
                )
                .map_err(|e| e.to_string())?;
            n += changed;
        }
        Ok(n)
    })
}

/// 诊断/自检：库路径 + 各 scope 的键数。
#[tauri::command]
pub async fn state_db_info() -> Result<serde_json::Value, String> {
    let path = std::env::var("PRTS_DB")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(db_path);
    let scopes: Vec<(String, i64)> = with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT scope, COUNT(*) FROM kv GROUP BY scope ORDER BY scope")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
    })?;
    Ok(serde_json::json!({
        "path": path.display().to_string(),
        "bytes": std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        "scopes": scopes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 直接对临时文件建库（绕开全局 OnceLock，测试可并行）。
    fn tmp_conn(tag: &str) -> (Connection, PathBuf) {
        let dir = std::env::temp_dir().join(format!("arkstage-state-test-{tag}-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        let conn = open_at(&path).unwrap();
        (conn, path)
    }

    fn put(conn: &Connection, scope: &str, key: &str, value: &str) {
        conn.execute(
            "INSERT INTO kv (scope, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
            params![scope, key, value, now_ms()],
        )
        .unwrap();
    }

    fn get(conn: &Connection, scope: &str, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM kv WHERE scope = ?1 AND key = ?2",
            params![scope, key],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn upsert_read_back_and_scope_isolation() {
        let (conn, path) = tmp_conn("kv");
        put(&conn, "workspace", "default", "(toolpanel|{placeholder/stage%62}%43)");
        put(&conn, "workspace", "default", "(toolpanel|{placeholder/stage%62}%30)"); // 覆盖
        assert_eq!(get(&conn, "workspace", "default").unwrap(), "(toolpanel|{placeholder/stage%62}%30)");
        assert!(get(&conn, "player", "default").is_none(), "scope 之间必须隔离");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn lives_outside_every_cache_root() {
        // 「清除所有缓存」= 删 `cache/` + `assets/` + `media/`（`commands::cache::all_cache_roots`）。
        // `state.db` 在**资源目录根**（不是这些子目录里）→ 清缓存不动"记忆"。
        let db = db_path();
        let roots = ["cache", "assets", "media"];
        assert_eq!(db.file_name().and_then(|n| n.to_str()), Some("state.db"));
        for sub in roots {
            assert!(
                !db.starts_with(crate::data_root::data_root().join(sub)),
                "state.db 不能落在 {sub}/ 里"
            );
        }
    }

    #[test]
    fn survives_corrupt_file_by_rebuilding() {
        let dir = std::env::temp_dir().join(format!("arkstage-state-test-corrupt-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        std::fs::write(&path, b"this is not a sqlite database at all").unwrap();
        let conn = open_at(&path).expect("损坏 → 重建后仍要能打开");
        put(&conn, "workspace", "default", "(a|b%40)");
        assert_eq!(get(&conn, "workspace", "default").unwrap(), "(a|b%40)");
        // 旧的坏文件被改名保留（可人工取证）。
        let kept = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).any(|e| {
            e.file_name().to_string_lossy().contains("corrupt")
        });
        assert!(kept, "损坏库应备份成 *.corrupt-<ts>");
        std::fs::remove_dir_all(&dir).ok();
    }
}
