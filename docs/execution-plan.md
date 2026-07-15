# Vellum — Execution Plan (2026-07 batch)

Working backlog for a set of bugs/features raised 2026-07-14. This is a planning
document, not part of the phase-numbered spec — [Vellum_spec.md](Vellum_spec.md)
stays the source of truth per [CLAUDE.md](../CLAUDE.md); fold the relevant
decisions back into it once each item ships. Sizes are relative complexity
(S/M/L/XL), not time estimates.

**Update (2026-07-14):** the first batch **shipped in v0.2.0** and has been
cleared from this board — Windows ARM64, the Azure DevOps Markdown profile
(H1–H6, task lists, image sizing, `.attachments`), Mermaid diagrams, the
Export-to-Markdown wizard, template dynamic inserts, code-block scrolling, and
the last-section / window-state / shuffle-color / colon-run-on fixes. What
remains below is the leftover backlog: the **deferred** macOS and Linux tracks,
and **move sections between notebooks** (the one still-open feature).

## At a glance

| ID | Item | Track | Size | Depends on |
|---|---|---|---|---|
| [MACOS](#1-macos-build-planning) | macOS build _(deferred)_ | Platform | XL | Apple Developer secrets in CI |
| [LINUX](#2-linux-build-planning) | Linux build _(deferred)_ | Platform | L | — |
| [MOVESECTION](#3-move-sections-between-notebooks) | Move sections between notebooks | Feature | XL | — |

---

## Track: Platform builds

**Scope — Windows-only.** Windows ARM64 shipped in **v0.2.0** (native x64 +
ARM64 installers from one release). [macOS](#1-macos-build-planning) and
[Linux](#2-linux-build-planning) remain **deferred** post-v1 — Vellum is
Windows-first (per [CLAUDE.md](../CLAUDE.md)); their planning and resolved
decisions below are kept intact for when they're picked back up.

### 1. macOS build (planning)

**Deferred (2026-07-14):** parked post-v1 — Vellum ships Windows-first. The
product decisions below still stand for whenever this is picked up; nothing here
is reversed, just not scheduled.

**Current state:** `ci.yml` already runs `cargo check` + `npm run build` on
`macos-latest` for every push (compile-only, no bundling). `tauri.conf.json`'s
icon list already includes `icon.icns`. Several behaviors are Windows-specific
by design and have no macOS equivalent yet:

| Concern | Where | Windows behavior today |
|---|---|---|
| Translucent titlebar | [lib.rs](../src-tauri/src/lib.rs) `window_vibrancy::apply_acrylic(...)` | Acrylic glass behind the custom titlebar |
| Disabling browser shortcuts | lib.rs `SetAreBrowserAcceleratorKeysEnabled(false)` | Blocks Ctrl+R/F5/Ctrl+P/F12 in release builds |
| GPU/hardware detection | [refine/hardware.rs](../src-tauri/src/refine/hardware.rs) `detect_gpus()` (`#[cfg(windows)]`, DXGI) | Drives Refine's Fast/Balanced/Thorough auto-pick |
| Process spawn/kill | [process/mod.rs](../src-tauri/src/process/mod.rs) (`#[cfg(windows)]` blocks) | Hidden console window flag, `taskkill /T` tree-kill |
| Menu bar | [MenuBar.tsx](../src/components/MenuBar.tsx) | Custom in-window menu (not the OS menu bar) |
| Titlebar buttons | [Titlebar.tsx](../src/components/Titlebar.tsx) | Windows-style min/max/close, top-right |
| Ollama runtime | `models.json` | `ollama-windows-amd64.zip` only |
| Default font | [config.rs](../src-tauri/src/config.rs) `default_font: "Segoe UI"` | Doesn't exist on macOS |

**Good news:** `window_vibrancy` (already a dependency for the Windows acrylic
effect) also supports macOS vibrancy (`apply_vibrancy` +
`NSVisualEffectMaterial`) — extending translucency is an additive
`#[cfg(target_os = "macos")]` branch, not a rewrite.

**Decided:**
- **Notarize.** You have an Apple Developer Program account — full
  codesign + notarize + staple pipeline for v1, no Gatekeeper-friction
  fallback needed.
- **Menu bar:** ship the same custom in-window `MenuBar.tsx` everywhere,
  matching your "ship the same thing everywhere" preference — no native
  macOS menu bar integration planned.
- **Titlebar:** keep the current Windows-style right-aligned buttons rather
  than macOS traffic lights — this also sets up cleanly for the theme system
  already flagged as a future item in [Vellum_spec.md](Vellum_spec.md) §16
  (Out of Scope).

**Proposed approach:**
- `#[cfg(target_os = "macos")]` branches for vibrancy (`window_vibrancy::apply_vibrancy`
  with an `NSVisualEffectMaterial` — the same crate already used for Windows
  acrylic), hardware detection (Metal/`sysinfo`-only heuristic — no DXGI
  equivalent needed if the RAM-only classification path is widened to cover
  it), and process spawn/kill (no hidden-window flag needed; tree-kill via a
  process-group signal instead of `taskkill`).
- Add `dmg` to `bundle.targets`; add a macOS job to a matrixed release
  workflow.
- **Signing pipeline:** `tauri-action` handles codesigning + notarization +
  stapling for macOS when given a Developer ID Application certificate
  (base64-encoded `.p12` + its password) and notarization credentials (an
  Apple ID + app-specific password, or a `notarytool` API key) as repo
  secrets — the same shape as the existing Windows minisign key setup
  documented in [CLAUDE.md](../CLAUDE.md) (secrets in, `tauri-action` does the
  rest). Confirm the exact current secret names against Tauri's docs when
  wiring this up (naming has shifted slightly across Tauri versions).
- Publish a macOS Ollama artifact (Ollama ships both `ollama-darwin.tgz` and
  `Ollama-darwin.zip`/`.dmg` forms) and use `local_data_dir()` (already
  OS-abstracted via Tauri's path API) for the runtime install location.
- Pick a sane `default_font` fallback for macOS (e.g. "Helvetica Neue" or
  "SF Pro Text").
- One caveat on the menu-bar decision, not a blocker: macOS still routes some
  system behaviors (Quit, Hide, Services, and standard Edit-menu
  Cut/Copy/Paste/Undo inside native text fields) through the application menu
  even when it's not visually shown, so a minimal/hidden native menu (or
  direct Cmd+Q/Cmd+H handling) is typically still registered under the hood —
  this doesn't conflict with keeping `MenuBar.tsx` as the only *visible* menu.

Given the product decisions are resolved, the main remaining prerequisite is
logistics — generating the Developer ID certificate and notarization
credentials and loading them as GitHub secrets — before the release workflow
can produce a signed macOS build. Still reasonable to schedule after ARM64 and
Linux since it's the largest net-new engineering surface (vibrancy, hardware
detection, process handling, a new CI job, and the signing pipeline all at
once).

---

### 2. Linux build (planning)

**Deferred (2026-07-14):** parked post-v1 — Vellum ships Windows-first. The
AppImage/updater decision below still stands for whenever this is picked up.

**Current state:** `ci.yml` already installs `libwebkit2gtk-4.1-dev`,
`libappindicator3-dev`, `librsvg2-dev`, `patchelf` and runs `cargo check` +
`npm run build` on `ubuntu-latest` — compile-only, no bundling, no release job.

**Decided, with a tradeoff worth flagging:** you leaned Flatpak first,
AppImage as a fallback. Worth weighing given how much you emphasized wanting
proper automatic updates: **Flatpak isn't a Tauri bundle target at all** —
Tauri's built-in bundler produces deb/rpm/AppImage/dmg/msi/nsis, but Flatpak
needs a separate manifest (`flatpak-builder`, a runtime dependency like
`org.freedesktop.Platform` for WebKitGTK, and either Flathub submission/review
or a self-hosted repo / a single `.flatpak` bundle attached to GitHub
Releases). More importantly, **Flatpak manages its own updates** (`flatpak
update`, tied to Flathub or a repo) — it would not go through
`tauri-plugin-updater` at all, so the in-app "restart to update" flow you
already built would silently not apply to a Flatpak install. AppImage, by
contrast, is a native Tauri bundle target and is supported by
`tauri-plugin-updater` (it patches the executable in place), keeping one
consistent updater story across Windows/macOS/Linux.
- **Recommendation:** ship **AppImage** as the v1 Linux target specifically
  because it keeps auto-update behavior consistent with the other platforms —
  treat **Flatpak as a later, parallel distribution channel** (e.g. a Flathub
  submission for discoverability) that would rely on Flatpak's own update
  mechanism instead of the in-app updater, as an explicit, separate decision
  when you're ready for it.
- ARM64 Linux wasn't addressed in your answer — defaulting to **x86_64-only**
  for v1 (Raspberry-Pi-class ARM64 Linux devices seem an unlikely target for
  this app) unless you'd rather include it.

**Proposed approach:**
- Add `appimage` to `bundle.targets`; add a Linux job to the release workflow
  (reuse the CI job's system-dependency install step).
- No code-signing equivalent is required for AppImage — lower friction than
  macOS.
- Same `#[cfg(target_os = "linux")]` audit as macOS for: hardware detection
  (no DXGI; RAM-only or a Vulkan-based heuristic), process kill (POSIX
  `kill`/process groups, no `taskkill`), Ollama artifact
  (`ollama-linux-amd64.tar.zst`, confirmed available on the same Ollama
  release already pinned).
- `window_vibrancy` has little/no Linux support (compositor-dependent) —
  plan on a flat/opaque titlebar there rather than trying to replicate acrylic.
- Menu bar / titlebar: ship the same custom in-window MenuBar + Titlebar as
  Windows/macOS (consistent with the "same everywhere" decision) — Linux
  desktop conventions are the least prescriptive of the three, so this needs
  no structural change, just verification under GTK/WebKitGTK.

---

## Track: Content features

### 3. Move sections between notebooks

**Current state — this is the biggest architectural item on the list.** Per
[CLAUDE.md](../CLAUDE.md), **each notebook is its own SQLite database file**;
confirmed in [db.rs](../src-tauri/src/db.rs) — the `sections` table has **no
`notebook_id` column** because notebook identity is which database file you
opened, not a foreign key. So "moving a section to a different notebook" is a
**cross-database data migration**, not a simple `UPDATE`.

**What actually has to happen, end to end:**
1. Read the section row + all its pages ([notebook.rs](../src-tauri/src/notebook.rs)
   `list_sections`/pages), `page_content`, `page_ops`, and `attachments` rows
   from the **source** notebook's DB.
2. Insert equivalent rows into the **destination** notebook's DB, with a fresh
   `sort_order` (append at the end) and identity preserved otherwise.
   `page_template_id` references stay valid as-is (templates are app-level/
   global, not per-notebook).
3. Move the on-disk files: inline images + attachments live under
   `attachments/<page-id>/` inside the notebook's own folder
   ([paths.rs](../src-tauri/src/paths.rs)). Since both notebooks live under the
   same `Documents\Vellum\` root, this can likely be a plain directory
   **rename** (fast, same-volume) rather than a full copy, with copy+delete as
   a cross-volume fallback.
4. Delete the section (cascades to pages/content/ops/attachment rows via
   `ON DELETE CASCADE`) from the source DB once the destination write is
   confirmed.
5. Re-index search: simplest-correct approach is to re-run the existing
   per-notebook `reindex_notebook` for **both** the source and destination
   notebooks afterward (rebuilds `fts_index` cleanly) rather than hand-patching
   individual rows; the master `search_index` cache already gets rebuilt via
   the app's existing reindex-on-startup path, or can be targeted directly if
   that's not fast enough in practice.
6. Only live (non-soft-deleted) sections should be movable — no interaction
   with the Recycle Bin's `deleted_at` semantics otherwise.

**New surface area:**
- Backend: a new Tauri command, e.g. `move_section_to_notebook(sourceNotebookId,
  sectionId, destNotebookId)`, implementing the steps above as one logical
  (best-effort atomic — see below) operation.
- Frontend: a "Move to Notebook…" entry in the section context menu
  ([sectionMenu.ts](../src/components/panels/sectionMenu.ts) `buildSectionMenu`),
  opening a small notebook-picker dialog; `vellum.tsx` action + `api.ts`
  wrapper per the repo's existing command-wiring convention (Rust command in
  `commands.rs` → registered in `lib.rs` → frontend wrapper in `api.ts`).

**Decided: confirm before moving.** Use the same native `ask()` confirmation
dialog (`@tauri-apps/plugin-dialog`) already used for permanent-delete actions
in [RecycleBinModal.tsx](../src/components/panels/RecycleBinModal.tsx)
(`confirmPurge`/`confirmEmpty`) for consistency — e.g.
`` ask(`Move section "${name}" and its N pages to "${destNotebook}"?`, { title: "Move Section", kind: "warning" }) ``.
That capability is already granted (`dialog:allow-ask` in
capabilities/default.json, wired for the recycle bin), so no new capability
entry is needed.

**Open risks:**
- **Atomicity/crash-safety.** A crash mid-move must not lose data. Recommend:
  write to the destination DB first and verify it, *then* delete from the
  source — never delete-then-write (mirrors the existing `purge_notebook`
  ordering rationale: it saves the registry before removing the folder, for
  the same reason).
  A partially-completed move should be recoverable or at worst leave a
  harmless duplicate rather than data loss.
- Size this as its own mini-project with explicit manual test cases (large
  section with many pages/attachments; move across notebooks with different
  section-color palettes already used; crash-mid-move simulation) before
  considering it done — not a quick win.

---

## Suggested sequencing

Only [MOVESECTION](#3-move-sections-between-notebooks) is active work — schedule
it as its own mini-project with dedicated testing (it's a cross-database
migration; see its section for the risks). [macOS](#1-macos-build-planning) and
[Linux](#2-linux-build-planning) are deferred post-v1 and unblocked whenever
they're picked up (Linux first — AppImage, no signing friction — then macOS).

## Decisions log

Decisions carried forward for the remaining items (the rest were resolved and
shipped in v0.2.0).

| # | Decision | Resolution |
|---|---|---|
| 1 | macOS signing | Full notarization (Apple Developer account available) |
| 2 | macOS menu bar | Same custom in-window `MenuBar.tsx` everywhere |
| 3 | macOS titlebar | Keep the Windows-style layout (themes planned later) |
| 4 | Linux packaging | AppImage for v1 (keeps the updater consistent); Flatpak flagged as a later, separate-update-mechanism channel |
| 5 | Move-section confirmation | Required, via the existing `ask()` dialog pattern |

**Residual open item:** whether ARM64 Linux is in scope — moot for now, since
[Linux](#2-linux-build-planning) is **deferred**; revisit alongside the Linux
track (defaulting to x86_64-only when it returns unless you say otherwise).
