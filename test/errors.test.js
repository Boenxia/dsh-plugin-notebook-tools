import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { call, callJson, caught, cleanupAll, tmpDir } from './_helpers.mjs';

after(cleanupAll);

const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

/** Assert an error's name / code / exact message. */
function assertError(err, name, code, message) {
  assert.ok(err, 'expected an error to be thrown');
  assert.equal(err.name, name);
  assert.equal(err.code, code);
  if (message !== undefined) assert.equal(err.message, message);
}

async function seededNotebook(dir, name = 'nb.ipynb') {
  const path = join(dir, name);
  await call('notebook_create', {
    path,
    cells: [
      { cell_type: 'markdown', source: '# t\n' },
      { cell_type: 'code', source: 'a\n' },
      { cell_type: 'code', source: 'b\n' },
    ],
  });
  return path;
}

test('missing file → NotebookNotFoundError on every reading tool', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'nope.ipynb');
  const expected = `Notebook not found: ${path}`;

  for (const [tool, args] of [
    ['notebook_read', { path }],
    ['notebook_list_cells', { path }],
    ['notebook_search', { path, query: 'x' }],
    ['notebook_edit_cell', { path, cell_id: 'a', new_source: 'x' }],
    ['notebook_delete_cell', { path, cell_id: 'a' }],
    ['notebook_clear_outputs', { path }],
  ]) {
    const err = await caught(() => call(tool, args));
    assertError(err, 'NotebookNotFoundError', 'NOTEBOOK_NOT_FOUND', expected);
  }
});

test('malformed JSON → InvalidNotebookError', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'broken.ipynb');
  await writeFile(path, '{ "nbformat": 4, ', 'utf-8');

  const err = await caught(() => call('notebook_read', { path }));
  assertError(
    err,
    'InvalidNotebookError',
    'INVALID_NOTEBOOK',
    'Invalid notebook: not parseable as JSON',
  );
});

test('an nbformat v3 fixture is rejected', async () => {
  const err = await caught(() =>
    call('notebook_read', { path: fixture('nbformat_v3.ipynb') }),
  );
  assertError(
    err,
    'UnsupportedNbformatError',
    'UNSUPPORTED_NBFORMAT',
    'Unsupported nbformat: v3. Only v4 supported.',
  );
});

test('the extension is validated before touching the filesystem', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'not-a-notebook.json');
  const err = await caught(() => call('notebook_read', { path }));
  assertError(
    err,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    `Notebook path must end in .ipynb (got: ${path})`,
  );

  const err2 = await caught(() => call('notebook_read', { path: '' }));
  assertError(err2, 'InvalidParametersError', 'INVALID_PARAMETERS', 'path must be a non-empty string');
});

test('out-of-range and unknown cell references', async () => {
  const dir = await tmpDir();
  const path = await seededNotebook(dir);

  const byIndex = await caught(() =>
    call('notebook_edit_cell', { path, index: 99, new_source: 'x\n' }),
  );
  assertError(byIndex, 'CellNotFoundError', 'CELL_NOT_FOUND', 'Cell not found: index=99');

  const byId = await caught(() =>
    call('notebook_delete_cell', { path, cell_id: 'zzzzzzzz' }),
  );
  assertError(
    byId,
    'CellNotFoundError',
    'CELL_NOT_FOUND',
    'Cell not found: cell_id=zzzzzzzz',
  );

  const readId = await caught(() => call('notebook_read', { path, cell_ids: ['nope'] }));
  assertError(readId, 'CellNotFoundError', 'CELL_NOT_FOUND', 'Cell not found: cell_id=nope');
});

test('cell_range bounds and mutual exclusion', async () => {
  const dir = await tmpDir();
  const path = await seededNotebook(dir);

  const oob = await caught(() =>
    call('notebook_read', { path, cell_range: { start: 0, end: 4 } }),
  );
  assertError(
    oob,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    'cell_range out of bounds (notebook has 3 cells)',
  );

  const inverted = await caught(() =>
    call('notebook_read', { path, cell_range: { start: 2, end: 1 } }),
  );
  assert.equal(inverted.code, 'INVALID_PARAMETERS');
  assert.equal(inverted.message, 'cell_range out of bounds (notebook has 3 cells)');

  const both = await caught(() =>
    call('notebook_read', { path, cell_range: { start: 0, end: 1 }, cell_ids: ['x'] }),
  );
  assertError(
    both,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    'Provide either cell_range or cell_ids, not both.',
  );
});

test('cell_id / index addressing rules', async () => {
  const dir = await tmpDir();
  const path = await seededNotebook(dir);
  const listed = await callJson('notebook_list_cells', { path });
  const id = listed.cells[1].id;

  const both = await caught(() =>
    call('notebook_edit_cell', { path, cell_id: id, index: 1, new_source: 'x\n' }),
  );
  assertError(
    both,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    'Provide either cell_id or index, not both.',
  );

  const neither = await caught(() =>
    call('notebook_edit_cell', { path, new_source: 'x\n' }),
  );
  assertError(
    neither,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    'Provide one of cell_id or index.',
  );

  const clearBoth = await caught(() =>
    call('notebook_clear_outputs', { path, cell_id: id, index: 1 }),
  );
  assertError(
    clearBoth,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    'Provide either cell_id or index, not both.',
  );
});

test('insert_cell position rules and bounds', async () => {
  const dir = await tmpDir();
  const path = await seededNotebook(dir);

  const none = await caught(() =>
    call('notebook_insert_cell', { path, cell_type: 'code', source: 'x\n' }),
  );
  assertError(
    none,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    'Provide exactly one of: position, anchor_id, or anchor_index.',
  );

  const two = await caught(() =>
    call('notebook_insert_cell', {
      path,
      cell_type: 'code',
      source: 'x\n',
      position: 0,
      anchor_index: 0,
    }),
  );
  assert.equal(two.code, 'INVALID_PARAMETERS');

  const oob = await caught(() =>
    call('notebook_insert_cell', { path, cell_type: 'code', source: 'x\n', position: 9 }),
  );
  assertError(
    oob,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    'position 9 out of bounds (notebook has 3 cells)',
  );

  const anchorOob = await caught(() =>
    call('notebook_insert_cell', {
      path,
      cell_type: 'code',
      source: 'x\n',
      anchor_index: 9,
    }),
  );
  assertError(
    anchorOob,
    'InvalidParametersError',
    'INVALID_PARAMETERS',
    'anchor_index 9 out of bounds (notebook has 3 cells)',
  );

  const anchorId = await caught(() =>
    call('notebook_insert_cell', {
      path,
      cell_type: 'code',
      source: 'x\n',
      anchor_id: 'missing0',
    }),
  );
  assertError(
    anchorId,
    'CellNotFoundError',
    'CELL_NOT_FOUND',
    'Cell not found: cell_id=missing0',
  );

  // position == cells.length is a valid append
  const appended = await call('notebook_insert_cell', {
    path,
    cell_type: 'code',
    source: 'x\n',
    position: 3,
  });
  assert.match(appended, /at index 3\. Notebook now has 4 cells\./);
});

test('invalid cell_type on create is rejected', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'bad.ipynb');
  const err = await caught(() =>
    call('notebook_create', { path, cells: [{ cell_type: 'banana', source: 'x' }] }),
  );
  assertError(err, 'InvalidParametersError', 'INVALID_PARAMETERS', 'Invalid cell_type: banana');
});

test('invalid regex is reported as INVALID_PARAMETERS', async () => {
  const dir = await tmpDir();
  const path = await seededNotebook(dir);
  const err = await caught(() =>
    call('notebook_search', { path, query: '[unclosed', regex: true }),
  );
  assert.equal(err.name, 'InvalidParametersError');
  assert.equal(err.code, 'INVALID_PARAMETERS');
  assert.match(err.message, /^Invalid regex: /);
});

test('stale expected_source_sha256 rejects the edit and does not write', async () => {
  const dir = await tmpDir();
  const path = await seededNotebook(dir);
  const before = await callJson('notebook_read', { path });
  const { snapshot } = await import('./_helpers.mjs');
  const pre = await snapshot(path);

  const err = await caught(() =>
    call('notebook_edit_cell', {
      path,
      cell_id: before.cells[1].id,
      new_source: 'clobbered\n',
      expected_source_sha256: 'deadbeef'.repeat(8),
    }),
  );
  assert.equal(err.name, 'StaleNotebookError');
  assert.equal(err.code, 'STALE_NOTEBOOK');
  assert.equal(
    err.message,
    `Cell source has changed since the last read (expected sha256=${'deadbeef'.repeat(8)}, got ${before.cells[1].source_sha256}).`,
  );

  const post = await snapshot(path);
  assert.equal(post.bytes, pre.bytes, 'file bytes unchanged');
  assert.equal(post.mtimeMs, pre.mtimeMs, 'file not rewritten');

  const del = await caught(() =>
    call('notebook_delete_cell', {
      path,
      cell_id: before.cells[1].id,
      expected_source_sha256: 'deadbeef'.repeat(8),
    }),
  );
  assert.equal(del.code, 'STALE_NOTEBOOK');
});

test('stale expected_file_mtime_ms rejects the write, with sub-ms tolerance', async () => {
  const dir = await tmpDir();
  const path = await seededNotebook(dir);
  const { snapshot } = await import('./_helpers.mjs');
  const { stat } = await import('node:fs/promises');
  const before = await callJson('notebook_read', { path });
  const pre = await snapshot(path);
  const { mtimeMs } = await stat(path);

  const err = await caught(() =>
    call('notebook_edit_cell', {
      path,
      cell_id: before.cells[1].id,
      new_source: 'clobbered\n',
      expected_file_mtime_ms: 1,
    }),
  );
  assert.equal(err.name, 'StaleNotebookError');
  assert.equal(err.code, 'STALE_NOTEBOOK');
  assert.equal(
    err.message,
    `Notebook file changed on disk since the last read (expected mtime_ms=1, got ${mtimeMs}).`,
  );

  const post = await snapshot(path);
  assert.equal(post.bytes, pre.bytes);
  assert.equal(post.mtimeMs, pre.mtimeMs);

  // an exact mtime passes
  const okExact = await call('notebook_edit_cell', {
    path,
    cell_id: before.cells[1].id,
    new_source: 'a2\n',
    expected_file_mtime_ms: mtimeMs,
  });
  assert.match(okExact, /^Edited cell /);

  // sub-millisecond jitter is tolerated
  const jittered = await callJson('notebook_read', { path });
  const { mtimeMs: m2 } = await stat(path);
  const okJitter = await call('notebook_edit_cell', {
    path,
    cell_id: jittered.cells[1].id,
    new_source: 'a3\n',
    expected_file_mtime_ms: m2 + 0.4,
  });
  assert.match(okJitter, /^Edited cell /);
});

test('notebook_validate reports expected failures as data instead of throwing', async () => {
  const dir = await tmpDir();

  const missing = join(dir, 'missing.ipynb');
  const v1 = await callJson('notebook_validate', { path: missing });
  assert.equal(v1.valid, false);
  assert.deepEqual(v1.errors, [`Notebook not found: ${missing}`]);
  assert.equal(v1.cell_count, 0);

  const broken = join(dir, 'broken.ipynb');
  await writeFile(broken, 'not json at all', 'utf-8');
  const v2 = await callJson('notebook_validate', { path: broken });
  assert.equal(v2.valid, false);
  assert.deepEqual(v2.errors, ['Invalid notebook: not parseable as JSON']);
  assert.deepEqual(v2.warnings, []);
  assert.equal(v2.nbformat, null);

  const v3 = await callJson('notebook_validate', { path: fixture('nbformat_v3.ipynb') });
  assert.equal(v3.valid, false);
  assert.equal(v3.nbformat, 3);
  assert.deepEqual(v3.errors, ['Unsupported nbformat: v3. Only v4 supported.']);

  const noCells = join(dir, 'nocells.ipynb');
  await writeFile(noCells, JSON.stringify({ nbformat: 4, nbformat_minor: 5 }), 'utf-8');
  const v4 = await callJson('notebook_validate', { path: noCells });
  assert.equal(v4.valid, false);
  assert.deepEqual(v4.errors, ['`cells` must be an array']);

  const badCell = join(dir, 'badcell.ipynb');
  await writeFile(
    badCell,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ cell_type: 'nope', source: 'x' }],
    }),
    'utf-8',
  );
  const v5 = await callJson('notebook_validate', { path: badCell });
  assert.equal(v5.valid, false);
  assert.deepEqual(v5.errors, ['Cell at index 0 has unsupported cell_type: nope']);

  // still throws for a genuinely invalid path, just like every other tool
  const v6 = await caught(() => call('notebook_validate', { path: join(dir, 'x.txt') }));
  assert.equal(v6.code, 'INVALID_PARAMETERS');
});

test('validate backfills missing ids and warns about nbformat_minor < 5', async () => {
  const v = await callJson('notebook_validate', { path: fixture('with_outputs.ipynb') });
  assert.equal(v.valid, true);
  assert.equal(v.nbformat_minor, 4);
  assert.equal(v.cell_count, 2);
  assert.equal(v.missing_cell_ids_backfillable, 2);
  assert.equal(v.warnings.length, 1);
  assert.equal(v.warnings[0].code, 'OLD_NBFORMAT_MINOR');
});

test('errors are never swallowed as a return value', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'dir-target.ipynb');
  await mkdir(path); // a directory where a notebook should be
  const err = await caught(() => call('notebook_read', { path }));
  // EISDIR surfaces as an unexpected error, wrapped — but still thrown.
  assert.ok(err instanceof Error, 'must throw, not return');
  assert.ok(err.code, 'carries a stable code');
});
