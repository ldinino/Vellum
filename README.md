# Vellum

A desktop note-taking application modeled on the layout and UX feel of Microsoft OneNote 2007. Structured around a Notebook → Section → Page hierarchy, with rich text editing as the core product. Refine (local-model text transformation) and grammar check are first-class features. Everything runs locally — nothing leaves the machine.

See [docs/Vellum_spec.md](docs/Vellum_spec.md) for the full product specification and phased implementation plan.

## Tech Stack

| Layer | Choice |
|---|---|
| App shell | Tauri v2 (Rust backend, WebView2) |
| Frontend | React + TypeScript (Vite) |
| Rich text | Tiptap |
| Storage | SQLite per notebook (WAL, FTS5) |
| Grammar | Harper (`harper-core`, embedded Rust crate — offline, real-time) |
| Inference | Ollama (downloaded on first Refine-enable, localhost only) |
| Styling | Bespoke retro CSS (7.css base) |

## Development

Prerequisites: Node.js 20+, Rust (stable, MSVC toolchain on Windows), WebView2 runtime.

```sh
npm install          # frontend dependencies
npm run tauri dev    # run the app in dev mode
npm run tauri build  # production build + installer
```

v1 targets Windows 10/11. Mac/Linux builds are kept warm via CI but are not release targets yet.
