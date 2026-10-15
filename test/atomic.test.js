import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import test, { after } from 'node:test';

import { buildTempPath, saveNotebook, serializeNotebook } from '../lib/nb/save.js';
import { loadNotebook } from '../lib/nb/load.js';
import { call, cleanupAll, readRaw, tempLeftovers, tmpDir } from './_helpers.mjs';

after(cleanupAll);

const SAMPLE = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  cells: [
    {
      cell_type: 'code',
      id: 'aaaaaaaa',
      source: ['import os\n', 'print(os.getcwd())\n'],
      metadata: {},
      execution_count: null,
      outputs: [],
    },
    { cell_type: 'markdown', id: 'bbbbbbbb', source: ['# head\n'], metadata: {} },
  ],
};

test('temp path is a dot-prefixed sibling of the target, never the system temp dir', async () => {
  const dir = await tmpDir();
  const target = join(dir, 'my notebook.ipynb');
  const temp = buildTempPath(target);

  assert.equal(dirname(temp), dir, 'temp lives in the SAME directory as the target');
  assert.equal(dirname(temp) === dirname(target), true);
  const re = new RegExp(
    `^\\.${basename(target).replace('.', '\\.')}\\.tmp-${process.pid}-\\d+-[0-9a-f]{8}$`,
  );
  assert.match(basename(temp), re);

  // unique across calls
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(buildTempPath(target));
  assert.equal(seen.size, 50);
});

test('serializeNotebook writes the Jupyter layout and never reshapes a source', () => {
  const text = serializeNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: 'code',
        id: 'x',
        source: ['a\n', 'b'],
        metadata: {},
        execution_count: null,
        outputs: [],
      },
    ],
  });
  assert.ok(text.startsWith('{\n "cells": ['), '1-space indent at depth 1, keys sorted');
  const parsedForIndent = JSON.parse(text);
  assert.equal(text, JSON.stringify(parsedForIndent, null, 1), 'exactly 1-space JSON indent');
  assert.notEqual(text, JSON.stringify(parsedForIndent, null, 2), 'never 2-space');
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.cells[0].source, ['a\n', 'b']);
  assert.equal(parsed.nbformat, 4);
  assert.equal(parsed.nbformat_minor, 5);
});

test('serializeNotebook preserves the source shape it is handed', () => {
  // A loaded notebook is serialized exactly as parsed; normalizing a string
  // source into a line array here would rewrite bytes the user never touched.
  const text = serializeNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ cell_type: 'markdown', id: 'y', source: '# hi\n', metadata: {} }],
  });
  assert.equal(JSON.parse(text).cells[0].source, '# hi\n');
  assert.equal(text.endsWith('\n'), false, 'pure serialization adds no trailing newline');
});

test('a successful save leaves no temp artifacts behind', async () => {
  const dir = await tmpDir();
  const target = join(dir, 'x.ipynb');
  await saveNotebook(target, SAMPLE);

  assert.deepEqual(await tempLeftovers(dir), []);
  assert.deepEqual(await readdir(dir), ['x.ipynb'], 'exactly one file, no leftovers');
  const raw = await readRaw(target);
  assert.deepEqual(raw.cells[0].source, ['import os\n', 'print(os.getcwd())\n']);
});

test('a failed save cleans up its temp file and never touches siblings', async () => {
  const dir = await tmpDir();
  const survivor = join(dir, 'survivor.ipynb');
  await saveNotebook(survivor, SAMPLE);
  const before = { bytes: await import('node:fs/promises').then((fs) => fs.readFile(survivor, 'utf-8')) };

  // Renaming a file onto an existing directory is a real failure on Windows.
  const dirTarget = join(dir, 'i-am-a-directory.ipynb');
  await mkdir(dirTarget);

  const err = await saveNotebook(dirTarget, SAMPLE).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'save onto a directory must fail');
  assert.ok(err.code, 'carries a filesystem code');

  const s = await stat(dirTarget);
  assert.equal(s.isDirectory(), true, 'the directory is still a directory');

  const after = await import('node:fs/promises').then((fs) => fs.readFile(survivor, 'utf-8'));
  assert.equal(after, before.bytes, 'sibling notebook bytes unchanged');

  const names = await readdir(dir);
  assert.deepEqual(
    names.filter((n) => n.includes('.tmp-')),
    [],
    'no temp file left behind after a failed save',
  );
  assert.deepEqual(names.sort(), ['i-am-a-directory.ipynb', 'survivor.ipynb']);
});

test('a save into a non-existent directory fails without creating anything', async () => {
  const dir = await tmpDir();
  const target = join(dir, 'missing-dir', 'x.ipynb');

  const err = await saveNotebook(target, SAMPLE).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.equal(err.code, 'ENOENT');
  await assert.rejects(() => stat(join(dir, 'missing-dir')));
  assert.deepEqual(await readdir(dir), [], 'nothing created');
});

test('tool-level mutations leave no temp files and always produce parseable JSON', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'workflow.ipynb');

  await call('notebook_create', {
    path,
    cells: [
      { cell_type: 'markdown', source: '# a\n' },
      { cell_type: 'code', source: 'x = 1\n' },
    ],
  });
  const listed = await callJsonList(path);
  await call('notebook_insert_cell', {
    path,
    cell_type: 'code',
    source: 'y = 2\n',
    anchor_index: 1,
  });
  await call('notebook_edit_cell', { path, cell_id: listed.cells[1].id, new_source: 'x = 42\n' });
  await call('notebook_clear_outputs', { path });
  await call('notebook_delete_cell', { path, index: 0 });

  assert.deepEqual(await tempLeftovers(dir), [], 'no temp files after 5 mutations');
  const raw = await readRaw(path);
  assert.equal(raw.cells.length, 2);
  // the file stays loadable by the real loader
  const nb = await loadNotebook(path);
  assert.equal(nb.cells.length, 2);
  assert.ok(nb.cells.every((c) => typeof c.id === 'string' && c.id.length > 0));
});

test('saving after a mid-flight failure leaves the previous contents intact', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'guarded.ipynb');
  await saveNotebook(path, SAMPLE);
  const before = await readRaw(path);
  const beforeStat = await stat(path);

  // Simulate a crash before rename: run the save with a target directory that
  // cannot be replaced, then confirm the surviving file is byte-identical.
  const blocked = join(dir, 'blocked.ipynb');
  await mkdir(blocked);
  await saveNotebook(blocked, { ...SAMPLE, nbformat_minor: 4 }).catch(() => {});

  const afterStat = await stat(path);
  assert.equal(afterStat.size, beforeStat.size);
  assert.deepEqual(await readRaw(path), before, 'original notebook untouched');
  assert.deepEqual(await tempLeftovers(dir), []);
});

test('a rename failure surfaces instead of silently succeeding, and cleans up', async () => {
  const dir = await tmpDir();
  const path = join(dir, 'ro.ipynb');
  await writeFile(path, 'read-only-content', { mode: 0o444 });

  try {
    // On Windows the target's read-only attribute makes the atomic rename fail
    // with EPERM — exactly the class of late failure atomic save must survive.
    const err = await saveNotebook(path, SAMPLE).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'a read-only target must not report success');
    assert.ok(err.code === 'EPERM' || err.code === 'EACCES', `got ${err.code}`);
    assert.deepEqual(await tempLeftovers(dir), [], 'temp cleaned up after the failed rename');
    assert.equal(await readFile(path, 'utf-8'), 'read-only-content', 'target untouched');
  } finally {
    const { chmod } = await import('node:fs/promises');
    await chmod(path, 0o666).catch(() => {});
  }
});

async function callJsonList(path) {
  const { callJson } = await import('./_helpers.mjs');
  return callJson('notebook_list_cells', { path });
}
