# Vellum — Punchlist

Running log of bugs and feature ideas raised by the maintainer while using the
app. This is a lightweight capture list, **not** a commitment or a schedule:
[execution-plan.md](execution-plan.md) is the working backlog and
[Vellum_spec.md](Vellum_spec.md) stays the source of truth (per
[CLAUDE.md](../CLAUDE.md)). Items graduate from here into the execution plan (and
then the spec) once they're picked up.

_Started 2026-07-28._

## Bugs

### Refine

_None logged yet._

### UI

- [ ] Refine spinner needs a better asset — an hourglass GIF or something.
- [ ] Invalid HTML in the menus: `MenuList` renders a `SubMenu`'s
  `<button role="menuitem">` inside its parent `<button role="menuitem">`, so
  React logs "In HTML, `<button>` cannot be a descendant of `<button>`" (a
  hydration error) every time a menu with a submenu opens. See
  [MenuBar.tsx](../src/components/MenuBar.tsx). **Reproduced 2026-08-13** — fires
  on the first menu open in `tauri dev`, with the full component stack.
- [ ] React warns "flushSync was called from inside a lifecycle method. React
  cannot flush when React is already rendering." during normal editing — source
  not yet identified (suspect Tiptap).
- [x] Grammar check sometimes incorrectly flags two lines as a run-on sentence:
  finish a sentence with a colon, hit Return, and begin a new sentence, and
  Harper mistakes the two for one long sentence.
- [x] Image grabbers are always visible — they should only appear on hover.

### UX

- [x] Don't spell-check or grammar-check hyperlinks.
- [x] Make code blocks more dynamic. Sometimes a code block should behave more
  like an inline `code` insert mid-sentence. If the code block is on its own
  line, keep today's behavior. If I highlight a word within a sentence (or invoke
  the code block while working inside a sentence), it should behave like bold or
  italic — i.e. an inline code mark rather than a block.

### Other

- [ ] **SILENTHOLD.** An instance that opens a Satchel another device already
  holds shows **nothing at all** — an ordinary writable window. Observed on the
  §5.6 rig (#7, screenshot in that PR). The user edits happily into a divergence
  they were never told about. This is the top open product defect on the sync
  track: STANDDOWN covers *losing* the lease mid-session, but never *arriving* to
  find it held.
- [x] Confirm on real hardware that locking the workstation releases the Satchel.
  **Observed 2026-08-13** on the rig with the idle timer at ten minutes so it
  could not be the cause: `LockWorkStation` 14:54:38.757 → `deletefile
  lease.json` 14:54:44.483. `sync::presence` is alive. *Suspend/resume and
  `WTS_REMOTE_DISCONNECT` are still unobserved.*
- [x] **DOUBLEYIELD — closed as a rig artefact (2026-08-13).** Measured on three
  configurations: dev + StrictMode, dev with StrictMode removed, and a static
  production frontend with no HMR. Yield and resume each issued exactly one
  rclone sequence in all three, with one React root and one `SyncSessionProvider`
  instance throughout, including across HMR generations. The doubling reproduces
  only when two `vellum.exe` share one `VELLUM_MACHINE_DIR` and therefore one
  log — including log lines torn mid-write by two writers, which no single
  process can produce. The lost push was two rig processes racing one crypt
  destination, not the shipped push path.
- [ ] Rig hygiene, both from the DOUBLEYIELD triage: `dev-two.ps1` writes
  `instance.pid` (line 202) and never reads it, so nothing stops a second
  `-Which A` — refuse to launch when that pid is alive, with `-Force` to
  override. And prefix every `applog` line with the process id, so a doubled
  operation in a shared log is attributable at a glance rather than after a day.
- [ ] Measurement trap: after any HMR update, `getCurrentWindow().isFocused()`
  returns `true` for a window that is not focused, so the yield timer never arms.
  Any rig measurement taken after a mid-session edit silently cannot yield.
  Use the prod-mode recipe (§5.6) for anything load-bearing.
- [ ] Retune `YIELD_IDLE_MS` (currently 60s) once the desk-to-laptop flip has
  been felt a few times, and watch how often a yield fires while a browser is in
  front of Vellum.
- [ ] Nothing on the TypeScript side has permanent test coverage. Measured at the
  #4 audit: mutating `msUntilYield` to ignore `focused` (yield on bare blur, the
  one behaviour the task forbade) and mutating `SATCHEL_IN_USE` so it no longer
  matches `IN_USE_PREFIX` both left `tsc`, `npm run build` and all 150 Rust tests
  green. Disposable harnesses prove logic at the time and guard nothing after.
  Deciding whether to adopt a JS test runner is the real item here.
- [ ] `shouldYieldNow` in [yield-lease.ts](../src/lib/yield-lease.ts) is exported
  and never called; `tsc` does not flag unused exports.

- [ ] `package-lock.json` is stuck at `"version": "0.2.0"` while package.json,
  Cargo.toml and tauri.conf.json are current — [bump-version.ps1](../scripts/bump-version.ps1)
  updates three files and not the lockfile. Every `npm install` therefore dirties
  the tree, which quietly undermines "the working tree is clean" as a check.
- [ ] Sync: the push guard's `PushPermit` proves the guard's answer was not
  discarded, but nothing proves it was asked about the *right* state —
  `push_permitted(&StandDown::default(), …)` still compiles. Closing it needs a
  mock `AppHandle` (`tauri::test`) or a binary-level integration test. Measured
  2026-08-13: with the call site neutralised, all 145 tests still passed.
- [ ] Sync session state `message` and `conflictCopy` are set and never read —
  a failed `begin_session` and a conflict copy taken during the opening pull are
  both invisible to the user. See
  [syncSession.tsx](../src/state/syncSession.tsx).

- [x] The UI is slow to draw: clicking a section takes a couple of seconds for
  the pages to come in, especially on ARM64 machines (tested on a Mac running
  Parallels).
  - Two measured backend causes fixed: every command was reopening the notebook
    database (~5 ms of setup vs ~0.2 ms of query — 24x overhead), and every
    launch rebuilt the whole search index (~1.2 s for 300 pages). Both are now
    cached / incremental. Frontend startup cost (bundle size, editor mount) has
    not been profiled yet — revisit if it still feels sluggish.

## Features

### UI

- [x] Evaluate dropping in [98.css](https://jdan.github.io/98.css/) — a design
  system for building faithful recreations of old UIs.
  - Evaluated and shipped as a **fourth theme family** rather than a dependency.
    98.css has no scoped build (it styles bare `button`/`input`/`select`/`a`/
    `pre` and the scrollbars), so importing it would have half-restyled all 101
    buttons in the app. Its actual value was ~10 colours and 6 bevel recipes,
    now re-expressed in `src/styles/theme98.css` under MIT attribution. Also
    found that **7.css was imported but applied to nothing** (no `.win7`
    element exists) — 82 KB of dead CSS, now removed.
- [x] Dark mode for both themes.
  - Aero has **Dark** and **Dark (OLED black)**; Windows 98 has **Dark**, which
    reuses the same palette behind 98 bevels. (Read as "both theme families" —
    untick if you meant something else.)
