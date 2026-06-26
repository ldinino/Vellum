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

For ad-hoc manual testing, `powershell scripts/dev-run.ps1` preps (resolves the repo + tools machine-independently, `npm install` if needed), builds and launches the app in its own window, then watches the Vellum process and automatically stops the dev server, frees the Vite port, and reverts any temporary edits it made (see its `TEMP CHANGES` section) once you close the app window. `-PrepOnly` checks the environment without building.

There is no test suite or linter configured yet.

Dev-machine copies of the runtime binaries and styling references are fetched (not committed) via:

```sh
powershell scripts/fetch-binaries.ps1     # Ollama → vendor/bin/
powershell scripts/fetch-references.ps1   # Office-Ribbon-2010 + makeaero → vendor/reference/
```

`vendor/` is gitignored. Office-Ribbon-2010 has **no code license** — extract color/gradient values from it into our CSS custom properties, never copy its code into the repo.

## Critical constraints

- **`time` crate is pinned to 0.3.47 in Cargo.lock.** 0.3.48 breaks `tauri-utils` compilation (E0119 trait conflicts). A bare `cargo update` will re-break the build; re-pin with `cargo update time --precise 0.3.47`. Remove the pin only once upstream fixes it.
- **In-app updates are wired (Phase 11).** `tauri-plugin-updater` + `tauri-plugin-process` are registered in `src-tauri/src/lib.rs`, and `createUpdaterArtifacts: true` is set in tauri.conf.json. Consequence: a full `npm run tauri build` now requires `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in the environment — but `cargo check`, `npm run build`, and `tauri dev` are unaffected (they don't bundle), so CI stays green. The `plugins.updater.pubkey` in tauri.conf.json is a placeholder until the maintainer runs `tauri signer generate` and pastes in the real minisign public key (the matching private key + password become the two repo secrets the release workflow consumes).
- **Version lives in three files and must stay in sync:** `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`. The updater compares the tauri.conf.json version, so a release bump that misses it ships a broken update. Use `scripts/bump-version.ps1 X.Y.Z` to set all three at once. **Versioning is Major.Minor.Hotfix:** never bump Major without the maintainer's explicit word; Minor = a new button/menu item/small feature; Hotfix = a change to existing features (the common case).

## Distribution model (decided — don't re-litigate)

- Tauri NSIS installer, per-user (`installMode: "currentUser"`), no admin elevation.
- **No code signing.** SmartScreen warning is accepted for v1. Updater artifacts use a free local minisign key — that is not code signing.
- In-app updates via `tauri-plugin-updater`; artifacts + `latest.json` on GitHub Releases (built, signed, and uploaded by `tauri-action` in `.github/workflows/release.yml`, triggered by a `vX.Y.Z` tag). The repo is public, so the updater endpoint (`releases/latest/download/latest.json`) resolves without auth. Releases are created as **drafts** — publishing one is what makes the update go live. The app auto-checks and auto-downloads on launch, then shows a non-blocking "restart to apply" prompt (`src/state/updater.tsx` + `src/components/UpdateNotice.tsx`); the Settings ▸ About button drives the same flow on demand.
- The Ollama runtime (~1.4 GB) is **not bundled**. The app downloads it on first Refine-enable into `%LOCALAPPDATA%\Vellum\runtime\[component]\[version]\` with SHA-256 verification. It must never live in `Documents\Vellum`, which is deliberately OneDrive-synced user data (notebooks, SQLite DBs, attachments). Grammar (Harper) is compiled in — no download.

## Architecture notes

- Rust backend (`src-tauri/`) owns **all** per-notebook SQLite access (WAL mode, FTS5): creation/migrations in `db.rs`, sections/pages/content CRUD in `notebook.rs` exposed as Tauri commands. We deliberately do **not** query from the frontend via tauri-plugin-sql — its pooled connections make transactions unsafe and leave `foreign_keys` off, which would break `ON DELETE CASCADE`. Commands open a single-connection pool per call (`db::open_pool`, foreign keys on). The backend also owns: background process lifecycle for Ollama (port 11435, spawn-on-demand, kill on exit), grammar checking via the embedded `harper-core` crate (in-process, no subprocess — wired in Phase 4), hardware detection, and the Ollama runtime download.
- Frontend (`src/`) is React + Tiptap. All Tiptap extensions from spec Section 6 are already installed. The word "AI" never appears in UI — the LLM feature is called "Refine" and is framed as an editing tool (spec Section 9). Grammar check is Harper (spec Section 10): real-time underlines, English-only v1.
- **WebView2 browser accelerator keys are disabled** on Windows (`AreBrowserAcceleratorKeysEnabled = false`, set in `src-tauri/src/lib.rs` setup): no Ctrl+R/F5 reload, Ctrl+P, zoom, or **F12 DevTools** — intentional, so the app behaves like a fixed desktop window, not a browser. It's gated to release builds (`#[cfg(not(debug_assertions))]`) so DevTools and reload stay available in `tauri dev`. Find-on-page is our own (`src/components/editor/find.ts` + `FindBar`), opened by Ctrl+F, **Edit ▸ Find**, or the editor context menu, replacing the native find.
- Styling is bespoke retro CSS built on 7.css; no CSS framework. Tokens get defined in Phase 0 from the vendor references.
- CI (`.github/workflows/ci.yml`) runs frontend build + `cargo check` on Windows/macOS/Linux for every push/PR to main. Keep all three green even though only Windows ships in v1.

## Conventions

- Work happens directly on `main` for now; CI must pass.
- App identifier is `tel.corpo.vellum`; product name "Vellum" (still listed as a placeholder name in the spec's open items).
