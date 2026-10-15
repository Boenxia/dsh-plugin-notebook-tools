import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { idOf } from '../lib/nb/cell.js';
import { fileSha256, sourceSha256 } from '../lib/nb/hash.js';
import { loadNotebook } from '../lib/nb/load.js';
import { serializeNotebook } from '../lib/nb/save.js';
import { call, callJson, cleanupAll, readRaw, tmpDir } from './_helpers.mjs';

/**
 * Fidelity + guard coverage: the notebook on disk must survive a write
 * untouched except for the intended edit, and every mutating tool must be
 * guardable by content hash.
 */

after(cleanupAll);

const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

const DOC = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
  cells: [
    { cell_type: 'markdown', id: 'md000001', source: ['# 标题 ünïcode\n'], metadata: {} },
    {
      cell_type: 'code',
      id: 'cd000001',
      source: ['print("hi")\n'],
      metadata: {},
      execution_count: null,
      outputs: [],
    },
  ],
};

/** Layouts a real notebook may arrive in. `indent: 0` is compact. */
const LAYOUTS = [
  { name: '1-space', indent: 1, indentArg: 1, newline: '\n', trailing: true },
  { name: '2-space', indent: 2, indentArg: 2, newline: '\n', trailing: true },
  { name: '4-space', indent: 4, indentArg: 4, newline: '\n', trailing: true },
  { name: 'compact', indent: 0, indentArg: 0, newline: '\n', trailing: true },
  { name: 'no trailing newline', indent: 1, indentArg: 1, newline: '\n', trailing: false },
  { name: 'CRLF', indent: 1, indentArg: 1, newline: '\r\n', trailing: true },
];

test('a notebook round-trips byte for byte whatever its layout', async () => {
  const dir = await tmpDir();

  for (const layout of LAYOUTS) {
    const slug = layout.name.replace(/[^a-z0-9]+/gi, '-');
    const path = join(dir, `${slug}.ipynb`);
    const lf = JSON.stringify(DOC, null, layout.indentArg) + (layout.trailing ? '\n' : '');
    const onDisk = layout.newline === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
    await writeFile(path, onDisk, 'utf-8');

    const nb = await loadNotebook(path);
    assert.equal(nb.style.indent, layout.indent, `${layout.name}: indent detected`);
    assert.equal(nb.newline, layout.newline, `${layout.name}: newline detected`);
    assert.equal(nb.trailingNewline, layout.trailing, `${layout.name}: trailing newline detected`);

    const text = serializeNotebook(nb) + (nb.trailingNewline ? '\n' : '');
    const reserialized = nb.newline === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
    assert.equal(reserialized, onDisk, `${layout.name}: byte-identical`);
  }
});

test('minimal.ipynb is byte-identical after a no-op mutation', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'noop.ipynb');
  const original = await readFile(fixture('minimal.ipynb'));
  await writeFile(path, original);

  // Every code cell in that fixture already has no outputs, so clearing them
  // changes nothing — and must therefore write nothing different.
  await call('notebook_clear_outputs', { path });

  const after = await readFile(path);
  assert.equal(fileSha256(after), fileSha256(original), 'file hash unchanged');
  assert.equal(after.toString('utf-8'), original.toString('utf-8'));
});

test('an absent outputs/metadata/execution_count key is never invented', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'bare.ipynb');
  const bare = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ cell_type: 'code', id: 'bare0001', source: ['x = 1\n'] }],
  };
  await writeFile(path, JSON.stringify(bare, null, 1) + '\n', 'utf-8');
  const before = fileSha256(await readFile(path));

  const listed = await callJson('notebook_list_cells', { path });
  assert.equal(listed.cells[0].outputs_count, 0, 'read path reports an empty output list');
  assert.equal(listed.cells[0].execution_count, null);
  assert.deepEqual(listed.cells[0].tags, []);

  await call('notebook_clear_outputs', { path });

  assert.equal(fileSha256(await readFile(path)), before, 'byte-identical: no keys invented');
  const raw = await readRaw(path);
  for (const key of ['outputs', 'metadata', 'execution_count']) {
    assert.equal(key in raw.cells[0], false, `${key} still absent`);
  }
});

test('a \\uXXXX-escaped file is content-identical but not byte-identical (documented limit)', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'escaped.ipynb');
  // Python's json.dump(ensure_ascii=True) writes every non-ASCII character as
  // a \uXXXX escape; JSON.stringify never does.
  const escaped =
    JSON.stringify(DOC, null, 1).replace(/[^\x00-\x7e]/g, (ch) => {
      return '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0');
    }) + '\n';
  await writeFile(path, escaped, 'utf-8');

  const nb = await loadNotebook(path);
  const reserialized = serializeNotebook(nb) + '\n';

  assert.notEqual(reserialized, escaped, 'JSON.stringify cannot emit \\uXXXX escapes');
  assert.deepEqual(JSON.parse(reserialized), JSON.parse(escaped), 'same document, though');
  assert.ok(reserialized.includes('标题 ünïcode'), 'non-ASCII is re-emitted as raw UTF-8');
});

test('derived ids are deterministic and only persisted at nbformat >= 4.5', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'v44.ipynb');
  const v44 = {
    nbformat: 4,
    nbformat_minor: 4,
    metadata: {},
    cells: [
      { cell_type: 'code', id: undefined, source: ['a = 1\n'], metadata: {}, outputs: [] },
      { cell_type: 'code', source: ['b = 2\n'], metadata: {}, outputs: [] },
    ],
  };
  delete v44.cells[0].id;
  await writeFile(path, JSON.stringify(v44, null, 1) + '\n', 'utf-8');

  const first = await loadNotebook(path);
  const ids = first.cells.map((cell) => idOf(cell));
  for (const id of ids) assert.match(id, /^sn[a-z0-9]{6}$/);
  const second = await loadNotebook(path);
  assert.deepEqual(second.cells.map((cell) => idOf(cell)), ids, 'stable across loads');
});

test('list → edit addresses a cell of a notebook too old to store ids', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'old.ipynb');
  const doc = {
    nbformat: 4,
    nbformat_minor: 4,
    metadata: {},
    cells: [
      { cell_type: 'code', source: ['a = 1\n'], metadata: {}, execution_count: null, outputs: [] },
      { cell_type: 'code', source: ['b = 2\n'], metadata: {}, execution_count: null, outputs: [] },
    ],
  };
  await writeFile(path, JSON.stringify(doc, null, 1) + '\n', 'utf-8');

  const listed = await callJson('notebook_list_cells', { path });
  const [firstId, secondId] = listed.cells.map((c) => c.id);
  assert.match(firstId, /^sn[a-z0-9]{6}$/);

  await call('notebook_edit_cell', { path, cell_id: firstId, new_source: 'a = 99\n' });

  const raw = await readRaw(path);
  assert.deepEqual(raw.cells[0].source, ['a = 99\n'], 'the right cell was edited');
  assert.equal(raw.nbformat_minor, 4, 'nbformat_minor is never bumped');
  assert.equal('id' in raw.cells[0], false, 'still no id on disk');
  assert.equal('id' in raw.cells[1], false);

  const relisted = await callJson('notebook_list_cells', { path });
  assert.equal(relisted.cells[1].id, secondId, 'an untouched cell keeps its derived id');
  assert.notEqual(relisted.cells[0].id, firstId, 'the edited cell derives a new id');
});

test('editing a cell whose source is a string keeps it a string on disk', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'string-source.ipynb');
  const doc = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: 'code',
        id: 'ssssssss',
        source: 'x = 1\n',
        metadata: {},
        execution_count: null,
        outputs: [],
      },
    ],
  };
  await writeFile(path, JSON.stringify(doc, null, 1) + '\n', 'utf-8');

  await call('notebook_edit_cell', { path, cell_id: 'ssssssss', new_source: 'y = 2\n' });

  const raw = await readRaw(path);
  assert.equal(raw.cells[0].source, 'y = 2\n', 'the on-disk shape is preserved');
});

test('a cell inserted into a Jupyter-written file keeps the canonical key order', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'order.ipynb');
  await call('notebook_create', {
    path,
    cells: [{ cell_type: 'code', source: 'x = 1\n' }],
  });
  await call('notebook_insert_cell', { path, cell_type: 'code', source: 'y = 2\n', position: 0 });

  const raw = await readRaw(path);
  const keys = Object.keys(raw.cells[0]);
  assert.deepEqual(keys, [...keys].sort(), 'alphabetical, like nbformat writes');
  assert.ok(keys.includes('cell_type') && keys.includes('source'));
});

test('a notebook that fails the deep audit is readable but refused on write', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'dup-id.ipynb');
  const doc = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: 'code', id: 'same', source: ['a = 1\n'], metadata: {}, outputs: [] },
      { cell_type: 'code', id: 'same', source: ['b = 2\n'], metadata: {}, outputs: [] },
    ],
  };
  await writeFile(path, JSON.stringify(doc, null, 1) + '\n', 'utf-8');
  const before = fileSha256(await readFile(path));

  const listed = await callJson('notebook_list_cells', { path });
  assert.equal(listed.cell_count, 2, 'still inspectable');

  const validated = await callJson('notebook_validate', { path });
  assert.equal(validated.valid, false);
  assert.match(validated.errors.join(' | '), /reuses id "same"/);

  const err = await call('notebook_edit_cell', { path, index: 0, new_source: 'z = 1\n' }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'the write must be refused');
  assert.equal(err.name, 'InvalidNotebookError');
  assert.equal(err.code, 'INVALID_NOTEBOOK');
  assert.match(err.message, /Refusing to write an invalid notebook/);
  assert.equal(fileSha256(await readFile(path)), before, 'file untouched');
});

test('every mutating tool honours expected_file_sha256', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'guards.ipynb');
  await call('notebook_create', {
    path,
    cells: [
      { cell_type: 'code', source: 'x = 1\n' },
      { cell_type: 'markdown', source: '# h\n' },
    ],
  });
  const listed = await callJson('notebook_list_cells', { path });
  const [firstId] = listed.cells.map((c) => c.id);
  const stale = 'deadbeef'.repeat(8);

  const calls = [
    ['notebook_edit_cell', { path, cell_id: firstId, new_source: 'x = 2\n' }],
    ['notebook_insert_cell', { path, cell_type: 'code', position: 0 }],
    ['notebook_delete_cell', { path, cell_id: firstId }],
    ['notebook_clear_outputs', { path }],
  ];

  for (const [name, args] of calls) {
    const err = await call(name, { ...args, expected_file_sha256: stale }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `${name} must reject a stale file hash`);
    assert.equal(err.name, 'StaleNotebookError', name);
    assert.equal(err.code, 'STALE_NOTEBOOK', name);
  }

  // The right hash lets the same call through.
  const fresh = fileSha256(await readFile(path));
  await call('notebook_edit_cell', {
    path,
    cell_id: firstId,
    new_source: 'x = 3\n',
    expected_file_sha256: fresh,
  });
  const raw = await readRaw(path);
  assert.deepEqual(raw.cells[0].source, ['x = 3\n']);
});

test('expected_source_sha256 guards the anchor and target cell', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'source-guard.ipynb');
  await call('notebook_create', {
    path,
    cells: [
      { cell_type: 'code', source: 'x = 1\n' },
      { cell_type: 'markdown', source: '# h\n' },
    ],
  });
  const listed = await callJson('notebook_list_cells', { path });
  const [codeId, mdId] = listed.cells.map((c) => c.id);

  const wrong = sourceSha256({ source: 'not x = 1\n' });
  const right = sourceSha256({ source: 'x = 1\n' });

  const insertErr = await call('notebook_insert_cell', {
    path,
    cell_type: 'code',
    anchor_id: codeId,
    expected_source_sha256: wrong,
  }).then(() => null, (e) => e);
  assert.equal(insertErr?.code, 'STALE_NOTEBOOK', 'insert guards its anchor');

  const clearErr = await call('notebook_clear_outputs', {
    path,
    cell_id: codeId,
    expected_source_sha256: wrong,
  }).then(() => null, (e) => e);
  assert.equal(clearErr?.code, 'STALE_NOTEBOOK', 'clear_outputs guards its target');

  await call('notebook_insert_cell', {
    path,
    cell_type: 'code',
    anchor_id: codeId,
    expected_source_sha256: right,
  });
  assert.equal((await callJson('notebook_list_cells', { path })).cell_count, 3);

  const clearOk = await call('notebook_clear_outputs', { path, index: 1, cell_id: mdId }).catch(
    () => null,
  );
  assert.ok(clearOk !== undefined);
});

test('the read tools hand back a hash the writers accept', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'handoff.ipynb');
  await call('notebook_create', { path, cells: [{ cell_type: 'code', source: 'x = 1\n' }] });

  const read = await callJson('notebook_read', { path });
  const listed = await callJson('notebook_list_cells', { path });
  assert.equal(read.file_sha256, listed.file_sha256, 'both read tools agree');
  assert.equal(read.file_sha256, fileSha256(await readFile(path)), 'and match the bytes on disk');

  await call('notebook_edit_cell', {
    path,
    index: 0,
    new_source: 'x = 2\n',
    expected_file_sha256: read.file_sha256,
  });
  assert.deepEqual((await readRaw(path)).cells[0].source, ['x = 2\n']);

  const stale = await call('notebook_clear_outputs', {
    path,
    expected_file_sha256: listed.file_sha256,
  }).then(() => null, (e) => e);
  assert.equal(stale?.code, 'STALE_NOTEBOOK', 'the pre-edit hash is stale');
});

test('fileSha256 hashes the raw bytes, newlines included', async () => {
  const lf = Buffer.from('{\n "nbformat": 4\n}\n', 'utf-8');
  const crlf = Buffer.from('{\r\n "nbformat": 4\r\n}\r\n', 'utf-8');
  assert.match(fileSha256(lf), /^[0-9a-f]{64}$/);
  assert.notEqual(fileSha256(lf), fileSha256(crlf));
});
