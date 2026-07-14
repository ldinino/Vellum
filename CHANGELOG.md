# Changelog

All notable changes to Vellum are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ldinino/Vellum/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ldinino/Vellum/releases/tag/v0.1.0
