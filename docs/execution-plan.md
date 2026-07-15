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
plus three open features — **move sections between notebooks**, **importing
documents into notebooks**, and **scoped proofreading** (per-notebook, section,
and page).

## At a glance

| ID | Item | Track | Size | Depends on |
|---|---|---|---|---|
| [MACOS](#1-macos-build-planning) | macOS build _(deferred)_ | Platform | XL | Apple Developer secrets in CI |
| [LINUX](#2-linux-build-planning) | Linux build _(deferred)_ | Platform | L | — |
| [MOVESECTION](#3-move-sections-between-notebooks) | Move sections between notebooks | Feature | XL | — |
| [IMPORT](#4-import-documents-into-notebooks) | Import documents (Markdown + more) into notebooks _(shipped)_ | Feature | L | — |
| [PROOFSCOPE](#5-scoped-proofreading-per-notebook-section-page) | Scoped proofreading (per-notebook, section, page) _(shipped)_ | Editing | M | — |

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

### 4. Import documents into notebooks

**Shipped ([Unreleased], 2026-07-14).** Built end to end: **File ▸ Import
documents…** → `src/components/ImportWizard.tsx` + the conversion library
`src/lib/import-document.ts`, backed by three new commands (`import_scan_folder`,
`import_read_file`, `import_copy_external_image` in
[commands.rs](../src-tauri/src/commands.rs), registered in
[lib.rs](../src-tauri/src/lib.rs)). New deps: `mammoth` (lazy) +
`markdown-it-task-lists`. Folded into spec §14 (renamed **Export / Import /
Print**) and §16 corrected, per [CLAUDE.md](../CLAUDE.md).

**Decisions taken (maintainer, 2026-07-14):** (a) formats = Tier 1 (Markdown /
HTML / text) **+ DOCX** via `mammoth`; PDF / RTF deferred, OneNote out. (b) **Both**
single-file **and** folder / round-trip (ADO wiki) import in v1. (c) Destination =
wizard-chosen notebook + section (folder import creates sections, never
notebooks). (d) Page title = first `# H1`, stripped from the body, else the
filename. (e) **No** confirmation dialog — the wizard + a progress / summary, since
import only creates pages.

**Verified:** `cargo check` + `cargo test` (4 new backend tests, incl. the
traversal-confinement guard) + `npm run build` all green; a throwaway harness
asserted the conversion pipeline (ADO `=Wx` rewrite, `[[_TOC_]]` strip, task-list
classes, mermaid fence → node, H1 title extraction, `javascript:`/non-image-`data:`
sanitising, data-URI decode, image re-homing) then was deleted. **Residual:** the
wizard UI + a real DOCX/folder import weren't eyeballed at runtime (env can't
launch the native window).

**New (2026-07-14) — the mirror of the Export-to-Markdown wizard: bring outside
documents *in* as pages.** Markdown is the primary target; the ask is to ingest
other document types too. This is currently *out of scope* per
[Vellum_spec.md](Vellum_spec.md) §16, which lists "OneNote import" and a now-stale
"Markdown / HTML / PDF export" (Markdown export actually shipped in Phase 10 /
§14). This item supersedes the import line the same way export did; when it
ships, fold the decision back into §14 (rename to "Export / Import / Print") and
correct §16, per [CLAUDE.md](../CLAUDE.md).

**The good news — most of the machinery already exists.** Import is export run
backwards, and the reverse-direction tools are already in the tree:
- **`markdown-it` ^14.2.0 is already a dependency** (Refine renders model
  Markdown → HTML via `renderMarkdown` in
  [refine-markdown.ts](../src/lib/refine-markdown.ts)). Markdown → HTML is exactly
  the front half of import.
- **Tiptap already goes HTML → document JSON** via
  `generateJSON(html, buildExtensions())` (the same call that seeds the welcome
  notebook; verified working against the shared schema). So the core path is
  `markdown-it → HTML → generateJSON → save_page_snapshot`, reusing
  [extensions.ts](../src/components/editor/extensions.ts) `buildExtensions()` —
  the very schema export / print / headless-convert already lean on.
- The write commands import needs to *call* already exist in
  [commands.rs](../src-tauri/src/commands.rs): `create_section`, `create_page`
  (+ `save_page_snapshot`), `save_page_image` (writes
  `attachments/<page>/<uuid>.<ext>`, returns the notebook-relative src),
  `add_attachment`, and `index_page` (search reindex).

So a **Markdown-only import is genuinely a Medium**; the "more document types"
ambition is what grows it to L.

**Proposed format tiers** (ship Tier 1 first; Tier 2 is the headline "more types"):

| Tier | Formats | How | New dep? |
|---|---|---|---|
| 1a | Markdown (`.md`, `.markdown`) | `markdown-it` → HTML → `generateJSON` | none |
| 1b | HTML (`.html`, `.htm`), plain text (`.txt`) | HTML straight to `generateJSON`; text wrapped in paragraphs | none |
| 2 | Word (`.docx`) | `mammoth` (DOCX → HTML) → `generateJSON` | `mammoth` |
| — _(defer)_ | PDF, RTF, OneNote (`.one`) | see below | — |

- **DOCX via `mammoth`** is the natural "more types" win. Confirmed on npm:
  **BSD-2-Clause**, ~4.4M weekly downloads, actively maintained (v1.12.0), ships
  a browser build (`mammoth.browser.js`) that takes an `{ arrayBuffer }` and
  returns a clean semantic HTML fragment (headings, lists, tables,
  bold/italic/underline/strike/sup/sub, links, images), with a `convertImage`
  hook we can point at `save_page_image` to re-home embedded images instead of
  inlining huge `data:` URIs. Excellent match for the Tiptap schema.
- **Defer PDF** — extraction is lossy (PDF has no reliable block structure;
  `pdf.js` recovers text but not headings/lists/tables), and it clashes with §16
  already excluding PDF *export*. **Defer RTF** (niche). **Keep OneNote out** —
  `.one` is an undocumented proprietary binary format reachable only via
  Microsoft's Graph / OneNote APIs; a project of its own (§16 already excludes it).

**Round-trip / folder import (recommended, symmetric with the export wizard).**
Because export lays a notebook out as `<Notebook>/<Section>/<Page>.md` with a
shared `.attachments/` (the Azure DevOps wiki convention), importing a *folder*
of Markdown should reconstruct that structure: subfolders → sections, `.md`
files → pages, image/link references resolved against the folder (incl.
`.attachments/`). This also makes Vellum a clean importer for existing **ADO
wiki** repos. Single-file import (the common case) just lands as one new page.

**Proposed architecture (mirror of export's frontend-converts / backend-writes
split):**
- **Frontend** owns the dialog + parse/convert (as export owns turndown): a new
  `ImportWizard.tsx` mirroring [ExportWizard.tsx](../src/components/ExportWizard.tsx)
  — pick file(s) or a folder via `open()` (`multiple` / `directory`;
  `dialog:allow-open` is **already granted** from the export folder picker),
  pick the destination (target notebook + section, defaulting to the current
  selection), then convert each source to document JSON. New `src/lib/import-*.ts`
  modules parallel to [export-markdown.ts](../src/lib/export-markdown.ts).
- **Backend** owns filesystem reads + writes (as `export_page` / `export_batch`
  own writes). A picked source lives *outside* `Documents\Vellum` and its
  referenced images are relative to it, so the backend must read arbitrary picked
  paths — plain `std::fs`, which needs no capability for our own commands and
  avoids wiring `plugin-fs` scopes on the frontend. Proposed commands:
  `import_read_source(path)` and `import_copy_external_image(notebookId, pageId,
  srcAbsPath) -> notebookRelSrc` (a `save_page_image` sibling that copies from an
  arbitrary on-disk path). Registered in [lib.rs](../src-tauri/src/lib.rs),
  wrapped in [api.ts](../src/data/api.ts) per the repo's 3-place command convention.
- **Order per page:** `create_page` → for each referenced/embedded image, copy
  bytes into `attachments/<newPage>/…` and rewrite the node `src` →
  `save_page_snapshot(json, preview)` → `index_page`. (Same
  create-then-image-then-save ordering paste already uses.) Sections are created
  first when a folder import needs them.

**Markdown-dialect fidelity (so an exported page round-trips).** Export emits the
ADO/GFM dialect; import should read the same one:
- **Tables + strikethrough** — on by default in `markdown-it`. ✅
- **Task lists** (`- [ ]` / `- [x]`) — *not* built into `markdown-it`; add
  `markdown-it-task-lists` (MIT) or a small custom rule. (Note: Refine
  deliberately skips task lists — see repo gotchas — but import wants them.)
- **ADO image size** `![alt](path =Wx)` — `markdown-it` won't parse the `=Wx`
  suffix; needs a small rule / post-process to strip it and set the
  `ResizableImage` width.
- **`mermaid` fenced blocks** — map a ```` ```mermaid ```` fence to a
  `MermaidDiagram` node, not a plain code block.
- **Preserved inline HTML** (highlight / sup / sub / underline / colour /
  alignment that export keeps as raw HTML) — needs `markdown-it({ html: true })`,
  unlike Refine's `html: false`. Safe *only* because it is parsed through the
  Tiptap schema (below), which drops anything not in `buildExtensions()`.

**Security (OWASP — untrusted document input).**
- Never inject imported HTML into the live DOM. Convert via `generateJSON` /
  schema parse only, which allow-lists to known nodes/marks and won't execute
  scripts or keep unknown attributes.
- Sanitize link/image targets: strip `javascript:` / `vbscript:` and non-image
  `data:` URIs from hrefs. `mammoth`'s own docs warn it does **no** sanitization
  and can emit `javascript:` links; `markdown-it` with `html:true` can carry them
  too.
- Keep `mammoth`'s `externalFileAccess` at its default (off). Validate that
  folder-import paths stay within the chosen root (no `..` traversal — mirror the
  guards in `export_batch` / `open_attachment`).

**Open decisions (need maintainer input — nothing built yet):**
1. **Format scope for v1** — Tier 1 (MD / HTML / txt) only, or include DOCX
   (Tier 2)? _Recommend Tier 1 + DOCX._
2. **Folder / round-trip import** in v1, or single-file only first? _Recommend
   single-file first, folder import as a fast follow (high value, low extra risk)._
3. **Where imports land** — always the current section, or a wizard-chosen
   notebook + section (and does a multi-file / folder import ever create a new
   notebook)? _Recommend a wizard-chosen destination; folder import may create
   sections but not notebooks._
4. **Page-title source** — first `# H1` in the doc, else the filename? _Recommend
   first H1 else filename, stripping the consumed H1 to avoid a duplicate
   title-in-body._
5. **Confirmation** — import is additive (new pages; no data-loss risk unlike
   MOVESECTION), so likely no `ask()` confirm, just the wizard + a progress /
   summary phase. _Confirm this is acceptable._

**Open risks / notes:**
- Import is **non-destructive** (only creates), so crash-safety is far simpler
  than MOVESECTION — worst case is a partially-created page recoverable via a
  normal delete. Still, drive a large multi-file / folder import with progress
  (reuse the export wizard's `running` / `done` / `error` phases).
- Lossy by nature for rich formats (DOCX especially — `mammoth` intentionally
  drops non-semantic styling; complex tables / footnotes degrade). Set
  expectations in the wizard and surface `mammoth`'s `messages` warnings.
- New deps to add: `mammoth` (TypeScript types are built in) and
  `markdown-it-task-lists` (+ `@types/markdown-it-task-lists` if needed). Respect
  the ERESOLVE / hand-add-to-`package.json` lock quirk noted for the Tiptap deps
  in the repo gotchas.
- Bundle size: `mammoth.browser` is sizeable — import it **lazily** (dynamic
  `import()` inside the DOCX path) so it never loads unless someone imports a
  `.docx`, in the spirit of Mermaid's lazy chunks.

---

## Track: Editing UX

### 5. Scoped proofreading (per-notebook, section, page)

**Shipped ([Unreleased], 2026-07-15; revised same day on maintainer feedback).**
Backend: migration 7 adds tri-state `grammar_pref` / `spell_pref` columns
(NULL = inherit, 0 = off, 1 = on) to `sections` + `pages`
([db.rs](../src-tauri/src/db.rs)) — superseding the first cut's single
`proofing_suppressed` flag (migration 6, left as a dead column since a dev DB may
already sit at v6); `Section`/`Page` carry the prefs + their list `SELECT`s, plus
`set_section_proofing` / `set_page_proofing`
([notebook.rs](../src-tauri/src/notebook.rs)); `NotebookMeta` gains `grammar_pref`
/ `spell_pref` ([config.rs](../src-tauri/src/config.rs)); three commands
registered in [lib.rs](../src-tauri/src/lib.rs). **No `grammar.rs` change**
(Harper is context-free) — but `extractText` now **skips code blocks and inline
code**, so code is never proofed. Frontend: effective grammar/spell resolve
**most-specific-wins** under the global master (`resolveProofing` in
[src/lib/proofing.ts](../src/lib/proofing.ts); the `proofing` selector in
`vellum.tsx`) and gate `PageEditor`'s `runGrammar` toggles; **Tools ▸ Proofread**
is a This Page / Section / Notebook submenu, each with **independent Grammar +
Spelling** toggles (built by `buildProofreadMenu`); the toolbar **badge** is a
plain one-click button that re-enables all proofreading for just the open page.
**Broader scopes are authoritative** — setting a section clears its pages'
overrides and setting a notebook clears all its sections'/pages' overrides — so a
badge-set page override can't get stuck (fixes a maintainer-reported
stickiness bug). Verified: `cargo check` + `cargo test` (3 new tests) +
`npm run build` + a throwaway harness for `resolveProofing` / code-exclusion, all
green.
**Residual:** the submenu + badge weren't eyeballed at runtime (env can't launch
the native window). Folded into spec §10 + CHANGELOG.

**Decisions (autonomous, = the recommendations below, refined on feedback):**
(1) grammar + spelling **independent per scope** (tri-state, 6 prefs); (2)
**most-specific-wins** — a page can override its section/notebook (not
suppress-only); (3) Tools submenu + a plain one-click badge button; (4)
per-notebook prefs in the `notebooks.json` registry; (5) **no** Properties-dialog
surface (Tools menu + badge only); (6) code is never proofed; (7) broader scopes
are **authoritative** — setting a section/notebook clears narrower overrides.

**Current state.** Spelling and grammar are a **single global pair of toggles** —
`grammar_enabled` + `spellcheck_enabled` in [config.rs](../src-tauri/src/config.rs)
`AppSettings` (persisted in `app.json`). They are set from **two** places today:
the **Tools menu** ("Check Spelling" / "Check Grammar" in
[MenuBar.tsx](../src/components/MenuBar.tsx)) and **Settings ▸ Proofing**
([ProofingSettings.tsx](../src/components/settings/ProofingSettings.tsx)). Those
Tools-menu entries are the redundant pair worth repurposing — Settings ▸ Proofing
already owns the global master toggles (plus the custom dictionary and
ignored-rules lists).

**The enabling insight — this is a frontend + persistence job, not an engine
change.** Harper is **context-free**: [PageEditor.tsx](../src/components/editor/PageEditor.tsx)
`runGrammar` sends the open page's plain text to `api.grammarCheck(text)` and gets
back offset spans; the backend ([grammar.rs](../src-tauri/src/grammar.rs)) has no
notion of which notebook/section/page the text came from. The on/off decision is
already a pure frontend gate — `runGrammar` early-returns and calls
`clearGrammarLints` when both toggles are off, and `mapLints` filters per toggle.
So scoping means only (a) **persisting** a per-scope flag and (b) computing an
**effective** toggle for the open page and feeding it into that existing gate.
**No `grammar.rs` change is required.**

**Data model — where each scope's flag lives.**
- **Page + section:** new columns on the `pages` and `sections` tables via a
  **new appended migration** in [db.rs](../src-tauri/src/db.rs) (never edit a
  shipped entry; index + 1 == `user_version`). Direct precedent: the
  `page_sort_mode`/`page_sort_dir` columns added to `sections` in migration 4.
  Update the [notebook.rs](../src-tauri/src/notebook.rs) `Section`/`Page` structs,
  their `list_sections`/`list_pages` `SELECT` lists, and add a setter command for
  each.
- **Notebook:** notebooks have **no metadata row in the DB** (identity is the DB
  file). The flag belongs in the `notebooks.json` registry —
  [config.rs](../src-tauri/src/config.rs) `NotebookMeta`, alongside
  `color`/`sort_order`/`deleted_at`.

**Proposed semantics (needs sign-off).** A **suppress-only cascade**: a narrower
scope can only turn proofreading **off**, never force it on over a broader "off".
Effective for the open page =
`globalEnabled AND NOT notebookSuppressed AND NOT sectionSuppressed AND NOT pageSuppressed`.
This keeps the mental model simple (Settings ▸ Proofing stays the master switch;
each scope is an opt-out) and avoids a three-state inherit/on/off matrix.
Recommend **one combined "proofreading" suppression per scope** rather than
separate spelling-vs-grammar flags at every level (3 flags, not 6) — the global
pair already lets you choose which check runs; per-scope you almost always want
"quiet this page/section/notebook entirely" (a code-snippet section, a notebook of
foreign-language quotes). Flag it if you'd rather have independent per-scope
spelling/grammar.

**Repurposing the Tools menu + the "smart" indicator (the creative part).**
- Replace the two redundant Tools toggles with a single **"Proofread ▸" submenu**
  whose entries are the three scopes — **This Page / This Section / This
  Notebook** — each an independent checkbox reflecting *that scope's own*
  suppression. The **check state is the indicator**: no clumsy "(this page)"
  suffix needed, because every level is shown at once and labelled. When a
  broader scope already suppresses the page, the narrower rows render disabled
  with a muted trailing reason ("off for this notebook"), using the existing
  `MenuItem` `checked`/`disabled` support.
- Pair it with an **ambient proofing badge in the editor toolbar** that reflects
  the page's *effective* state. When proofreading is suppressed for the open
  page, the badge shows a visibly "paused" proofing icon and its tooltip **names
  the responsible scope** — "Proofreading paused for this section". Clicking the
  badge opens the same three scope toggles in a small popover, so the indicator
  and the control are one element. This directly answers the real UX hazard: with
  silent suppression, a page with no underlines looks like grammar check is
  *broken* — the badge makes the absence explained and one click from reversible.
- (Optional flourish) the section tab / page-list row for a suppressed scope
  could carry a tiny muted proofing glyph, so the state is legible from the nav
  too.
- **Settings ▸ Proofing keeps the global master toggles unchanged** — only the
  Tools menu is repurposed. Per-scope flags could *also* surface as a checkbox in
  [SectionPropertiesModal.tsx](../src/components/panels/SectionPropertiesModal.tsx)
  (section) and a Notebook Properties surface — note there is **no notebook
  properties dialog yet** (rename/color live inline in the
  [NavPanel.tsx](../src/components/panels/NavPanel.tsx) notebook context menu), so
  the notebook toggle is either a new small dialog or another context-menu entry.

**New surface area.**
- **Backend:** one appended `db.rs` migration (columns on `pages` + `sections`);
  `notebook.rs` struct fields + `list_*` `SELECT`s + `set_page_proofing` /
  `set_section_proofing` commands; a `NotebookMeta` field + a
  `set_notebook_proofing` path that re-saves the registry; register the new
  commands in [lib.rs](../src-tauri/src/lib.rs).
- **Frontend:** [types.ts](../src/data/types.ts) additions on
  `Section`/`Page`/notebook + `api.ts` wrappers; [vellum.tsx](../src/state/vellum.tsx)
  state + setter actions + a small `effectiveProofing(pageId)` selector over the
  open page's scope chain, wired into `PageEditor` `runGrammar`'s `toggles`; the
  Tools submenu rework in `MenuBar.tsx`; the ambient badge component; optional
  Section/Notebook properties checkboxes.
- **Docs:** fold the scoping model into **spec Section 10** (which currently says
  "Runs on the current page only") + a CHANGELOG entry.

**Proposed decisions (need your call).**
1. Suppress-only cascade (narrower scope can only turn off) vs a full three-state
   inherit/on/off per scope. _Recommend suppress-only._
2. One combined proofreading flag per scope vs separate spelling/grammar per
   scope. _Recommend combined._
3. Indicator treatment: ambient toolbar badge that names the suppressing scope +
   doubles as the control, with the Tools submenu exposing all three scopes.
   _Recommend as described._
4. Per-notebook flag home: `NotebookMeta` registry (matches `color`/`deleted_at`).
   _Recommend registry._
5. Surface the per-scope toggles in the Properties dialogs too, or Tools
   menu + badge only? (Notebook has no properties dialog yet.)

**Open risks / notes:**
- **Append-only migration** — add a new `db.rs` entry, never touch a shipped one;
  existing notebooks migrate on open (default = not suppressed, so today's
  behavior is preserved).
- **No regression to the global switch** — Settings ▸ Proofing stays
  authoritative; existing installs with grammar/spell on keep underlines
  everywhere until a scope is explicitly quieted.
- **Discoverability is the point** — scoped suppression must never look like a
  bug; don't ship the persistence without a visible effective-state cue (the
  badge).
- Size **M**: broad (migration + 3 persistence homes + effective-state plumbing +
  UI), but no cross-database migration and no engine work, so materially smaller
  than [MOVESECTION](#3-move-sections-between-notebooks).

---

## Suggested sequencing

[IMPORT](#4-import-documents-into-notebooks) **shipped** ([Unreleased],
2026-07-14) — the full slice (Markdown / HTML / text **+ DOCX**, single-file
**and** folder round-trip), and [PROOFSCOPE](#5-scoped-proofreading-per-notebook-section-page)
**shipped** ([Unreleased], 2026-07-15) — the suppress-only per-page/section/notebook
model with the Tools submenu + toolbar badge. That leaves one active feature.
[MOVESECTION](#3-move-sections-between-notebooks) is the heaviest — a
cross-database migration; schedule it as its own mini-project with dedicated
testing (see its section for the risks). [macOS](#1-macos-build-planning) and
[Linux](#2-linux-build-planning) stay deferred post-v1 and unblocked whenever
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
| 6 | Proofreading scope model | **Shipped (revised):** most-specific-wins — a page can override its section/notebook, under a hard global master |
| 7 | Per-scope granularity | **Shipped (revised):** grammar + spelling independent per scope (tri-state: inherit/on/off) |
| 8 | Scoped-proofreading indicator | **Shipped (revised):** Tools ▸ Proofread submenu with per-scope Grammar/Spelling toggles + a plain one-click toolbar badge button; code blocks never proofed |

**Residual open item:** whether ARM64 Linux is in scope — moot for now, since
[Linux](#2-linux-build-planning) is **deferred**; revisit alongside the Linux
track (defaulting to x86_64-only when it returns unless you say otherwise).

**Pending decisions ([IMPORT](#4-import-documents-into-notebooks)):** all
resolved and **shipped** — see the decisions taken at the top of the
[IMPORT](#4-import-documents-into-notebooks) section (Tier 1 + DOCX; single-file
and folder import; wizard-chosen destination; H1-else-filename title; no
confirmation).
