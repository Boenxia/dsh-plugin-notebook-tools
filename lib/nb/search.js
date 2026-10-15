import { idOf, normalizeSourceOut } from './cell.js';
import { InvalidParametersError } from './errors.js';

/**
 * @typedef {object} SearchOptions
 * @property {string} query
 * @property {boolean} [regex]
 * @property {boolean} [case_sensitive]
 * @property {import('./types.js').CellType} [cell_type]
 * @property {number} [max_matches]
 * @property {number} [context_lines]
 */

/**
 * @typedef {object} SearchMatch
 * @property {number} index
 * @property {string} id
 * @property {import('./types.js').CellType} cell_type
 * @property {number} line 1-based line number within the cell source.
 * @property {string} preview
 * @property {string[]} context
 */

const PREVIEW_MAX_CHARS = 200;

/**
 * @param {import('./types.js').Notebook} nb
 * @param {SearchOptions} opts
 * @returns {SearchMatch[]}
 */
export function searchCells(nb, opts) {
  if (typeof opts.query !== 'string' || opts.query.length === 0) {
    throw new InvalidParametersError('query must be a non-empty string');
  }

  const max = opts.max_matches ?? 20;
  const context = opts.context_lines ?? 1;

  const matcher = buildMatcher(opts);
  /** @type {SearchMatch[]} */
  const matches = [];

  for (let i = 0; i < nb.cells.length; i++) {
    if (matches.length >= max) break;
    const cell = nb.cells[i];
    if (!cell) continue;
    if (opts.cell_type && cell.cell_type !== opts.cell_type) continue;

    const text = normalizeSourceOut(cell.source);
    const lines = text.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (matches.length >= max) break;
      const line = lines[lineIdx] ?? '';
      if (!matcher(line)) continue;

      const start = Math.max(0, lineIdx - context);
      const end = Math.min(lines.length, lineIdx + context + 1);
      matches.push({
        index: i,
        id: idOf(cell),
        cell_type: cell.cell_type,
        line: lineIdx + 1,
        preview: truncate(line, PREVIEW_MAX_CHARS),
        context: lines.slice(start, end),
      });
    }
  }

  return matches;
}

/**
 * @param {SearchOptions} opts
 * @returns {(line: string) => boolean}
 */
function buildMatcher(opts) {
  if (opts.regex) {
    /** @type {RegExp} */
    let re;
    try {
      re = new RegExp(opts.query, opts.case_sensitive ? '' : 'i');
    } catch (err) {
      throw new InvalidParametersError(
        `Invalid regex: ${/** @type {Error} */ (err).message}`,
      );
    }
    return (line) => re.test(line);
  }
  if (opts.case_sensitive) {
    return (line) => line.includes(opts.query);
  }
  const needle = opts.query.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

/**
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated]`;
}
