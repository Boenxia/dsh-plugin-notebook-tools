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
