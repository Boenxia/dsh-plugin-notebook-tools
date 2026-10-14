import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { normalizeSourceIn } from './cell.js';

/**
 * Atomic write protocol:
 *   1. Serialize with a 1-space JSON indent (Jupyter convention).
 *   2. Write to a sibling temp file in the SAME directory — staying in the
 *      same directory keeps `rename` atomic (no EXDEV across filesystems).
 *   3. fsync the temp file handle so the bytes are durable.
 *   4. rename(temp, path) — atomic on the same filesystem.
 *   5. On any failure, best-effort `unlink` the temp file and re-throw.
 *
 * The temp name is `.<basename>.tmp-<pid>-<counter>-<random>` and never lives
 * in the system temp dir, so a killed process can never leave the target
 * file half-written. `node:path` is used for the basename (the reference
 * implementation hand-rolled a `/`-only split, which breaks on Windows).
 */

let tempCounter = 0;

/**
 * @param {string} destination
 * @returns {string}
 */
export function buildTempPath(destination) {
  const dir = dirname(destination);
  const base = basename(destination);
  tempCounter += 1;
  const random = randomBytes(4).toString('hex');
  return join(dir, `.${base}.tmp-${process.pid}-${tempCounter}-${random}`);
}

/**
 * @param {string} path
 * @param {import('./types.js').Notebook} nb
 * @returns {Promise<void>}
 */
export async function saveNotebook(path, nb) {
  const serialized = serializeNotebook(nb);
  const tempPath = buildTempPath(path);

  let renamed = false;
  /** @type {Awaited<ReturnType<typeof open>>|null} */
  let fileHandle = null;
  try {
    fileHandle = await open(tempPath, 'w', 0o644);
    await fileHandle.writeFile(serialized, 'utf-8');
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;

    await rename(tempPath, path);
    renamed = true;
  } finally {
    if (fileHandle !== null) {
      try {
        await fileHandle.close();
      } catch {
        // already closed or unwritable; nothing more we can do
      }
    }
    if (!renamed) {
      try {
        await unlink(tempPath);
      } catch {
        // temp may not exist; ignore
      }
    }
  }
}

/**
 * @param {import('./types.js').Notebook} nb
 * @returns {string}
 */
export function serializeNotebook(nb) {
  /** @type {import('./types.js').Notebook} */
  const normalized = {
    nbformat: 4,
    nbformat_minor: nb.nbformat_minor,
    metadata: nb.metadata,
    cells: nb.cells.map(normalizeCellForDisk),
  };
  return JSON.stringify(normalized, null, 1);
}

/**
 * @param {import('./types.js').Cell} cell
 * @returns {import('./types.js').Cell}
 */
function normalizeCellForDisk(cell) {
  const sourceArray = Array.isArray(cell.source)
    ? cell.source
    : normalizeSourceIn(cell.source);
  return { ...cell, source: sourceArray };
}
