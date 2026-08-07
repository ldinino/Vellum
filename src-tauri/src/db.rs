//! Per-notebook SQLite: creation and versioned migrations.
//!
//! The backend owns all notebook DB access — creation/migrations here, and
//! sections/pages/content CRUD via sqlx in `notebook.rs`, exposed to the
//! renderer as Tauri commands. (We do not use tauri-plugin-sql from the
//! frontend: its connection pool makes cross-call transactions unsafe and
//! leaves `foreign_keys` off per connection, which would break our
//! `ON DELETE CASCADE` deletes.) Schema version is tracked with
//! `PRAGMA user_version`.
//!
//! All access goes through a single-connection `SqlitePool` rather than a bare
//! `SqliteConnection`: executing on `&mut SqliteConnection` trips rustc's
//! higher-ranked lifetime bug (rust-lang/rust#89976) inside tauri's command
//! futures, while `&Pool` does not. Single connection also means
//! `foreign_keys` and transactions are deterministic.

use sqlx::sqlite::{SqlitePoolOptions, SqliteConnectOptions, SqliteJournalMode};
use sqlx::{Pool, Sqlite};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Ordered migrations. Index + 1 == resulting `user_version`.
/// Never edit an entry that has shipped — append a new one.
const MIGRATIONS: &[&str] = &[
    // 1: initial schema (spec Section 4)
    r#"
    CREATE TABLE sections (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        color            TEXT,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        page_template_id TEXT,
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE pages (
        id         TEXT PRIMARY KEY,
        section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        title      TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_pages_section ON pages(section_id, sort_order);

    CREATE TABLE page_content (
        page_id      TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
        content_json TEXT NOT NULL,
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Operation log for crash recovery (spec Section 13). Replayed over the
    -- last page_content snapshot on open, then cleared.
    CREATE TABLE page_ops (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        op_json    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_page_ops_page ON page_ops(page_id, id);

    CREATE TABLE attachments (
        id         TEXT PRIMARY KEY,
        page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        filename   TEXT NOT NULL,
        path       TEXT NOT NULL,
        mime_type  TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_attachments_page ON attachments(page_id);

    -- Search index: title + flattened content text + attachment filenames.
    -- page_id is stored but not tokenized.
    CREATE VIRTUAL TABLE fts_index USING fts5(
        page_id UNINDEXED,
        title,
        content,
        attachment_names
    );
    "#,
    // 2: denormalized page preview (first line of content) for the page list.
    r#"
    ALTER TABLE pages ADD COLUMN preview TEXT NOT NULL DEFAULT '';
    "#,
    // 3: attachment byte size, for the attachment-bar display (spec Section 12).
    r#"
    ALTER TABLE attachments ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
    "#,
    // 4: per-section page sort preference (spec Section 5 / Phase 9). 'custom' is
    //    the user's drag-reorder order; 'created'/'modified' sort by timestamp.
    //    Direction is 'asc'/'desc' (ignored for 'custom').
    r#"
    ALTER TABLE sections ADD COLUMN page_sort_mode TEXT NOT NULL DEFAULT 'custom';
    ALTER TABLE sections ADD COLUMN page_sort_dir  TEXT NOT NULL DEFAULT 'asc';
    "#,
    // 5: soft-delete / Recycle Bin (spec Section 5.1). NULL = live; an RFC3339
    //    timestamp = in the recycle bin. Only the directly-deleted row is
    //    stamped — descendants are filtered transitively (a page is live iff it
    //    AND its section have deleted_at NULL), so restoring is a single clear
    //    and a child deleted before its parent keeps its own stamp.
    r#"
    ALTER TABLE sections    ADD COLUMN deleted_at TEXT;
    ALTER TABLE pages       ADD COLUMN deleted_at TEXT;
    ALTER TABLE attachments ADD COLUMN deleted_at TEXT;
    "#,
    // 6: scoped proofreading (execution-plan #5). 0 = proofread normally;
    //    1 = proofreading (spell + grammar) suppressed for this section/page.
    //    Suppress-only: the effective state for the open page is
    //    `global AND NOT notebookSuppressed AND NOT sectionSuppressed AND NOT
    //    pageSuppressed` (the per-notebook flag lives in notebooks.json, not
    //    here). Default 0 so existing notebooks keep proofreading everywhere.
    r#"
    ALTER TABLE sections ADD COLUMN proofing_suppressed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE pages    ADD COLUMN proofing_suppressed INTEGER NOT NULL DEFAULT 0;
    "#,
    // 7: independent per-scope grammar/spell prefs (execution-plan #5, revised
    //    on feedback). Replaces migration 6's single combined suppress flag with
    //    a tri-state PER CATEGORY: NULL = inherit, 0 = off, 1 = on. Effective for
    //    the open page is most-specific-wins (page ▸ section ▸ notebook, default
    //    on) under the global master toggle. Migration 6 is left untouched (a dev
    //    DB may already sit at user_version 6), so `proofing_suppressed` stays as
    //    a now-unused column; its "suppressed" rows carry over as both off.
    r#"
    ALTER TABLE sections ADD COLUMN grammar_pref INTEGER;
    ALTER TABLE sections ADD COLUMN spell_pref   INTEGER;
    ALTER TABLE pages    ADD COLUMN grammar_pref INTEGER;
    ALTER TABLE pages    ADD COLUMN spell_pref   INTEGER;
    UPDATE sections SET grammar_pref = 0, spell_pref = 0 WHERE proofing_suppressed = 1;
    UPDATE pages    SET grammar_pref = 0, spell_pref = 0 WHERE proofing_suppressed = 1;
    "#,
];

/// Open a single-connection pool to a notebook DB with foreign keys on and
/// WAL set. Single connection means `pool.begin()` transactions and
/// `ON DELETE CASCADE` behave predictably (the cascade needs `foreign_keys`,
/// which is per-connection in SQLite).
pub(crate) async fn open_pool(db_path: &Path, create: bool) -> Result<Pool<Sqlite>, String> {
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(create)
        // WAL is persistent — every later connection (including the
        // frontend's via tauri-plugin-sql) inherits it from the file.
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| format!("open {}: {e}", db_path.display()))
}

/// Cache of open notebook pools, keyed by database path (managed Tauri state).
///
/// Opening a SQLite connection is *not* free: the old "open a pool per command"
/// approach cost ~5 ms of setup per call (schema check + two connections) versus
/// ~0.2 ms for the query itself, on every section click, page load, and
/// auto-save. That overhead is much worse on ARM64/virtualized filesystems and
/// on the OneDrive-synced data folder, where each file open goes through a sync
/// filter driver. Pools are cheap to clone (`Pool` is an `Arc` internally) and a
/// cached pool keeps the same single-connection semantics the rest of the code
/// relies on (`foreign_keys` on, deterministic transactions).
///
/// IMPORTANT: an open pool holds a file handle, and Windows refuses to delete or
/// rename a file that is still open. Any code that removes a notebook folder or
/// moves the data root MUST call [`PoolCache::evict`] / [`PoolCache::clear`]
/// first, or the delete/move will fail.
///
/// IMPORTANT: callers must **not** call `close()` on a pool from this cache — it
/// is shared, and closing it breaks every later command with "attempted to
/// acquire a connection on a closed pool". `get_or_open` defends against that by
/// discarding a closed pool and reopening, so a stray close costs performance
/// rather than breaking the app.
#[derive(Default)]
pub struct PoolCache {
    pools: Mutex<HashMap<PathBuf, Pool<Sqlite>>>,
}

impl PoolCache {
    /// The cached pool for `db_path`, if one is present and still usable. A pool
    /// someone closed is dropped from the cache so the caller reopens it.
    fn get(&self, db_path: &Path) -> Option<Pool<Sqlite>> {
        let mut map = self.pools.lock().ok()?;
        match map.get(db_path) {
            Some(pool) if !pool.is_closed() => Some(pool.clone()),
            Some(_) => {
                map.remove(db_path);
                None
            }
            None => None,
        }
    }

    /// The cached pool for `db_path`, opening (and migrating) it on first use.
    pub async fn get_or_open(&self, db_path: &Path) -> Result<Pool<Sqlite>, String> {
        if let Some(pool) = self.get(db_path) {
            return Ok(pool);
        }
        // Migrate only on the first open of this database in the process: the
        // schema can't change underneath us afterwards, so later calls skip it.
        create_or_migrate(db_path).await?;
        let pool = open_pool(db_path, false).await?;
        // Another task may have opened the same DB while we awaited; keep
        // whichever landed first so there is never more than one live pool per
        // file, and close ours.
        let existing = {
            match self.pools.lock() {
                Ok(mut map) => match map.get(db_path) {
                    Some(p) if !p.is_closed() => Some(p.clone()),
                    _ => {
                        map.insert(db_path.to_path_buf(), pool.clone());
                        None
                    }
                },
                Err(_) => None,
            }
        };
        match existing {
            Some(winner) => {
                pool.close().await;
                Ok(winner)
            }
            None => Ok(pool),
        }
    }

    /// Close and forget the pool for one database (call before deleting it).
    pub async fn evict(&self, db_path: &Path) {
        let pool = self
            .pools
            .lock()
            .ok()
            .and_then(|mut map| map.remove(db_path));
        if let Some(pool) = pool {
            pool.close().await;
        }
    }

    /// Close and forget every pool. Sync must do this before transferring a
    /// Satchel: an open pool keeps the WAL alive, so a checkpoint can't fully
    /// fold it back into the database file and the copy would be torn.
    pub async fn clear(&self) {
        let pools: Vec<Pool<Sqlite>> = match self.pools.lock() {
            Ok(mut map) => map.drain().map(|(_, p)| p).collect(),
            Err(_) => Vec::new(),
        };
        for pool in pools {
            pool.close().await;
        }
    }
}

/// Open (creating if missing) a notebook DB, switch it to WAL, and bring the
/// schema up to date. Returns the final schema version.
pub async fn create_or_migrate(db_path: &Path) -> Result<i64, String> {
    let pool = open_pool(db_path, true).await?;

    let mut version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("read user_version: {e}"))?;

    while (version as usize) < MIGRATIONS.len() {
        let next = version + 1;
        // One transaction per migration. PRAGMA user_version lives in the DB
        // header and is journaled, so it commits or rolls back with the batch.
        let sql = format!(
            "BEGIN;\n{}\nPRAGMA user_version = {next};\nCOMMIT;",
            MIGRATIONS[version as usize]
        );
        sqlx::raw_sql(&sql)
            .execute(&pool)
            .await
            .map_err(|e| format!("apply migration {next}: {e}"))?;
        version = next;
    }

    pool.close().await;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn creates_schema_wal_and_fts5() {
        let dir = std::env::temp_dir().join(format!("vellum-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("notebook.db");

        let version = create_or_migrate(&db_path).await.unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());

        // Idempotent on reopen.
        assert_eq!(create_or_migrate(&db_path).await.unwrap(), version);
        assert!(integrity_check(&db_path).await.unwrap());

        let pool = open_pool(&db_path, false).await.unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");

        // FTS5 must be compiled in and the virtual table usable.
        sqlx::query("INSERT INTO fts_index (page_id, title, content, attachment_names) VALUES ('p1', 'Sprint planning', 'carry-over items', '')")
            .execute(&pool)
            .await
            .unwrap();
        let hits: i64 =
            sqlx::query_scalar("SELECT count(*) FROM fts_index WHERE fts_index MATCH 'sprint'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(hits, 1);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The pool cache must reuse one pool per database, keep the
    /// single-connection semantics the CRUD code relies on, and — critically —
    /// release the file handle on `evict`. Windows refuses to delete a file that
    /// is still open, so purging a notebook (or moving the data root) breaks
    /// unless the cached pool is closed first.
    #[tokio::test]
    async fn pool_cache_reuses_and_releases_the_database() {
        let dir = std::env::temp_dir().join(format!("vellum-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("notebook.db");

        let cache = PoolCache::default();
        // First call migrates a brand-new DB; later calls reuse the same pool.
        let a = cache.get_or_open(&db_path).await.unwrap();
        let b = cache.get_or_open(&db_path).await.unwrap();
        assert!(!a.is_closed() && !b.is_closed());

        // foreign_keys is per-connection and ON DELETE CASCADE depends on it.
        let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&a)
            .await
            .unwrap();
        assert_eq!(fk, 1, "cached pool must keep foreign_keys on");

        // A write through one handle is visible through the other.
        sqlx::query("INSERT INTO sections (id, name, sort_order) VALUES ('s1','Sec',0)")
            .execute(&a)
            .await
            .unwrap();
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM sections")
            .fetch_one(&b)
            .await
            .unwrap();
        assert_eq!(n, 1);

        cache.evict(&db_path).await;
        assert!(a.is_closed(), "evict must close the pool");
        // The whole point: the folder is now deletable.
        std::fs::remove_dir_all(&dir).expect("notebook folder must be removable after evict");
    }

    /// A caller that wrongly closes a shared pool must not poison the cache for
    /// every later command ("attempted to acquire a connection on a closed
    /// pool"). The cache notices and reopens instead.
    #[tokio::test]
    async fn pool_cache_recovers_from_a_closed_pool() {
        let dir = std::env::temp_dir().join(format!("vellum-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("notebook.db");

        let cache = PoolCache::default();
        let first = cache.get_or_open(&db_path).await.unwrap();
        first.close().await; // simulate a stray close somewhere in the codebase

        let second = cache.get_or_open(&db_path).await.unwrap();
        assert!(!second.is_closed(), "cache must hand back a usable pool");
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM sections")
            .fetch_one(&second)
            .await
            .expect("queries must work again after a stray close");
        assert_eq!(n, 0);

        cache.evict(&db_path).await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Quick integrity check, surfaced on notebook open (spec Phase 11).
pub async fn integrity_check(db_path: &Path) -> Result<bool, String> {
    let pool = open_pool(db_path, false).await?;
    let result: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("integrity_check: {e}"))?;
    pool.close().await;
    Ok(result == "ok")
}
