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
| [STANDDOWN](#51-standdown--act-on-a-lost-lease-shipped) | Stand down when the lease is lost _(shipped)_ | S | SYNC-A |
| [YIELD](#52-yield--release-the-lease-on-idle-lock-and-sleep) | Release the lease on idle, lock and sleep | M | STANDDOWN |
| [HANDOFF](#53-handoff--ask-the-holder-to-let-go) | Ask the holder to let go (remote request file + Notify) | M | STANDDOWN, YIELD |
| [STAGEDPUSH](#54-stagedpush--make-the-remote-switchover-the-commit-point) | Make the remote switchover the commit point | M | SYNC-A |
| [COPY](#55-copy--how-the-take-over-is-described) | Take-over wording and vocabulary rules | S | STANDDOWN |

**Sequencing.** SATCHEL ships alone. SYNC-A and OPLOG ship together in the next
release — the oplog is written but not yet trusted. SYNC-B flips the switch only
once replay-and-diff has been clean over a sustained stretch of real usage.

**Status (2026-08-12).** SATCHEL **shipped in v0.4.0** and its decisions are
folded into [Vellum_spec.md](Vellum_spec.md). SYNC-A is **built but gated off**:
the Sync tab is hidden and nothing syncs on open or close unless
`settings.syncEnabled` is set by hand in `app.json` (debug builds always show
it). OPLOG has its foundation only — clock, record format and writer — with the
mutation paths not yet instrumented and no verifier. SYNC-B is untouched.
[§5 Device handoff](#5-device-handoff-2026-08-12-batch) is the newly opened
track that makes the checkout model liveable across three devices; it is a
prerequisite for ungating sync, and SYNC-B is not.

**Why sync is gated rather than shipped.** It works end to end against a local
folder and Google Drive, but it has not been proven over time or across real
devices. The OAuth token is stored without an rclone config file, so whether a
provider that rotates refresh tokens still works days later is unverified; only
Drive's error strings have been seen in anger; and OPLOG — the thing that makes
concurrent editing genuinely safe — is barely started. Putting people's
notebooks behind a mechanism we can't yet stand behind is the one mistake this
feature cannot recover from.

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
- **Bundled in the installer as a Tauri sidecar**, not downloaded. rclone's
  Windows zip is ~30 MB (v1.75.0: 30 MB amd64, 27 MB arm64) — two Vellum
  installers, not the 1.4 GB that forces Ollama to be downloaded. Paying ~30 MB
  deletes the entire acquisition subsystem: no download UI, progress, cancel,
  retry or resume; no SHA-256 pin to re-verify on every rclone release; no
  "failed behind a corporate proxy" support burden. Sync works on first launch,
  offline. Given that *stupidly easy* is this feature's hard requirement, that
  trade is the whole point. **Reverses the initial "download on demand"
  decision, which had been reasoned by false analogy to Ollama.**
- The binary lives at `src-tauri/binaries/rclone-<target-triple>.exe`, fetched
  by [fetch-binaries.ps1](../scripts/fetch-binaries.ps1) for dev and by CI
  before bundling. `src-tauri/binaries/` is gitignored — we do not commit a
  30 MB third-party binary.
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
- **There is no `rclone.conf`.** rclone accepts a complete remote definition
  through `RCLONE_CONFIG_<NAME>_<KEY>` environment variables, and `--config ""`
  disables the config file entirely — both verified against the shipped binary.
  So credentials are never written to disk in rclone's format at all, and the
  user's own `%APPDATA%\rclone\rclone.conf` can never collide with our remote
  names. **This supersedes the original plan of an encrypted `rclone.conf` plus
  a config password in Credential Manager; that whole layer is gone.**
- The remote definition (endpoint, keys, and the two `crypt` passwords) is
  stored as a single **DPAPI-encrypted blob** at
  `%LOCALAPPDATA%\Vellum\satchels\<satchel-id>.remote` — machine-local, never
  inside a Satchel, decryptable only by the same Windows user on the same
  machine. That is the same protection class as Credential Manager without the
  extra dependency.
- Secrets reach rclone by **environment, not argv**: argv is readable by any
  process on the machine via the process list; environment is not.
- `crypt` passwords must be rclone-*obscured* values, produced by
  `rclone obscure`. Obscuring is not encryption — it is merely the format crypt
  expects, and the DPAPI blob is what actually protects them at rest.
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
| `<satchel-id>.remote` (machine-local, DPAPI-encrypted) | The full remote definition: endpoint, credentials, and the two crypt passwords. |
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

## 5. Device handoff (2026-08-12 batch)

**Why this exists.** The three-device goal is *sequential* use — desk, then
laptop, then back. SYNC-A's checkout model is the right shape for that, but the
switch currently feels terrible: the departing device holds the lease until it
is closed or goes stale, and staleness is 15 minutes
(`STALE_AFTER_SECS`, [lease.rs](../src-tauri/src/sync/lease.rs)) polled every
4 minutes (`HEARTBEAT_MS`, [syncSession.tsx](../src/state/syncSession.tsx)).

This track makes the flip feel instant **without** SYNC-B. It is deliberately
not a step toward concurrent editing; it is what makes checkout liveable.

**Decided:** solve it by releasing the lease *on the way out*, not by asking for
it faster on the way in. The departing device knows it is being left long before
the arriving device knows it wants in. Polling harder was considered and
rejected as the primary mechanism — each poll is an rclone spawn plus an
authenticated round trip, and some backends meter transactions.

### 5.1 STANDDOWN — act on a lost lease *(shipped)*

**Shipped 2026-08-13 (#2).** Prerequisite for the rest of this track.

The heartbeat detected that another device took the lease, set `lostLease` in
[syncSession.tsx](../src/state/syncSession.tsx) — and **nothing read it**. The
app kept accepting edits and would push over the new holder on close, so the
existing take-over path was effectively decorative.

- On losing the lease: drop the session to read-only and say so plainly.
- Never push after losing the lease. Offer to preserve unsynced local work as a
  conflict Satchel instead — the mechanism §2 already defines.
- Re-acquiring is an explicit user action, not automatic, in this task.

**A refuted premise worth keeping.** The brief assumed a false heartbeat meant
"taken over". It did not: an **absent** lease also returned false, and
`sync_now` releases the lease when it finishes. Wiring read-only to that boolean
would have dropped the user into read-only after **every successful sync**. The
heartbeat now returns a three-way `Standing` — `Ours`, `Vacant`, `TakenOver` —
and only `TakenOver` stands the session down. A transport failure stays an
`Err`, so a dropped connection never means read-only.

**`Standing::Vacant` is YIELD's trigger.** A vacant lease is the ordinary state
between syncs; §5.2's optimistic re-acquire is exactly the case of finding
`Vacant` and quietly taking it back.

**Deliberately left open:** local structural edits (create/rename/delete section
or page, attachments) still write while stood down. Nothing reaches the remote
except through the guarded push, and the generation check turns divergence into
a conflict Satchel. Page editing is continuous and is where "silently unable to
save" bites; structural edits are discrete. Revisit only if it bites in practice.

**Residual, recorded not hidden:** the push guard is enforced by a `PushPermit`
token the pusher cannot fabricate, which closes "the guard's answer was
discarded" at compile time. It does **not** close "the guard was asked about the
wrong state". Closing that needs a mock `AppHandle` or a binary-level
integration test; judged bigger than the fix. On the punchlist.

### 5.2 YIELD — release the lease on idle, lock and sleep

The one the user actually feels. The desktop syncs and releases once it is
clearly not in use, so the laptop finds the lease already free and waits for
nothing.

- Trigger on *unfocused **and** no input for a tunable idle period* — **not**
  bare blur, which would drop the lease every time you alt-tab to a browser.
- Session lock and system suspend release **immediately**, no timer: both mean
  "gone" unambiguously.
- Precedent for the shape: `REFINE_IDLE_RELEASE_MS` in
  [PageEditor.tsx](../src/components/editor/PageEditor.tsx) already idle-releases
  Ollama.
- Returning must be **optimistically writable** — re-take the lease in the
  background and only interrupt if someone else holds it. Blocking on a network
  round trip every time you come back replaces one bad feeling with another.

### 5.3 HANDOFF — ask the holder to let go

Backstop for "I walked away mid-sentence and it never noticed". The arriving
device writes a request file to the remote; the holder sees it on the poll it is
already doing, finishes its sync, and releases.

- Only helps when the holder is **running and online**. If nothing answers, fall
  through to the existing forced take-over, with staleness as the final backstop.
- The arriving device must show the wait honestly and offer **Take over now**
  rather than spinning silently.
- Poll rate should be **inverse to local activity**: actively typing means you
  are not about to switch, so poll slowly; idle or unfocused means poll quickly.
  YIELD naturally bounds how long the fast window lasts.

**Notify is a button, not just a mechanism.** Word 97 solved this exact problem
against a dumb SMB share with no server arbitration — our constraint precisely —
with a **File In Use** dialog offering *Read Only / Notify / Cancel*, where
**Notify** polled the lock and told you the moment the file came free. Adopt it:
asking to be notified is an explicit user action, not silent background
behaviour. That also settles the polling-cost argument — poll quickly **because
the user asked**, and only then.

### 5.4 STAGEDPUSH — make the remote switchover the commit point

`push` transfers with `rclone sync` **in place** and writes the generation
marker afterwards ([engine.rs](../src-tauri/src/sync/engine.rs)). A transfer
interrupted midway therefore leaves the remote holding half-new data under an
old marker, and a puller trusts the marker. SYNC-A's exit criterion "killing the
app mid-sync leaves both local and remote openable" is believed **not met**.

Stage into a generation-scoped path and let the marker flip be the only commit —
a single small-file write, atomic on every supported backend.

### 5.5 COPY — how the take-over is described

Settled 2026-08-13 after seeing the shipped bar in the app. The original text
read as an apology: three separate reassurances for one situation.

> **This Satchel is open on DESKTOP-01.** Editing is paused here.
> **[ Save a copy here ]  [ Take over ]**

- **Name the machine.** "Open elsewhere" tells the user they are blocked and
  refuses to say by what.
- **One reassurance, not three.** Drop "nothing will be sent to your storage" —
  that is mechanism, not comfort.
- **"Take over" matches the shipped dialog** in
  [SyncSettings.tsx](../src/components/settings/SyncSettings.tsx) ("Take over
  anyway?", title "Satchel in use"). One word per action across the product.
- Rejected: *Fork from here* (developer vocabulary; does not say what is copied
  or where it lands) and *Transfer session* ("session" is our word, and it is
  directionally ambiguous on the one button that evicts another machine).

**Vocabulary rules.** User-facing: *open on*, *paused*, *take over*, *a copy of
your unsent changes*. Never in the UI: *lease*, *heartbeat*, *stand down*,
*generation*, *conflict Satchel* — "conflict" makes people think they broke
something. The backend error string should be brought onto the same wording as
the bar rather than saying "is using this Satchel" in one place and "is open on"
in the other.

### Exit criteria

- Losing the lease makes the session read-only and prevents any later push.
- Desk → laptop within a minute of stopping work: the laptop opens writable with
  no take-over prompt and no perceptible wait.
- Locking the workstation releases the lease without waiting out the idle timer.
- Returning to the yielded device is immediately typable.
- A holder left open and idle responds to a handoff request without the user
  touching it; a holder that is offline still yields via take-over.
- Killing the app mid-push leaves the remote openable at the previous generation.

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
| 2026-08-06 | **rclone is bundled as a Tauri sidecar, not downloaded** (reverses the earlier call). At ~30 MB it is nothing like Ollama's 1.4 GB, and bundling removes the whole download/verify/retry/offline subsystem — which is what "stupidly easy" actually requires. Installer grows ~12 MB → ~42 MB. |
| 2026-08-07 | **No `rclone.conf`.** Remotes are defined entirely through `RCLONE_CONFIG_*` environment variables with `--config ""`; the definition is stored as one DPAPI-encrypted blob. Verified against the shipped binary, including a `crypt` round trip. Removes the encrypted-config-file and config-password layer, keeps credentials off disk, and isolates us from the user's own rclone config. |
| 2026-08-12 | The three-device goal is served by **checkout, made fast** — not by concurrent editing. SYNC-B stays parked; §5 is what makes SYNC-A liveable. |
| 2026-08-12 | Handoff works by the departing device **yielding on idle/lock/sleep**, not by the arriving device polling harder. Faster polling was rejected as the primary mechanism (rclone spawn + authenticated round trip per poll; some backends meter transactions); it survives only as an activity-inverse backstop in HANDOFF. |
| 2026-08-12 | Returning to a yielded device must be optimistically writable — the lease is re-taken in the background, never blocking the first keystroke. |
| 2026-08-13 | A heartbeat has **three** outcomes, not two: `Ours` / `Vacant` / `TakenOver`. Only `TakenOver` stands a session down; `Vacant` is ordinary (our own sync releases the lease when it finishes) and is YIELD's re-acquire trigger. A transport failure is an `Err`, never a standing — a dropped connection must not mean read-only. |
| 2026-08-13 | While stood down, **local structural edits stay allowed** (sections, pages, attachments). Nothing reaches the remote except the guarded push, and divergence becomes a conflict Satchel. Only page editing is paused. |
| 2026-08-13 | Take-over copy: **"This Satchel is open on DESKTOP-01. Editing is paused here."** with **[ Save a copy here ] [ Take over ]**. Name the machine — "elsewhere" tells the user they are blocked and refuses to say by what. *Fork* and *Transfer session* rejected. |
| 2026-08-13 | UI vocabulary: *open on*, *paused*, *take over*, *a copy of your unsent changes*. Banned from the UI: *lease*, *heartbeat*, *stand down*, *generation*, *conflict Satchel*. |
| 2026-08-13 | HANDOFF gets an explicit **Notify** button, after Word 97's *File In Use* dialog, which solved this against a dumb SMB share with no arbitration. Polling fast is justified because the user asked, not as ambient behaviour. |
