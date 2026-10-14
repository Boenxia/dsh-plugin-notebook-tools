import { randomBytes } from 'node:crypto';

import { CellNotFoundError, InvalidParametersError } from './errors.js';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate an 8-character id in the same alphabet as nanoid's default
 * (nbformat cell ids are `[a-zA-Z0-9]{1,64}`). Replaces the `nanoid`
 * dependency with `node:crypto`.
 *
 * @returns {string}
 */
export function newCellId() {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}

/**
 * @typedef {object} CellRef
 * @property {string} [cell_id]
 * @property {number} [index]
 */

/**
 * Resolve a cell by id (preferred) or index. Exactly one must be provided.
 *
 * @param {import('./types.js').Notebook} nb
 * @param {CellRef} ref
 * @returns {{cell: import('./types.js').Cell, index: number}}
 */
export function resolveCellRef(nb, ref) {
  const hasId = ref.cell_id !== undefined && ref.cell_id !== null;
  const hasIndex = ref.index !== undefined && ref.index !== null;

  if (hasId && hasIndex) {
    throw new InvalidParametersError('Provide either cell_id or index, not both.');
  }
  if (!hasId && !hasIndex) {
    throw new InvalidParametersError('Provide one of cell_id or index.');
  }

  if (hasId) {
    const id = /** @type {string} */ (ref.cell_id);
    const index = nb.cells.findIndex((c) => c.id === id);
    if (index < 0) throw new CellNotFoundError({ cell_id: id });
    const cell = nb.cells[index];
    if (!cell) throw new CellNotFoundError({ cell_id: id });
    return { cell, index };
  }

  const index = /** @type {number} */ (ref.index);
  const cell = nb.cells[index];
  if (!cell) throw new CellNotFoundError({ index });
  return { cell, index };
}

/**
 * Split a string source into Jupyter's line-array form, keeping the trailing
 * newline on each element.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function normalizeSourceIn(source) {
  if (source.length === 0) return [];
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Join the on-disk array form back into a single string for consumers.
 *
 * @param {string|string[]|undefined} source
 * @returns {string}
 */
export function normalizeSourceOut(source) {
  if (source === undefined || source === null) return '';
  if (Array.isArray(source)) return source.join('');
  return source;
}
