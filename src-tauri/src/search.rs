//! Full-text search (spec Section 11).
//!
//! Two FTS5 indexes are kept in sync on every page save:
//!   * a per-notebook `fts_index` (created in `db.rs`) — the durable, authoritative
//!     index for one notebook, rebuilt from its own rows;
//!   * a master `search-index.db` in the Vellum root that mirrors every notebook's
//!     pages with breadcrumb + filter metadata inline.
//!
//! Queries run against the master index (global, or scoped by `notebookIds`);
//! the per-notebook index is the source the master is derived from and self-heals
//! it on `reindex_all`. This keeps a single, well-tested query path while still
//! satisfying the per-notebook indexing requirement — see the Section 11 design
//! note in docs/Vellum_spec.md.

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Pool, QueryBuilder, Row, Sqlite};
use std::path::Path;

use crate::notebook::PageIndexData;

/// Marker chars wrapping a matched run inside a snippet. The renderer splits on
/// these to highlight — control chars can't appear in note text, and emitting
/// them (rather than `<mark>`) keeps the snippet free of injectable HTML.
pub const HL_OPEN: char = '\u{1}';
pub const HL_CLOSE: char = '\u{2}';

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchFilters {
    /// Restrict to these notebooks (the scope dropdown / multi-select). Empty or
    /// absent means all notebooks.
    pub notebook_ids: Option<Vec<String>>,
    pub section_id: Option<String>,
    /// Which timestamp the date range applies to: "created" or "modified".
    pub date_field: Option<String>,
    /// RFC3339 bounds (inclusive); ISO-8601 sorts lexicographically.
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    /// When `Some(true)`, only pages that have at least one attachment.
    pub has_attachment: Option<bool>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub page_id: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub section_id: String,
    pub section_name: String,
    pub title: String,
    /// Content excerpt with matched runs wrapped in HL_OPEN/HL_CLOSE.
    pub snippet: String,
    pub created_at: String,
    pub updated_at: String,
    pub has_attachment: bool,
}

/// Flatten a Tiptap document JSON into searchable plain text: every `text` node
/// concatenated with spaces between block boundaries. Robust to unknown nodes.
pub fn flatten_text(content_json: &str) -> String {
    let mut out = String::new();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(content_json) {
        collect_text(&value, &mut out);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collect_text(node: &serde_json::Value, out: &mut String) {
    if let Some(t) = node.get("text").and_then(|t| t.as_str()) {
        out.push_str(t);
        out.push(' ');
    }
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            collect_text(child, out);
        }
        out.push(' ');
    }
}

/// Turn raw user input into a safe FTS5 MATCH expression: each whitespace token
/// becomes a quoted prefix term, AND-ed together. Returns None for empty input.
pub fn fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        // Drop the FTS phrase delimiter so our own quoting can't be broken out of.
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

// ---------------------------------------------------------------------------
// Master index DB
// ---------------------------------------------------------------------------

/// Open (creating if asked) the master cross-notebook index and ensure its
/// schema. Single-connection pool, WAL — same rationale as `db::open_pool`.
pub async fn open_master(db_path: &Path, create: bool) -> Result<Pool<Sqlite>, String> {
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(create)
        .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| format!("open master index {}: {e}", db_path.display()))?;

    // One FTS5 table holds the searchable text plus UNINDEXED breadcrumb/filter
    // columns, so a global query needs no joins.
    sqlx::query(
        "CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(\
            page_id UNINDEXED,\
            notebook_id UNINDEXED,\
            notebook_name UNINDEXED,\
            section_id UNINDEXED,\
            section_name UNINDEXED,\
            title,\
            content,\
            attachment_names,\
            created_at UNINDEXED,\
            updated_at UNINDEXED,\
            has_attachment UNINDEXED\
        )",
    )
    .execute(&pool)
    .await
    .map_err(|e| format!("create master schema: {e}"))?;

    Ok(pool)
}

/// Replace a page's master-index row (delete-then-insert; FTS5 has no upsert).
pub async fn upsert_master(
    pool: &Pool<Sqlite>,
    notebook_id: &str,
    notebook_name: &str,
    data: &PageIndexData,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin master upsert: {e}"))?;
    sqlx::query("DELETE FROM search_index WHERE page_id = ?1")
        .bind(&data.page_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("master delete: {e}"))?;
    sqlx::query(
        "INSERT INTO search_index (page_id, notebook_id, notebook_name, section_id, \
         section_name, title, content, attachment_names, created_at, updated_at, has_attachment) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(&data.page_id)
    .bind(notebook_id)
    .bind(notebook_name)
    .bind(&data.section_id)
    .bind(&data.section_name)
    .bind(&data.title)
    .bind(&data.content_text)
    .bind(&data.attachment_names)
    .bind(&data.created_at)
    .bind(&data.updated_at)
    .bind(if data.has_attachment { "1" } else { "0" })
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("master insert: {e}"))?;
    tx.commit().await.map_err(|e| format!("commit master upsert: {e}"))
}

pub async fn remove_page(pool: &Pool<Sqlite>, page_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM search_index WHERE page_id = ?1")
        .bind(page_id)
        .execute(pool)
        .await
        .map_err(|e| format!("master remove page: {e}"))?;
    Ok(())
}

pub async fn remove_notebook(pool: &Pool<Sqlite>, notebook_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM search_index WHERE notebook_id = ?1")
        .bind(notebook_id)
        .execute(pool)
        .await
        .map_err(|e| format!("master remove notebook: {e}"))?;
    Ok(())
}

/// Drop master rows for any notebook id not in `keep` (cleans up notebooks
/// deleted while the app was closed).
pub async fn prune_notebooks(pool: &Pool<Sqlite>, keep: &[String]) -> Result<(), String> {
    if keep.is_empty() {
        sqlx::query("DELETE FROM search_index")
            .execute(pool)
            .await
            .map_err(|e| format!("master prune all: {e}"))?;
        return Ok(());
    }
    let mut qb: QueryBuilder<Sqlite> =
        QueryBuilder::new("DELETE FROM search_index WHERE notebook_id NOT IN (");
    let mut sep = qb.separated(", ");
    for id in keep {
        sep.push_bind(id);
    }
    qb.push(")");
    qb.build()
        .execute(pool)
        .await
        .map_err(|e| format!("master prune: {e}"))?;
    Ok(())
}

/// Run a search against the master index. Empty query → no results.
pub async fn search(
    pool: &Pool<Sqlite>,
    raw_query: &str,
    filters: &SearchFilters,
) -> Result<Vec<SearchHit>, String> {
    let Some(match_q) = fts_query(raw_query) else {
        return Ok(Vec::new());
    };

    // Column 6 is `content`; wrap matched runs in the highlight markers.
    let select = format!(
        "SELECT page_id, notebook_id, notebook_name, section_id, section_name, title, \
         snippet(search_index, 6, char({}), char({}), '…', 12) AS snippet, \
         created_at, updated_at, has_attachment \
         FROM search_index WHERE search_index MATCH ",
        HL_OPEN as u32,
        HL_CLOSE as u32,
    );
    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(select);
    qb.push_bind(match_q);

    if let Some(ids) = &filters.notebook_ids {
        if !ids.is_empty() {
            qb.push(" AND notebook_id IN (");
            let mut sep = qb.separated(", ");
            for id in ids {
                sep.push_bind(id);
            }
            qb.push(")");
        }
    }
    if let Some(sid) = &filters.section_id {
        qb.push(" AND section_id = ").push_bind(sid);
    }
    // `col` is a fixed literal chosen here, never user input.
    let col = match filters.date_field.as_deref() {
        Some("created") => Some("created_at"),
        Some("modified") => Some("updated_at"),
        _ => None,
    };
    if let Some(col) = col {
        if let Some(from) = &filters.date_from {
            qb.push(format!(" AND {col} >= ")).push_bind(from);
        }
        if let Some(to) = &filters.date_to {
            qb.push(format!(" AND {col} <= ")).push_bind(to);
        }
    }
    if filters.has_attachment == Some(true) {
        qb.push(" AND has_attachment = '1'");
    }
    qb.push(" ORDER BY rank LIMIT 200");

    let rows = qb
        .build()
        .fetch_all(pool)
        .await
        .map_err(|e| format!("search query: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| SearchHit {
            page_id: r.get("page_id"),
            notebook_id: r.get("notebook_id"),
            notebook_name: r.get("notebook_name"),
            section_id: r.get("section_id"),
            section_name: r.get("section_name"),
            title: r.get("title"),
            snippet: r.get("snippet"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            has_attachment: r.get::<String, _>("has_attachment") == "1",
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_tiptap_doc() {
        let doc = r#"{"type":"doc","content":[
            {"type":"heading","content":[{"type":"text","text":"Sprint planning"}]},
            {"type":"paragraph","content":[{"type":"text","text":"carry-over items"},{"type":"text","text":" and risks"}]}
        ]}"#;
        assert_eq!(flatten_text(doc), "Sprint planning carry-over items and risks");
    }

    #[test]
    fn builds_safe_prefix_query() {
        assert_eq!(fts_query("  meeting   notes "), Some("\"meeting\"* \"notes\"*".into()));
        // Quotes are stripped so the expression can't be broken out of.
        assert_eq!(fts_query("foo\"bar"), Some("\"foobar\"*".into()));
        assert_eq!(fts_query("   "), None);
    }

    async fn master() -> (Pool<Sqlite>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("vellum-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("search-index.db");
        (open_master(&path, true).await.unwrap(), dir)
    }

    fn data(page_id: &str, title: &str, content: &str, has_attachment: bool) -> PageIndexData {
        PageIndexData {
            page_id: page_id.into(),
            section_id: "sec1".into(),
            section_name: "Meeting Notes".into(),
            title: title.into(),
            content_text: content.into(),
            attachment_names: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-06-01T00:00:00Z".into(),
            has_attachment,
        }
    }

    #[tokio::test]
    async fn index_search_filter_and_remove() {
        let (pool, dir) = master().await;

        upsert_master(&pool, "nb1", "Work", &data("p1", "Sprint planning", "carry-over items and risks", false))
            .await
            .unwrap();
        upsert_master(&pool, "nb2", "Home", &data("p2", "Groceries", "milk and bread", true))
            .await
            .unwrap();

        // Global match.
        let hits = search(&pool, "sprint", &SearchFilters::default()).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].page_id, "p1");
        assert_eq!(hits[0].notebook_name, "Work");
        // A content match wraps the run in the highlight markers.
        let content_hit = search(&pool, "carry", &SearchFilters::default()).await.unwrap();
        assert!(content_hit[0].snippet.contains(HL_OPEN));
        assert!(content_hit[0].snippet.contains(HL_CLOSE));

        // Prefix matching: "car" finds "carry-over".
        assert_eq!(search(&pool, "car", &SearchFilters::default()).await.unwrap().len(), 1);

        // Scope filter to nb2 excludes the nb1 hit.
        let scoped = search(
            &pool,
            "i",
            &SearchFilters { notebook_ids: Some(vec!["nb2".into()]), ..Default::default() },
        )
        .await
        .unwrap();
        assert!(scoped.iter().all(|h| h.notebook_id == "nb2"));

        // Has-attachment filter.
        let with_attach = search(
            &pool,
            "and",
            &SearchFilters { has_attachment: Some(true), ..Default::default() },
        )
        .await
        .unwrap();
        assert_eq!(with_attach.len(), 1);
        assert_eq!(with_attach[0].page_id, "p2");

        // Re-upsert replaces, not duplicates.
        upsert_master(&pool, "nb1", "Work", &data("p1", "Sprint planning", "now mentions kittens", false))
            .await
            .unwrap();
        assert_eq!(search(&pool, "kittens", &SearchFilters::default()).await.unwrap().len(), 1);
        assert_eq!(search(&pool, "carry", &SearchFilters::default()).await.unwrap().len(), 0);

        // Remove + prune.
        remove_page(&pool, "p1").await.unwrap();
        assert_eq!(search(&pool, "kittens", &SearchFilters::default()).await.unwrap().len(), 0);
        prune_notebooks(&pool, &["nb-none".into()]).await.unwrap();
        assert_eq!(search(&pool, "milk", &SearchFilters::default()).await.unwrap().len(), 0);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
