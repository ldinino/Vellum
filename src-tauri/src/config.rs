//! app.json and notebooks.json — app-level config and the notebook registry.
//! Both are written atomically (temp file + rename) so a crash mid-write can
//! never leave a corrupt file behind.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::paths;

// ---------------------------------------------------------------------------
// app.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub settings: AppSettings,
    pub page_templates: Vec<PageTemplate>,
    pub refine_templates: Vec<RefineTemplate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Refine is OFF by default on first run (spec Section 9).
    pub refine_enabled: bool,
    pub grammar_enabled: bool,
    pub spellcheck_enabled: bool,
    pub default_font: String,
    pub default_font_size: u32,
    /// Strict (0.0) .. Liberal (1.0) global default.
    pub refine_adherence: f32,
    /// Fast | Balanced | Thorough; None until first-run detection picks one.
    pub refine_model_tier: Option<String>,
    pub grammar_language: String,
    /// Cleared until the user completes the first-run setup screen (spec
    /// Section 9 / Phase 7).
    pub first_run_complete: bool,
    /// Set once the starter Refine templates have been seeded (Phase 8). Gated
    /// on this flag so we never re-seed after the user deletes them.
    pub starters_seeded: bool,
    /// Set once the first-launch "Welcome to Vellum" notebook has been seeded
    /// (Phase 11). Gated on this flag so it is created exactly once and never
    /// reappears after the user deletes it.
    pub welcome_seeded: bool,
    /// Words the user added to the Harper spell-check dictionary (spec Section
    /// 10). Global and persisted here so they survive restarts; merged into the
    /// curated dictionary in `grammar.rs`.
    pub custom_dictionary: Vec<String>,
    /// Grammar lint categories (Harper `LintKind`, e.g. "Repetition") the user
    /// chose to ignore via "Ignore this rule". Persisted so the choice is
    /// reversible (managed in Settings → Proofing).
    pub ignored_grammar_rules: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            refine_enabled: false,
            // Grammar check is on by default (Harper is compiled in, no download).
            grammar_enabled: true,
            spellcheck_enabled: true,
            default_font: "Segoe UI".into(),
            // 14px = the editor's base size token (--text-size-editor); keep in
            // sync so a fresh app.json matches the default page look.
            default_font_size: 14,
            refine_adherence: 0.5,
            refine_model_tier: None,
            grammar_language: "en-US".into(),
            first_run_complete: false,
            starters_seeded: false,
            welcome_seeded: false,
            custom_dictionary: Vec::new(),
            ignored_grammar_rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageTemplate {
    pub id: String,
    pub name: String,
    /// Tiptap document JSON.
    pub content_json: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

/// One few-shot example pair rendered into the harness (Phase 8) — the biggest
/// reliability lever for strict formats on small models (spec Section 8).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExamplePair {
    pub input: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RefineTemplate {
    pub id: String,
    pub name: String,
    /// The transformation rules (Phase 8). Was `systemPrompt` pre-Phase 8; old
    /// values are folded in on load (see `migrate_refine_templates`).
    pub instructions: String,
    /// Always serialized (even when empty) so the IPC payload matches the
    /// frontend's non-optional `examples: ExamplePair[]` — a missing field there
    /// is a render crash.
    pub examples: Vec<ExamplePair>,
    pub description: Option<String>,
    /// Overrides the global Strict..Liberal setting when set.
    pub adherence_override: Option<f32>,
    /// Legacy pre-Phase 8 field; read for migration, never written back.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub system_prompt: String,
}

// ---------------------------------------------------------------------------
// notebooks.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NotebookRegistry {
    pub notebooks: Vec<NotebookMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NotebookMeta {
    pub id: String,
    pub name: String,
    /// Folder name under Documents\Vellum (sanitized, may differ from name).
    pub folder: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    /// Soft-delete timestamp (RFC3339) for the Recycle Bin (spec Section 5.1).
    /// None = live; Some = in the bin (the folder stays on disk until the
    /// notebook is purged). Skipped on serialize so live notebooks stay clean.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    /// Scoped proofreading (execution-plan #5): per-category tri-state —
    /// None = inherit, Some(true) = on, Some(false) = off — for every page in
    /// this notebook. Skipped on serialize when None so unaffected notebooks
    /// stay clean in notebooks.json.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grammar_pref: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spell_pref: Option<bool>,
}

// ---------------------------------------------------------------------------
// Atomic JSON I/O
// ---------------------------------------------------------------------------

/// Write JSON atomically: serialize to `<path>.tmp` in the same directory,
/// fsync, then rename over the destination (MoveFileEx with REPLACE_EXISTING
/// on Windows — atomic on NTFS).
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("serialize {}: {e}", path.display()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp: PathBuf = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("fsync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })
}

fn read_json_or_default<T: Default + for<'de> Deserialize<'de> + Serialize>(
    path: &Path,
) -> Result<T, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            // Tolerate a UTF-8 BOM: Documents\Vellum is OneDrive-synced and may be
            // touched by external editors/tools that prepend one, which serde_json
            // would otherwise reject ("expected value at line 1 column 1").
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            serde_json::from_str(text).map_err(|e| format!("parse {}: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let value = T::default();
            write_json_atomic(path, &value)?;
            Ok(value)
        }
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

pub fn load_app_config(app: &AppHandle) -> Result<AppConfig, String> {
    let path = paths::app_json_path(app)?;
    let mut config: AppConfig = read_json_or_default(&path)?;

    // Migrate + seed once; persist only if something actually changed so we
    // don't churn the file (and OneDrive) on every launch.
    let mut changed = migrate_refine_templates(&mut config);
    if !config.settings.starters_seeded {
        if config.refine_templates.is_empty() {
            config.refine_templates = crate::refine::starters::starter_templates();
        }
        config.settings.starters_seeded = true;
        changed = true;
    }
    if changed {
        write_json_atomic(&path, &config)?;
    }
    Ok(config)
}

/// Fold the legacy `systemPrompt` field into `instructions` (Phase 8 migration).
/// Returns whether any template changed.
fn migrate_refine_templates(config: &mut AppConfig) -> bool {
    let mut changed = false;
    for t in &mut config.refine_templates {
        if t.instructions.is_empty() && !t.system_prompt.is_empty() {
            t.instructions = std::mem::take(&mut t.system_prompt);
            changed = true;
        } else if !t.system_prompt.is_empty() {
            // instructions already set (newer file touched by an old build?) —
            // drop the stale legacy value so it stops round-tripping.
            t.system_prompt.clear();
            changed = true;
        }
    }
    changed
}

pub fn save_app_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    write_json_atomic(&paths::app_json_path(app)?, config)
}

pub fn load_registry(app: &AppHandle) -> Result<NotebookRegistry, String> {
    read_json_or_default(&paths::notebooks_json_path(app)?)
}

pub fn save_registry(app: &AppHandle, registry: &NotebookRegistry) -> Result<(), String> {
    write_json_atomic(&paths::notebooks_json_path(app)?, registry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_system_prompt_deserializes_then_migrates() {
        // A pre-Phase 8 app.json: a template stored as `systemPrompt`.
        let json = r#"{
            "refineTemplates": [
                { "id": "1", "name": "Old", "systemPrompt": "Make it formal." }
            ]
        }"#;
        let mut cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.refine_templates[0].system_prompt, "Make it formal.");
        assert!(cfg.refine_templates[0].instructions.is_empty());

        assert!(migrate_refine_templates(&mut cfg));
        let t = &cfg.refine_templates[0];
        assert_eq!(t.instructions, "Make it formal.");
        assert!(t.system_prompt.is_empty());

        // Re-running is a no-op (idempotent).
        assert!(!migrate_refine_templates(&mut cfg));
    }

    #[test]
    fn migrated_template_drops_legacy_field_on_serialize() {
        let t = RefineTemplate {
            id: "1".into(),
            name: "New".into(),
            instructions: "Tighten.".into(),
            examples: vec![ExamplePair { input: "a".into(), output: "b".into() }],
            description: None,
            adherence_override: None,
            system_prompt: String::new(),
        };
        let s = serde_json::to_string(&t).unwrap();
        assert!(!s.contains("systemPrompt"), "legacy field is not written back");
        assert!(s.contains("instructions"));
        assert!(s.contains("examples"));
    }

    #[test]
    fn empty_examples_are_serialized_as_array() {
        // Always present (even empty) so the IPC payload matches the frontend's
        // non-optional `examples` array — a missing field is a render crash.
        let t = RefineTemplate {
            id: "1".into(),
            name: "New".into(),
            instructions: "Tighten.".into(),
            examples: vec![],
            description: None,
            adherence_override: None,
            system_prompt: String::new(),
        };
        let s = serde_json::to_string(&t).unwrap();
        assert!(s.contains("\"examples\":[]"), "empty examples serialize as []");
    }

    #[test]
    fn notebook_proofing_prefs_skip_when_inherit_and_roundtrip() {
        // execution-plan #5: per-category proofreading prefs live here.
        // Live notebooks stay clean \u2014 it's not written when a pref is None (inherit), like deleted_at.
        let clean = NotebookMeta {
            id: "n1".into(),
            name: "Work".into(),
            folder: "n1".into(),
            ..Default::default()
        };
        let s = serde_json::to_string(&clean).unwrap();
        assert!(!s.contains("grammarPref"), "an inherited (None) pref is not written");
        assert!(!s.contains("spellPref"));

        // Explicit prefs serialize under camelCase keys and round-trip.
        let set = NotebookMeta { grammar_pref: Some(false), spell_pref: Some(true), ..clean };
        let s = serde_json::to_string(&set).unwrap();
        assert!(s.contains("\"grammarPref\":false"));
        assert!(s.contains("\"spellPref\":true"));
        let back: NotebookMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(back.grammar_pref, Some(false));
        assert_eq!(back.spell_pref, Some(true));

        // An older notebooks.json entry (no prefs) reads as inherit.
        let old: NotebookMeta =
            serde_json::from_str(r#"{"id":"n1","name":"Work","folder":"n1"}"#).unwrap();
        assert_eq!(old.grammar_pref, None);
        assert_eq!(old.spell_pref, None);
    }
}
