import { readFile, stat } from 'node:fs/promises';

import { newCellId } from './cell.js';
import {
  InvalidNotebookError,
  NotebookNotFoundError,
  UnsupportedNbformatError,
} from './errors.js';
import { SUPPORTED_CELL_TYPES } from './types.js';

/**
 * Stat a notebook, mapping ENOENT to the domain's `NotebookNotFoundError` so
 * mutating tools report `Notebook not found: {path}` instead of leaking a raw
 * filesystem error.
 *
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats>}
 */
export async function statNotebook(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (isEnoent(err)) throw new NotebookNotFoundError(path);
    throw err;
  }
}

/**
 * @typedef {object} ValidationWarning
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors
 * @property {ValidationWarning[]} warnings
 * @property {number} missing_cell_ids_backfillable
 * @property {import('./types.js').Notebook} [notebook]
 */

/**
 * Read + parse + validate. Backfills missing cell ids in memory.
 *
 * @param {string} path
 * @returns {Promise<import('./types.js').Notebook>}
 */
export async function loadNotebook(path) {
  /** @type {string} */
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) throw new NotebookNotFoundError(path);
    throw err;
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidNotebookError('Invalid notebook: not parseable as JSON');
  }

  return assertValidNotebook(parsed);
}

/**
 * Synchronous shape check used by `notebook_validate` and `loadNotebook`.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateNotebookShape(value) {
  /** @type {string[]} */
  const errors = [];
  /** @type {ValidationWarning[]} */
  const warnings = [];

  if (!isPlainObject(value)) {
    errors.push('Notebook root must be a JSON object');
    return { valid: false, errors, warnings, missing_cell_ids_backfillable: 0 };
  }

  const nbformat = value['nbformat'];
  if (typeof nbformat !== 'number') {
    errors.push('Missing or non-numeric `nbformat` field');
  } else if (nbformat !== 4) {
    return {
      valid: false,
      errors: [`Unsupported nbformat: v${nbformat}. Only v4 supported.`],
      warnings,
      missing_cell_ids_backfillable: 0,
    };
  }

  const nbformatMinor = value['nbformat_minor'];
  if (typeof nbformatMinor !== 'number') {
    errors.push('Missing or non-numeric `nbformat_minor` field');
  } else if (nbformatMinor < 5) {
    warnings.push({
      code: 'OLD_NBFORMAT_MINOR',
      message: `nbformat_minor=${nbformatMinor} predates cell ids (v4.5). Cell ids are backfilled in memory but only persisted on save.`,
    });
  }

  const cellsRaw = value['cells'];
  if (!Array.isArray(cellsRaw)) {
    errors.push('`cells` must be an array');
    return { valid: false, errors, warnings, missing_cell_ids_backfillable: 0 };
  }

  /** @type {import('./types.js').Cell[]} */
  const cells = [];
  let backfilled = 0;
  for (let i = 0; i < cellsRaw.length; i++) {
    const cellResult = normalizeCell(cellsRaw[i], i);
    if (cellResult.kind === 'error') {
      errors.push(cellResult.message);
      continue;
    }
    if (cellResult.backfilled) backfilled++;
    cells.push(cellResult.cell);
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, missing_cell_ids_backfillable: backfilled };
  }

  const metadata = isPlainObject(value['metadata'])
    ? /** @type {import('./types.js').NotebookMetadata} */ (value['metadata'])
    : {};

  /** @type {import('./types.js').Notebook} */
  const notebook = {
    nbformat: 4,
    nbformat_minor: typeof nbformatMinor === 'number' ? nbformatMinor : 5,
    metadata,
    cells,
  };

  return {
    valid: true,
    errors,
    warnings,
    missing_cell_ids_backfillable: backfilled,
    notebook,
  };
}

/**
 * Build a fresh nbformat v4.5 notebook for `notebook_create`.
 *
 * @param {{cells?: Array<{cell_type: import('./types.js').CellType, source?: string, metadata?: Record<string, unknown>}>, kernel?: {name?: string, display_name?: string, language?: string}, metadata?: Record<string, unknown>}} [options]
 * @returns {import('./types.js').Notebook}
 */
export function createNotebook(options = {}) {
  /** @type {import('./types.js').KernelSpec} */
  const kernelspec = {
    name: options.kernel?.name ?? 'python3',
    display_name: options.kernel?.display_name ?? 'Python 3',
    language: options.kernel?.language ?? 'python',
  };

  /** @type {import('./types.js').NotebookMetadata} */
  const baseMetadata = {
    kernelspec,
    language_info: { name: kernelspec.language ?? 'python' },
    ...(options.metadata ?? {}),
  };
  if (options.metadata?.kernelspec) {
    baseMetadata.kernelspec = /** @type {import('./types.js').KernelSpec} */ (
      options.metadata.kernelspec
    );
  }

  const cells = (options.cells ?? []).map((c) =>
    buildNewCell(c.cell_type, c.source ?? '', c.metadata ?? {}),
  );

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: baseMetadata,
    cells,
  };
}

/**
 * @param {import('./types.js').CellType} cellType
 * @param {string} source
 * @param {Record<string, unknown>} [metadata]
 * @returns {import('./types.js').Cell}
 */
export function buildNewCell(cellType, source, metadata = {}) {
  if (cellType === 'code') {
    return {
      cell_type: 'code',
      id: newCellId(),
      source,
      metadata,
      execution_count: null,
      outputs: [],
    };
  }
  if (cellType === 'markdown') {
    return { cell_type: 'markdown', id: newCellId(), source, metadata };
  }
  return { cell_type: 'raw', id: newCellId(), source, metadata };
}

/**
 * @param {unknown} value
 * @returns {import('./types.js').Notebook}
 */
function assertValidNotebook(value) {
  if (!isPlainObject(value)) {
    throw new InvalidNotebookError('Notebook root must be a JSON object');
  }
  const nbformat = value['nbformat'];
  if (typeof nbformat !== 'number') {
    throw new InvalidNotebookError('Missing or non-numeric `nbformat` field');
  }
  if (nbformat !== 4) {
    throw new UnsupportedNbformatError(nbformat);
  }
  const result = validateNotebookShape(value);
  if (!result.valid || !result.notebook) {
    throw new InvalidNotebookError(
      result.errors[0] ?? 'Notebook failed validation',
    );
  }
  return result.notebook;
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {{kind: 'ok', cell: import('./types.js').Cell, backfilled: boolean}|{kind: 'error', message: string}}
 */
function normalizeCell(raw, index) {
  if (!isPlainObject(raw)) {
    return { kind: 'error', message: `Cell at index ${index} is not an object` };
  }
  const cellType = raw['cell_type'];
  if (typeof cellType !== 'string' || !SUPPORTED_CELL_TYPES.has(cellType)) {
    return {
      kind: 'error',
      message: `Cell at index ${index} has unsupported cell_type: ${String(cellType)}`,
    };
  }

  const sourceRaw = raw['source'];
  /** @type {string|string[]} */
  let source;
  if (typeof sourceRaw === 'string') {
    source = sourceRaw;
  } else if (Array.isArray(sourceRaw) && sourceRaw.every((s) => typeof s === 'string')) {
    source = /** @type {string[]} */ (sourceRaw);
  } else if (sourceRaw === undefined) {
    source = '';
  } else {
    return {
      kind: 'error',
      message: `Cell at index ${index} has invalid source (must be string or string[])`,
    };
  }

  const metadata = isPlainObject(raw['metadata'])
    ? /** @type {Record<string, unknown>} */ (raw['metadata'])
    : {};

  const idRaw = raw['id'];
  const hasId = typeof idRaw === 'string' && idRaw.length > 0;
  const id = hasId ? /** @type {string} */ (idRaw) : newCellId();

  if (cellType === 'code') {
    const executionCount = raw['execution_count'];
    const execution_count = typeof executionCount === 'number' ? executionCount : null;
    const outputsRaw = raw['outputs'];
    const outputs = Array.isArray(outputsRaw)
      ? /** @type {import('./types.js').CellOutput[]} */ (outputsRaw.filter(isPlainObject))
      : [];
    /** @type {import('./types.js').CodeCell} */
    const cell = { cell_type: 'code', id, source, metadata, execution_count, outputs };
    return { kind: 'ok', cell, backfilled: !hasId };
  }

  if (cellType === 'markdown') {
    /** @type {import('./types.js').MarkdownCell} */
    const cell = { cell_type: 'markdown', id, source, metadata };
    if (isPlainObject(raw['attachments'])) {
      cell.attachments = /** @type {Record<string, unknown>} */ (raw['attachments']);
    }
    return { kind: 'ok', cell, backfilled: !hasId };
  }

  /** @type {import('./types.js').RawCell} */
  const rawCell = { cell_type: 'raw', id, source, metadata };
  if (isPlainObject(raw['attachments'])) {
    rawCell.attachments = /** @type {Record<string, unknown>} */ (raw['attachments']);
  }
  return { kind: 'ok', cell: rawCell, backfilled: !hasId };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isEnoent(err) {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    /** @type {{code: unknown}} */ (err).code === 'ENOENT'
  );
}
