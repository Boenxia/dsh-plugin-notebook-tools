# dsh-plugin-notebook-tools

Cell-aware Jupyter notebook tools for DSH agents. A zero-dependency Node ESM
plugin that ports the OpenClaw `notebook-tools` plugin (9 tools) onto the DSH
host.

The core `read` / `write` / `edit` tools treat `.ipynb` files as opaque JSON,
which is error-prone, token-hungry, and easy to corrupt. This plugin provides a
structured, cell-aware API instead: stable cell ids, output-aware truncation,
stale-edit guards, and atomic writes.

## Install

```powershell
dsh plugin --profile desktop add --config.minimumReleaseAge=0 F:\path\to\dsh-plugin-notebook-tools
```

`dsh plugin` forwards to the pnpm bundled with DSH, and `--profile` is
required. The `--config.minimumReleaseAge=0` override is needed while the
target profile's *existing* lockfile entries are newer than pnpm's default
`minimumReleaseAge` cutoff (pnpm 11.7.0 enforces that default even when the
profile's `pnpm-workspace.yaml` lists the same offenders under
`minimumReleaseAgeExclude`). Without it you get
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` naming packages you did not touch.

On success the package is appended to **both** `dependencies` and
`dsh.profile.bundles` in `<DSH_HOME>\profiles\<profile>\package.json` — no
manual edit needed. A failed run can still leave a link in `node_modules`, so
treat the `package.json` entry, not `node_modules`, as proof.

The plugin ships a `cordis.patch.yml` that inserts it under the id
`notebook-tools`. DSH composes that row at boot, so **restart the DSH app** for
the tools to appear in an already-running session.

No dependencies are installed: `pnpm install` is unnecessary, and the package
imports only `node:` builtins.

## Companion skill

`skill/notebook-tools/SKILL.md` is the matching DSH skill: it tells the agent
when to reach for these tools, which of them can mutate a notebook, and how
stable a cell id really is. Copy it into the skills directory:

```powershell
Copy-Item -Recurse skill\notebook-tools "$env:USERPROFILE\.dsh\skills\notebook-tools" -Force
```

DSH hot-reloads the skills directory, so the skill shows up without a restart —
unlike the plugin itself, which is composed at boot.

## Tools

| Tool | Writes | Purpose |
| --- | --- | --- |
| `notebook_create` | yes | Create a notebook from structured cells |
| `notebook_read` | no | Structured read, optionally with outputs |
| `notebook_list_cells` | no | Cheap index: id, type, preview, counts |
| `notebook_search` | no | Find cells by text or regex |
| `notebook_validate` | no | Validate structure and report facts |
| `notebook_edit_cell` | yes | Replace a cell's source / type |
| `notebook_insert_cell` | yes | Insert a new cell at a position |
| `notebook_delete_cell` | yes | Delete a cell by id or index |
| `notebook_clear_outputs` | yes | Clear outputs (all or one cell) |

## Guarantees

- **Atomic saves.** Mutations serialize with a 1-space JSON indent and write to
  a sibling temp file (`.‹basename›.tmp-‹pid›-‹counter›-‹random›`) in the same
  directory, `fsync` it, then `rename` over the target. A killed process can
  never leave a half-written notebook, and no temp file ever lands in the system
  temp directory.
- **Cell ids over indexes.** `notebook_read`, `notebook_list_cells`, and
  `notebook_search` always return an `id`; missing ids are backfilled in memory
  and persisted on the next save (bumping `nbformat_minor` to 5). Indexes shift
  after every insert/delete — prefer ids.
- **Editing a code cell clears `outputs` and `execution_count`,** and the
  response text says so.
- **Stale-edit guards.** `expected_source_sha256` and `expected_file_mtime_ms`
  fail the operation *before* any write when the notebook changed underneath
  you. mtime comparison tolerates sub-millisecond jitter.
- **Source on disk is a string array** (one line per element, trailing `\n`);
  tools return the joined string.
- **nbformat 4 only.** v3 and earlier are rejected.
- **No kernel execution, ever.**
- **Failures throw** a `NotebookError` subclass carrying a stable `code`
  (`NOTEBOOK_NOT_FOUND`, `STALE_NOTEBOOK`, `CELL_NOT_FOUND`, …). There is no
  `isError` field on the DSH tool result contract.

## Usage

```
notebook_list_cells  { path: "~/analysis.ipynb" }
notebook_read        { path: "~/analysis.ipynb", cell_ids: ["a1b2c3d4"] }
notebook_search      { path: "~/analysis.ipynb", query: "train_test_split" }
notebook_edit_cell   { path: "~/analysis.ipynb", cell_id: "a1b2c3d4",
                       new_source: "model.fit(X, y)\n",
                       expected_source_sha256: "…" }
notebook_validate    { path: "~/analysis.ipynb" }
```

## Development

```powershell
node --test          # from this directory
```

Tests use `node:test` + `node:assert/strict` and require Node >= 22 (verified
on Node 24).

## Layout

```
lib/index.js              composition only — registers the 9 tools on ctx.tools
lib/nb/*.js               pure domain; node: builtins only, no host SDK imports
lib/tools/*.js            adapters: JSON Schema params, error mapping, response text
test/*.test.js            node:test suites
cordis.patch.yml          the composition row DSH merges at boot
skill/notebook-tools/     the companion skill (SKILL.md)
```

The domain layer (`lib/nb/`) knows nothing about DSH — it only knows about
notebooks, so it stays unit-testable in isolation.

## Credits and license

MIT. This is a **port**, not a fork: the domain layer and all nine tool
adapters were re-implemented for the DSH plugin host from the original plugin's
documented behavior.

- Upstream: [`Lightbridge-KS/openclaw-notebook-tools`](https://github.com/Lightbridge-KS/openclaw-notebook-tools)
  by Kittipos Sirivongrungson (MIT). The tool surface, the behavioral spec in
  its `docs/Notebook-Tools-Spec.md`, and the companion skill all originate
  there.
- This port: the DSH packaging (`cordis.patch.yml`, the `dsh.bundle.patch`
  hook), the zero-dependency plain-object tool descriptors, and the test
  suites.

`LICENSE` carries both copyright notices.
