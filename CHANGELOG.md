# Changelog

All notable changes to Vellum are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.5] - 2026-07-15

### Added

- **Scoped proofreading** — Spelling and grammar can now be turned on or off
  independently for just one page, a whole section, or an entire notebook —
  handy for a code-snippet section or notes written in another language — from
  the new **Tools ▸ Proofread** menu (This Page / This Section / This Notebook,
  each with its own Grammar and Spelling toggles). A more specific scope wins, so
  you can proofread a single page inside a notebook you've otherwise turned off;
  changing a section's or notebook's setting resets the pages inside it, so those
  per-page exceptions never get stuck.
  When checking is off for the page you're on, a button appears in the toolbar to
  turn it back on for that page in one click. Code blocks and inline code are
  never proofed. The **Settings ▸ Proofing** switches remain the overall on/off.
- **Import documents** — A new **File ▸ Import documents…** wizard brings outside
  documents in as pages. Import one or more Markdown, HTML, plain-text, or Word
  (`.docx`) files, or a whole folder at once — a folder's subfolders become
  sections, so you can pull in an exported Azure DevOps wiki in one step. Each
  document's first heading becomes the page title, and referenced or embedded
  images come along with it. Choose which notebook and section the pages land in.

### Changed

- The **Tools** menu's old **Check Spelling** / **Check Grammar** switches are
  now a **Proofread** submenu for turning grammar and spelling off per page,
  section, or notebook. The global on/off switches still live in
  **Settings ▸ Proofing**.

## [0.2.0] - 2026-07-14

### Added

- **Choose where your notebooks are stored** — Settings ▸ General has a new
  **Change…** button that moves your Vellum data folder anywhere you like,
  including outside OneDrive, so OneDrive stops making duplicate copies of open
  notebooks. The app restarts to apply the new location.
- **Mermaid diagrams** — Insert flowcharts and other diagrams with **Insert ▸
  Mermaid Diagram**, edit the source in place, and see it render live. Diagrams
  export to a Markdown `mermaid` code block and print as images.
- **Export to Markdown** — The export command is now a wizard: export the
  current page, a chosen set of pages, an entire section, or a whole notebook.
  Multi-page exports are organized into Notebook / Section folders with one
  shared attachments folder.
- **Template placeholders** — Page templates can now include dynamic inserts
  from a new **Insert placeholder** dropdown in the template editor. One-shot
  tokens (`{{PageTitle}}`, `{{SectionName}}`, `{{NotebookName}}`, and the
  current date/time) are filled in when a page is created; live date/time
  fields re-evaluate every time the page is opened.
- **Windows on ARM** — Vellum now ships a native ARM64 build alongside the
  Intel/AMD (x64) build, so it runs at full speed on Windows on ARM devices such
  as Copilot+ PCs. Installs and updates pick the right build automatically.

### Changed

- **Code blocks** — Long lines now scroll horizontally within the block
  instead of wrapping, so code keeps its original formatting.

### Fixed

- The horizontal scrollbar's highlight now runs top-to-bottom, matching the
  app's other surfaces, instead of left-to-right.

## [0.1.0] - 2026-06-25

Initial release.

### Added

- **Organization** — Notebook → Section → Page structure with color coding,
  drag-to-reorder, and right-click actions at every level.
- **Rich-text editor** — Headings, bold/italic/underline/strikethrough, bullet
  and numbered lists, blockquotes, code blocks, tables, inline images (paste,
  drag-and-drop, and resize), hyperlinks, font and size, text and highlight
  color, alignment, and superscript/subscript.
- **Automatic saving** — Continuous background save with crash recovery; no
  manual save and no unsaved-changes prompts.
- **Proofreading** — Real-time spelling and grammar checking with inline
  underlines, one-click suggestions, a custom dictionary, and reversible
  "ignore" controls (English).
- **Refine** — Optional, on-device text transformation (proofread, reformat, or
  apply a template) that runs entirely locally with no network calls. Off by
  default.
- **Search** — Full-text search across all notebooks, scoped search by section
  or notebook, and in-page find.
- **Attachments** — Attach files to any page, with previewable inline images.
- **Recycle Bin** — Recoverable deletion of notebooks, sections, pages, and
  attachments.
- **Page templates** — A template library for starting new pages consistently.
- **Export & print** — Export a page to Markdown and print clean copies.
- **Settings** — Editor defaults, proofing, templates, Refine, and data-location
  controls.
- **Windows installer** — Per-user installation, no administrator rights
  required.
- **In-app updates** — Automatic background update checks delivered from GitHub
  Releases, with a one-click restart to apply.

[Unreleased]: https://github.com/ldinino/Vellum/compare/v0.2.5...HEAD
[0.2.5]: https://github.com/ldinino/Vellum/compare/v0.2.0...v0.2.5
[0.2.0]: https://github.com/ldinino/Vellum/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ldinino/Vellum/releases/tag/v0.1.0
