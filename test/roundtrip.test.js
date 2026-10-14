import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';

import {
  call,
  callJson,
  cleanupAll,
  readRaw,
  tempLeftovers,
  tmpDir,
} from './_helpers.mjs';

after(cleanupAll);

test('create → read → list → search → edit → insert → delete → clear_outputs → validate', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'analysis.ipynb');

  // ---- create -------------------------------------------------------------
  const created = await call('notebook_create', {
    path,
    cells: [
      { cell_type: 'markdown', source: '# My analysis\n' },
      { cell_type: 'code', source: 'import pandas as pd\n' },
      {
        cell_type: 'code',
        source:
          '# split data\nfrom sklearn.model_selection import train_test_split\nX_train, X_test = train_test_split(X, y)\n',
      },
    ],
    kernel: { name: 'python3', display_name: 'Python 3', language: 'python' },
  });
  assert.match(created, /^Created notebook /);
  assert.match(created, /cells=3, overwritten=false, kernel=python3\./);

  // ---- read ---------------------------------------------------------------
  const read1 = await callJson('notebook_read', { path });
  assert.equal(read1.path, path);
  assert.equal(read1.nbformat, 4);
  assert.equal(read1.nbformat_minor, 5);
  assert.equal(read1.cells.length, 3);
  assert.equal(typeof read1.mtime_ms, 'number');
  assert.equal(read1.metadata.kernelspec.name, 'python3');
  for (const [i, cell] of read1.cells.entries()) {
    assert.equal(cell.index, i);
    assert.equal(typeof cell.id, 'string');
    assert.ok(cell.id.length >= 8, 'ids are stable and populated');
    assert.match(cell.source_sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof cell.line_count, 'number');
    assert.equal(cell.outputs, undefined, 'outputs omitted by default');
  }
  assert.equal(read1.cells[0].cell_type, 'markdown');
  assert.equal(read1.cells[0].source, '# My analysis\n');
  assert.equal(read1.cells[0].line_count, 2, "'# My analysis\\n' is two split lines");
  assert.equal(read1.cells[1].source, 'import pandas as pd\n');
  assert.equal(read1.cells[1].execution_count, null);
  assert.equal(read1.cells[1].outputs_count, 0);

  const codeId = read1.cells[1].id;
  const searchId = read1.cells[2].id;

  // targeted read by id
  const readIds = await callJson('notebook_read', { path, cell_ids: [codeId] });
  assert.equal(readIds.cells.length, 1);
  assert.equal(readIds.cells[0].id, codeId);
  assert.equal(readIds.cells[0].index, 1);

  // targeted read by range (half-open)
  const readRange = await callJson('notebook_read', { path, cell_range: { start: 1, end: 3 } });
  assert.deepEqual(
    readRange.cells.map((c) => c.index),
    [1, 2],
  );

  // ---- list ---------------------------------------------------------------
  const list = await callJson('notebook_list_cells', { path });
  assert.equal(list.cell_count, 3);
  assert.equal(list.cells.length, 3);
  assert.deepEqual(list.cells.map((c) => c.id), read1.cells.map((c) => c.id));
  assert.equal(list.cells[0].preview, '# My analysis');
  assert.equal(list.cells[0].execution_count, null);
  assert.equal(list.cells[0].has_outputs, false);
  assert.equal(list.cells[1].has_outputs, false);
  assert.equal(list.cells[1].source_chars, 'import pandas as pd\n'.length);
  assert.deepEqual(list.cells[2].tags, []);

  const listShorter = await callJson('notebook_list_cells', { path, preview_len: 4 });
  assert.equal(listShorter.cells[0].preview, '# My…');

  // ---- search -------------------------------------------------------------
  const search = await callJson('notebook_search', { path, query: 'train_test_split' });
  assert.equal(search.query, 'train_test_split');
  assert.equal(search.matches.length, 2, 'two lines mention the symbol');
  assert.equal(search.matches[0].index, 2);
  assert.equal(search.matches[0].id, searchId);
  assert.equal(search.matches[0].line, 2);
  assert.equal(search.matches[0].cell_type, 'code');
  assert.deepEqual(search.matches[0].context, [
    '# split data',
    'from sklearn.model_selection import train_test_split',
    'X_train, X_test = train_test_split(X, y)',
  ]);

  const caseSensitive = await callJson('notebook_search', {
    path,
    query: 'Train_Test_Split',
    case_sensitive: true,
  });
  assert.equal(caseSensitive.matches.length, 0);
  const caseInsensitive = await callJson('notebook_search', {
    path,
    query: 'Train_Test_Split',
  });
  assert.equal(caseInsensitive.matches.length, 2);

  const limited = await callJson('notebook_search', { path, query: 't', max_matches: 1 });
  assert.equal(limited.matches.length, 1);

  const regexed = await callJson('notebook_search', {
    path,
    query: '^import\\s+pandas',
    regex: true,
  });
  assert.equal(regexed.matches.length, 1);
  assert.equal(regexed.matches[0].id, codeId);

  const typed = await callJson('notebook_search', {
    path,
    query: 'analysis',
    cell_type: 'code',
  });
  assert.equal(typed.matches.length, 0, 'cell_type filter excludes markdown');

  // ---- edit (code cell) ---------------------------------------------------
  const edited = await call('notebook_edit_cell', {
    path,
    cell_id: codeId,
    new_source: 'import pandas as pd\nimport numpy as np\n',
    expected_source_sha256: read1.cells[1].source_sha256,
  });
  assert.match(edited, new RegExp(`^Edited cell ${codeId} \\(was index 1\\)\\.`));
  assert.match(edited, /cell_type=code\./);
  assert.match(edited, /Source: 20 → 39 chars\./);
  assert.match(edited, /Outputs cleared\./);
  assert.match(edited, /New source_sha256=[0-9a-f]{64}\.$/);

  const afterEdit = await callJson('notebook_read', { path });
  assert.equal(afterEdit.cells[1].source, 'import pandas as pd\nimport numpy as np\n');
  assert.notEqual(afterEdit.cells[1].source_sha256, read1.cells[1].source_sha256);

  // ---- insert -------------------------------------------------------------
  const inserted = await call('notebook_insert_cell', {
    path,
    cell_type: 'markdown',
    source: '## Results\n',
    anchor_id: codeId,
    placement: 'after',
  });
  assert.match(inserted, /^Inserted markdown cell [A-Za-z0-9]+ at index 2\./);
  assert.match(inserted, /Notebook now has 4 cells\./);
  const newId = inserted.match(/^Inserted markdown cell ([A-Za-z0-9]+) /)[1];

  const afterInsert = await callJson('notebook_list_cells', { path });
  assert.equal(afterInsert.cell_count, 4);
  assert.equal(afterInsert.cells[2].id, newId);
  assert.equal(afterInsert.cells[2].preview, '## Results');
  // cell ids are stable across the insert even though indexes shifted
  assert.equal(afterInsert.cells[3].id, searchId);

  const prepended = await call('notebook_insert_cell', {
    path,
    cell_type: 'raw',
    source: 'raw preamble\n',
    anchor_id: newId,
    placement: 'before',
  });
  assert.match(prepended, /at index 2\./);

  // ---- delete -------------------------------------------------------------
  const deleted = await call('notebook_delete_cell', { path, cell_id: newId });
  assert.match(deleted, new RegExp(`^Deleted cell ${newId} \\(was index 3\\)\\.`));
  assert.match(deleted, /Notebook now has 4 cells\./);

  const afterDelete = await callJson('notebook_list_cells', { path });
  assert.equal(afterDelete.cell_count, 4);
  assert.equal(afterDelete.cells.some((c) => c.id === newId), false);

  // ---- clear_outputs ------------------------------------------------------
  const cleared = await call('notebook_clear_outputs', { path });
  assert.match(cleared, /^Cleared \d+ outputs? across \d+ code cells?\.$/);

  // ---- validate -----------------------------------------------------------
  const validated = await callJson('notebook_validate', { path });
  assert.equal(validated.path, path);
  assert.equal(validated.valid, true);
  assert.equal(validated.nbformat, 4);
  assert.equal(validated.nbformat_minor, 5);
  assert.equal(validated.cell_count, 4);
  assert.equal(validated.missing_cell_ids_backfillable, 0);
  assert.deepEqual(validated.warnings, []);
  assert.deepEqual(validated.errors, []);

  // ---- on-disk shape ------------------------------------------------------
  const raw = await readRaw(path);
  for (const cell of raw.cells) {
    assert.ok(Array.isArray(cell.source), 'source on disk is a string array');
    for (const line of cell.source) assert.equal(typeof line, 'string');
  }
  const text = await readFile(path, 'utf-8');
  assert.match(text, /\n \}/, 'saved with a 1-space JSON indent');
  assert.equal(text.endsWith('\n'), false, 'JSON.stringify output, no trailing newline added');
  assert.deepEqual(await tempLeftovers(dir), [], 'no temp files left behind');
});

test('create refuses to overwrite unless overwrite=true', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'exists.ipynb');
  await call('notebook_create', { path, cells: [{ cell_type: 'code', source: 'a\n' }] });

  const err = await call('notebook_create', { path }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'second create without overwrite must fail');
  assert.equal(err.name, 'NotebookAlreadyExistsError');
  assert.equal(err.code, 'NOTEBOOK_ALREADY_EXISTS');
  assert.equal(err.message, `Notebook already exists: ${path}. Pass overwrite=true to replace.`);

  const again = await call('notebook_create', { path, overwrite: true, cells: [] });
  assert.match(again, /overwritten=true/);
  const raw = await readRaw(path);
  assert.equal(raw.cells.length, 0);
});

test('a code-cell edit really clears outputs and execution_count on disk', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'outputs.ipynb');
  const cellId = 'aaaaaaaa';
  const withOutputs = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [
      {
        cell_type: 'code',
        id: cellId,
        source: ['print("ok")\n'],
        metadata: {},
        execution_count: 7,
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['ok\n'] },
          {
            output_type: 'execute_result',
            data: { 'text/plain': '3' },
            metadata: {},
            execution_count: 7,
          },
        ],
      },
    ],
  };
  const { writeNotebook } = await import('./_helpers.mjs');
  await writeNotebook(path, withOutputs);

  const before = await callJson('notebook_read', {
    path,
    include_outputs: true,
  });
  assert.equal(before.cells[0].execution_count, 7);
  assert.equal(before.cells[0].outputs_count, 2);
  assert.equal(before.cells[0].outputs[0].text, 'ok\n');

  const edited = await call('notebook_edit_cell', {
    path,
    cell_id: cellId,
    new_source: 'print("changed")\n',
  });
  assert.match(edited, /Outputs cleared\./);

  const raw = await readRaw(path);
  assert.deepEqual(raw.cells[0].outputs, []);
  assert.equal(raw.cells[0].execution_count, null);

  const after = await callJson('notebook_read', { path, include_outputs: true });
  assert.deepEqual(after.cells[0].outputs, []);
  assert.equal(after.cells[0].execution_count, null);
});

test('include_outputs honours max_output_items / max_output_chars', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'many.ipynb');
  const outputs = [];
  for (let i = 0; i < 8; i++) {
    outputs.push({ output_type: 'stream', name: 'stdout', text: [`line ${i}\n`] });
  }
  const { writeNotebook } = await import('./_helpers.mjs');
  await writeNotebook(path, {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: 'code',
        id: 'bbbbbbbb',
        source: ['x\n'],
        metadata: {},
        execution_count: 1,
        outputs,
      },
    ],
  });

  const limited = await callJson('notebook_read', { path, include_outputs: true });
  assert.equal(limited.cells[0].outputs_count, 8);
  assert.equal(limited.cells[0].outputs.length, 6, '5 kept + 1 overflow placeholder');
  assert.equal(limited.cells[0].outputs[5].text, '[+3 more outputs elided]');

  const truncated = await callJson('notebook_read', {
    path,
    include_outputs: true,
    max_output_items: 1,
    max_output_chars: 3,
  });
  assert.equal(truncated.cells[0].outputs[0].text, 'lin…[truncated]');
  assert.equal(truncated.cells[0].outputs[1].text, '[+7 more outputs elided]');

  const none = await callJson('notebook_read', {
    path,
    include_outputs: true,
    max_output_items: 0,
  });
  assert.deepEqual(none.cells[0].outputs, []);
});

test('clear_outputs on a single cell, and on a non-code cell', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'clear.ipynb');
  const { writeNotebook } = await import('./_helpers.mjs');
  await writeNotebook(path, {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: 'code',
        id: 'c1',
        source: ['a\n'],
        metadata: {},
        execution_count: 2,
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['a\n'] }],
      },
      {
        cell_type: 'code',
        id: 'c2',
        source: ['b\n'],
        metadata: {},
        execution_count: 3,
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['b\n'] },
          { output_type: 'stream', name: 'stderr', text: ['e\n'] },
        ],
      },
      { cell_type: 'markdown', id: 'm1', source: ['# hi\n'], metadata: {} },
    ],
  });

  const one = await call('notebook_clear_outputs', { path, cell_id: 'c2' });
  assert.equal(one, 'Cleared 2 outputs across 1 code cell.');
  let raw = await readRaw(path);
  assert.equal(raw.cells[0].outputs.length, 1, 'untouched sibling');
  assert.deepEqual(raw.cells[1].outputs, []);
  assert.equal(raw.cells[1].execution_count, null);

  const onMarkdown = await call('notebook_clear_outputs', { path, cell_id: 'm1' });
  assert.equal(onMarkdown, 'Cell m1 (index 2) is markdown; nothing to clear.');

  const all = await call('notebook_clear_outputs', { path });
  assert.equal(all, 'Cleared 1 output across 1 code cell.');
  raw = await readRaw(path);
  assert.deepEqual(raw.cells[0].outputs, []);
  assert.equal(raw.cells[0].execution_count, null);
});

test('edit_cell can change cell type', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'types.ipynb');
  await call('notebook_create', {
    path,
    cells: [{ cell_type: 'markdown', source: '# title\n' }],
  });
  const listed = await callJson('notebook_list_cells', { path });
  const id = listed.cells[0].id;

  const toCode = await call('notebook_edit_cell', {
    path,
    cell_id: id,
    new_source: 'x = 1\n',
    new_cell_type: 'code',
  });
  assert.match(toCode, /cell_type markdown → code\./);
  assert.match(toCode, /Outputs cleared\./);
  let raw = await readRaw(path);
  assert.equal(raw.cells[0].cell_type, 'code');
  assert.deepEqual(raw.cells[0].outputs, []);
  assert.equal(raw.cells[0].execution_count, null);

  const toRaw = await call('notebook_edit_cell', {
    path,
    cell_id: id,
    new_source: 'plain\n',
    new_cell_type: 'raw',
  });
  assert.match(toRaw, /cell_type code → raw\./);
  assert.doesNotMatch(toRaw, /Outputs cleared\./);
  raw = await readRaw(path);
  assert.equal(raw.cells[0].cell_type, 'raw');
  assert.equal('outputs' in raw.cells[0], false, 'code-only fields dropped');
  assert.equal('execution_count' in raw.cells[0], false);
});
