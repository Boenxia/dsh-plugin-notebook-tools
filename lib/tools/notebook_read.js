import { stat } from 'node:fs/promises';

import { executionCountOf, idOf, normalizeSourceOut, outputsOf } from '../nb/cell.js';
import { CellNotFoundError, InvalidParametersError, NotebookError } from '../nb/errors.js';
import { fileSha256, sourceSha256 } from '../nb/hash.js';
import { loadNotebook } from '../nb/load.js';
import { truncateOutputs } from '../nb/outputs.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { internalError, stringOutput, toolJson } from './result.js';

const DESCRIPTION =
  'Read a Jupyter notebook and return its cells as structured data. Use this before editing when cell contents are needed.';

/**
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookReadTool(logger) {
  return {
    name: 'notebook_read',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to .ipynb; may include ~' },
        include_outputs: {
          type: 'boolean',
          description: 'Include cell outputs (truncated). Default: false.',
          default: false,
        },
        max_output_chars: {
          type: 'integer',
          description: 'Max characters per output. Default: 2000.',
          default: 2000,
          minimum: 0,
        },
        max_output_items: {
          type: 'integer',
          description: 'Max outputs per cell. Default: 5.',
          default: 5,
          minimum: 0,
        },
        cell_range: {
          type: 'object',
          description:
            'Half-open [start, end) index range. Mutually exclusive with cell_ids.',
          properties: {
            start: { type: 'integer', minimum: 0 },
            end: { type: 'integer', description: 'Exclusive.', minimum: 0 },
          },
          required: ['start', 'end'],
          additionalProperties: false,
        },
        cell_ids: {
          type: 'array',
          description: 'Exact cell ids to read. Mutually exclusive with cell_range.',
          items: { type: 'string' },
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

        if (params.cell_range && params.cell_ids) {
          throw new InvalidParametersError('Provide either cell_range or cell_ids, not both.');
        }

        const nb = await loadNotebook(path);
        const stats = await stat(path);

        const includeOutputs = params.include_outputs ?? false;
        const maxChars = params.max_output_chars ?? 2000;
        const maxItems = params.max_output_items ?? 5;

        const targetCells = selectCells(nb.cells, params);
        const cellsOut = targetCells.map(({ cell, index }) =>
          renderCell(cell, index, includeOutputs, maxChars, maxItems),
        );

        return toolJson({
          path,
          mtime_ms: stats.mtimeMs,
          file_sha256: fileSha256(nb.bytes),
          nbformat: nb.nbformat,
          nbformat_minor: nb.nbformat_minor,
          metadata: nb.metadata,
          cells: cellsOut,
        });
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_read', e, logger);
      }
    },
  };
}

/**
 * @param {import('../nb/types.js').Cell[]} cells
 * @param {{cell_range?: {start: number, end: number}, cell_ids?: string[]}} params
 * @returns {Array<{cell: import('../nb/types.js').Cell, index: number}>}
 */
function selectCells(cells, params) {
  if (params.cell_range) {
    const { start, end } = params.cell_range;
    if (start > cells.length || end > cells.length || start > end) {
      throw new InvalidParametersError(
        `cell_range out of bounds (notebook has ${cells.length} cells)`,
      );
    }
    return cells.slice(start, end).map((cell, i) => ({ cell, index: start + i }));
  }
  if (params.cell_ids && params.cell_ids.length > 0) {
    /** @type {Array<{cell: import('../nb/types.js').Cell, index: number}>} */
    const out = [];
    for (const id of params.cell_ids) {
      const idx = cells.findIndex((c) => idOf(c) === id);
      if (idx < 0) throw new CellNotFoundError({ cell_id: id });
      const cell = cells[idx];
      if (!cell) throw new CellNotFoundError({ cell_id: id });
      out.push({ cell, index: idx });
    }
    return out;
  }
  return cells.map((cell, index) => ({ cell, index }));
}

/**
 * @param {import('../nb/types.js').Cell} cell
 * @param {number} index
 * @param {boolean} includeOutputs
 * @param {number} maxChars
 * @param {number} maxItems
 */
function renderCell(cell, index, includeOutputs, maxChars, maxItems) {
  const source = normalizeSourceOut(cell.source);
  /** @type {Record<string, unknown>} */
  const out = {
    index,
    id: idOf(cell),
    cell_type: cell.cell_type,
    source,
    source_sha256: sourceSha256(cell),
    line_count: source.length === 0 ? 0 : source.split('\n').length,
  };
  if (cell.cell_type === 'code') {
    out.execution_count = executionCountOf(cell);
    out.outputs_count = outputsOf(cell).length;
    if (includeOutputs) {
      out.outputs = truncateOutputs(outputsOf(cell), { maxChars, maxItems });
    }
  }
  return out;
}
