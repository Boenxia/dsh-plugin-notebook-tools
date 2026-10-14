import { stat } from 'node:fs/promises';

import { normalizeSourceOut } from '../nb/cell.js';
import { NotebookError } from '../nb/errors.js';
import { loadNotebook } from '../nb/load.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { internalError, stringOutput, toolJson } from './result.js';

const DESCRIPTION =
  'Lightweight index of a notebook — one object per cell. Use when you only need to find the right cell to act on.';

/**
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookListCellsTool(logger) {
  return {
    name: 'notebook_list_cells',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to .ipynb; may include ~' },
        preview_len: {
          type: 'integer',
          description: 'Max characters of the first source line. Default: 120.',
          default: 120,
          minimum: 0,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: stringOutput(),
    async execute(args, _exec) {
      const params = args ?? {};
      try {
        const path = normalizeNotebookPath(params.path);
        assertIpynbExtension(path);
        const nb = await loadNotebook(path);
        const stats = await stat(path);
        const previewLen = params.preview_len ?? 120;

        const cells = nb.cells.map((cell, index) => describe(cell, index, previewLen));

        return toolJson({ path, mtime_ms: stats.mtimeMs, cell_count: nb.cells.length, cells });
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_list_cells', e, logger);
      }
    },
  };
}

/**
 * @param {import('../nb/types.js').Cell} cell
 * @param {number} index
 * @param {number} previewLen
 */
function describe(cell, index, previewLen) {
  const source = normalizeSourceOut(cell.source);
  const metadata = /** @type {Record<string, unknown>} */ (cell.metadata ?? {});
  const tags = Array.isArray(metadata['tags'])
    ? /** @type {unknown[]} */ (metadata['tags']).filter((t) => typeof t === 'string')
    : [];
  const base = {
    index,
    id: cell.id,
    cell_type: cell.cell_type,
    preview: previewOf(source, previewLen),
    source_chars: source.length,
    line_count: source.length === 0 ? 0 : source.split('\n').length,
    tags,
  };
  if (cell.cell_type === 'code') {
    return {
      ...base,
      execution_count: cell.execution_count,
      outputs_count: cell.outputs.length,
      has_outputs: cell.outputs.length > 0,
    };
  }
  return { ...base, execution_count: null, outputs_count: 0, has_outputs: false };
}

/**
 * @param {string} source
 * @param {number} max
 * @returns {string}
 */
function previewOf(source, max) {
  if (max <= 0) return '';
  const firstLine = source.split('\n', 1)[0] ?? '';
  return firstLine.length <= max ? firstLine : `${firstLine.slice(0, max)}…`;
}
