import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  newCellId,
  normalizeSourceIn,
  normalizeSourceOut,
  resolveCellRef,
} from '../lib/nb/cell.js';
import { assertFreshFile, assertFreshSource, sourceSha256 } from '../lib/nb/hash.js';
import { createNotebook, loadNotebook, validateNotebookShape } from '../lib/nb/load.js';
import { truncateOutputs } from '../lib/nb/outputs.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../lib/nb/path.js';
import { saveNotebook, serializeNotebook } from '../lib/nb/save.js';
import { searchCells } from '../lib/nb/search.js';
import { cleanupAll, tmpDir } from './_helpers.mjs';

after(cleanupAll);

const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

// ---------------------------------------------------------------- cell.ts

test('normalizeSourceIn splits into Jupyter line arrays, keeping newlines', () => {
  assert.deepEqual(normalizeSourceIn(''), []);
  assert.deepEqual(normalizeSourceIn('a'), ['a']);
  assert.deepEqual(normalizeSourceIn('a\n'), ['a\n']);
  assert.deepEqual(normalizeSourceIn('a\nb'), ['a\n', 'b']);
  assert.deepEqual(normalizeSourceIn('a\nb\n'), ['a\n', 'b\n']);
  assert.deepEqual(normalizeSourceIn('a\n\nb\n'), ['a\n', '\n', 'b\n']);
  assert.deepEqual(normalizeSourceIn('\n'), ['\n']);
});

test('normalizeSourceOut joins back, and round-trips losslessly', () => {
  assert.equal(normalizeSourceOut(['a\n', 'b']), 'a\nb');
  assert.equal(normalizeSourceOut('raw'), 'raw');
  assert.equal(normalizeSourceOut(undefined), '');
  for (const s of ['', 'a', 'a\n', 'a\nb\n\nc', '\n\n']) {
    assert.equal(normalizeSourceOut(normalizeSourceIn(s)), s, JSON.stringify(s));
  }
});

test('newCellId produces 8 alphanumeric chars, uniquely', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = newCellId();
    assert.match(id, /^[A-Za-z0-9]{8}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 2000, 'no collisions in 2000 draws');
});

test('resolveCellRef resolves by id and by index, and rejects bad combinations', () => {
  const nb = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: 'markdown', id: 'm1', source: 'a\n', metadata: {} },
    { cell_type: 'code', id: 'c1', source: 'b\n', metadata: {}, execution_count: null, outputs: [] },
  ] };

  const byId = resolveCellRef(nb, { cell_id: 'c1' });
  assert.equal(byId.index, 1);
  assert.equal(byId.cell.id, 'c1');

  const byIndex = resolveCellRef(nb, { index: 0 });
  assert.equal(byIndex.cell.id, 'm1');
  assert.equal(byIndex.index, 0);

  assert.throws(() => resolveCellRef(nb, { cell_id: 'c1', index: 1 }), {
    name: 'InvalidParametersError',
    message: 'Provide either cell_id or index, not both.',
  });
  assert.throws(() => resolveCellRef(nb, {}), {
    name: 'InvalidParametersError',
    message: 'Provide one of cell_id or index.',
  });
  assert.throws(() => resolveCellRef(nb, { cell_id: 'nope' }), {
    name: 'CellNotFoundError',
    message: 'Cell not found: cell_id=nope',
  });
  assert.throws(() => resolveCellRef(nb, { index: 9 }), {
    name: 'CellNotFoundError',
    message: 'Cell not found: index=9',
  });
});

// ---------------------------------------------------------------- hash.ts

test('sourceSha256 is stable, matches node:crypto, and ignores array/string form', () => {
  const asString = { source: 'a\nb\n' };
  const asArray = { source: ['a\n', 'b\n'] };
  const expected = createHash('sha256').update('a\nb\n', 'utf-8').digest('hex');

  assert.equal(sourceSha256(asString), expected);
  assert.equal(sourceSha256(asArray), expected, 'both disk forms hash identically');
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.notEqual(sourceSha256({ source: 'a\nb' }), expected);
});

test('assertFreshFile tolerates sub-millisecond jitter but rejects real changes', () => {
  assert.doesNotThrow(() => assertFreshFile(1000, undefined));
  assert.doesNotThrow(() => assertFreshFile(1000.0, 1000));
  assert.doesNotThrow(() => assertFreshFile(1000.4, 1000));
  assert.doesNotThrow(() => assertFreshFile(1000, 1000.9));
  assert.throws(() => assertFreshFile(1001, 1000), {
    name: 'StaleNotebookError',
    code: 'STALE_NOTEBOOK',
    message: 'Notebook file changed on disk since the last read (expected mtime_ms=1000, got 1001).',
  });
});

test('assertFreshSource rejects a changed cell and passes an unchanged one', () => {
  const cell = { source: 'a\n' };
  const sha = sourceSha256(cell);
  assert.doesNotThrow(() => assertFreshSource(cell, undefined));
  assert.doesNotThrow(() => assertFreshSource(cell, sha));
  assert.throws(() => assertFreshSource(cell, 'deadbeef'), {
    name: 'StaleNotebookError',
    code: 'STALE_NOTEBOOK',
    message: `Cell source has changed since the last read (expected sha256=deadbeef, got ${sha}).`,
  });
});

// ---------------------------------------------------------------- path.ts

test('normalizeNotebookPath expands ~ and resolves to an absolute path', () => {
  const abs = normalizeNotebookPath('/tmp/x.ipynb');
  assert.equal(abs, resolve('/tmp/x.ipynb'));
  assert.equal(normalizeNotebookPath('~/nb.ipynb'), resolve(homedir(), 'nb.ipynb'));
  assert.equal(normalizeNotebookPath('rel/nb.ipynb'), resolve(process.cwd(), 'rel/nb.ipynb'));
  assert.equal(normalizeNotebookPath('~'), resolve(homedir()));
  assert.throws(() => normalizeNotebookPath(''), {
    name: 'InvalidParametersError',
    message: 'path must be a non-empty string',
  });
  assert.throws(() => normalizeNotebookPath(undefined), {
    name: 'InvalidParametersError',
  });
});

test('assertIpynbExtension accepts .ipynb in any case and rejects others', () => {
  assert.doesNotThrow(() => assertIpynbExtension('/x/a.ipynb'));
  assert.doesNotThrow(() => assertIpynbExtension('/x/A.IPYNB'));
  assert.throws(() => assertIpynbExtension('/x/a.json'), {
    name: 'InvalidParametersError',
    message: 'Notebook path must end in .ipynb (got: /x/a.json)',
  });
});

// ---------------------------------------------------------------- search.ts

test('searchCells: literal, case-insensitive by default, context lines', () => {
  const nb = { cells: [
    { cell_type: 'markdown', id: 'm1', source: '# Title\nsome text\n', metadata: {} },
    { cell_type: 'code', id: 'c1', source: 'a\nNEEDLE\nb\nc\n', metadata: {}, execution_count: null, outputs: [] },
  ] };

  const hits = searchCells(nb, { query: 'needle' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'c1');
  assert.equal(hits[0].index, 1);
  assert.equal(hits[0].line, 2, '1-based line number');
  assert.deepEqual(hits[0].context, ['a', 'NEEDLE', 'b']);

  const sensitive = searchCells(nb, { query: 'needle', case_sensitive: true });
  assert.equal(sensitive.length, 0);

  const wide = searchCells(nb, { query: 'NEEDLE', context_lines: 2 });
  assert.deepEqual(wide[0].context, ['a', 'NEEDLE', 'b', 'c']);

  const none = searchCells(nb, { query: 'NEEDLE', context_lines: 0 });
  assert.deepEqual(none[0].context, ['NEEDLE']);

  const typed = searchCells(nb, { query: 'Title', cell_type: 'code' });
  assert.equal(typed.length, 0);
});

test('searchCells: regex and max_matches', () => {
  const nb = { cells: [
    { cell_type: 'code', id: 'c1', source: 'foo1\nfoo2\nbar\n', metadata: {}, execution_count: null, outputs: [] },
  ] };
  const re = searchCells(nb, { query: '^foo\\d$', regex: true });
  assert.equal(re.length, 2);
  assert.equal(
    searchCells(nb, { query: '^FOO\\d$', regex: true }).length,
    2,
    'regex inherits the case-insensitive default',
  );
  assert.equal(searchCells(nb, { query: '^FOO\\d$', regex: true, case_sensitive: true }).length, 0);

  const capped = searchCells(nb, { query: 'foo', max_matches: 1 });
  assert.equal(capped.length, 1);

  assert.throws(() => searchCells(nb, { query: '[', regex: true }), {
    name: 'InvalidParametersError',
  });
  assert.throws(() => searchCells(nb, { query: '' }), {
    name: 'InvalidParametersError',
    message: 'query must be a non-empty string',
  });
});

test('searchCells truncates very long match lines', () => {
  const long = 'x'.repeat(400);
  const nb = { cells: [
    { cell_type: 'code', id: 'c1', source: `${long}\n`, metadata: {}, execution_count: null, outputs: [] },
  ] };
  const hits = searchCells(nb, { query: 'x' });
  assert.equal(hits[0].preview.length, 200 + '…[truncated]'.length);
  assert.ok(hits[0].preview.endsWith('…[truncated]'));
});

// ---------------------------------------------------------------- outputs.ts

test('truncateOutputs elides images, vendor MIME blobs, and overflow items', () => {
  const outputs = [
    { output_type: 'stream', name: 'stdout', text: ['hello world\n'] },
    { output_type: 'stream', name: 'stderr', text: 'e\n' },
    { output_type: 'display_data', data: { 'image/png': 'AAAA', 'text/plain': '<Figure>' }, metadata: {} },
    { output_type: 'display_data', data: { 'application/vnd.plotly.v1+json': { x: 1 } }, metadata: {} },
    { output_type: 'execute_result', data: { 'application/json': { a: 1 }, 'text/plain': 'x' }, metadata: {}, execution_count: 2 },
    { output_type: 'error', ename: 'E', evalue: 'v', traceback: ['l1', 'l2'] },
    { output_type: 'stream', name: 'stdout', text: ['7th\n'] },
  ];

  const kept = truncateOutputs(outputs, { maxChars: 1000, maxItems: 5 });
  assert.equal(kept.length, 6, '5 kept + overflow placeholder');
  assert.equal(kept[0].text, 'hello world\n');
  assert.equal(kept[1].text, 'e\n', 'string form preserved');
  assert.equal(kept[2].data['image/png'], '<image: 4 bytes elided>');
  assert.equal(kept[2].data['text/plain'], '<Figure>');
  assert.equal(kept[3].data['application/vnd.plotly.v1+json'], '<application/vnd.plotly.v1+json: elided>');
  assert.equal(kept[4].data['application/json'], '{"a":1}');
  assert.equal(kept[4].execution_count, 2);
  assert.deepEqual(kept[5], {
    output_type: 'stream',
    name: 'stdout',
    text: '[+2 more outputs elided]',
  });

  const all = truncateOutputs(outputs, { maxChars: 1000, maxItems: 7 });
  assert.equal(all.length, 7);
  assert.deepEqual(all[5], outputs[5], 'error outputs pass through when under the cap');
  assert.deepEqual(all[5].traceback, ['l1', 'l2']);
  assert.deepEqual(all[6], { output_type: 'stream', name: 'stdout', text: '7th\n' });
});

test('truncateOutputs appends the truncation marker and handles maxItems 0', () => {
  const outputs = [{ output_type: 'stream', name: 'stdout', text: ['abcdefghij\n'] }];
  const cut = truncateOutputs(outputs, { maxChars: 3, maxItems: 5 });
  assert.equal(cut[0].text, 'abc…[truncated]');
  assert.deepEqual(truncateOutputs(outputs, { maxChars: 3, maxItems: 0 }), []);
  assert.equal(truncateOutputs(outputs, { maxChars: 0, maxItems: 1 })[0].text, '…[truncated]');
});

test('truncateOutputs reports the overflow count and pluralises it', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    output_type: 'stream', name: 'stdout', text: [`${i}\n`],
  }));
  assert.equal(truncateOutputs(mk(2), { maxChars: 9, maxItems: 1 })[1].text, '[+1 more output elided]');
  assert.equal(truncateOutputs(mk(4), { maxChars: 9, maxItems: 1 })[1].text, '[+3 more outputs elided]');
  assert.equal(truncateOutputs(mk(1), { maxChars: 9, maxItems: 1 }).length, 1);
});

test('truncateOutputs truncates error tracebacks per line', () => {
  const kept = truncateOutputs(
    [{ output_type: 'error', ename: 'E', evalue: 'v', traceback: ['abcdefghij'] }],
    { maxChars: 3, maxItems: 1 },
  );
  assert.deepEqual(kept[0].traceback, ['abc…[truncated]']);
});

// ---------------------------------------------------------------- load.ts

test('loadNotebook reads the minimal fixture and round-trips it', async () => {
  const nb = await loadNotebook(fixture('minimal.ipynb'));
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.nbformat_minor, 5);
  assert.equal(nb.cells.length, 2);
  assert.equal(nb.cells[0].id, 'md000001');
  assert.equal(nb.metadata.kernelspec.name, 'python3');
});

test('loadNotebook backfills missing ids in memory (fixture has nbformat_minor 4)', async () => {
  const nb = await loadNotebook(fixture('with_outputs.ipynb'));
  assert.equal(nb.nbformat_minor, 4);
  for (const cell of nb.cells) {
    assert.match(cell.id, /^[A-Za-z0-9]{8}$/, 'generated, not persisted');
  }
  const onDisk = JSON.parse(await readFile(fixture('with_outputs.ipynb'), 'utf-8'));
  assert.equal('id' in onDisk.cells[0], false, 'fixture on disk is untouched');
});

test('loadNotebook maps filesystem and parse failures to typed errors', async () => {
  await assert.rejects(() => loadNotebook(fixture('does-not-exist.ipynb')), {
    name: 'NotebookNotFoundError',
    code: 'NOTEBOOK_NOT_FOUND',
  });
  await assert.rejects(() => loadNotebook(fixture('nbformat_v3.ipynb')), {
    name: 'UnsupportedNbformatError',
    code: 'UNSUPPORTED_NBFORMAT',
    message: 'Unsupported nbformat: v3. Only v4 supported.',
  });
});

test('createNotebook applies the reference defaults', () => {
  const nb = createNotebook();
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.nbformat_minor, 5);
  assert.deepEqual(nb.metadata.kernelspec, {
    name: 'python3',
    display_name: 'Python 3',
    language: 'python',
  });
  assert.equal(nb.metadata.language_info.name, 'python');
  assert.deepEqual(nb.cells, []);

  const withCells = createNotebook({
    cells: [
      { cell_type: 'code', source: 'x\n' },
      { cell_type: 'markdown', source: '# h\n' },
      { cell_type: 'raw', source: 'r\n' },
    ],
    kernel: { name: 'ir', display_name: 'R', language: 'r' },
    metadata: { custom: true },
  });
  assert.equal(withCells.metadata.kernelspec.name, 'ir');
  assert.equal(withCells.metadata.custom, true);
  assert.equal(withCells.cells[0].cell_type, 'code');
  assert.equal(withCells.cells[0].execution_count, null);
  assert.deepEqual(withCells.cells[0].outputs, []);
  assert.equal(withCells.cells[1].cell_type, 'markdown');
  assert.equal('outputs' in withCells.cells[1], false);
  assert.equal(withCells.cells[2].cell_type, 'raw');
  const ids = withCells.cells.map((c) => c.id);
  assert.equal(new Set(ids).size, 3, 'fresh unique ids');
});

test('validateNotebookShape reports the reference messages', () => {
  assert.deepEqual(pick(validateNotebookShape(null)), {
    valid: false, errors: ['Notebook root must be a JSON object'], backfill: 0,
  });
  assert.deepEqual(pick(validateNotebookShape({ nbformat: 4 })), {
    valid: false, errors: ['Missing or non-numeric `nbformat_minor` field', '`cells` must be an array'], backfill: 0,
  });
  assert.deepEqual(pick(validateNotebookShape({ nbformat: '4' })), {
    valid: false, errors: ['Missing or non-numeric `nbformat` field', 'Missing or non-numeric `nbformat_minor` field', '`cells` must be an array'], backfill: 0,
  });
  assert.deepEqual(pick(validateNotebookShape({ nbformat: 3, cells: [] })), {
    valid: false, errors: ['Unsupported nbformat: v3. Only v4 supported.'], backfill: 0,
  });
  assert.deepEqual(
    pick(validateNotebookShape({ nbformat: 4, nbformat_minor: 5, cells: [1, 2] })),
    {
      valid: false,
      errors: ['Cell at index 0 is not an object', 'Cell at index 1 is not an object'],
      backfill: 0,
    },
  );
  assert.deepEqual(
    pick(validateNotebookShape({ nbformat: 4, nbformat_minor: 5, cells: [{ cell_type: 'x' }] })),
    { valid: false, errors: ['Cell at index 0 has unsupported cell_type: x'], backfill: 0 },
  );
  assert.deepEqual(
    pick(validateNotebookShape({ nbformat: 4, nbformat_minor: 5, cells: [{ cell_type: 'code', source: 5 }] })),
    { valid: false, errors: ['Cell at index 0 has invalid source (must be string or string[])'], backfill: 0 },
  );

  const ok = validateNotebookShape({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ cell_type: 'code', id: 'abc', source: [], metadata: {}, execution_count: null, outputs: [] }],
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.missing_cell_ids_backfillable, 0);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.notebook.cells[0].id, 'abc');

  const oldMinor = validateNotebookShape({ nbformat: 4, nbformat_minor: 2, cells: [] });
  assert.equal(oldMinor.valid, true);
  assert.equal(oldMinor.warnings[0].code, 'OLD_NBFORMAT_MINOR');
});

function pick(r) {
  return { valid: r.valid, errors: r.errors, backfill: r.missing_cell_ids_backfillable };
}

// ---------------------------------------------------------------- save.ts

test('save → load round-trips a notebook losslessly modulo formatting', async () => {
  const dir = await tmpDir();
  const path = `${dir}/roundtrip.ipynb`;
  const original = createNotebook({
    cells: [
      { cell_type: 'code', source: 'import os\nprint("hi")\n' },
      { cell_type: 'markdown', source: '# heading\n\nbody\n' },
      { cell_type: 'raw', source: 'raw\ntext' },
    ],
  });
  await saveNotebook(path, original);
  const reloaded = await loadNotebook(path);

  assert.equal(reloaded.nbformat, 4);
  assert.equal(reloaded.nbformat_minor, 5);
  assert.deepEqual(
    reloaded.cells.map((c) => [c.cell_type, c.id, normalizeSourceOut(c.source)]),
    original.cells.map((c) => [c.cell_type, c.id, normalizeSourceOut(c.source)]),
  );
  assert.deepEqual(reloaded.cells[0].outputs, []);
  assert.equal(reloaded.cells[0].execution_count, null);
  assert.equal(reloaded.metadata.kernelspec.name, 'python3');

  // second write is byte-stable
  await saveNotebook(path, reloaded);
  const a = await readFile(path, 'utf-8');
  await saveNotebook(path, await loadNotebook(path));
  assert.equal(await readFile(path, 'utf-8'), a, 'idempotent serialization');
});

test('serializeNotebook preserves an explicit nbformat_minor and 4 literal', () => {
  const text = serializeNotebook({
    nbformat: 4,
    nbformat_minor: 4,
    metadata: {},
    cells: [{ cell_type: 'markdown', id: 'x', source: 'a\n', metadata: {} }],
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.nbformat, 4);
  assert.equal(parsed.nbformat_minor, 4);
});

// ---------------------------------------------------------------- errors.ts

test('NotebookError subclasses carry stable codes and names', async () => {
  const { NotebookError, NotebookNotFoundError, NotebookAlreadyExistsError, InvalidNotebookError, UnsupportedNbformatError, CellNotFoundError, InvalidParametersError, StaleNotebookError } = await import('../lib/nb/errors.js');

  const cases = [
    [new NotebookError('m'), 'NotebookError', 'NOTEBOOK_ERROR', 'm'],
    [new NotebookError('m', 'CUSTOM'), 'NotebookError', 'CUSTOM', 'm'],
    [new NotebookNotFoundError('/p'), 'NotebookNotFoundError', 'NOTEBOOK_NOT_FOUND', 'Notebook not found: /p'],
    [new NotebookAlreadyExistsError('/p'), 'NotebookAlreadyExistsError', 'NOTEBOOK_ALREADY_EXISTS', 'Notebook already exists: /p. Pass overwrite=true to replace.'],
    [new InvalidNotebookError('bad'), 'InvalidNotebookError', 'INVALID_NOTEBOOK', 'bad'],
    [new UnsupportedNbformatError(3), 'UnsupportedNbformatError', 'UNSUPPORTED_NBFORMAT', 'Unsupported nbformat: v3. Only v4 supported.'],
    [new CellNotFoundError({ cell_id: 'a' }), 'CellNotFoundError', 'CELL_NOT_FOUND', 'Cell not found: cell_id=a'],
    [new CellNotFoundError({ index: 2 }), 'CellNotFoundError', 'CELL_NOT_FOUND', 'Cell not found: index=2'],
    [new InvalidParametersError('p'), 'InvalidParametersError', 'INVALID_PARAMETERS', 'p'],
    [new StaleNotebookError('s'), 'StaleNotebookError', 'STALE_NOTEBOOK', 's'],
  ];
  for (const [err, name, code, message] of cases) {
    assert.ok(err instanceof NotebookError, `${name} extends NotebookError`);
    assert.ok(err instanceof Error);
    assert.equal(err.name, name);
    assert.equal(err.code, code);
    assert.equal(err.message, message);
  }
});
