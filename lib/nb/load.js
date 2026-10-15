import { readFile, stat } from 'node:fs/promises';

import { idOf, newCellId, normalizeSourceIn, normalizeSourceOut, rememberSyntheticId, syntheticCellId } from './cell.js';
import {
  InvalidNotebookError,
  NotebookNotFoundError,
  UnsupportedNbformatError,
} from './errors.js';
import { DEFAULT_STYLE, detectNewline, detectStyle, normalizeNewlines } from './style.js';
import { SUPPORTED_CELL_TYPES } from './types.js';

/** nbformat cell ids are `[a-zA-Z0-9]{1,64}`, dash/underscore tolerated. */
const CELL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
 * Read + parse + validate, keeping the parsed document as the single source of
 * truth for saving.
 *
 * @param {string} path
 * @returns {Promise<import('./types.js').Notebook>}
 */
export async function loadNotebook(path) {
  /** @type {Buffer} */
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if (isEnoent(err)) throw new NotebookNotFoundError(path);
    throw err;
  }

  const raw = bytes.toString('utf-8');
  // Newline style must be read off the raw bytes: everything downstream works
  // on an LF-normalized copy so comparisons and offsets stay simple.
  const newline = detectNewline(raw);
  const text = normalizeNewlines(raw);

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidNotebookError('Invalid notebook: not parseable as JSON');
  }

  return openNotebook(parsed, bytes, text, newline);
}

/**
 * Wrap the document that was just parsed, without rebuilding it.
 *
 * Everything the file already had stays in `json`, which is what gets
 * re-serialized — so keys this tool does not model (unknown root keys, absent
 * `metadata` / `outputs` / `execution_count`) survive a write untouched, and an
 * untouched notebook round-trips byte for byte.
 *
 * @param {unknown} value
 * @param {Buffer} bytes
 * @param {string} text LF-normalized source text.
 * @param {'\n'|'\r\n'} newline
 * @returns {import('./types.js').Notebook}
 */
function openNotebook(value, bytes, text, newline) {
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
  if (!result.valid) {
    throw new InvalidNotebookError(result.errors[0] ?? 'Notebook failed validation');
  }

  const nbformatMinor = typeof value['nbformat_minor'] === 'number' ? value['nbformat_minor'] : 5;
  const cells = /** @type {import('./types.js').Cell[]} */ (value['cells']);

  // Style detection re-serializes the document, so it has to run while the
  // document is still exactly what is on disk — before ids are backfilled.
  const style = detectStyle(value, text);
  const backfilled = backfillCellIds(cells, nbformatMinor);

  return {
    json: /** @type {Record<string, unknown>} */ (value),
    nbformat: 4,
    nbformat_minor: nbformatMinor,
    metadata: isPlainObject(value['metadata']) ? value['metadata'] : {},
    cells,
    bytes,
    text,
    style,
    newline,
    trailingNewline: text.endsWith('\n'),
    backfilled,
  };
}

/**
 * Give every cell without an id a deterministic stand-in, in place.
 *
 * At nbformat >= 4.5 the id is stored on the cell (a real write, so the file
 * becomes self-describing and the id survives later source edits). Below 4.5
 * there is nowhere to put it and the id stays in a `WeakMap`.
 *
 * @param {import('./types.js').Cell[]} cells
 * @param {number} nbformatMinor
 * @returns {number} How many cells needed a stand-in.
 */
function backfillCellIds(cells, nbformatMinor) {
  /** @type {Set<string>} */
  const taken = new Set();
  for (const cell of cells) {
    const existing = idOf(cell);
    if (existing) taken.add(existing);
  }

  let count = 0;
  for (const cell of cells) {
    if (idOf(cell)) continue;

    const source = normalizeSourceOut(cell.source);
    let ordinal = 0;
    let id = syntheticCellId(source, ordinal);
    while (taken.has(id)) {
      ordinal += 1;
      id = syntheticCellId(source, ordinal);
    }
    taken.add(id);
    rememberSyntheticId(cell, id);
    count += 1;

    if (nbformatMinor >= 5) cell.id = id;
  }
  return count;
}

/**
 * `true` for a string that is a valid nbformat cell id.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCellId(value) {
  return typeof value === 'string' && CELL_ID_RE.test(value);
}

/**
 * Shape check used by `loadNotebook` and `notebook_validate`.
 *
 * Deliberately limited to problems that make the document unusable: a notebook
 * with, say, a duplicated cell id can still be read and inspected, so it loads.
 * Use `auditNotebookShape` for the full audit that `notebook_validate` reports
 * and that saving enforces.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateNotebookShape(value) {
  return inspectNotebook(value, false);
}

/**
 * `validateNotebookShape` plus the deep checks: cell id format and uniqueness,
 * `metadata` / `outputs` types, source element types. A notebook that fails
 * this cannot be written back.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function auditNotebookShape(value) {
  return inspectNotebook(value, true);
}

/**
 * @param {unknown} value
 * @param {boolean} deep
 * @returns {ValidationResult}
 */
function inspectNotebook(value, deep) {
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
      message: `nbformat_minor=${nbformatMinor} predates cell ids (v4.5). Cell ids are derived deterministically and are not persisted.`,
    });
  }

  const cellsRaw = value['cells'];
  if (!Array.isArray(cellsRaw)) {
    errors.push('`cells` must be an array');
    return { valid: false, errors, warnings, missing_cell_ids_backfillable: 0 };
  }

  let backfilled = 0;
  /** @type {Map<string, number>} */
  const idsSeen = new Map();

  for (let i = 0; i < cellsRaw.length; i++) {
    const cell = cellsRaw[i];
    const where = `Cell at index ${i}`;

    if (!isPlainObject(cell)) {
      errors.push(`${where} is not an object`);
      continue;
    }

    const cellType = cell['cell_type'];
    if (typeof cellType !== 'string' || !SUPPORTED_CELL_TYPES.has(cellType)) {
      errors.push(`${where} has unsupported cell_type: ${String(cellType)}`);
      continue;
    }

    const sourceError = checkSource(cell['source'], where);
    if (sourceError) {
      errors.push(sourceError);
      continue;
    }

    const idRaw = cell['id'];
    const hasId = typeof idRaw === 'string' && idRaw.length > 0;
    if (hasId) {
      if (deep && !isValidCellId(idRaw)) {
        errors.push(`${where} has an invalid id ${JSON.stringify(idRaw)} (must match [A-Za-z0-9_-]{1,64})`);
      } else if (deep && idsSeen.has(idRaw)) {
        errors.push(`${where} reuses id ${JSON.stringify(idRaw)} from cell ${idsSeen.get(idRaw)}`);
      } else if (!idsSeen.has(idRaw)) {
        idsSeen.set(idRaw, i);
      }
    } else {
      backfilled += 1;
    }

    if (!deep) continue;

    if (cell['metadata'] !== undefined && !isPlainObject(cell['metadata'])) {
      errors.push(`${where}.metadata must be an object`);
    }

    if (cellType === 'code') {
      const outputs = cell['outputs'];
      if (outputs === undefined) {
        warnings.push({
          code: 'CODE_CELL_WITHOUT_OUTPUTS',
          message: `${where} has no \`outputs\` key; Jupyter treats it as an empty list.`,
        });
      } else if (!Array.isArray(outputs)) {
        errors.push(`${where}.outputs must be an array`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, missing_cell_ids_backfillable: backfilled };
  }

  const metadata = isPlainObject(value['metadata']) ? value['metadata'] : {};

  /** @type {import('./types.js').Notebook} */
  const notebook = {
    nbformat: 4,
    nbformat_minor: typeof nbformatMinor === 'number' ? nbformatMinor : 5,
    metadata,
    cells: /** @type {import('./types.js').Cell[]} */ (cellsRaw),
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
 * @param {unknown} source
 * @param {string} where
 * @returns {string|null} An error message, or `null` when the source is fine.
 */
function checkSource(source, where) {
  if (source === undefined) return null;
  if (typeof source === 'string') return null;
  if (Array.isArray(source) && source.every((line) => typeof line === 'string')) return null;
  return `${where} has invalid source (must be string or string[])`;
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

  /** @type {Record<string, unknown>} */
  const json = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: baseMetadata,
    cells,
  };

  return {
    json,
    nbformat: 4,
    nbformat_minor: 5,
    metadata: baseMetadata,
    cells,
    bytes: Buffer.alloc(0),
    text: '',
    style: { ...DEFAULT_STYLE },
    newline: '\n',
    trailingNewline: true,
    backfilled: 0,
  };
}

/**
 * @param {import('./types.js').CellType} cellType
 * @param {string} source
 * @param {Record<string, unknown>} [metadata]
 * @returns {import('./types.js').Cell}
 */
export function buildNewCell(cellType, source, metadata = {}) {
  const lines = normalizeSourceIn(source);
  // Keys in alphabetical order so a cell inserted into a Jupyter-written file
  // keeps that file's canonical layout instead of appending a differently
  // ordered block.
  if (cellType === 'code') {
    return {
      cell_type: 'code',
      execution_count: null,
      id: newCellId(),
      metadata,
      outputs: [],
      source: lines,
    };
  }
  if (cellType === 'markdown') {
    return { cell_type: 'markdown', id: newCellId(), metadata, source: lines };
  }
  return { cell_type: 'raw', id: newCellId(), metadata, source: lines };
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
