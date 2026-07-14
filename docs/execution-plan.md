# Vellum — Execution Plan (2026-07 batch)

Working backlog for a set of bugs/features raised 2026-07-14. This is a planning
document, not part of the phase-numbered spec — [Vellum_spec.md](Vellum_spec.md)
stays the source of truth per [CLAUDE.md](../CLAUDE.md); fold the relevant
decisions back into it once each item ships. Sizes are relative complexity
(S/M/L/XL), not time estimates.

**Update (2026-07-14):** all 11 originally-open decisions have been resolved —
see the [Decisions log](#decisions-log) at the bottom for a quick-reference
table, and each item's section below for the reasoning.

## At a glance

| ID | Item | Track | Size | Depends on |
|---|---|---|---|---|
| [ARM64](#1-windows-arm64-build) | Windows ARM64 build | Platform | M | — |
| [LINUX](#3-linux-build-planning) | Linux build | Platform | L | — |
| [MACOS](#2-macos-build-planning) | macOS build | Platform | XL | Apple Developer secrets in CI |
| [MDPROFILE](#4-define-the-vellum-markdown-profile) | Scope Markdown to Azure DevOps flavor | Markdown | S | — |
| [MERMAID](#5-mermaid-diagram-support) | Mermaid diagram support | Markdown | L | MDPROFILE |
| [EXPORTWIZ](#6-export-to-markdown-wizard) | "Export to Markdown…" wizard | Markdown | L | MDPROFILE |
| [TEMPLATES](#7-template-dynamic-inserts) | Template dynamic inserts | Feature | L | — |
| [MOVESECTION](#8-move-sections-between-notebooks) | Move sections between notebooks | Feature | XL | — |
| [GRAMMARBUG](#9-grammar-run-on-sentence-after-a-colon) | Run-on sentence after a colon | Bug | S | — |
| [LASTSECTION](#10-notebook-switch-should-keep-the-last-section-viewed) | Notebook switch keeps last section | UX | S | — |
| [COLORRANDOM](#11-weighted-color-randomness) | Weighted color randomness | UX | S | — |
| [WINDOWSTATE](#12-remember-window-size-and-position) | Remember window size/position | UX | S | — |
| [CODESCROLL](#13-code-blocks-should-scroll-not-wrap) | Code blocks scroll instead of wrapping | UX | S | — |

---

## Track: Platform builds

### 1. Windows ARM64 build

**Current state:** [tauri.conf.json](../src-tauri/tauri.conf.json) bundles only
`nsis` with no target triple pinned; [release.yml](../.github/workflows/release.yml)
runs a single `windows-latest` (x64) job. [resources/models.json](../src-tauri/resources/models.json)
hardcodes one Ollama artifact: `ollama-windows-amd64.zip`. `Cargo.toml`'s
`[target.'cfg(windows)'.dependencies]` (the `windows` crate for DXGI GPU
detection) is arch-agnostic — it compiles for any Windows target, ARM64 included.

**Decided: cross-compile from `windows-latest`.** MSVC's x64→ARM64 cross
compilation for Windows targets is first-class supported (not emulation), it
slots into the exact OS-matrix pattern `ci.yml` already uses, and it avoids
depending on the newer/less-proven `windows-11-arm` hosted runner pool. Your
automatic-update setup (`tauri-plugin-updater`, already wired) needs no
changes either way — this decision is purely about which build machine
produces the ARM64 artifact.

**Decided: ship Ollama's native ARM64 build.** Confirmed on Ollama's GitHub
releases: `ollama-windows-arm64.zip` exists for the same `v0.30.10` already
pinned in `models.json`
(`https://github.com/ollama/ollama/releases/download/v0.30.10/ollama-windows-arm64.zip`,
~15.3 MB — much smaller than the x64 build's ~1.36 GB because it ships without
the CUDA/ROCm GPU backends that ARM64 Windows devices don't use). Refine gets
full native support on ARM64; no emulation or degraded-mode story needed.

**Proposed approach:**
- Add the target: `rustup target add aarch64-pc-windows-msvc` + the ARM64 MSVC
  build-tools component (Visual Studio Installer → "MSVC v143 - VS 2022 C++
  ARM64 build tools"). Build with `tauri build --target aarch64-pc-windows-msvc`;
  Tauri's bundler names the NSIS installer per-arch automatically.
- CI: extend `release.yml` to a matrix (`x86_64-pc-windows-msvc`,
  `aarch64-pc-windows-msvc`) cross-compiled from `windows-latest`, the same
  pattern `ci.yml` already uses for its OS matrix.
- `tauri-plugin-updater`'s `latest.json` supports one entry per target
  (`windows-x86_64`, `windows-aarch64`, …) in a single release, so no updater
  changes are needed beyond the release workflow producing both — the in-app
  "restart to update" flow you already built keeps working as-is.
- WebView2: Microsoft ships a native ARM64 WebView2 runtime; the bootstrapper
  selects it automatically. No app-side change.
- Restructure [resources/models.json](../src-tauri/resources/models.json)'s flat
  `ollama: {...}` object into one entry per architecture, e.g.:
  ```json
  "ollama": {
    "windows-x86_64":  { "version": "v0.30.10", "url": ".../ollama-windows-amd64.zip", "sha256": "9606cee7501703a0969682667def313130f99ed73f44a88a7a8efe82d4b565f0", "sizeBytes": 1461643772 },
    "windows-aarch64": { "version": "v0.30.10", "url": ".../ollama-windows-arm64.zip", "sha256": "fe9e06480417c4ca651d1b010a3fe6654f8740ad076632a46ef3d638773888d3", "sizeBytes": 16000000 }
  }
  ```
  and have the runtime-download code (wherever it currently reads
  `manifest.ollama.url`) pick the entry keyed by `std::env::consts::ARCH`
  (`"x86_64"` / `"aarch64"` — accurate at compile time, since each installer is
  arch-specific, not a universal binary). **Before shipping, re-verify the
  ARM64 sha256/size against Ollama's published `sha256sum.txt` for that
  release** — the value above was transcribed from GitHub's rendered release
  page, not independently hashed; treat it as a starting point, not a verified
  value.
- Respect the `time` 0.3.47 pin ([CLAUDE.md](../CLAUDE.md) constraint) — adding a
  target does not touch `Cargo.lock` resolution, but never run a bare
  `cargo update` while wiring this up.

**Residual risk (not a decision — just needs real hardware):** native ARM64
hardware (or a Windows-on-ARM VM) is needed for manual verification — CI
cross-compiling only proves it *builds*, not that Ollama/process-spawn/DXGI
detection behave correctly on real ARM64 silicon.

---

### 2. macOS build (planning)

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

### 3. Linux build (planning)

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

## Track: Microsoft-flavored Markdown

### 4. Define the "Vellum Markdown Profile"

**Why first:** [MERMAID](#5-mermaid-diagram-support) and
[EXPORTWIZ](#6-export-to-markdown-wizard) both touch the Markdown layer: settle
the dialect once, then build both against it. Reference:
[Markdown Syntax for Files, Widgets, Wikis — Azure DevOps](https://learn.microsoft.com/en-us/azure/devops/project/wiki/markdown-guidance?view=azure-devops)
(wiki column = our target).

**Current state:** two independent, generic Markdown paths exist today, neither
scoped to a particular dialect:
- [export-markdown.ts](../src/lib/export-markdown.ts) — `turndown` + `turndown-plugin-gfm` (editor HTML → Markdown for "Export Page as Markdown…").
- [refine-markdown.ts](../src/lib/refine-markdown.ts) — `markdown-it` default preset (model Markdown output → HTML for the Refine preview/insert).

**Gap analysis** (current Vellum behavior vs. Azure DevOps wiki syntax):

| Feature | Vellum today | ADO wiki | Action |
|---|---|---|---|
| Paragraphs/line breaks | turndown emits blank-line paragraphs + two-trailing-space hard breaks | Same rule exactly (Enter twice = paragraph; two trailing spaces = soft break) | Verify with a round-trip test; likely already correct |
| Headings | H1–H4 only ([extensions.ts](../src/components/editor/extensions.ts) `heading: { levels: [1,2,3,4] }`) | H1–H6 | **Done — widened to H1–H6** (2026-07-14) |
| Tables | `turndown-plugin-gfm` pipe tables | Pipe tables + alignment colons | Already compatible |
| Checklists / task lists | **Done (2026-07-14)** — `TaskList`/`TaskItem` (nested) from `@tiptap/extension-list`, toolbar button + CSS | `- [ ]` / `- [x]` | **Done** — custom turndown `taskListItem` rule emits the syntax (Tiptap wraps the checkbox in `<label>`/`<div>`, so gfm's built-in rule doesn't fire; harness-verified) |
| Mermaid diagrams | **None** | Fenced ```` ```mermaid ```` block or `::: mermaid` container | See [MERMAID](#5-mermaid-diagram-support) |
| Image sizing | **Done (2026-07-14)** — emits `![alt](path =Wx)` ([export-markdown.ts](../src/lib/export-markdown.ts)) | Native `![alt](path =WxH)` syntax | **Done** — ResizableImage stores only width → `=Wx` (space before `=`, trailing `x`); path percent-encoded for spaces/parens |
| Inline HTML (`<u>`, `<span style>`, `<sup>/<sub>`, `<font>`) | Already preserved as inline HTML (WYSIWYG export) | Explicitly supported in wiki pages | Already compatible — no change |
| Code blocks | Plain fenced blocks, no language tag (spec: "no syntax highlighting in v1") | Fenced blocks + optional language id | Already compatible (renders unhighlighted, which is valid) |
| Emoji shortcodes | Not handled | `:smile:` etc. | Non-goal unless requested |
| Attachments folder | **Done (2026-07-14, single-page)** — export now writes `.attachments/` | Repo-wide `.attachments/` folder | **Done (single-page)** — backend preserves the leading dot; multi-page shared-root layout + cross-batch dedup still deferred to [EXPORTWIZ](#6-export-to-markdown-wizard) |
| `[[_TOC_]]` / `[[_TOSP_]]` / `<details>` collapsible / `::: video :::` / Boards query embeds / `@mentions` / page-visit counts | Not applicable | Wiki-server-rendered features | Non-goals — meaningless outside a live ADO wiki, **except** optionally auto-inserting `[[_TOC_]]` at the top of a multi-page export bundle (harmless plain text elsewhere) |
| Math (KaTeX) | Not handled | `$...$` / fenced ` ```KaTeX ` | Non-goal — not requested |

**Implementation note — widening headings (H1–H4 → H1–H6): done (2026-07-14).**
The `edit-heading-5.png`/`edit-heading-6.png` icons turned out to already exist
in the source pack at `assets/fugue-icons-3.5.6/icons-shadowless/` (an earlier
pass here mistakenly reported them missing — `FILENAME.txt`'s manifest just
doesn't list every file; the directory listing is the authoritative source).
Copied both into [src/assets/icons/](../src/assets/icons/) alongside 1–4, and
updated the three touch points: `heading: { levels: [1,2,3,4] }` →
`[1,2,3,4,5,6]` in [extensions.ts](../src/components/editor/extensions.ts);
the `headings` active-state selector and the button-rendering
`([1,2,3,4] as const).map(...)` in
[EditorToolbar.tsx](../src/components/editor/EditorToolbar.tsx) both widened to
`1|2|3|4|5|6`. `npm run build` (tsc + vite) verified clean.

**Implementation note — task lists, image sizing, `.attachments` (2026-07-14).**
- Task lists: `TaskList` + `TaskItem` (nested) from `@tiptap/extension-list`
  (Tiptap v3's home for them — there is no standalone `@tiptap/extension-task-list`
  package in v3; added as an explicit dep, already present transitively via
  starter-kit) wired into [extensions.ts](../src/components/editor/extensions.ts);
  a "Task list" toolbar button (`ui-check-boxes-list` icon, copied from the Fugue
  pack) in [EditorToolbar.tsx](../src/components/editor/EditorToolbar.tsx);
  checkbox-row CSS in [editor.css](../src/components/editor/editor.css). Export:
  Tiptap wraps the checkbox in `<label>`/`<div>` inside `<li data-type="taskItem">`,
  so turndown-plugin-gfm's built-in checkbox rule (which expects the checkbox
  directly in the `<li>`) never fires — a custom `taskListItem` rule in
  [export-markdown.ts](../src/lib/export-markdown.ts) reads `data-checked` and
  emits `- [ ]`/`- [x]` (turndown's `addRule` prepends, so it wins over the
  built-in `listItem` rule). Refine's markdown-it path is left as-is (a `- [ ]`
  renders as plain text — out of scope, degrades gracefully).
- Image sizing: `exportImage` now emits `![alt](path =Wx)` (ResizableImage
  stores only width; ADO wants a space before `=`, no space around `x`, and a
  trailing `x` for width-only). Paths are percent-encoded for spaces/parens
  (`%20`/`%28`/`%29`) instead of angle-bracketed, matching ADO's plain form so
  the size suffix parses.
- `.attachments`: single-page export writes to `.attachments/` (was
  `<md-stem> files/`). The backend `export_page`
  ([commands.rs](../src-tauri/src/commands.rs)) preserves the leading dot (the
  shared `sanitize_attachment_name` strips it, which is correct for file names).
  Multi-page shared-root layout + cross-batch dedup remain with
  [EXPORTWIZ](#6-export-to-markdown-wizard).
- Verified: `npm run build` + `cargo check` clean; a throwaway turndown harness
  (real turndown + gfm via domino) asserted the task-list/image/paragraph output,
  then was deleted.

**Deliverable for this item specifically:** the self-contained dialect gaps
shipped (2026-07-14) — task lists, ADO image-size syntax, and the `.attachments`
folder for single-page export (see the implementation note above);
[Vellum_spec.md](Vellum_spec.md) Section 6 was updated for the editor-feature
changes (H1–H6, task lists). The remaining dialect specifics (export folder
layout, mermaid) fold into the spec once [MERMAID](#5-mermaid-diagram-support)
and [EXPORTWIZ](#6-export-to-markdown-wizard) ship, per
[CLAUDE.md](../CLAUDE.md)'s "update the spec when a decision changes it."

---

### 5. Mermaid diagram support

**Current state:** no Mermaid support anywhere (`mermaid` does not appear in
the codebase). No `mermaid` npm package installed.

**Proposed approach:**
- New Tiptap node (`MermaidDiagram`, modeled on
  [ResizableImage.tsx](../src/components/editor/ResizableImage.tsx)'s NodeView
  pattern) storing the raw diagram source as node text/attrs.
- NodeView renders the source through the `mermaid` package into inline SVG,
  live-updating on edit, with an explicit error/invalid-syntax state (don't let
  a bad diagram crash the editor).
- Authoring UX: an "Insert ▸ Mermaid Diagram" entry in
  [MenuBar.tsx](../src/components/MenuBar.tsx) `insertItems()` (next to the
  existing Table entry) inserting a small starter template; click-to-edit
  toggles between rendered SVG and a raw-source textarea/popover.
- Markdown mapping: export emits a fenced ```` ```mermaid ```` block (portable —
  works with plain fenced-code-block conventions, not just the `:::` container
  syntax); paste/import of a ```` ```mermaid ```` fenced block parses into the
  node.
- Mermaid.js renders to pure SVG in-DOM, so it should behave identically across
  WebView2/WKWebView/WebKitGTK — low cross-platform risk once
  [MACOS](#2-macos-build-planning)/[LINUX](#3-linux-build-planning) land.
- Print: [print-page.ts](../src/lib/print-page.ts) builds from `editor.getHTML()`
  into an iframe — confirm the rendered SVG survives that HTML round-trip (or
  re-render mermaid inside the print iframe from the raw source if not).

**Explicit non-goal for v1:** live-rendering Mermaid blocks that a Refine
template generates ([refine-markdown.ts](../src/lib/refine-markdown.ts) uses
plain `markdown-it`, which will render a ` ```mermaid ` fence as an inert code
block). Fine to defer — only the manually-inserted node needs live rendering
at first.

---

### 6. "Export to Markdown…" wizard

**Current state:** [MenuBar.tsx](../src/components/MenuBar.tsx) has a single
"Export Page as Markdown…" item, current-page-only, wired to
`exportCurrentPage()` → backend `export_page` (per
[Vellum_spec.md §14](Vellum_spec.md), source paths validated against the notebook
dir, dest names sanitized). [export-markdown.ts](../src/lib/export-markdown.ts)
already has `sanitizeFilename`/`uniqueName` collision-avoidance helpers that a
batch export can reuse.

**Proposed approach:**
- Rename the menu item to **"Export to Markdown…"**; it opens a new wizard
  modal instead of jumping straight to a save dialog.
- Wizard steps: **(1) Scope** — Current Page (default) / Choose Pages… (checklist)
  / Entire Section / Entire Notebook. **(2) Destination** — single-file save
  dialog for one page (unchanged today), folder-picker for anything multi-page.
  **(3) Options** — pull from the [MDPROFILE](#4-define-the-vellum-markdown-profile)
  decisions (attachments-folder convention, optional `[[_TOC_]]` insertion).
  **(4) Run** — progress for many pages, then a completion summary with an
  "Open folder" button.
- Folder layout for Section/Notebook scope:
  `<Destination>/<Notebook>/<Section>/<Page>.md`, with **one shared
  `.attachments/` folder at the export root** (matching a real Azure DevOps
  wiki repo layout, per the now-decided [MDPROFILE](#4-define-the-vellum-markdown-profile)
  convention) rather than a folder per page — extend the existing
  `uniqueName` collision helper to dedupe across the *whole* batch, not just
  within one page's files. Single-page export keeps the same `.attachments`
  naming, just scoped to that one page.
- **Key technical unblock — exporting pages that aren't open:** the frontend
  turndown pipeline only has a live Tiptap instance for the *currently open*
  page. Reuse the pattern [welcome-content.ts](../src/data/welcome-content.ts)
  already proves in reverse (`generateJSON(html, buildExtensions())` at seed
  time): call **`generateHTML(contentJson, buildExtensions())`** (from
  `@tiptap/react`) per page fetched via the existing content-read API, entirely
  headless — no editor needs to mount. This keeps one Markdown-conversion code
  path (frontend turndown) instead of duplicating it in Rust.
- Backend: either generalize `export_page` to accept multiple page IDs, or add
  an `export_batch` command that loops the same per-page copy/write helper.

**Decided:** the "insert `[[_TOC_]]`" checkbox for multi-page bundles defaults
to **off** (per your go-ahead on the recommendation) — it's ADO-wiki-specific
syntax that's inert noise in a plain Markdown viewer.

---

## Track: Content features

### 7. Template dynamic inserts

**Current state:** per [Vellum_spec.md §7](Vellum_spec.md), page templates
store `content_json` in `app.json` (app-level) and the backend `create_page`
command copies it verbatim into a new page's first snapshot. Placeholder text
today is **plain, manually-replaced** text like `[Client Name]`, `[Date]` — no
substitution mechanism exists.

**Decided: two kinds of placeholder.** Most tokens (`PageTitle`, `SectionName`,
`NotebookName`, and non-live date/time) substitute **once, at creation time**.
Date/Time additionally get a **live-updating** variant — the placeholder
survives as real content and re-evaluates every time the page is opened,
similar to a Word field code. That's a bigger feature than plain text
substitution: a live value can't just be written into the text once (that
would freeze it), so it needs to be its own thing in the document, not a string.

**Token syntax** (refining your `{CurrentDateLive,MMDDYYHH:MM}` idea onto one
consistent delimiter — double curly braces everywhere, comma-separated
optional format):
- One-shot: `{{PageTitle}}`, `{{SectionName}}`, `{{NotebookName}}`,
  `{{CurrentDate}}`, `{{CurrentTime}}`, `{{CurrentDateTime}}` — stamps the
  value at creation time, then it's just ordinary text forever after.
- Live: `{{CurrentDateLive}}`, `{{CurrentTimeLive}}`, `{{CurrentDateTimeLive}}`,
  each with an optional format parameter, e.g. `{{CurrentDateLive,MM/DD/YYYY}}`
  — falls back to a sensible default format (locale short date) when omitted.
  "Live" means *re-evaluated whenever the page loads*, not a ticking clock
  while you sit looking at it — flag if you actually want the latter (a
  bigger feature still: a `setInterval` re-render while the page stays open).

**Proposed approach:**
- **One-shot tokens:** substitute in the backend `create_page` path
  (notebook.rs/commands.rs) — walk the template's Tiptap JSON tree, replacing
  `{{Token}}` occurrences inside text-node `.text` strings only (never touch
  `type`/`attrs`), before writing the new page's first snapshot. `{{PageTitle}}`
  resolves to whatever default title `create_page` is given (e.g. "New Page"),
  since the user typically renames *after* creation — accepted as-is, since
  it's the "for the most part, one-shot" case.
- **Live tokens:** a new inline atomic Tiptap node (e.g. `dynamicField`, attrs
  `{ kind, format? }`), rendered via a NodeView (same pattern as
  [ResizableImage.tsx](../src/components/editor/ResizableImage.tsx)) that
  computes its display text from `kind`/`format` fresh every time it mounts —
  i.e. every page load. It's non-editable as plain text (a small chip/pill,
  similar to a mention), inserted from the template editor's placeholder
  dropdown. Critically, the one-shot text-substitution walk above must **skip**
  `dynamicField` nodes entirely — they carry over into the new page's
  `content_json` unchanged and keep re-evaluating live from then on, in the
  template *and* in every page created from it.
- Markdown export: a live field has no meaning in a static `.md` file, so
  export flattens it to its current computed value as plain text at export
  time (same idea as a one-shot token, just resolved later).
- Frontend: the template editor
  ([PageTemplatesManager.tsx](../src/components/settings/PageTemplatesManager.tsx))
  gets an "Insert placeholder" dropdown listing both one-shot tokens (inserted
  as literal text) and live fields (inserted as the new node), so authors
  don't need to hand-type the syntax.

**Sizing note:** this is now closer to **L** than the original **M** — the
live half is a real new node type with a NodeView, in the same complexity
class as [MERMAID](#5-mermaid-diagram-support), not just a text find/replace.

---

### 8. Move sections between notebooks

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

## Track: Bug fixes & UX polish

### 9. Grammar: run-on sentence after a colon

**Root cause (found):** [grammar.ts](../src/components/editor/grammar.ts)
`extractText()` joins separate block/paragraph texts with a **single `\n`**
so Harper sees paragraph boundaries at all. When a paragraph ends with a colon
and the next paragraph starts a new sentence — e.g. `"Overview:"` [Enter]
`"This is the next sentence."` — the flattened text becomes
`"Overview:\nThis is the next sentence."` A colon doesn't grammatically end a
sentence, and a single `\n` likely isn't a strong enough boundary signal for
Harper's sentence tokenizer to treat the two paragraphs as separate sentences,
so it flags the whole span as one run-on sentence.

**Proposed approach:**
- Try inserting a stronger paragraph-boundary marker between blocks — e.g. two
  newlines (`\n\n`, a conventional "hard" paragraph break in most sentence
  tokenizers) instead of one — and verify against harper-core's actual
  behavior with a unit test (mirroring the existing spelling test at
  [grammar.rs](../src-tauri/src/grammar.rs)#L189) using a colon-ended paragraph
  followed by a new one.
- `mapOffset`'s binary search operates on `segments[].textStart`/`.length` and
  treats anything between segments as "a gap" generically — widening the
  inter-block separator from 1 to 2 characters doesn't need any change there,
  but re-verify offset mapping at block boundaries after the change (adjacent
  same-parent text nodes should still map to identical positions, per the
  function's own doc comment).
- If a wider separator alone doesn't change Harper's behavior, the fallback is
  sentence-aware chunking: lint each block/paragraph as an independent Harper
  document rather than one flattened string — bigger change, only pursue if
  the simple separator fix doesn't resolve it.

---

### 10. Notebook switch should keep the last section viewed

**Root cause (found):** [vellum.tsx](../src/state/vellum.tsx) `selectNotebook()`:
```ts
const cur = ref.current.selectedSectionId;
const keep = cur && sections.some((sec) => sec.id === cur) ? cur : null;
const target = keep ?? sections[0]?.id ?? null;
```
`cur` is whatever section was selected in the *previous* notebook. Section IDs
are UUIDs unique per notebook, so `cur` essentially never matches an ID in the
newly-selected notebook's section list — `keep` is always `null` when actually
switching notebooks, and `target` always falls through to `sections[0]`. (This
check only ever does something on a same-notebook no-op re-select.)

**Proposed approach:** persist a **per-notebook** "last section" map, mirroring
the existing `readLastPage`/`writeLastPage` localStorage pattern
(`vellum.tsx` lines ~245-258) which already does exactly this for pages within
a section. Add `readLastSection(notebookId)`/`writeLastSection(notebookId,
sectionId)` over a `notebookId → sectionId` map, and in `selectNotebook`, when
the current global `selectedSectionId` doesn't belong to the target notebook,
look up that notebook's own last-viewed section (falling back to
`sections[0]` only if the saved one no longer exists) instead of relying on
the cross-notebook `cur` check. Write to it alongside the existing
selection-persistence effect (~line 556) so it doesn't need a second effect.

---

### 11. Weighted color randomness

**Root cause (found):** [palette.ts](../src/data/palette.ts)
`randomPaletteColor()` is a uniform `Math.floor(Math.random() * PALETTE.length)`
pick with no memory of recent picks — called independently for every new
notebook/section (4 call sites in
[vellum.tsx](../src/state/vellum.tsx): `createNotebook`, `createSectionWithPage`,
and two more). True uniform randomness *feels* non-random to people (the
classic "shuffled iPod playlist" complaint) — short streaks of repeats are
statistically normal but read as broken.

**Proposed approach:** replace the uniform pick with a **shuffle bag**: shuffle
the palette once, hand out colors from the front, reshuffle only once the bag
is exhausted. This guarantees no color repeats until every other color has
been used at least once, which directly matches "weight it so something else
gets picked" — and it's a well-known, simple, correct fix for this exact
complaint (no probability tuning to get wrong). Implement as module-level
state in `palette.ts` (resets on app restart, which is fine — this is a UX
nicety, not persisted data), replacing the body of `randomPaletteColor()`
without changing its signature or call sites.

---

### 12. Remember window size and position

**Current state:** [tauri.conf.json](../src-tauri/tauri.conf.json) hardcodes
`width: 1200, height: 800, center: true` with no persistence.
[useWindowMaximized.ts](../src/components/useWindowMaximized.ts) only tracks
*maximized* state for corner-rounding/glass-frame purposes — it doesn't
persist size/position at all. No `tauri-plugin-window-state` dependency exists
today.

**Proposed approach:**
- Adopt `tauri-plugin-window-state` (official Tauri plugin) — it automatically
  saves size/position/maximized state on move/resize/close and restores it on
  next launch, needing only registration in `lib.rs` + a
  `window-state:default` capability entry, rather than hand-rolling
  `onMoved`/`onResized` listeners and a save file.
- Remove (or make conditional on "no saved state exists yet") the hardcoded
  `center: true` so a returning user's position isn't overridden every launch —
  center only applies to a genuinely first-ever launch.
- Storage location: this is machine-local UI state, not user data — it should
  live under `%LOCALAPPDATA%` like the diagnostic log
  ([paths.rs](../src-tauri/src/paths.rs) `log_file_path`), **not** under the
  OneDrive-synced `Documents\Vellum`, since two machines legitimately have
  different screen geometries. Confirm the plugin's default store location
  matches this (it uses the app's local data dir by default) rather than
  assuming.

---

### 13. Code blocks should scroll, not wrap

**Done (2026-07-14):** implemented as proposed.
[editor.css](../src/components/editor/editor.css) `.v-prose pre` now declares
`white-space: pre; overflow-wrap: normal; word-break: normal;` alongside the
existing `overflow-x: auto`, and a higher-specificity `.ProseMirror.v-prose pre`
rule re-asserts those three to beat prosemirror-view's base
`.ProseMirror pre { white-space: pre-wrap }` (equal specificity to `.v-prose
pre`, so it could otherwise win on stylesheet load order). Verified the
contenteditable carries **both** classes — prosemirror-view merges ours onto its
own (`class="ProseMirror v-prose"`) in `computeDocDeco`
([index.js](../node_modules/prosemirror-view/dist/index.js) `attrs.class += " "
+ value`), so the qualified selector reliably wins. Inline `code` and the print
path ([print-page.ts](../src/lib/print-page.ts), which wraps on purpose) are
untouched; the Refine preview reuses `.v-prose` and picks up the base rule for
consistency. `npm run build` (tsc + vite) clean.

**Current state:** fenced code blocks (`<pre>`, from StarterKit's `codeBlock`
node — kept monospace with no syntax highlighting per
[Vellum_spec.md](Vellum_spec.md) v1) already *intend* to scroll:
[editor.css](../src/components/editor/editor.css) `.v-prose pre` sets
`overflow-x: auto`. But that rule is dead in practice — long lines wrap instead
of overflowing, so the horizontal scrollbar never appears.

**Root cause (found):** prosemirror-view ships a base stylesheet
([prosemirror.css](../node_modules/prosemirror-view/style/prosemirror.css)) that
sets `.ProseMirror { white-space: break-spaces; word-wrap: break-word; }` and,
more specifically, `.ProseMirror pre { white-space: pre-wrap; }`. The
contenteditable root carries **both** the `ProseMirror` class (added by Tiptap)
and our `v-prose` class ([PageEditor.tsx](../src/components/editor/PageEditor.tsx)
`attributes: { class: "v-prose", ... }`), so every code block is matched by both
`.ProseMirror pre` and `.v-prose pre`. Since `.v-prose pre` never declares
`white-space`, the base rule's `pre-wrap` wins and lines wrap — which is exactly
why `overflow-x: auto` has nothing to overflow.

**Proposed approach:**
- In [editor.css](../src/components/editor/editor.css), give `.v-prose pre`
  (and `.v-prose pre code`) an explicit `white-space: pre;` plus
  `overflow-wrap: normal; word-break: normal;` to defeat the inherited
  `word-wrap: break-word`, keeping the existing `overflow-x: auto`. The block
  then becomes a horizontally scrollable window for long lines.
- **Watch specificity/source order:** `.v-prose pre` and `.ProseMirror pre`
  have equal specificity (one class + one element), so the override only wins
  if editor.css loads *after* prosemirror-view's base CSS. If that ordering
  isn't guaranteed, bump specificity slightly (e.g. `.ProseMirror.v-prose pre`,
  since the root element carries both classes) rather than reaching for
  `!important`.
- **This is code *blocks* only.** Inline `code` (`.v-prose code`) should keep
  flowing with the surrounding text — don't give it `white-space: pre` or a
  scrollbar. The "inline… word wrap" phrasing refers to the block's content
  wrapping within the page width, not to inline spans.

**Explicit non-goals / leave-alone:**
- **Print keeps wrapping.** [print-page.ts](../src/lib/print-page.ts) sets
  `.v-print-content pre { white-space: pre-wrap; word-wrap: break-word; }` on
  purpose — paper has no horizontal scrollbar, so wrapping is correct there.
  This change is on-screen only; don't touch the print path.
- **Refine preview inherits the fix for free.**
  [RefinePreviewModal.tsx](../src/components/editor/RefinePreviewModal.tsx)
  reuses the `v-prose` class, so its code blocks scroll too — desirable for
  consistency, no extra work.

**Verification:** paste a code block with a line wider than the editor and
confirm a horizontal scrollbar appears (no wrapping); confirm short lines and
inline code are visually unchanged; confirm print still wraps.

---

## Suggested sequencing

Not a hard dependency chain except where noted — reorder freely by priority.

1. **Quick independent wins:** [LASTSECTION](#10-notebook-switch-should-keep-the-last-section-viewed),
   [COLORRANDOM](#11-weighted-color-randomness), [WINDOWSTATE](#12-remember-window-size-and-position),
   [CODESCROLL](#13-code-blocks-should-scroll-not-wrap),
   [GRAMMARBUG](#9-grammar-run-on-sentence-after-a-colon) (needs a bit of
   experimentation to confirm the Harper fix).
2. **Markdown profile decision** ([MDPROFILE](#4-define-the-vellum-markdown-profile)) —
   small effort, unblocks the next two.
3. **Mermaid** and **Export wizard** ([MERMAID](#5-mermaid-diagram-support),
   [EXPORTWIZ](#6-export-to-markdown-wizard)) — can proceed in parallel once
   MDPROFILE lands; doing Mermaid first means the wizard's first release
   already round-trips diagrams.
4. **Template dynamic inserts** ([TEMPLATES](#7-template-dynamic-inserts)) —
   independent, slot in anytime; the live-field half pairs naturally with
   Mermaid (same "new Tiptap node + NodeView" shape of work).
5. **Platform builds:** [ARM64](#1-windows-arm64-build) first (smallest, same
   OS/toolchain, decisions already locked in), then
   [LINUX](#3-linux-build-planning) (AppImage, no signing friction), then
   [MACOS](#2-macos-build-planning) last — product decisions are resolved now,
   but it's still the largest net-new engineering surface (vibrancy, hardware
   detection, a new CI job, and the notarization pipeline all at once) plus a
   logistics dependency (Apple Developer secrets in CI).
6. **Move sections between notebooks** ([MOVESECTION](#8-move-sections-between-notebooks)) —
   the largest, riskiest item (cross-database migration). Schedule it
   deliberately with dedicated testing, independent of everything else above.

## Decisions log

All 11 originally-open decisions were resolved on 2026-07-14 — see the
relevant item's section above for the full reasoning behind each.

| # | Decision | Resolution |
|---|---|---|
| 1 | ARM64 CI strategy | Cross-compile on `windows-latest` |
| 2 | Ollama native ARM64 build | Confirmed available (`ollama-windows-arm64.zip`) — ship it |
| 3 | macOS signing | Full notarization (Apple Developer account available) |
| 4 | macOS menu bar | Same custom in-window `MenuBar.tsx` everywhere |
| 5 | macOS titlebar | Keep the Windows-style layout (themes planned later) |
| 6 | Linux packaging | AppImage for v1 (keeps the updater consistent); Flatpak flagged as a later, separate-update-mechanism channel |
| 7 | Attachments folder convention | Adopt ADO's `.attachments/` |
| 8 | Heading levels | Widen to H1–H6 — **done** (2026-07-14; icons existed in the source pack, see [MDPROFILE](#4-define-the-vellum-markdown-profile)) |
| 9 | `[[_TOC_]]` auto-insert default | Off |
| 10 | Template placeholders | One-shot by default; Date/Time also get a live-updating variant (new node type) |
| 11 | Move-section confirmation | Required, via the existing `ask()` dialog pattern |

**Residual open items** (small, non-blocking):
- Whether ARM64 Linux is in scope at all (defaulting to x86_64-only unless
  you say otherwise).
- Exact live-field format-token vocabulary (`MM/DD/YYYY` style vs. something
  else) — proposed a small preset list in the template editor rather than
  requiring hand-typed format strings; refine at implementation time.
