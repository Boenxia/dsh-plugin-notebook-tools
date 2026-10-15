import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { InvalidNotebookError } from './errors.js';
import { auditNotebookShape } from './load.js';
import { DEFAULT_STYLE, serializeWith, toDiskNewline } from './style.js';

/**
 * Atomic write protocol:
 *   1. Serialize with the style the file already used (`nb.style`); a new
 *      notebook gets the Jupyter convention of a 1-space indent and sorted keys.
 *   2. Write to a sibling temp file in the SAME directory — staying in the
 *      same directory keeps `rename` atomic (no EXDEV across filesystems).
 *   3. fsync the temp file handle so the bytes are durable.
 *   4. rename(temp, path) — atomic on the same filesystem.
 *   5. On any failure, best-effort `unlink` the temp file and re-throw.
 *
 * The document is validated (`auditNotebookShape`) before anything is written:
 * a notebook we would corrupt is refused, not half-written.
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
  const value = documentOf(nb);
  const audited = auditNotebookShape(value);
  if (!audited.valid) {
    throw new InvalidNotebookError(
      `Refusing to write an invalid notebook: ${audited.errors.join('; ')}`,
    );
  }

  const body = serializeNotebook(nb);
  const text = body + (nb.trailingNewline ?? true ? '\n' : '');
  const diskText = toDiskNewline(text, nb.newline ?? '\n');
  const payload = Buffer.from(diskText, 'utf-8');

  const tempPath = buildTempPath(path);

  let renamed = false;
  /** @type {Awaited<ReturnType<typeof open>>|null} */
  let fileHandle = null;
  try {
    fileHandle = await open(tempPath, 'w', 0o644);
    await fileHandle.writeFile(payload);
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

  // Keep the in-memory facts in step with what is now on disk.
  nb.bytes = payload;
  nb.text = text;
}

/**
 * Serialize a notebook exactly as it will hit disk (newlines still LF).
 *
 * @param {import('./types.js').Notebook} nb
 * @returns {string}
 */
export function serializeNotebook(nb) {
  return serializeWith(documentOf(nb), nb.style ?? DEFAULT_STYLE);
}

/**
 * The document to serialize: the parsed document for a loaded notebook, or a
 * notebook-shaped object for a caller that built one by hand.
 *
 * @param {import('./types.js').Notebook} nb
 * @returns {Record<string, unknown>}
 */
function documentOf(nb) {
  if (nb.json) return /** @type {Record<string, unknown>} */ (nb.json);
  return {
    nbformat: nb.nbformat ?? 4,
    nbformat_minor: nb.nbformat_minor ?? 5,
    metadata: nb.metadata ?? {},
    cells: nb.cells ?? [],
  };
}
