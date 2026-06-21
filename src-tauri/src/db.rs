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
use std::path::Path;

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
