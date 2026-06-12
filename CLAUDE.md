# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Vellum — a Windows-first desktop note-taking app (Tauri v2 + React + TypeScript) styled after OneNote 2007. **docs/Vellum_spec.md is the source of truth**: full product spec plus an 11-phase implementation plan with dependency ordering and exit criteria. Implementation has not started yet (Phase 0 is next); the code is currently the scaffold. When a product or sequencing question comes up, check the spec before deciding, and update the spec when a decision changes it.

## Commands

```sh
npm run tauri dev        # run the full app (starts Vite + Rust backend)
npm run dev              # frontend only in a browser (no Tauri APIs available)
npm run build            # typecheck (tsc) + production frontend build
cargo check              # in src-tauri/ — compile-check the Rust backend
npm run tauri build      # production build + NSIS installer
```

There is no test suite or linter configured yet.

Dev-machine copies of the runtime binaries and styling references are fetched (not committed) via:

```sh
powershell scripts/fetch-binaries.ps1     # Ollama + LanguageTool → vendor/bin/
powershell scripts/fetch-references.ps1   # Office-Ribbon-2010 + makeaero → vendor/reference/
```

`vendor/` is gitignored. Office-Ribbon-2010 has **no code license** — extract color/gradient values from it into our CSS custom properties, never copy its code into the repo.

## Critical constraints

- **`time` crate is pinned to 0.3.47 in Cargo.lock.** 0.3.48 breaks `tauri-utils` compilation (E0119 trait conflicts). A bare `cargo update` will re-break the build; re-pin with `cargo update time --precise 0.3.47`. Remove the pin only once upstream fixes it.
- **`tauri-plugin-updater` and `tauri-plugin-process` are dependencies but deliberately NOT wired into the builder** (src-tauri/src/lib.rs), and `createUpdaterArtifacts` must stay out of tauri.conf.json until the minisign keypair exists (Phase 11) — builds fail without `TAURI_SIGNING_PRIVATE_KEY` once that flag is set.
- **Version lives in three files and must stay in sync:** `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`. The updater compares the tauri.conf.json version, so a release bump that misses it ships a broken update.

## Distribution model (decided — don't re-litigate)

- Tauri NSIS installer, per-user (`installMode: "currentUser"`), no admin elevation.
- **No code signing.** SmartScreen warning is accepted for v1. Updater artifacts use a free local minisign key — that is not code signing.
- In-app updates via `tauri-plugin-updater`; artifacts + `latest.json` on GitHub Releases (published by `tauri-action`). Repo is private until the first release, then flips public so the updater endpoint resolves.
- Heavyweight runtimes (Ollama ~1.4 GB, LanguageTool+jlink JRE ~200 MB) are **not bundled**. The app downloads them on first feature-enable into `%LOCALAPPDATA%\Vellum\runtime\[component]\[version]\` with SHA-256 verification. They must never live in `Documents\Vellum`, which is deliberately OneDrive-synced user data (notebooks, SQLite DBs, attachments).

## Architecture notes

- Rust backend (`src-tauri/`) owns: per-notebook SQLite (WAL mode, FTS5 — confirmed compiled into tauri-plugin-sql's bundled SQLite), background process lifecycle for Ollama (port 11435, spawn-on-demand, kill on exit) and LanguageTool (random localhost port), hardware detection, and runtime component downloads.
- Frontend (`src/`) is React + Tiptap. All Tiptap extensions from spec Section 6 are already installed. The word "AI" never appears in UI — the LLM feature is called "Refine" and is framed as an editing tool (spec Section 9).
- Styling is bespoke retro CSS built on 7.css; no CSS framework. Tokens get defined in Phase 0 from the vendor references.
- CI (`.github/workflows/ci.yml`) runs frontend build + `cargo check` on Windows/macOS/Linux for every push/PR to main. Keep all three green even though only Windows ships in v1.

## Conventions

- Work happens directly on `main` for now; CI must pass.
- App identifier is `tel.corpo.vellum`; product name "Vellum" (still listed as a placeholder name in the spec's open items).
