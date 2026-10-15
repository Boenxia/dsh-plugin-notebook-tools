import { idOf, resolveCellRef } from '../nb/cell.js';
import { InvalidParametersError, NotebookError } from '../nb/errors.js';
import { assertFreshFile, assertFreshFileSha, assertFreshSource } from '../nb/hash.js';
import { loadNotebook, statNotebook } from '../nb/load.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { saveNotebook } from '../nb/save.js';
import { internalError, stringOutput, toolText } from './result.js';
import { fileSha256Schema } from './schema.js';

const DESCRIPTION = 'Delete a cell by id or index.';

/**
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookDeleteCellTool(logger) {
  return {
    name: 'notebook_delete_cell',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to .ipynb; may include ~' },
        cell_id: { type: 'string', description: 'Preferred stable cell id.' },
        index: {
          type: 'integer',
          description: 'Fallback zero-based index. Exactly one of cell_id / index.',
          minimum: 0,
        },
        expected_source_sha256: {
          type: 'string',
          description: 'Fail if the cell source no longer hashes to this value.',
        },
        expected_file_sha256: fileSha256Schema(),
        expected_file_mtime_ms: {
          type: 'number',
          description: 'Fail if the file mtime no longer matches.',
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

        if (params.cell_id !== undefined && params.index !== undefined) {
          throw new InvalidParametersError('Provide either cell_id or index, not both.');
        }

        const stats = await statNotebook(path);
        assertFreshFile(stats.mtimeMs, params.expected_file_mtime_ms);

        const nb = await loadNotebook(path);
        assertFreshFileSha(nb.bytes, params.expected_file_sha256);

        const { cell, index } = resolveCellRef(nb, {
          ...(params.cell_id !== undefined ? { cell_id: params.cell_id } : {}),
          ...(params.index !== undefined ? { index: params.index } : {}),
        });
        assertFreshSource(cell, params.expected_source_sha256);

        nb.cells.splice(index, 1);
        await saveNotebook(path, nb);

        return toolText(
          `Deleted cell ${idOf(cell)} (was index ${index}). ` +
            `Notebook now has ${nb.cells.length} cells.`,
        );
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_delete_cell', e, logger);
      }
    },
  };
}
