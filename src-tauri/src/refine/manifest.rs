//! The bundled model manifest (`models.json`): the pinned Ollama runtime
//! (version / url / sha256), the tier→model defaults, and the hardware
//! thresholds used to pick a tier. Data-only, so it can be retuned without
//! recompiling the binary (spec Section 9 / Open Items).
//!
//! Resolution precedence: a user override in `Documents\Vellum\models.json`
//! (future-proofing; not shipped), then the bundled resource, then — in debug
//! builds — the copy in the source tree so `tauri dev` works without a full
//! bundle (mirrors `paths::vendor_bin_dir`).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    /// One pinned Ollama runtime per platform, keyed `"{OS}-{ARCH}"` (e.g.
    /// "windows-x86_64", "windows-aarch64"). Each Windows arch ships a native
    /// build, so the download picks the entry matching the running binary.
    pub ollama: BTreeMap<String, OllamaPin>,
    pub tiers: Vec<TierEntry>,
    pub thresholds: Thresholds,
}

/// The manifest projected for the renderer: `ollama` resolved to the single pin
/// for the running build's platform, so the frontend needn't know the arch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedManifest {
    pub schema_version: u32,
    pub ollama: OllamaPin,
    pub tiers: Vec<TierEntry>,
    pub thresholds: Thresholds,
}

impl Manifest {
    /// The Ollama runtime pin for the current build's platform. The key is
    /// `"{OS}-{ARCH}"`, evaluated for the *target* at compile time, so a
    /// cross-compiled aarch64 binary correctly resolves "windows-aarch64".
    pub fn current_ollama(&self) -> Result<&OllamaPin, String> {
        let key = current_platform_key();
        self.ollama
            .get(&key)
            .ok_or_else(|| format!("models.json has no Ollama runtime pinned for platform '{key}'"))
    }

    /// Project to the renderer-facing shape (resolve `ollama` for this platform).
    pub fn resolve_for_current_platform(&self) -> Result<ResolvedManifest, String> {
        Ok(ResolvedManifest {
            schema_version: self.schema_version,
            ollama: self.current_ollama()?.clone(),
            tiers: self.tiers.clone(),
            thresholds: self.thresholds.clone(),
        })
    }
}

/// The `ollama` map key for the running build: `"{OS}-{ARCH}"` — e.g.
/// "windows-x86_64" or "windows-aarch64".
pub fn current_platform_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPin {
    pub version: String,
    pub url: String,
    pub sha256: String,
    /// Expected zip size; lets the UI show a total before the first byte and
    /// covers servers that omit Content-Length. 0 = unknown.
    #[serde(default)]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierEntry {
    /// "Fast" | "Balanced" | "Thorough" — matches `AppSettings.refineModelTier`.
    pub id: String,
    /// Ollama model identifier, e.g. "qwen3:14b".
    pub model: String,
    /// Approximate on-disk download size, shown before pulling (e.g. "~9 GB").
    pub size_label: String,
    /// Recommended system RAM for this tier (e.g. "16 GB").
    pub target_ram_label: String,
    /// One-line guidance on when this tier fits.
    pub use_for: String,
    /// Lighter model to fall back to on tight memory (Phase 8 auto-selection).
    #[serde(default)]
    pub fallback: Option<TierFallback>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierFallback {
    pub model: String,
    pub size_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    /// A GPU with at least this much *dedicated* VRAM counts as discrete.
    pub discrete_min_vram_bytes: u64,
    pub discrete_balanced_min_vram_bytes: u64,
    pub discrete_thorough_min_vram_bytes: u64,
    /// Integrated GPUs share system memory and are capped at Balanced, so they
    /// only need a system-RAM floor for that tier.
    pub integrated_balanced_min_ram_bytes: u64,
}

/// Resolve and parse the manifest (override → bundled resource → debug source).
pub fn load_manifest(app: &AppHandle) -> Result<Manifest, String> {
    let path = resolve_path(app)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("read manifest {}: {e}", path.display()))?;
    parse(&text).map_err(|e| format!("parse manifest {}: {e}", path.display()))
}

fn parse(text: &str) -> Result<Manifest, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map_err(|e| e.to_string())
}

fn resolve_path(app: &AppHandle) -> Result<PathBuf, String> {
    // 1. User override in the data dir (lets a power user retune without a build).
    if let Ok(dir) = paths::data_dir(app) {
        let over = dir.join("models.json");
        if over.is_file() {
            return Ok(over);
        }
    }
    // 2. Bundled resource (tauri.conf.json bundle.resources).
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("resources").join("models.json");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    // 3. Dev fallback: the copy in the source tree (debug builds run from repo).
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("models.json");
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err("models.json manifest not found".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../../resources/models.json");

    #[test]
    fn parses_bundled_manifest() {
        let m = parse(SAMPLE).expect("bundled manifest parses");
        assert_eq!(m.schema_version, 1);
        // Assert over the whole map so this stays host-independent (cargo test
        // also runs on the macOS/Linux CI runners, whose keys aren't pinned).
        assert!(!m.ollama.is_empty(), "at least one platform is pinned");
        for (key, pin) in &m.ollama {
            assert!(pin.url.contains(&pin.version), "{key}: url embeds its version");
            assert_eq!(pin.sha256.len(), 64, "{key}: sha256 is 64 hex chars");
        }
        // Both shipped Windows arches carry the matching native build.
        assert!(m.ollama.get("windows-x86_64").expect("x64 pinned").url.contains("amd64"));
        assert!(m.ollama.get("windows-aarch64").expect("arm64 pinned").url.contains("arm64"));
        let tier = |id: &str| m.tiers.iter().find(|t| t.id == id);
        // Defaults are non-reasoning instruct models (qwen3's hybrid reasoning
        // was unsuppressible on some Ollama builds — see Phase 8 design note).
        assert_eq!(tier("Fast").map(|t| t.model.as_str()), Some("qwen2.5:3b"));
        assert_eq!(tier("Balanced").map(|t| t.model.as_str()), Some("qwen2.5:14b"));
        assert_eq!(tier("Thorough").map(|t| t.model.as_str()), Some("gpt-oss:20b"));
        // Every tier advertises a size + RAM target; Fast/Balanced have fallbacks.
        assert!(m.tiers.iter().all(|t| !t.size_label.is_empty() && !t.target_ram_label.is_empty()));
        assert!(tier("Fast").unwrap().fallback.is_some());
        let t = &m.thresholds;
        assert!(t.discrete_thorough_min_vram_bytes > t.discrete_balanced_min_vram_bytes);
        assert!(t.discrete_balanced_min_vram_bytes > t.discrete_min_vram_bytes);
    }

    #[test]
    fn round_trips() {
        let m = parse(SAMPLE).unwrap();
        let s = serde_json::to_string(&m).unwrap();
        let again = parse(&s).unwrap();
        assert_eq!(m.ollama.len(), again.ollama.len());
        assert_eq!(
            m.ollama["windows-aarch64"].sha256,
            again.ollama["windows-aarch64"].sha256
        );
        assert_eq!(m.tiers.len(), again.tiers.len());
    }

    #[test]
    fn tolerates_bom() {
        let with_bom = format!("\u{feff}{SAMPLE}");
        assert!(parse(&with_bom).is_ok());
    }
}
