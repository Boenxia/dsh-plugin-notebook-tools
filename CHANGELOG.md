# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.3] - 2026-10-15

### Fixed

- The skill's fidelity section claimed that nothing is ever invented, full stop.
  The cell you edit is the exception: editing a code cell writes `outputs` and
  `execution_count` — that is what "clear the outputs" means — so a cell that
  carried neither key gains both, appended at the end of its key order. Only
  *untouched* cells keep their exact shape. The wording now says so, bullet by
  bullet, instead of leaving the reader to discover it from a byte diff.
  Verified end to end against a hand-written nbformat 4.4 file (2-space indent,
  CRLF, no trailing newline, no cell ids): the untouched cells kept their array
  `source` and their `outputs`/`execution_count` and were not given an `id`; the
  file kept its indent, its CRLF and its missing trailing newline; the edited
  cell alone came back with the two keys appended.

## [0.2.2] - 2026-10-15

### Fixed

- `npm run release` compared the tag with HEAD through the bare ref, which for
  an annotated tag yields the *tag object* rather than the commit it marks — so
  a tag that did point at HEAD was reported as pointing somewhere else, and
  re-running a finished release failed. It now compares the peeled commit
  (`refs/tags/v<x.y.z>^{commit}`). As a result a completed release is a clean
  no-op: the push and the tag are skipped and the existing GitHub Release is
  reported instead of being posted a second time.

### Added

- `test/release.test.js` pins the peeling down against a throwaway repository.

## [0.2.1] - 2026-10-15

Releases are a script now, not a habit: `npm run release` verifies the version
against the CHANGELOG, runs the tests, tags, pushes, and publishes the GitHub
Release.

### Added

- **`npm run release`** (`scripts/release.mjs`): reads the version from
  `package.json` and refuses to run unless `CHANGELOG.md` carries a matching,
  non-empty `## [x.y.z]` section and a `[x.y.z]:` link reference; requires a
  clean working tree on the release branch with the version bump already
  committed; runs `node --test`; pushes the release branch; creates the
  annotated tag `v<x.y.z>`; pushes it; and creates the GitHub Release through
  the REST API, using the tag annotation as the release title and the CHANGELOG
  section as its body.
  Credentials come from `GITHUB_TOKEN` / `GH_TOKEN` or `git credential fill`
  and are never printed. Flags: `--title`, `--dry-run`, `--skip-tests`,
  `--branch`, `--remote`.
- `test/release.test.js`: covers the argument parser, remote URL parsing,
  CHANGELOG section and link-reference extraction, and token resolution.

### Changed

- `package.json` gains the `release` script. No published file changed.

## [0.2.0] - 2026-10-15

Fidelity and guard hardening: a notebook now survives a write untouched except
for the edit you asked for, and every mutating tool can be guarded by a content
hash rather than a timestamp. Ported back from the Python CLI skill that had
grown these properties first.

### Added

- **Layout-preserving serialization.** `lib/nb/style.js` probes the layout a
  notebook already uses — JSON indent (0/1/2/4), CRLF vs LF, and whether the
  file ends with a newline — and writes it back in that same layout. Cells whose
  `source` is a plain string stay a string; keys that were absent
  (`outputs`, `execution_count`, `metadata`) are not invented. A file that is
  read and written back unmodified is byte-identical, which makes the plugin
  safe to point at notebooks produced by JupyterLab, `nbformat.writes`, or hand
  editing. Known limits: tab indentation, `\uXXXX`-escaped non-ASCII (Python's
  `ensure_ascii=True`), and more than one trailing newline are normalized to the
  tool's defaults.
- **`expected_file_sha256` on all four mutating tools.** `expected_file_mtime_ms`
  cannot see a rewrite that happens inside the same millisecond; the content
  hash can. `notebook_read` and `notebook_list_cells` now return `file_sha256`
  so the value never has to be guessed.
- **`expected_source_sha256` on `notebook_insert_cell` (its anchor cell) and
  `notebook_clear_outputs` (its target cell).** Every mutating tool now accepts
  the same three guards.
- **Deterministic ids for notebooks too old to store them.** A missing cell id
  is derived from `sha256("v1|<ordinal>|<source>")` instead of random bytes, so
  the same cell gets the same id on every load, across processes.
- **Structure validation before every write.** The save path runs the deep
  audit and refuses to write a notebook that fails it — cell ids must match
  `^[A-Za-z0-9_-]{1,64}$` and be unique, `metadata` must be an object when
  present, a code cell's `outputs` must be an array when present, and every
  element of a `source` array must be a string. `notebook_validate` reports the
  same deep problems.
- `test/fidelity.test.js` — byte-for-byte round trips across six file layouts,
  deterministic id behavior at nbformat 4.4 and 4.5, guard coverage for all four
  writers, append-only behavior for an unedited cell, and the documented
  non-preservable cases. Suite: 61 → 75 assertions.

### Changed

- **Writes no longer reformat the whole file.** The old save path rebuilt the
  document and forced a 1-space indent, which reformatted every notebook it
  touched (and silently dropped unknown root keys).
- **`nbformat_minor` is no longer bumped.** Backfilling an id never changes the
  declared notebook format.

### Fixed

- README and CHANGELOG claimed id backfill "bumps `nbformat_minor` to 5". No
  code path ever did that; the documentation now matches the implementation.
- A notebook that is valid enough to inspect but structurally broken is now
  reported by `notebook_validate` and refused by the writers, instead of being
  silently loaded and rewritten.

## [0.1.2] - 2026-10-14

### Added

- A **`cell_type` self-check** in the skill's style section: the first cell and
  every `## N.` heading cell must be `markdown`. Markdown-prose content typed as
  `code` is executed as Python and dies on the first non-comment line with
  `SyntaxError: invalid character '（' (U+FF08)` — a failure that surfaces
  several cells away from the cell that actually has the wrong type.
- A **wrong-type trap** in the "after editing" checklist: after any layout
  refactor, re-check the cell types with `notebook_list_cells`. `notebook_validate`
  only validates structure, so a markdown body sitting in a code cell passes it
  and still breaks `Run All` on the first cell.

### Changed

- The troubleshooting order for "the notebook won't run" is now: check
  `cell_type` first, then check for a cell stuck waiting on `input()`.

## [0.1.1] - 2026-10-14

### Added

- A **notebook authoring style** section in the companion skill
  (`skill/notebook-tools/SKILL.md`). Section commentary belongs in its own
  markdown cell, one `## N. 中文标题` heading per section, no section banners
  inside code cells, and callouts as blockquotes. This codifies the layout the
  tools were originally used to produce; an explicit user request still wins.

### Changed

- The skill `description` and `whenToUse` now list *creating/authoring* notebooks
  as a trigger, not only reading and cleaning them.

## [0.1.0] - 2026-10-14

First release: a DSH port of OpenClaw's `openclaw-notebook-tools`.

### Added

- Nine cell-aware Jupyter notebook tools registered on the DSH plugin host:
  `notebook_create`, `notebook_read`, `notebook_list_cells`, `notebook_search`,
  `notebook_validate`, `notebook_edit_cell`, `notebook_insert_cell`,
  `notebook_delete_cell`, `notebook_clear_outputs`.
- `lib/nb/` — a pure domain layer (cell ids, source normalization, load and
  validate, output truncation, hashing, path resolution, search) that imports
  only `node:` builtins.
- `lib/tools/` — tool adapters carrying JSON Schema parameters, stable error
  codes, and the human-readable or JSON response text each tool returns.
- `cordis.patch.yml` — the composition row DSH merges at boot, wired through the
  package's `dsh.bundle.patch` hook.
- `skill/notebook-tools/SKILL.md` — the companion DSH skill.
- 61 `node:test` assertions covering the domain layer, error mapping, atomic
  writes, and full create → read → edit → delete round trips.

### Semantics

Ported behavior-for-behavior from the upstream spec:

- **Atomic saves.** Mutations serialize with a 1-space JSON indent, write to a
  sibling temp file, `fsync` it, then `rename` over the target. A killed process
  cannot leave a half-written notebook, and temp files never land in the system
  temp directory.
- **Cell ids over indexes.** `notebook_read`, `notebook_list_cells`, and
  `notebook_search` always return an `id`; missing ids are backfilled in memory
  and persisted on the next save, which bumps `nbformat_minor` to 5.
- **Editing a code cell clears its `outputs` and `execution_count`.**
- **Stale-edit guards.** `expected_source_sha256` and `expected_file_mtime_ms`
  fail the operation before any write; the mtime comparison tolerates
  sub-millisecond jitter.
- **Source on disk is a string array** (one element per line, trailing newline
  preserved); the tools return the joined string.
- **nbformat 4 only**; v3 and earlier are rejected.
- **No kernel execution, ever.**

### Notes

- Zero runtime dependencies: the package imports only `node:` builtins and
  registers plain tool descriptors, so nothing resolves from the host SDK.
- Deliberate deviations from upstream: the domain layer uses `node:path` rather
  than a hand-rolled POSIX-only path split (upstream's version breaks on
  Windows), and cell ids come from `node:crypto` rather than `nanoid`.

[Unreleased]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Boenxia/dsh-plugin-notebook-tools/releases/tag/v0.1.0
