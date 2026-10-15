import { createHash } from 'node:crypto';

import { normalizeSourceOut } from './cell.js';
import { StaleNotebookError } from './errors.js';

/** Sub-millisecond jitter tolerated when comparing mtimes. */
const MTIME_EPSILON_MS = 1;

/**
 * Stable sha256 over the joined source text of a cell.
 *
 * @param {import('./types.js').Cell|{source?: string|string[]}} cell
 * @returns {string}
 */
export function sourceSha256(cell) {
  return createHash('sha256').update(normalizeSourceOut(cell.source), 'utf-8').digest('hex');
}

/**
 * sha256 over the raw bytes of a notebook, newlines included — the same digest
 * `Get-FileHash`, `sha256sum` and `git hash-object` report for that file. An LF
 * and a CRLF copy of the same JSON hash differently.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function fileSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {number} actualMtimeMs
 * @param {number} [expected]
 */
export function assertFreshFile(actualMtimeMs, expected) {
  if (expected === undefined || expected === null) return;
  if (Math.abs(actualMtimeMs - expected) < MTIME_EPSILON_MS) return;
  throw new StaleNotebookError(
    `Notebook file changed on disk since the last read (expected mtime_ms=${expected}, got ${actualMtimeMs}).`,
  );
}

/**
 * Guard on the file's exact bytes, as read by `loadNotebook`. Tighter than the
 * mtime guard: it also catches a rewrite inside the same millisecond, and it is
 * immune to the coarse mtime resolution some filesystems report.
 *
 * @param {Buffer} bytes Bytes as returned by `loadNotebook`.
 * @param {string} [expected]
 */
export function assertFreshFileSha(bytes, expected) {
  if (expected === undefined || expected === null) return;
  const actual = fileSha256(bytes);
  if (actual === expected) return;
  throw new StaleNotebookError(
    `Notebook file changed on disk since the last read (expected file_sha256=${expected}, got ${actual}).`,
  );
}

/**
 * @param {import('./types.js').Cell} cell
 * @param {string} [expected]
 */
export function assertFreshSource(cell, expected) {
  if (expected === undefined || expected === null) return;
  const actual = sourceSha256(cell);
  if (actual === expected) return;
  throw new StaleNotebookError(
    `Cell source has changed since the last read (expected sha256=${expected}, got ${actual}).`,
  );
}
