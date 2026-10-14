# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Boenxia/dsh-plugin-notebook-tools/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Boenxia/dsh-plugin-notebook-tools/releases/tag/v0.1.0
