# Vellum — Product Specification & Implementation Plan

> App name is a placeholder. v1 targets Windows 10/11.

---

## Part 1: Product Specification

---

### 1. Overview

A desktop note-taking application modeled on the layout and UX feel of Microsoft OneNote 2007. Structured around a Notebook → Section → Page hierarchy. Rich, reliable text editing is the core product. Refine (text transformation via local language model) and grammar check are first-class features. The aesthetic is deliberately retro — Office 2007-era gradients, glyphs, glass, and depth. Nothing leaves the machine.

---

### 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| App shell | Tauri v2 | Rust backend, WebView2 on Windows |
| Frontend | React | |
| Rich text | Tiptap (free/MIT tier) | Built on ProseMirror |
| Storage | SQLite (per-notebook) | WAL mode, FTS5 for search |
| Grammar | LanguageTool | Bundled with minimal JRE via jlink |
| LLM inference | Ollama (bundled binary) | Custom port 11435, custom model path |
| Styling | Bespoke CSS component library | No framework — retro aesthetic requires hand-built components |

---

### 3. Platform & Distribution

**v1 target:** Windows 10 and 11 (WebView2 is standard on both).

**Future Mac/Linux:** Tauri's Rust backend and React frontend are cross-platform by default. The delta for Mac/Linux is:
- WebView rendering differences (WKWebView on Mac, WebKitGTK on Linux) — test CSS, no rewrites expected
- Platform-specific file path handling (Tauri provides abstractions for this)
- CI matrix builds (Windows, Mac, Linux) should be set up from day one so this stays low-effort

**Bundled dependencies:**
- `ollama.exe` — started on app launch only when Refine is enabled, via `OLLAMA_HOST=127.0.0.1:11435`, `OLLAMA_MODELS` pointed to app-specific path. Killed on app exit. No UI, no tray icon. If Refine is disabled in Settings, Ollama is never spawned.
- LanguageTool JAR + minimal JRE built with `jlink` — only required modules, roughly 50–80MB compressed. Started as a background process on launch, bound to localhost.

Both processes are spawned by the Tauri Rust backend and are not visible to the user.

---

### 4. Data Architecture

**File layout:**

```
%USERPROFILE%\Documents\Vellum\
  app.json                    ← app-level config: page templates, Refine templates, settings
  notebooks.json              ← registry of notebook paths and metadata
  [Notebook Name]\
    notebook.db               ← SQLite: sections, pages, content, FTS5 index
    attachments\
      [page-id]\
        filename.pdf
        filename.png
```

OneDrive (and other sync clients) cover this path by default on Windows — no code required for cloud backup.

**SQLite schema (per notebook):**

- `sections` — id, name, color, sort_order, page_template_id (nullable), created_at, updated_at
- `pages` — id, section_id, title, sort_order, created_at, updated_at
- `page_content` — page_id, content_json (Tiptap JSON doc), updated_at
- `page_ops` — id, page_id, op_json, created_at (operation log for crash recovery)
- `attachments` — id, page_id, filename, path, mime_type, created_at
- `fts_index` — FTS5 virtual table over page title + content text + attachment filenames

**app.json stores:**
- Page template library (name, content_json, id, created_at)
- Refine template library (name, system_prompt, description, adherence_override, id)
- App-level settings

**Search across notebooks:** A lightweight master index DB lives in the Vellum root and maintains a cross-notebook FTS5 index. Updated on every save. Scoped search queries the per-notebook DB directly; global search queries the master index.

---

### 5. Navigation & Layout

**Left panel — fixed width, resizable**

```
[ + New Notebook ]
▼ Notebook Name
    Section A
  ▶ Section B
▶ Another Notebook
```

- Notebooks are collapsible. Expanded notebooks show their sections.
- Clicking a section loads its page list in the right panel.
- Right-click notebook: Rename, Delete, Add Section, Change color.
- Right-click section: Rename, Delete, Add Page, Change color, **Properties**.
- Section Properties modal: name, color, page template assignment (dropdown: None / [template names]).
- Drag to reorder sections within a notebook.
- No top tab bar.

**Right panel — page list**

- Pages listed for the currently selected section.
- Shows: page title, first line of content preview, last modified date.
- [ + New Page ] at top.
- Right-click: Rename, Delete, Duplicate, Move to section.
- Drag to reorder.

**Main area — editor**

- Fills remaining space.
- Page title is an editable h1 at the top, outside the Tiptap content area.
- Toolbar docked at the top of the editor (formatting controls, search).

**No section tabs at top. No floating elements.**

---

### 6. Rich Text Editor

Built on Tiptap with the following extensions enabled:

**Formatting**
- Bold, Italic, Underline, Strikethrough
- Headings H1–H4
- Font family (system fonts)
- Font size
- Text color, highlight color
- Text alignment (left, center, right, justify)
- Superscript, Subscript
- Clear formatting

**Structure**
- Bullet list, Ordered list
- Blockquote
- Horizontal rule
- Code block (monospace, no syntax highlighting in v1)
- Tables (add/remove rows and columns)

**Media**
- Images: paste from clipboard, drag/drop onto page, resize via handles
- Images are stored in the notebook's attachments folder and referenced by path

**Inline**
- Links (click to open, right-click to edit/remove)

**Spell check:** WebView2 native via `spellcheck` attribute. No additional dependency.

**Grammar check:** LanguageTool (see Section 11).

**Custom marks:**
- `refineSuggestion` — for Refine inline suggestions (see Section 10)
- `grammarError` — for LanguageTool grammar underlines

---

### 7. Page Templates

Page templates are pre-formatted Tiptap documents that are automatically inserted when a new page is created in a section configured to use one. They are independent of Refine templates.

**What they are:** Named documents containing any combination of headings, body text, tables, placeholder text (e.g., `[Client Name]`, `[Date]`), and formatting. Placeholder text is plain text — the user replaces it manually.

**Storage:** Page template library stored in `app.json` (app-level, not per-notebook). Each template: id, name, content_json, created_at, updated_at.

**Template editor:** A full editor instance inside Settings → Templates → Page Templates. Supports all editor formatting. Save / Discard / Delete controls.

**Template library:** List view in Settings → Templates → Page Templates showing template name and a brief preview. Create, edit, delete, duplicate.

**Assignment:** Section Properties (right-click section → Properties) has a "New Page Template" dropdown. Options: None, or any named template from the library. Setting is stored in the `sections.page_template_id` column.

**Behavior on new page creation:**
- If the section has no template: new page opens blank.
- If the section has a template: the template's content_json is copied into the new page's content. The template itself is not modified.

---

### 8. Refine Templates

Refine templates are named system prompts used by the Refine feature. They are independent of page templates.

**Storage:** Refine template library stored in `app.json` (app-level).

**Template properties:**
- Name (user-defined)
- System prompt (multi-line text)
- Description (optional, shown in selector)
- Adherence override (optional — overrides the global Strict ↔ Liberal setting for this template)

**Management:** Settings → Refine → Templates. Create, edit, delete, reorder.

**Context menu behavior:**
- One Refine template exists: right-click selected text shows "Refine..." as a single item.
- Multiple Refine templates exist: right-click shows "Refine ▶" with a submenu listing template names.

---

### 9. Refine

**What it is:** A text transformation feature. The user selects text, triggers Refine, a local model processes it according to a Refine template, and returns the result inline with changes underlined for review.

**What it is not:** An AI assistant. The word "AI" does not appear anywhere in the UI. It is presented as an editing tool alongside spell check and grammar check. No assistant framing, no chat interface, no generative suggestions unprompted.

**Kill switch:** Refine can be completely disabled in Settings → Refine → Enable Refine (toggle). When off: Ollama is never started, "Refine" does not appear in context menus, and all Refine UI surfaces are hidden. This toggle is also surfaced during first-run setup as the first option shown.

**Trigger:** Highlight text → right-click → "Refine..." (one template) or "Refine ▶" → [template name] (multiple templates).

**Processing:**
1. Selected text and the chosen template's system prompt are sent to Ollama (local, port 11435).
2. Ollama is loaded just-in-time. If not already running, the bundled binary is started. Memory is allocated on demand.
3. A subtle loading indicator appears on the selected text.
4. On response, Refine computes a word-level diff between original and returned text.

**Result rendering — Strict mode (low variance):**
- Inserted or changed words/phrases are wrapped in `refineSuggestion` marks and underlined.
- Unchanged text is left as-is.
- Hover a suggestion: tooltip shows Accept / Reject.
- Right-click a suggestion: Accept, Reject, Accept All, Reject All.

**Result rendering — Liberal mode (high variance):**
- If the diff exceeds a threshold (>40% of text changed), the entire block is treated as a rewrite.
- The original text is preserved in memory.
- Returned text replaces it and is underlined as a block.
- A "Revert" button floats near the block.
- Individual word-level accept/reject is still available within the block.

**After resolution:** Once all suggestions are resolved and the user resumes typing (short idle threshold), Refine releases the Ollama process and frees memory if no other Refine operation is pending.

**Model tiers:**

| Tier | Target hardware | Model class |
|---|---|---|
| Fast | CPU-only or ≤4GB VRAM | 3B–4B quantized |
| Balanced | 6–8GB VRAM | 7B–8B quantized |
| Thorough | 12GB+ VRAM | 13B+ quantized |

Hardware detection via Windows API in Rust backend (VRAM, RAM). Auto-selected on first run; user can override in Settings. Specific model identifiers are maintained in a bundled `models.json` manifest that can be updated independently of the app binary. System requirements are not finalized — the manifest and tier thresholds will be tuned during pre-release testing.

**CPU-only fallback:** Viable with the Fast tier only. A Q4-quantized 3B model on a modern CPU (AVX2-capable) processes approximately 8–12 tokens/second. For a typical Refine request (200–400 words), expect 25–90 seconds. When CPU-only is detected, a persistent warning is shown in Settings and inline at point of use: "Refine on this machine may be slow. Requests may take 30–90 seconds." The feature remains usable — the user is informed, not blocked. NPU detection and acceleration are not in scope for v1 but noted for future evaluation.

**Strict ↔ Liberal slider:** Surfaces in Settings → Refine and as an optional per-invocation override. Controls both the model temperature and injects modifier instructions into the system prompt:
- Strict end: lower temperature + appends "Follow the template exactly. Do not add, remove, or restructure beyond what is explicitly specified."
- Liberal end: higher temperature + appends "Improve flow, add connective tissue, and reorganize for clarity where helpful."

Labelled "Strict ↔ Liberal" in all UI. The word "temperature" does not appear in user-facing surfaces.

**Settings → Refine:**
- Enable Refine toggle (OFF by default on first run)
- Strict ↔ Liberal slider (global default)
- Model selector: Fast / Balanced / Thorough (with auto-detected recommendation shown)
- Template manager (see Section 8)
- Debug panel access (see below)

**Debug panel** (Settings → Refine → Advanced → Open Debug Panel):
Not surfaced in normal use. Intended for development, model evaluation, and power users tuning behavior. Provides:
- Arbitrary model name input (bypasses tier system)
- Full parameter controls: temperature, top_p, top_k, num_predict, context window size
- System prompt editor (separate from saved templates, for ad-hoc testing)
- User text input
- Raw request preview (exact prompt sent to Ollama)
- Raw response output
- Latency timer (time to first token, total time)
- Ollama process log (stderr/stdout passthrough)

---

### 10. Grammar Check

**Engine:** LanguageTool, bundled with a minimal JRE produced by `jlink`.

**Distribution approach:**
- LanguageTool JAR is included in the app bundle.
- A custom minimal JRE is built at compile time using `jlink` with only the Java modules required by LanguageTool. Target size: ~50–80MB after compression.
- The Tauri Rust backend spawns LanguageTool as a local HTTP server on startup (localhost, random available port). Port is passed to the renderer at startup.
- Killed on app exit.

**UI behavior:**
- Grammar errors underlined in a distinct color (separate from Refine suggestions and spell check).
- Hover underline: shows LanguageTool's suggested correction and rule description.
- Click suggestion to accept.
- Right-click: Accept, Ignore, Ignore Rule.

**Scope:** Runs on the current page only. Does not scan across pages or notebooks in the background.

**Portability:** The bundled JRE approach makes the app self-contained on Windows, Mac, and Linux. No Java installation required on the host.

---

### 11. Search

**Entry point:** Single search bar in the toolbar, always visible.

**Default behavior:** Global search across all notebooks.

**Scope filter:** Dropdown next to the search bar — All Notebooks, or any specific notebook by name.

**Search engine:** SQLite FTS5. Master index DB for global; per-notebook DB for scoped.

**Filters (collapsible panel below the search bar):**
- Notebook (multi-select)
- Section (depends on notebook selection)
- Date range (created, last modified)
- Has attachment (checkbox)

**Results display:**
- Result cards: notebook / section / page breadcrumb, page title, matched text snippet with keyword highlighted, last modified date, attachment indicator if present.
- Click result: opens the page, scrolls to first match, highlights matches.
- Results update as the user types (debounced, ~200ms).

**Indexing:** FTS5 index updated on every page save. New pages indexed immediately. Attachments indexed by filename and MIME type (not by content in v1).

**Performance expectation:** Results for typical note corpora (10k–100k words) in <100ms.

---

### 12. Attachments

**How to attach:** Drag and drop a file onto any page.

**Display:** Attachments pin to the top of the page in a fixed attachment bar, styled like an email attachment strip. Each attachment shows: icon (by type), filename, file size. Click to open with the system default application.

**Storage:** Files are copied to `[Notebook]\attachments\[page-id]\` at drop time. The original file is not moved or modified. The attachment record in the DB references the relative path.

**Right-click attachment:** Open, Remove (removes from page and deletes the copy in the attachments folder).

**Search:** Attachment filenames and MIME types are indexed in FTS5. Search results show an attachment indicator; matching on attachment filename surfaces the page.

**Image files dropped on page:** Treated as inline images if dropped into the editor body; treated as attachments if dropped above the content area into the attachment bar.

---

### 13. Auto-Save & Crash Recovery

**Save strategy:**
- Tiptap emits a transaction on every document change.
- Each transaction is written to `page_ops` (operation log) debounced at 300ms.
- A full content snapshot is written to `page_content` debounced at 3 seconds.
- SQLite WAL mode is always on — writes are atomic; partial writes do not corrupt the DB.

**Crash recovery:**
- On open, if a page has unresolved ops in `page_ops` newer than the last `page_content` snapshot, replay ops over the snapshot.
- Provides recovery to within ~300ms of last keystroke.

No manual save. No save indicator. No "unsaved changes" state.

**App-level registry** (`notebooks.json`) is written atomically (write to temp file, rename) to prevent corruption on crash during notebook create/rename/delete.

---

### 14. Export / Print

**v1 scope:** Print current page only.

**Implementation:** Invoke the WebView2 print dialog (`window.print()`). A print stylesheet hides the navigation panels and renders only the page content and title. Attachments print as a simple list of filenames.

No PDF export, no Markdown export, no HTML export in v1.

---

### 15. Settings

| Section | Contents |
|---|---|
| General | App data location (read-only, shows Documents path) |
| Templates | Page template library: create, edit, delete |
| Editor | Default font, default font size, spell check on/off |
| Grammar | Grammar check on/off, LanguageTool language selection |
| Refine | Enable toggle, Strict ↔ Liberal slider, model selector, Refine template manager, debug panel access |
| About | Version, bundled dependency versions |

---

### 16. Out of Scope (v1)

- Version / page history
- OneNote import
- Markdown / HTML / PDF export
- Cloud sync (OneDrive covers this passively via Documents folder)
- Real-time collaboration
- OCR on image attachments
- Mobile
- Plugin/extension system
- NPU acceleration
- Themes beyond the retro aesthetic

---

---

## Part 2: Implementation Plan

Phases are ordered by dependency. Each phase should be shippable/testable before the next begins. UI polish is applied incrementally from Phase 2 onward, with a dedicated final pass.

---

### Phase 0 — Project Foundation

**Goal:** Runnable Tauri + React shell. Nothing visible to a user yet.

- Initialize Tauri v2 project with React
- Set up CI matrix builds: Windows, Mac, Linux
- Establish `Documents\Vellum\` file layout; implement `app.json` and `notebooks.json` with atomic writes
- Implement per-notebook SQLite creation (WAL mode, schema migrations via versioned migration runner)
- Implement Ollama background process: spawn conditionally (Refine enabled only), bind to port 11435, custom model path, kill on exit
- Implement LanguageTool background process: spawn on launch, bind to available localhost port, kill on exit
- Define CSS custom property tokens: colors, gradients, spacing, border radii, shadow depths for retro theme. Color and gradient values sourced from Office-Ribbon-2010 LESS (toolbar gradients, button group borders, amber/orange hover glow) and 7.css (window chrome, panel backgrounds, control states)
- Build core UI component library using 7.css (scoped via `7.scoped.css`, tree-shaken to required components) as the base. Office-Ribbon-2010 LESS serves as the measured color/gradient reference for toolbar and button states — extract values, convert to CSS custom properties, no jQuery dependency carried over
- Components requiring bespoke work beyond 7.css: Toolbar (Office 2007–2010 gradient and button groups), left navigation panel, page list panel, attachment bar, Refine suggestion underlines, grammar underlines
- Window chrome/titlebar: `decorations: false` in Tauri config, custom React titlebar component. Aero glass CSS generated with reference to makeaero for accurate backdrop-filter and gradient values

**Exit criteria:** App launches, creates notebook DB in Documents, spawns and kills background processes cleanly, component gallery renders correctly.

---

### Phase 1 — Navigation Shell

**Goal:** Full Notebook → Section → Page hierarchy navigable. No real editor yet — pages show a placeholder.

- Left panel: notebook/section tree with expand/collapse, active state, color indicators
- Right panel: page list for selected section — title, preview line, modified date
- New Notebook, New Section, New Page creation flows
- Rename, Delete, Reorder (drag) for all three levels
- Right-click context menus on all nav items including section Properties
- Section Properties modal: name, color, page template dropdown (None / templates from library — wired up properly in Phase 6)
- Keyboard navigation (arrow keys, Enter to open, F2 to rename)
- Page title (editable h1) above editor area

**Exit criteria:** Full CRUD and navigation works. State persists to SQLite correctly on every action.

---

### Phase 2 — Editor Core + Auto-Save

**Goal:** Fully functional rich text editor with reliable auto-save. Highest-risk phase.

- Integrate Tiptap with all extensions listed in the spec
- Implement `spellcheck` attribute (WebView2 native spell check)
- Implement formatting toolbar: all controls wired to Tiptap commands
- Image support: paste from clipboard, drag/drop, resize handles via custom Tiptap node
- Image file storage: copy to `attachments\[page-id]\` on insert, reference by relative path
- Table support: insert, add/remove rows and columns, resize columns
- Implement `page_ops` operation log: Tiptap transaction listener → debounced 300ms write to SQLite
- Implement `page_content` snapshot: debounced 3s write
- Implement crash recovery: op replay on page open
- Link: click to open in system browser, right-click to edit/remove

**Exit criteria:** All formatting features work. Auto-save is invisible to user. Simulated crash followed by reopen recovers content to within one sentence.

---

### Phase 3 — Search

**Goal:** Fast, reliable global and scoped keyword search with filters.

- Build and maintain FTS5 index in per-notebook DB on every page save
- Build master cross-notebook index DB; sync on every page save
- Search bar UI: always visible in toolbar
- Results panel: slides down or overlays, shows result cards with breadcrumb, snippet, keyword highlight
- Scope filter dropdown (all / specific notebook)
- Filter panel: notebook multi-select, section, date range, has attachment
- Click result → open page, scroll to first match, highlight all matches
- Debounced result updates as user types

**Exit criteria:** Search returns correct results in <100ms on a corpus of 500+ pages. Filters work correctly. Match highlighting is accurate.

---

### Phase 4 — Grammar Check

**Goal:** LanguageTool grammar underlines working in editor.

- Verify bundled JRE (`jlink` build) starts LanguageTool correctly on Windows
- Implement Rust backend: spawn LanguageTool server, pass port to renderer at startup
- Implement Tiptap `grammarError` mark and decoration
- On page open and on save (debounced 2s after last keystroke), send page text to LanguageTool HTTP API
- Render grammar underlines with hover tooltip (suggestion + rule)
- Click to accept, right-click for Accept / Ignore / Ignore Rule
- Settings toggle: grammar check on/off
- Settings: language selection (LanguageTool supports multiple languages)
- Test bundled JRE + JAR on a clean Windows machine with no Java installed

**Exit criteria:** Grammar errors underline correctly. Accept/ignore flows work. No Java dependency on host machine required.

---

### Phase 5 — Attachments

**Goal:** File attachments on pages, pinned at top, search-indexed.

- Drag-and-drop anywhere on page: over attachment bar → attach; over editor body with image file → insert inline
- Attachment bar: fixed strip at top of page, shows icon/filename/size
- On attach: copy file to `attachments\[page-id]\`, write DB record
- Click attachment: open with system default app
- Right-click: Open, Remove
- Update FTS5 index to include attachment filenames on page save

**Exit criteria:** Files attach, display, open, and remove correctly. Attachment filenames appear in search results.

---

### Phase 6 — Page Templates

**Goal:** Page template library and per-section assignment working.

- Page template data model in `app.json`
- Settings → Templates → Page Templates: create, edit (full editor instance), delete, duplicate
- Section Properties modal wired to template library: dropdown populated from app.json
- New page creation logic: if section has a template assigned, copy template content_json into new page

**Exit criteria:** Templates persist across sessions. New pages in a configured section open with template content. Sections with no template open blank.

---

### Phase 7 — Refine Templates + Refine Infrastructure

**Goal:** Refine template library, Ollama process lifecycle, and hardware detection working. No UI suggestions yet.

- Refine template data model in `app.json`
- Settings → Refine → Templates: create, edit (name, system prompt, description, adherence override), delete, reorder
- Ollama process: conditional spawn (Refine enabled check), port 11435, custom model path
- Hardware detection: VRAM and RAM via Windows API in Rust; map to Fast/Balanced/Thorough tier
- `models.json` manifest: load on startup, expose to renderer
- Model download flow: progress indicator, error handling
- CPU-only detection: flag in app state, surface warning in Settings and at point of Refine invocation
- First-run setup screen: Enable Refine toggle (default OFF), model tier display, hardware summary
- Debug panel: arbitrary model input, full parameter controls, raw prompt/response display, latency timer, Ollama log passthrough

**Exit criteria:** Templates persist. Hardware detection correctly identifies tier. Ollama spawns/kills cleanly. CPU-only warning surfaces correctly. Debug panel shows raw Ollama interaction.

---

### Phase 8 — Refine (Full Feature)

**Goal:** Full Refine flow end-to-end. Second highest-risk phase.

- Right-click context menu on selected text: "Refine..." (one template) or "Refine ▶" submenu (multiple)
- Send selected text + system prompt to Ollama with Strict ↔ Liberal modifier
- Word-level diff algorithm (diff-match-patch or equivalent, tuned to word boundaries)
- Implement `refineSuggestion` Tiptap mark: attributes `original`, `type` (insert | delete | rewrite)
- Conservative rendering: individual word/phrase underlines with hover tooltip (Accept / Reject)
- Right-click suggestion: Accept, Reject, Accept All, Reject All
- Liberal/rewrite rendering (>40% diff threshold): full block underline, Revert button
- Post-resolution cleanup: marks cleared, idle timer triggers Ollama process release
- Strict ↔ Liberal slider: wired to temperature + system prompt modifier injection
- "Refine" language in all UI — never "AI," never "model," never assistant-framing

**Exit criteria:** Full flow works end-to-end on all three model tiers. Accept/reject works at word and block level. Revert works. Process lifecycle is clean. CPU-only path works with warning visible.

---

### Phase 9 — UI Polish Pass

**Goal:** Cohesive retro aesthetic across all surfaces.

- Audit all components against CSS token system from Phase 0
- Toolbar: gradient fill, beveled separators, raised button states
- Panels: subtle gradient backgrounds, inset shadow borders
- Active/hover states on all interactive elements (3D press effect on buttons)
- Scrollbars: custom styled, retro appearance
- Context menus and submenus: bordered, shadowed, styled consistently
- Modals: glass/shadow treatment
- Attachment bar: distinct visual zone
- Refine suggestion underlines: distinct color, subtle animation on hover
- Grammar underlines: distinct color from Refine and spell check
- Typography: verify Segoe UI fallback chain works across platforms
- Retro glyphs/icons: replace any default browser UI elements

**Exit criteria:** Visual review against Office 2007 reference screenshots. No surfaces that look like default browser or generic React UI.

---

### Phase 10 — Print & Settings

**Goal:** Print current page. Complete Settings UI.

- Print stylesheet: hide nav panels, render page title + content only, attachments as filename list
- Wire `window.print()` to print button / keyboard shortcut
- Settings modal: all sections from spec (General, Templates, Editor, Grammar, Refine, About)
- Verify all settings persist correctly and apply immediately where expected

**Exit criteria:** Print renders cleanly. All settings survive app restart.

---

### Phase 11 — QA & Hardening

**Goal:** Ship-ready on Windows. Mac/Linux builds verified.

- Background process error handling: Ollama or LanguageTool fails to start, crashes mid-use, or port unavailable
- SQLite integrity: run `PRAGMA integrity_check` on notebook open; surface error if DB is corrupt
- Large notebook performance: test with 1000+ pages, 10+ notebooks
- Search performance: verify <100ms at scale
- Crash recovery: systematic testing of crash at various save states
- Memory: verify Ollama releases after Refine idle timeout; no leaks in long sessions
- Mac build: test WebView rendering, file paths, background process behavior
- Linux build (best effort): same checks
- Installer / updater: Tauri's built-in updater wired to a release channel
- Code signing (Windows): required for SmartScreen to not block the installer

**Exit criteria:** No data loss scenarios. Background processes are robust. Installer runs cleanly on a clean Windows 10 VM.

---

## Dependency Graph

```
Phase 0 (Foundation)
  └── Phase 1 (Navigation)
        └── Phase 2 (Editor + Auto-Save)
              ├── Phase 3 (Search)
              ├── Phase 4 (Grammar)
              ├── Phase 5 (Attachments)
              ├── Phase 6 (Page Templates)
              └── Phase 7 (Refine Infrastructure)
                    └── Phase 8 (Refine Full)
                          └── Phase 9 (UI Polish)
                                └── Phase 10 (Print + Settings)
                                      └── Phase 11 (QA)
```

Phases 3, 4, 5, 6, and 7 can proceed in parallel after Phase 2 is stable.

---

## Open Items

| Item | Status |
|---|---|
| App name | Undefined — placeholder throughout |
| Model manifest (models.json) | TBD — requires testing across hardware tiers to determine viable models and thresholds |
| System requirements | TBD — will be determined through pre-release model evaluation |
| LanguageTool language packs to bundle | Decision needed before Phase 4 — English-only is the v1 default candidate |
| Code signing certificate (Windows) | Required before public distribution |
| Auto-updater infrastructure | Server/endpoint needed before Phase 11 |
