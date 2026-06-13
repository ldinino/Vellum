//! Section and page data access for a single notebook DB.
//!
//! All functions take a `&Pool<Sqlite>` opened by `db::open_pool` (single
//! connection, foreign keys on). Deletes rely on `ON DELETE CASCADE`: removing
//! a section removes its pages, and removing a page removes its content, ops,
//! and attachment rows. `fts_index` is a virtual table with no foreign key, so
//! its rows are cleaned up explicitly where present (search lands in Phase 3;
//! today it is empty).

use serde::Serialize;
use sqlx::{Pool, Sqlite};

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub page_template_id: Option<String>,
}

pub async fn list_sections(pool: &Pool<Sqlite>) -> Result<Vec<Section>, String> {
    sqlx::query_as::<_, Section>(
        "SELECT id, name, color, sort_order, page_template_id \
         FROM sections ORDER BY sort_order, name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list sections: {e}"))
}

pub async fn create_section(pool: &Pool<Sqlite>, name: &str) -> Result<Section, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Section name cannot be empty".into());
    }
    let id = new_id();
    let sort_order = next_sort_order(pool, "SELECT MAX(sort_order) FROM sections").await?;
    sqlx::query("INSERT INTO sections (id, name, sort_order) VALUES (?1, ?2, ?3)")
        .bind(&id)
        .bind(name)
        .bind(sort_order)
        .execute(pool)
        .await
        .map_err(|e| format!("create section: {e}"))?;
    Ok(Section {
        id,
        name: name.to_string(),
        color: None,
        sort_order,
        page_template_id: None,
    })
}

pub async fn rename_section(pool: &Pool<Sqlite>, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Section name cannot be empty".into());
    }
    sqlx::query("UPDATE sections SET name = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(name)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("rename section: {e}"))?;
    Ok(())
}

/// Update the Section Properties modal fields in one call.
pub async fn update_section(
    pool: &Pool<Sqlite>,
    id: &str,
    name: &str,
    color: Option<String>,
    page_template_id: Option<String>,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Section name cannot be empty".into());
    }
    sqlx::query(
        "UPDATE sections SET name = ?1, color = ?2, page_template_id = ?3, updated_at = ?4 \
         WHERE id = ?5",
    )
    .bind(name)
    .bind(color)
    .bind(page_template_id)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("update section: {e}"))?;
    Ok(())
}

pub async fn delete_section(pool: &Pool<Sqlite>, id: &str) -> Result<(), String> {
    // Cascade removes the section's pages and their content/ops/attachments.
    sqlx::query("DELETE FROM sections WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("delete section: {e}"))?;
    Ok(())
}

pub async fn reorder_sections(pool: &Pool<Sqlite>, ordered_ids: &[String]) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin reorder: {e}"))?;
    for (order, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE sections SET sort_order = ?1 WHERE id = ?2")
            .bind(order as i64)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("reorder sections: {e}"))?;
    }
    tx.commit().await.map_err(|e| format!("commit reorder: {e}"))
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub section_id: String,
    pub title: String,
    pub sort_order: i64,
    pub updated_at: String,
    /// First line of content, denormalized for the page-list preview.
    pub preview: String,
}

pub async fn list_pages(pool: &Pool<Sqlite>, section_id: &str) -> Result<Vec<Page>, String> {
    sqlx::query_as::<_, Page>(
        "SELECT id, section_id, title, sort_order, updated_at, preview \
         FROM pages WHERE section_id = ?1 ORDER BY sort_order, created_at",
    )
    .bind(section_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list pages: {e}"))
}

pub async fn create_page(
    pool: &Pool<Sqlite>,
    section_id: &str,
    title: &str,
) -> Result<Page, String> {
    let id = new_id();
    let ts = now();
    let sort_order: i64 = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(sort_order) FROM pages WHERE section_id = ?1",
    )
    .bind(section_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("create page sort order: {e}"))?
    .map_or(0, |m| m + 1);
    sqlx::query(
        "INSERT INTO pages (id, section_id, title, sort_order, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    )
    .bind(&id)
    .bind(section_id)
    .bind(title)
    .bind(sort_order)
    .bind(&ts)
    .execute(pool)
    .await
    .map_err(|e| format!("create page: {e}"))?;
    Ok(Page {
        id,
        section_id: section_id.to_string(),
        title: title.to_string(),
        sort_order,
        updated_at: ts,
        preview: String::new(),
    })
}

pub async fn set_page_title(pool: &Pool<Sqlite>, id: &str, title: &str) -> Result<(), String> {
    sqlx::query("UPDATE pages SET title = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(title)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("set page title: {e}"))?;
    Ok(())
}

pub async fn delete_page(pool: &Pool<Sqlite>, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM pages WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("delete page: {e}"))?;
    Ok(())
}

/// Copy a page (title + content snapshot, if any) into the same section.
pub async fn duplicate_page(pool: &Pool<Sqlite>, id: &str) -> Result<Page, String> {
    let src: (String, String, String) =
        sqlx::query_as("SELECT section_id, title, preview FROM pages WHERE id = ?1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("read page for duplicate: {e}"))?
            .ok_or_else(|| format!("Unknown page id {id}"))?;
    let (section_id, title, preview) = src;

    let mut tx = pool.begin().await.map_err(|e| format!("begin duplicate: {e}"))?;
    let new = new_id();
    let ts = now();
    let sort_order: i64 = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(sort_order) FROM pages WHERE section_id = ?1",
    )
    .bind(&section_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("duplicate sort order: {e}"))?
    .map_or(0, |m| m + 1);

    sqlx::query(
        "INSERT INTO pages (id, section_id, title, sort_order, preview, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
    )
    .bind(&new)
    .bind(&section_id)
    .bind(format!("{title} (copy)"))
    .bind(sort_order)
    .bind(&preview)
    .bind(&ts)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("duplicate page row: {e}"))?;

    // Copy the content snapshot if the source has one.
    sqlx::query(
        "INSERT INTO page_content (page_id, content_json, updated_at) \
         SELECT ?1, content_json, ?2 FROM page_content WHERE page_id = ?3",
    )
    .bind(&new)
    .bind(&ts)
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("duplicate page content: {e}"))?;

    tx.commit().await.map_err(|e| format!("commit duplicate: {e}"))?;
    Ok(Page {
        id: new,
        section_id,
        title: format!("{title} (copy)"),
        sort_order,
        updated_at: ts,
        preview,
    })
}

/// Move a page to another section (within the same notebook). Appended to the
/// end of the target section.
pub async fn move_page(
    pool: &Pool<Sqlite>,
    id: &str,
    to_section_id: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin move: {e}"))?;
    let sort_order: i64 = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(sort_order) FROM pages WHERE section_id = ?1",
    )
    .bind(to_section_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("move sort order: {e}"))?
    .map_or(0, |m| m + 1);

    sqlx::query("UPDATE pages SET section_id = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4")
        .bind(to_section_id)
        .bind(sort_order)
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("move page: {e}"))?;
    tx.commit().await.map_err(|e| format!("commit move: {e}"))
}

pub async fn reorder_pages(pool: &Pool<Sqlite>, ordered_ids: &[String]) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin reorder pages: {e}"))?;
    for (order, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE pages SET sort_order = ?1 WHERE id = ?2")
            .bind(order as i64)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("reorder pages: {e}"))?;
    }
    tx.commit().await.map_err(|e| format!("commit reorder pages: {e}"))
}

// ---------------------------------------------------------------------------
// Page content & auto-save (spec Section 13)
// ---------------------------------------------------------------------------
//
// Two tiers of full-document checkpoints, both crash-safe via WAL:
//   page_ops     — appended frequently (~300ms) while editing; each row is a
//                  full Tiptap doc, newer than the last snapshot.
//   page_content — the durable snapshot (~3s); supersedes and prunes the ops
//                  it incorporates.
// Recovery prefers the newest surviving op (it is by construction newer than
// the snapshot), else the snapshot. We store full docs rather than ProseMirror
// steps: at our scale the writes are cheap and replay-free recovery is far more
// robust (no step/schema-mismatch failure modes).

/// Return the freshest saved document for a page, or None for a blank page.
pub async fn load_page_content(
    pool: &Pool<Sqlite>,
    page_id: &str,
) -> Result<Option<String>, String> {
    if let Some(op) = sqlx::query_scalar::<_, String>(
        "SELECT op_json FROM page_ops WHERE page_id = ?1 ORDER BY id DESC LIMIT 1",
    )
    .bind(page_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("load page op: {e}"))?
    {
        return Ok(Some(op));
    }
    sqlx::query_scalar::<_, String>("SELECT content_json FROM page_content WHERE page_id = ?1")
        .bind(page_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("load page content: {e}"))
}

/// Append a frequent op-log checkpoint (full doc).
pub async fn append_page_op(
    pool: &Pool<Sqlite>,
    page_id: &str,
    op_json: &str,
) -> Result<(), String> {
    sqlx::query("INSERT INTO page_ops (page_id, op_json) VALUES (?1, ?2)")
        .bind(page_id)
        .bind(op_json)
        .execute(pool)
        .await
        .map_err(|e| format!("append page op: {e}"))?;
    Ok(())
}

/// Write the durable snapshot, refresh the page-list preview/timestamp, and
/// prune the ops this snapshot supersedes (those that existed when it started).
pub async fn save_page_snapshot(
    pool: &Pool<Sqlite>,
    page_id: &str,
    content_json: &str,
    preview: &str,
) -> Result<(), String> {
    let ts = now();
    let mut tx = pool.begin().await.map_err(|e| format!("begin snapshot: {e}"))?;

    let max_op: i64 = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(id) FROM page_ops WHERE page_id = ?1",
    )
    .bind(page_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("snapshot max op: {e}"))?
    .unwrap_or(0);

    sqlx::query(
        "INSERT INTO page_content (page_id, content_json, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(page_id) DO UPDATE SET content_json = excluded.content_json, \
         updated_at = excluded.updated_at",
    )
    .bind(page_id)
    .bind(content_json)
    .bind(&ts)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("write snapshot: {e}"))?;

    sqlx::query("UPDATE pages SET preview = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(preview)
        .bind(&ts)
        .bind(page_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("update page preview: {e}"))?;

    sqlx::query("DELETE FROM page_ops WHERE page_id = ?1 AND id <= ?2")
        .bind(page_id)
        .bind(max_op)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("prune ops: {e}"))?;

    tx.commit().await.map_err(|e| format!("commit snapshot: {e}"))
}

// ---------------------------------------------------------------------------

async fn next_sort_order(pool: &Pool<Sqlite>, max_query: &str) -> Result<i64, String> {
    let max: Option<i64> = sqlx::query_scalar(max_query)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("next sort order: {e}"))?;
    Ok(max.map_or(0, |m| m + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_pool() -> (Pool<Sqlite>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("vellum-nb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notebook.db");
        crate::db::create_or_migrate(&path).await.unwrap();
        (crate::db::open_pool(&path, false).await.unwrap(), dir)
    }

    #[tokio::test]
    async fn section_and_page_crud_with_cascade() {
        let (pool, dir) = temp_pool().await;

        let s = create_section(&pool, "Meeting Notes").await.unwrap();
        assert_eq!(list_sections(&pool).await.unwrap().len(), 1);

        let p1 = create_page(&pool, &s.id, "Sprint planning").await.unwrap();
        let _p2 = create_page(&pool, &s.id, "Retro").await.unwrap();
        assert_eq!(list_pages(&pool, &s.id).await.unwrap().len(), 2);
        // Appended in order.
        assert!(_p2.sort_order > p1.sort_order);

        set_page_title(&pool, &p1.id, "Sprint planning v2").await.unwrap();
        let dup = duplicate_page(&pool, &p1.id).await.unwrap();
        assert!(dup.title.ends_with("(copy)"));
        assert_eq!(list_pages(&pool, &s.id).await.unwrap().len(), 3);

        // Deleting the section cascades to all its pages.
        delete_section(&pool, &s.id).await.unwrap();
        assert_eq!(list_sections(&pool).await.unwrap().len(), 0);
        let orphans: i64 = sqlx::query_scalar("SELECT count(*) FROM pages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(orphans, 0, "cascade should remove pages with the section");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn move_reorder_and_update_section() {
        let (pool, dir) = temp_pool().await;

        let a = create_section(&pool, "A").await.unwrap();
        let b = create_section(&pool, "B").await.unwrap();
        let p = create_page(&pool, &a.id, "Page").await.unwrap();

        // Move page A -> B.
        move_page(&pool, &p.id, &b.id).await.unwrap();
        assert_eq!(list_pages(&pool, &a.id).await.unwrap().len(), 0);
        let in_b = list_pages(&pool, &b.id).await.unwrap();
        assert_eq!(in_b.len(), 1);
        assert_eq!(in_b[0].section_id, b.id);

        // Reorder sections: B before A.
        reorder_sections(&pool, &[b.id.clone(), a.id.clone()]).await.unwrap();
        let sections = list_sections(&pool).await.unwrap();
        assert_eq!(sections[0].id, b.id);

        // Update section properties.
        update_section(&pool, &a.id, "A renamed", Some("#abc123".into()), Some("tmpl-1".into()))
            .await
            .unwrap();
        let a2 = list_sections(&pool)
            .await
            .unwrap()
            .into_iter()
            .find(|s| s.id == a.id)
            .unwrap();
        assert_eq!(a2.name, "A renamed");
        assert_eq!(a2.color.as_deref(), Some("#abc123"));
        assert_eq!(a2.page_template_id.as_deref(), Some("tmpl-1"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn content_recovery_and_pruning() {
        let (pool, dir) = temp_pool().await;
        let s = create_section(&pool, "S").await.unwrap();
        let p = create_page(&pool, &s.id, "P").await.unwrap();

        // Blank page.
        assert!(load_page_content(&pool, &p.id).await.unwrap().is_none());

        // Snapshot becomes the loaded content and updates the list preview.
        save_page_snapshot(&pool, &p.id, r#"{"v":1}"#, "v1 preview").await.unwrap();
        assert_eq!(
            load_page_content(&pool, &p.id).await.unwrap().as_deref(),
            Some(r#"{"v":1}"#)
        );
        let listed = list_pages(&pool, &s.id).await.unwrap().pop().unwrap();
        assert_eq!(listed.preview, "v1 preview");

        // An op newer than the snapshot wins recovery (simulates a crash mid-edit).
        append_page_op(&pool, &p.id, r#"{"v":2}"#).await.unwrap();
        assert_eq!(
            load_page_content(&pool, &p.id).await.unwrap().as_deref(),
            Some(r#"{"v":2}"#)
        );

        // The next snapshot supersedes and prunes that op.
        save_page_snapshot(&pool, &p.id, r#"{"v":3}"#, "v3").await.unwrap();
        let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM page_ops WHERE page_id = ?1")
            .bind(&p.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0);
        assert_eq!(
            load_page_content(&pool, &p.id).await.unwrap().as_deref(),
            Some(r#"{"v":3}"#)
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
