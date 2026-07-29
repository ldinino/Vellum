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
- [ ] Grammar check sometimes incorrectly flags two lines as a run-on sentence:
  finish a sentence with a colon, hit Return, and begin a new sentence, and
  Harper mistakes the two for one long sentence.
- [x] Image grabbers are always visible — they should only appear on hover.

### UX

- [ ] Don't spell-check or grammar-check hyperlinks.
- [ ] Make code blocks more dynamic. Sometimes a code block should behave more
  like an inline `code` insert mid-sentence. If the code block is on its own
  line, keep today's behavior. If I highlight a word within a sentence (or invoke
  the code block while working inside a sentence), it should behave like bold or
  italic — i.e. an inline code mark rather than a block.

### Other

- [ ] The UI is slow to draw: clicking a section takes a couple of seconds for
  the pages to come in, especially on ARM64 machines (tested on a Mac running
  Parallels).

## Features

### UI

- [ ] Evaluate dropping in [98.css](https://jdan.github.io/98.css/) — a design
  system for building faithful recreations of old UIs.
- [ ] Dark mode for both themes.
