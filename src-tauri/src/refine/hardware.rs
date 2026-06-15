//! Hardware detection and tier mapping (spec Section 9, "Model tiers").
//!
//! We report system RAM and, on Windows, every DXGI graphics adapter (name,
//! dedicated VRAM, shared system memory). The tricky case is shared-memory
//! integrated GPUs — Intel Arc 140V on Lunar Lake reports tiny *dedicated* VRAM
//! but runs Ollama on the iGPU using a large slice of system RAM, so a naive
//! dedicated-VRAM check would mis-tier it as CPU-only. `classify` therefore:
//!   - discrete GPU (dedicated VRAM ≥ threshold) → tier by VRAM,
//!   - integrated GPU (real adapter, little dedicated VRAM) → tier by system RAM,
//!     capped at Balanced (Thorough is memory-bound on shared memory),
//!   - only the Basic Render Driver (no real GPU) → CPU-only → Fast + warning.
//!
//! Detection is side-effect free: it returns a recommendation; the renderer
//! persists the chosen tier via `save_app_config`.

use serde::Serialize;
use tauri::AppHandle;

use super::manifest::{self, Thresholds};

/// Shown in Settings and at point of use when no GPU offload is available
/// (spec Section 9, CPU-only fallback).
pub const CPU_ONLY_WARNING: &str =
    "Refine on this machine may be slow. Requests may take 30–90 seconds.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapter {
    pub description: String,
    pub dedicated_video_memory: u64,
    pub dedicated_system_memory: u64,
    pub shared_system_memory: u64,
    pub vendor_id: u32,
    /// The Microsoft Basic Render Driver / a WARP software adapter — not real
    /// GPU offload.
    pub is_basic_render_driver: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedHardware {
    pub total_ram_bytes: u64,
    pub gpus: Vec<GpuAdapter>,
    pub cpu_only: bool,
    /// "Fast" | "Balanced" | "Thorough".
    pub recommended_tier: String,
    /// "discrete" | "integrated" | "none".
    pub gpu_kind: String,
    /// Non-null only on CPU-only machines.
    pub warning: Option<String>,
}

/// The portion of `DetectedHardware` derived purely from inputs — split out so
/// the mapping logic is unit-testable without touching the OS.
pub struct Classification {
    pub recommended_tier: String,
    pub gpu_kind: String,
    pub cpu_only: bool,
    pub warning: Option<String>,
}

/// Map RAM + adapters to a tier. Pure; see the module docs for the rules.
pub fn classify(total_ram_bytes: u64, gpus: &[GpuAdapter], t: &Thresholds) -> Classification {
    let usable: Vec<&GpuAdapter> = gpus.iter().filter(|g| !g.is_basic_render_driver).collect();

    let Some(best) = usable.iter().max_by_key(|g| g.dedicated_video_memory) else {
        // No real GPU adapter — CPU-only.
        return Classification {
            recommended_tier: "Fast".into(),
            gpu_kind: "none".into(),
            cpu_only: true,
            warning: Some(CPU_ONLY_WARNING.into()),
        };
    };

    if best.dedicated_video_memory >= t.discrete_min_vram_bytes {
        let vram = best.dedicated_video_memory;
        let tier = if vram >= t.discrete_thorough_min_vram_bytes {
            "Thorough"
        } else if vram >= t.discrete_balanced_min_vram_bytes {
            "Balanced"
        } else {
            "Fast"
        };
        Classification {
            recommended_tier: tier.into(),
            gpu_kind: "discrete".into(),
            cpu_only: false,
            warning: None,
        }
    } else {
        // Integrated GPU: shares system memory, capped at Balanced.
        let tier = if total_ram_bytes >= t.integrated_balanced_min_ram_bytes {
            "Balanced"
        } else {
            "Fast"
        };
        Classification {
            recommended_tier: tier.into(),
            gpu_kind: "integrated".into(),
            cpu_only: false,
            warning: None,
        }
    }
}

/// Detect this machine's hardware and recommend a tier.
pub fn detect(app: &AppHandle) -> Result<DetectedHardware, String> {
    let manifest = manifest::load_manifest(app)?;
    let total_ram_bytes = total_ram();
    let gpus = detect_gpus().unwrap_or_else(|e| {
        eprintln!("GPU detection failed (treating as CPU-only): {e}");
        Vec::new()
    });
    let c = classify(total_ram_bytes, &gpus, &manifest.thresholds);
    Ok(DetectedHardware {
        total_ram_bytes,
        gpus,
        cpu_only: c.cpu_only,
        recommended_tier: c.recommended_tier,
        gpu_kind: c.gpu_kind,
        warning: c.warning,
    })
}

fn total_ram() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory() // bytes (sysinfo ≥ 0.30)
}

#[cfg(windows)]
fn detect_gpus() -> Result<Vec<GpuAdapter>, String> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_ERROR_NOT_FOUND,
    };

    let mut out = Vec::new();
    unsafe {
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1: {e}"))?;
        let mut i = 0u32;
        loop {
            let adapter: IDXGIAdapter1 = match factory.EnumAdapters1(i) {
                Ok(a) => a,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(format!("EnumAdapters1({i}): {e}")),
            };
            let desc = adapter
                .GetDesc1()
                .map_err(|e| format!("GetDesc1({i}): {e}"))?;

            let description = String::from_utf16_lossy(&desc.Description)
                .trim_end_matches('\0')
                .trim()
                .to_string();
            let is_software = (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0;
            out.push(GpuAdapter {
                dedicated_video_memory: desc.DedicatedVideoMemory as u64,
                dedicated_system_memory: desc.DedicatedSystemMemory as u64,
                shared_system_memory: desc.SharedSystemMemory as u64,
                vendor_id: desc.VendorId,
                is_basic_render_driver: is_software
                    || (desc.VendorId == 0x1414 && description.contains("Basic Render")),
                description,
            });
            i += 1;
        }
    }
    Ok(out)
}

#[cfg(not(windows))]
fn detect_gpus() -> Result<Vec<GpuAdapter>, String> {
    // DXGI is Windows-only; off-Windows we report no GPU (CPU-only fallback).
    // Keeps macOS/Linux CI green; v1 only ships on Windows.
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thresholds() -> Thresholds {
        Thresholds {
            discrete_min_vram_bytes: 3u64 << 30,
            discrete_balanced_min_vram_bytes: 6u64 << 30,
            discrete_thorough_min_vram_bytes: 12u64 << 30,
            integrated_balanced_min_ram_bytes: 16u64 << 30,
        }
    }

    fn gpu(desc: &str, vram_gb: u64, shared_gb: u64, vendor: u32, basic: bool) -> GpuAdapter {
        GpuAdapter {
            description: desc.into(),
            dedicated_video_memory: vram_gb << 30,
            dedicated_system_memory: 0,
            shared_system_memory: shared_gb << 30,
            vendor_id: vendor,
            is_basic_render_driver: basic,
        }
    }

    #[test]
    fn discrete_tiers_by_vram() {
        let t = thresholds();
        let big = [gpu("RTX 4090", 24, 0, 0x10DE, false)];
        let mid = [gpu("RTX 4060", 8, 0, 0x10DE, false)];
        let low = [gpu("GTX 1650", 4, 0, 0x10DE, false)];
        assert_eq!(classify(64 << 30, &big, &t).recommended_tier, "Thorough");
        assert_eq!(classify(32 << 30, &mid, &t).recommended_tier, "Balanced");
        assert_eq!(classify(16 << 30, &low, &t).recommended_tier, "Fast");
        assert_eq!(classify(16 << 30, &low, &t).gpu_kind, "discrete");
        assert!(!classify(16 << 30, &low, &t).cpu_only);
    }

    #[test]
    fn lunar_lake_integrated_is_balanced_not_cpu_only() {
        // Intel Arc 140V: tiny dedicated VRAM, large shared memory, 32 GB RAM.
        let t = thresholds();
        let igpu = [gpu("Intel(R) Arc(TM) 140V GPU", 0, 16, 0x8086, false)];
        let c = classify(32 << 30, &igpu, &t);
        assert_eq!(c.recommended_tier, "Balanced");
        assert_eq!(c.gpu_kind, "integrated");
        assert!(!c.cpu_only);
        assert!(c.warning.is_none());
    }

    #[test]
    fn integrated_with_little_ram_is_fast() {
        let t = thresholds();
        let igpu = [gpu("AMD Radeon Graphics", 0, 4, 0x1002, false)];
        let c = classify(8 << 30, &igpu, &t);
        assert_eq!(c.recommended_tier, "Fast");
        assert_eq!(c.gpu_kind, "integrated");
    }

    #[test]
    fn basic_render_driver_only_is_cpu_only() {
        let t = thresholds();
        let sw = [gpu("Microsoft Basic Render Driver", 0, 0, 0x1414, true)];
        let c = classify(16 << 30, &sw, &t);
        assert!(c.cpu_only);
        assert_eq!(c.recommended_tier, "Fast");
        assert_eq!(c.gpu_kind, "none");
        assert_eq!(c.warning.as_deref(), Some(CPU_ONLY_WARNING));
    }

    /// Diagnostic for the real machine (e.g. the Lunar Lake dev box). Ignored by
    /// default — run with `cargo test print_real_hardware -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_real_hardware() {
        let ram = total_ram();
        let gpus = detect_gpus().expect("detect gpus");
        eprintln!("total RAM: {:.1} GB", ram as f64 / (1u64 << 30) as f64);
        for g in &gpus {
            eprintln!(
                "GPU: {} | dedicated VRAM {:.1} GB | shared {:.1} GB | vendor {:#06x} | basic={}",
                g.description,
                g.dedicated_video_memory as f64 / (1u64 << 30) as f64,
                g.shared_system_memory as f64 / (1u64 << 30) as f64,
                g.vendor_id,
                g.is_basic_render_driver,
            );
        }
        let c = classify(ram, &gpus, &thresholds());
        eprintln!(
            "=> tier {} | kind {} | cpu_only {}",
            c.recommended_tier, c.gpu_kind, c.cpu_only
        );
    }

    #[test]
    fn picks_strongest_real_adapter() {
        // A laptop with both an iGPU and the software driver, plus a discrete GPU:
        // the discrete one wins, the software driver is ignored.
        let t = thresholds();
        let gpus = [
            gpu("Microsoft Basic Render Driver", 0, 0, 0x1414, true),
            gpu("Intel UHD", 0, 8, 0x8086, false),
            gpu("RTX 4070", 12, 0, 0x10DE, false),
        ];
        let c = classify(32 << 30, &gpus, &t);
        assert_eq!(c.recommended_tier, "Thorough");
        assert_eq!(c.gpu_kind, "discrete");
    }
}
