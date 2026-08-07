# Vellum — Satchels & BYO Sync (2026-08 batch)

Planning document for two related features raised 2026-08-06. Like
[execution-plan.md](execution-plan.md), this is **not** part of the
phase-numbered spec — [Vellum_spec.md](Vellum_spec.md) stays the source of truth
per [CLAUDE.md](../CLAUDE.md); fold the resolved decisions back into it as each
item ships. Sizes are relative complexity (S/M/L/XL), not time estimates.

## At a glance

| ID | Item | Size | Depends on |
|---|---|---|---|
| [SATCHEL](#1-satchels) | Satchels — multiple data roots, switch by relaunch | M | — |
| [SYNC-A](#2-sync-phase-a--whole-satchel-sync) | BYO sync, phase A: whole-Satchel rclone sync + lease | L | SATCHEL |
| [OPLOG](#3-oplog-shadow-write--replay-and-diff) | Oplog shadow-write + replay-and-diff harness | L | SATCHEL |
| [SYNC-B](#4-sync-phase-b--oplog-as-canonical) | BYO sync, phase B: oplog becomes canonical | XL | SYNC-A, OPLOG |

**Sequencing.** SATCHEL ships alone. SYNC-A and OPLOG ship together in the next
release — the oplog is written but not yet trusted. SYNC-B flips the switch only
once replay-and-diff has been clean over a sustained stretch of real usage.

---

## 1. Satchels

A **Satchel** is a self-contained Vellum data root: notebooks, attachments,
settings, templates, dictionary — everything. Today there is exactly one, at a
path recorded in `%LOCALAPPDATA%\Vellum\data-location.txt`. This feature lets a
user keep several (e.g. a dev Satchel and a real one) and switch between them.

### Decided

- **Name:** "Satchel", user-facing. No `.satchel` folder extension — Windows
  gives no shell benefit for it, folder pickers can't filter on it, and it makes
  paths uglier. Identity comes from a **marker file** instead.
- **Everything is Satchel-scoped.** `app.json` stays inside the Satchel exactly
  as it is today. Appearance, proofing settings, custom dictionary, templates —
  all of it travels with the folder, so a synced Satchel opened on a new machine
  is immediately configured. Only the *list of known Satchels* is machine-local.
- **Switching relaunches the app.** No live swap. Accepted explicitly as the
  price of the above.
- **No titlebar indicator.** If you're unsure which Satchel you're in, check
  Settings.
- **No CLI/env override.** Dropped.
- **"Change…" (move data) is removed, not replaced.** Relocating a Satchel is
  done by closing Vellum, moving the folder in Explorer, and re-opening it —
  Explorer's move is more reliable than ours and obviously reversible. The
  stable Satchel `id` means the moved folder is recognised as the same Satchel
  rather than added as a duplicate. `set_data_dir` and `move_dir` in
  [commands.rs](../src-tauri/src/commands.rs) get deleted.

### Data model

**Marker file** — `<satchel>/satchel.json`, written on create:

```jsonc
{
  "id": "b1f0…",          // uuid, stable forever; survives moves and renames
  "name": "Vellum",       // shown in the dropdown on every machine
  "formatVersion": 1
}
```

`id` is what makes "is this the Satchel I already know, just moved?" answerable,
and later it is the key that binds a Satchel to its sync remote.

**Machine-local list** — `%LOCALAPPDATA%\Vellum\satchels.json`, replacing
`data-location.txt`:

```jsonc
{
  "activeId": "b1f0…",
  "known": [
    { "id": "b1f0…", "name": "Vellum", "path": "C:\\Vellum" },
    { "id": "9ac2…", "name": "Dev",    "path": "C:\\Dev\\VellumData" }
  ]
}
```

`name` and `path` here are a **cache** for rendering the dropdown before any
Satchel is opened; the marker file is authoritative and refreshes the cache on
open.

### Backend changes

- `paths.rs`: replace `data_location_pointer` / `custom_data_dir` /
  `set_data_root` with a `satchels` module — `load_list`, `save_list`,
  `active_path`, `read_marker`, `write_marker`, `create_satchel`,
  `open_satchel`, `forget_satchel`. `data_dir()` keeps its signature and simply
  resolves the active Satchel, so every existing call site is untouched.
- New commands: `list_satchels`, `create_satchel(parent, name)`,
  `open_satchel(path)`, `set_active_satchel(id)`, `forget_satchel(id)`,
  `rename_satchel(id, name)`.
- Switching = write `activeId` → `app.restart()` (`tauri-plugin-process` is
  already registered). No pool draining, no asset-scope re-grant, no cache
  invalidation — the relaunch handles all of it.

### Startup resolution

1. No `satchels.json` (fresh install or migration) → see *Migration* below.
2. `activeId` resolves to an existing folder with a readable marker → open it.
3. **Path missing or marker unreadable** → show a blocking chooser: *"Vellum
   can't find the Satchel *Dev* at `…`. It may be on a drive that isn't
   connected, or a synced folder that hasn't downloaded yet."* with **Locate…**,
   **Open a different Satchel**, and **Create a new Satchel**. Never silently
   fall back to a default and create an empty one — that reads as data loss.
4. Marker present but `formatVersion` newer than we understand → refuse to open,
   with a "this Satchel was made by a newer version of Vellum" message. Cheap
   insurance once sync means folders travel between machines.

### Migration (existing installs)

On first launch after upgrade: resolve the current data root exactly as today
(custom pointer, else `Documents\Vellum`), write a `satchel.json` into it with a
fresh uuid and name `"Vellum"`, seed `satchels.json` with it as active, delete
`data-location.txt`. Silent, no prompt, no data movement.

### Creating a Satchel

**Settings ▸ General ▸ New Satchel…** → folder picker for the *parent* + a name
field → creates `<parent>\<name>\`, writes the marker and an empty
`notebooks.json`, then offers to switch (relaunch).

- **Copy settings from the current Satchel**, via a checkbox that is **checked
  by default**; unchecking it gives defaults. Copies the `settings` block,
  page templates, Refine templates, custom dictionary and ignored grammar rules
  from `app.json` — never notebooks, and never the `*_seeded` / `firstRunComplete`
  flags (the new Satchel seeds its own Welcome notebook and starter templates).
- Reuses the existing first-run seeding for the Welcome notebook, gated on
  `welcome_seeded` in the new Satchel's own `app.json`.
- Refuse to create inside an existing Satchel (nested Satchels are a trap).

### Settings UI

Replaces the current "App data location" block
([settings/](../src/components/settings/)):

| Control | Behaviour |
|---|---|
| **Satchel** list | One row per known Satchel, the current one highlighted and badged "In use". Each row carries a **sync-state icon** (see below) and an **✕** to forget it, with a tooltip: *"Remove from this list. The folder and its notebooks are not deleted."* Choosing another → confirm *"Vellum will restart to open **Dev**."* → relaunch. *(Shipped as a row list rather than a dropdown: a native `<select>` can't hold a per-row icon and ✕ button, and the list is only ever a handful of entries.)* |
| **Open…** | Folder picker. Validates the marker; if absent, offer *"This folder isn't a Satchel. Create one here?"*. If the `id` is already known at a different path, update the path in place (the moved-folder case) rather than adding a duplicate. |
| **New Satchel…** | As above. |
| **Open folder** | Unchanged — opens the active Satchel in Explorer. |
| Path label | Each row shows its Satchel's full path, so no separate label is needed. |
| ~~**Change…**~~ | Removed. Explanatory copy: to move a Satchel, close Vellum, move the folder, then **Open…** it. |

**Sync-state icon.** Every Satchel row shows one of two states, so "is this one
synced?" is answerable at a glance without opening the sync panel:

| State | Icon | Meaning |
|---|---|---|
| Local | `drive` | Lives only on this machine. |
| Synced | `network-cloud` | Bound to a remote. Tooltip names it and the last sync time. |

The state is derived from whether the Satchel has a sync binding, so it renders
correctly for non-active Satchels too — which means the binding must be readable
without opening the Satchel (see [Where the binding lives](#where-the-binding-lives)).
[Fugue](../assets/fugue-icons-3.5.6/) already has suitable `drive` and `cloud`
glyphs; add dark variants via `scripts/build-dark-icons.ps1`.

Until SYNC-A ships, every Satchel is Local and the icon column is still worth
adding — it makes the later addition a non-event.

The existing OneDrive explainer copy needs a rewrite; it currently describes the
move-data flow.

### Exit criteria

- Existing install upgrades in place with no prompt and no data movement.
- Create → switch → create → switch back leaves both Satchels intact, each with
  its own settings and notebooks.
- Moving a Satchel folder in Explorer and re-opening it updates the existing
  list entry rather than duplicating it.
- A missing Satchel path produces the chooser, never an empty new root.
- Forgetting a Satchel deletes nothing on disk.

---

## 2. Sync, phase A — whole-Satchel sync

**Goal:** one canonical Satchel across devices, with the user's own storage.
Explicitly *not* concurrent multi-device editing — that's SYNC-B.

### Transport: rclone

- MIT-licensed single static binary; covers S3, B2, SFTP, WebDAV, Google Drive,
  Dropbox, OneDrive.
- **Downloaded on demand**, not bundled — reuse the Ollama pattern exactly:
  `%LOCALAPPDATA%\Vellum\runtime\rclone\<version>\`, pinned version + SHA-256 in
  [resources/models.json](../src-tauri/resources/models.json) (or a sibling
  `runtime.json`). Installer size is unaffected.
- Invoked as a child process through the existing
  [process/](../src-tauri/src/process/) machinery (hidden console window,
  tree-kill on exit).
- **rclone is an implementation detail.** The word "rclone" appears nowhere in
  the UI except a line in About / third-party notices. See below.

### Setup UX — the hard requirement

Configuring rclone by hand is genuinely miserable, and that misery is the thing
this feature exists to eliminate. **We never shell out to interactive `rclone
config`, never ask the user to open a terminal, and never show them a config
file.** We write `rclone.conf` ourselves from a form.

**Curated providers only.** A short list of tiles — not rclone's 70-backend
menu:

| Provider | What we ask for |
|---|---|
| Any S3-compatible (incl. Backblaze B2, Wasabi, Cloudflare R2) | Endpoint (prefilled per preset), bucket, key id, secret |
| SFTP | Host, user, password or key file |
| WebDAV (Nextcloud etc.) | URL, user, password |
| Google Drive / Dropbox / OneDrive | One **Connect** button → browser OAuth |

"Other (advanced)" can expose a raw remote string for people who already have a
working rclone config, but it is never on the happy path.

**Everything else is decided for the user:**

- The `crypt` wrapper is applied automatically — not a checkbox, not a question.
  There is no "unencrypted" option.
- We generate the remote name, the folder layout, `--exclude` rules, the
  transfer flags, and the `crypt` filename-encryption mode. No knobs.
- OAuth uses rclone's local browser callback, driven headlessly by us. The user
  sees a browser tab and a success page — nothing else.
- **Test before saving.** The setup dialog performs a real write/read/delete
  round trip and reports a plain-English result. A misconfigured remote must be
  impossible to save.
- Errors are translated. rclone's stderr is diagnostic, not user-facing; map the
  common failures (bad credentials, bucket missing, clock skew, no network) to
  sentences a person can act on, and put the raw text in the log only.

**Second-device pairing must be one paste.** This is where every BYO-sync tool
falls down. On the first device, **Settings ▸ Sync ▸ Copy connection code**
produces a single opaque string: the remote config plus the encryption key,
encrypted under a passphrase the user chooses. On the second device: **Open
Satchel ▸ From a connection code** → paste → passphrase → it pulls and opens.
No re-entering endpoints, no re-typing keys, no chance of a mismatched crypt key
silently producing a second, invisible copy of the data.

The passphrase is the only thing the user has to remember or transport, and it
protects the code in transit — so it is safe to send the code to yourself over
email or a notes app.

**Copying the code is required to finish setup.** With `crypt`, losing the key
means the data is unrecoverable — there is no provider to appeal to. So the last
step of the setup wizard is a **Save your connection code** screen, and **Finish
is disabled until the code has been copied or saved**:

- The code is shown in a read-only, selectable monospace field.
- A **Copy** button that swaps to a checkmark (and "Copied") for ~2s on click,
  then reverts — the pattern from modern code-snippet UIs.
- A **Save to file…** button beside it, which satisfies the same gate. The
  clipboard is not durable storage, and a user who copies and then copies
  something else has nothing.
- Plain copy above the field: *"This code is the only way to open this Satchel
  on another device. If you lose it and your passphrase, the synced notebooks
  cannot be recovered — not by us, not by your storage provider."*
- Manual selection of the field's text does **not** satisfy the gate; only the
  two buttons do, because only they are observable.

Re-copyable any time afterwards from **Settings ▸ Sync ▸ Copy connection code**,
which uses the same button treatment. Regenerating the code (e.g. after rotating
credentials) re-arms the same gate.

### Security

- The remote is wrapped in an rclone **`crypt`** remote, always, so filenames
  and contents are encrypted before leaving the machine. The provider is never
  trusted — that's the whole pitch.
- `rclone.conf` lives in `%LOCALAPPDATA%\Vellum\`, **never inside the Satchel**
  (it must not sync). Config encryption is enabled and the config password is
  stored in Windows Credential Manager (DPAPI-backed). rclone's default
  "obscure" is obfuscation, not encryption — do not rely on it.
- **Never log rclone command lines or stdout verbatim** — tokens and passwords
  appear in both. The [applog](../src-tauri/src/applog.rs) integration must
  redact.
- **Losing the encryption key means losing the data.** Setup cannot be completed
  until the connection code has been copied or saved to a file — see
  [Setup UX](#setup-ux--the-hard-requirement).

### Where the binding lives

Split deliberately, so the sync-state icon can render for a Satchel that isn't
open while no secret ever syncs:

| Where | What |
|---|---|
| `satchels.json` (machine-local) | Per Satchel: `sync: { remote: "b2", label: "Backblaze B2", lastSyncedAt }` — enough to draw the cloud icon and its tooltip. No credentials. |
| `rclone.conf` (machine-local, encrypted) | Credentials and the crypt key. |
| Inside the Satchel | Nothing sync-related except `lease.json` and the oplog. |
- **Never log rclone command lines or stdout verbatim** — tokens and passwords
  appear in both. The [applog](../src-tauri/src/applog.rs) integration must
  redact.

### Correctness: SQLite is the hard part

`notebook.db` is opaque to rclone, and in WAL mode the `.db` file alone is not a
complete snapshot. Every sync therefore:

1. Drains the `PoolCache` (closes all connections) — the same call
   `set_data_dir` uses today.
2. Runs `PRAGMA wal_checkpoint(TRUNCATE)` on each notebook.
3. Excludes `-wal` / `-shm` from the transfer (`--exclude`).
4. Transfers, then reopens.

Sync runs **on quiesce and on close**, never per-keystroke. A multi-MB DB per
save is untenable.

### Single-writer lease

Scope is the **whole Satchel**, matching the sync payload (`app.json` travels,
which is the point).

- On open: pull, then write `lease.json` to the remote with `{ deviceId,
  deviceName, acquiredAt, heartbeatAt }`. Refresh the heartbeat periodically.
- If a live lease is held by another device: offer **Open read-only** or **Take
  over** (with a plain warning that the other device's unsaved work may be
  lost). A stale heartbeat past a threshold takes over without ceremony.
- On close: final sync, then release.
- Advisory, not enforced — a device that is offline can still edit. That
  produces a conflict, handled below.

### Conflicts

At this granularity a conflict is a **whole-Satchel** conflict. Losing side is
preserved as a sibling Satchel folder (`Vellum (conflict 2026-08-06 from
LAPTOP)`) that the user can open like any other and copy pages out of. Never
overwrite silently.

### Warnings

- If a Satchel being bound to a remote sits under a **OneDrive** root, warn
  before proceeding: two sync engines on the same live SQLite files is the exact
  failure the spec already cautions about. Vellum sync is an *alternative* to
  OneDrive, not an addition. Offer to create/move the Satchel outside OneDrive,
  and allow overriding with an explicit "I understand".
- Detection: compare the canonical path against the `OneDrive` /
  `OneDriveCommercial` environment variables and the known-folder Documents path
  when it redirects into OneDrive (as it does on the maintainer's machine —
  `…\OneDrive - Microsoft\Documents\…`).

### UI

New **Settings ▸ Sync** panel, scoped to the active Satchel:

- Not synced → a single **Set up sync…** button opening the provider tiles.
- Synced → provider name, last-synced time, **Sync now**, lease status ("In use
  by LAPTOP since 09:12"), **Copy connection code**, and **Stop syncing** (which
  leaves the local Satchel and the remote copy both intact, and says so).
- First-run download of the rclone component reuses the Ollama download UI
  pattern — progress, size, cancellable — with no mention of what it is beyond
  "sync support".

### Exit criteria

- A person who has never heard of rclone completes setup on device 1 and pairing
  on device 2 without leaving the app, without a terminal, and without reading
  documentation.
- Two machines, alternating use, no data loss over a sustained real-usage
  period.
- Killing the app mid-sync leaves both local and remote openable.
- Deliberately forcing a conflict produces a conflict Satchel, not a merge.
- A wrong credential is caught by the setup round trip, not at first sync.
- Setup cannot be finished without copying or saving the connection code, and
  the saved code opens the Satchel on a second device.
- No secret ever appears in `vellum.log`.

---

## 3. Oplog shadow-write + replay-and-diff

Ships **with** SYNC-A, but changes no behaviour: the log is written and verified,
never read by the app. This is the on-ramp to SYNC-B.

### Record format

Append-only JSONL, one file per device, inside the Satchel:
`<satchel>/<notebook>/oplog/<deviceId>.jsonl`. Append-only per-device files are
the one thing file sync is genuinely good at — no two devices ever write the
same file, so there is nothing to conflict.

```jsonc
{ "v": 1, "op": "page.move", "hlc": "…", "dev": "…", "id": "page-7", "to": "section-3" }
```

Baked in from the first record and painful to change later:

- **`dev`** — stable per-device uuid (shared with the sync lease).
- **`hlc`** — hybrid logical clock, not wall-clock. Clock skew between machines
  will otherwise reorder edits.
- **`v`** — format version on every record.
- **Intent, not diffs.** `"page 7 moved to section 3"`, never `"row updated"`.
  Intent merges; diffs don't. This is the single most important constraint.

### Verification: replay-and-diff

Reading the logs by eye will not find the bugs that matter. The failure mode in
SYNC-B is a mutation path that *forgot* to log — and an absent entry is
invisible in a log.

The harness rebuilds a fresh `notebook.db` from an empty database by replaying
the oplog, then structurally diffs it against the live DB. Any difference means
something isn't captured, and the diff names the operation. Runs on app close
during the shadow period, plus a **Settings ▸ Advanced ▸ Verify change log**
button. Failures are logged with the offending operation.

This converts "use it for a few weeks and hope" into a hard binary signal.

### Growth

The log grows without bound. Compaction: periodic snapshot + truncate of records
older than the snapshot. Design the format for it now; implement when it bites.

### Exit criteria

- Replay-and-diff green across weeks of real usage, covering page/section
  create, rename, move, delete, content edits, attachments, and cross-notebook
  section moves.

---

## 4. Sync, phase B — oplog as canonical

Flip only once §3's exit criteria are met.

- `notebook.db` is demoted to a locally rebuildable **projection** of the log.
- Sync transfers only oplog files and content-addressed (immutable) attachment
  blobs — small, incremental, conflict-free by construction.
- Merge is last-write-wins **per page**, with the losing version retained as a
  conflict page (what OneNote effectively does). Structural ops (move, delete)
  merge by intent.
- The single-writer lease can be relaxed to advisory-only; genuine offline
  editing on two devices now merges instead of conflicting.
- Free consequences worth advertising: per-page version history, and "restore a
  deleted page" becomes trivial.

### Exit criteria

- Two devices, both edited offline, both reconnect → all edits present, no
  silent loss, conflicts surfaced as pages.
- A corrupted or deleted `notebook.db` rebuilds fully from the log.

---

## Decisions log

| Date | Decision |
|---|---|
| 2026-08-06 | Name is **Satchel**. No `.satchel` folder extension; identity via a `satchel.json` marker with a stable uuid. |
| 2026-08-06 | All settings stay Satchel-scoped (inside `app.json`) so a synced Satchel is preconfigured on a new machine. Only the known-Satchel list is machine-local. |
| 2026-08-06 | Switching Satchels relaunches the app. No live swap. |
| 2026-08-06 | No titlebar Satchel indicator — Settings is the place to check. |
| 2026-08-06 | No CLI parameter or environment override. |
| 2026-08-06 | "Change…" / move-data is **removed**, not replaced. Move the folder in Explorer and re-open it; **New Satchel…** takes its place in the UI. |
| 2026-08-06 | Forgetting a Satchel is non-destructive; ✕ carries a tooltip saying so. |
| 2026-08-06 | **New Satchel…** copies settings from the current Satchel by default (checkbox, checked); unchecking gives defaults. |
| 2026-08-06 | Each Satchel shows a sync-state icon in the dropdown: disk (local) or cloud (synced). |
| 2026-08-06 | Sync scope is the whole Satchel (settings included), so the lease is per-Satchel, not per-notebook. |
| 2026-08-06 | A synced Satchel should live outside OneDrive; warn (with override) when binding one that isn't. |
| 2026-08-06 | rclone is an implementation detail: curated provider tiles, no interactive `rclone config`, no terminal, encryption always on and never a question, mandatory connection round trip before saving, translated errors. |
| 2026-08-06 | Second-device pairing is a single **connection code** (remote config + crypt key, encrypted under a user passphrase) — paste, passphrase, done. |
| 2026-08-06 | Setup **cannot be finished** until the connection code is copied or saved to a file. Copy button shows a checkmark + "Copied" for ~2s; manual text selection does not satisfy the gate. |
| 2026-08-06 | Ship phase A, shadow-write the oplog in the same release, flip to phase B only after replay-and-diff is sustained-clean. |
