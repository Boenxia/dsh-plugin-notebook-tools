import { createHash, randomBytes } from 'node:crypto';

import { CellNotFoundError, InvalidParametersError } from './errors.js';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SYNTHETIC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Ids held for cells that have none **on disk**.
 *
 * A `WeakMap` rather than a property on the cell, because the parsed JSON is
 * mutated and re-serialized in place: any own enumerable property would be
 * written back into the user's file. Notebooks below nbformat 4.5 have nowhere
 * to store an id, so those cells need one that lives outside the document.
 *
 * @type {WeakMap<object, string>}
 */
const SYNTHETIC_IDS = new WeakMap();

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
 * Deterministic stand-in id for a cell that has no id on disk.
 *
 * `sha256('v1|<ordinal>|<source>')` folded into six base-36 digits behind an
 * `sn` prefix. Deterministic on purpose: `notebook_list_cells` followed by
 * `notebook_edit_cell` addresses the same cell even in a notebook too old to
 * store ids, while a source change changes the id — so a stale id fails loudly
 * instead of silently hitting the wrong cell.
 *
 * @param {string} source Joined cell source.
 * @param {number} [ordinal] Disambiguates cells with identical sources.
 * @returns {string}
 */
export function syntheticCellId(source, ordinal = 0) {
  const digest = createHash('sha256').update(`v1|${ordinal}|${source}`, 'utf-8').digest('hex');
  let number = BigInt(`0x${digest.slice(0, 16)}`);
  /** @type {string[]} */
  const chars = [];
  for (let i = 0; i < 6; i++) {
    chars.push(SYNTHETIC_ALPHABET[Number(number % 36n)]);
    number /= 36n;
  }
  return `sn${chars.reverse().join('')}`;
}

/**
 * @param {object} cell
 * @param {string} id
 */
export function rememberSyntheticId(cell, id) {
  SYNTHETIC_IDS.set(cell, id);
}

/**
 * The cell's stable id: the one on disk when it has one, otherwise the
 * in-memory stand-in. Every cell returned by `loadNotebook` resolves to one.
 *
 * @param {import('./types.js').Cell} cell
 * @returns {string|undefined}
 */
export function idOf(cell) {
  if (typeof cell.id === 'string' && cell.id.length > 0) return cell.id;
  return SYNTHETIC_IDS.get(cell);
}

/**
 * A code cell's outputs. Absent means empty — reading must not invent a key
 * that a later save would write into the user's file.
 *
 * @param {import('./types.js').Cell} cell
 * @returns {import('./types.js').CellOutput[]}
 */
export function outputsOf(cell) {
  return Array.isArray(cell.outputs) ? cell.outputs : [];
}

/**
 * @param {import('./types.js').Cell} cell
 * @returns {number|null}
 */
export function executionCountOf(cell) {
  return typeof cell.execution_count === 'number' ? cell.execution_count : null;
}

/**
 * @param {import('./types.js').Cell} cell
 * @returns {Record<string, unknown>}
 */
export function metadataOf(cell) {
  return isPlainObject(cell.metadata) ? cell.metadata : {};
}

/**
 * Replace a cell's source while keeping the shape it already had on disk: a
 * cell whose source is a string keeps a string (a one-line diff), everything
 * else gets Jupyter's line-array form. New cells always get the array form.
 *
 * @param {import('./types.js').Cell} cell
 * @param {string} text
 */
export function setCellSource(cell, text) {
  const hadSource = cell.source !== undefined && cell.source !== null;
  const asString = hadSource && !Array.isArray(cell.source);
  cell.source = asString ? text : normalizeSourceIn(text);
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
    const index = nb.cells.findIndex((c) => idOf(c) === id);
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
