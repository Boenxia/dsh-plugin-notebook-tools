import { executionCountOf, idOf, outputsOf, resolveCellRef } from '../nb/cell.js';
import { InvalidParametersError, NotebookError } from '../nb/errors.js';
import { assertFreshFile, assertFreshFileSha, assertFreshSource } from '../nb/hash.js';
import { loadNotebook, statNotebook } from '../nb/load.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { saveNotebook } from '../nb/save.js';
import { internalError, stringOutput, toolText } from './result.js';
import { fileSha256Schema } from './schema.js';

const DESCRIPTION =
  'Clear cell outputs. Either all code cells, or a specific one. If neither cell_id nor index is provided, clears all code-cell outputs.';

/**
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookClearOutputsTool(logger) {
  return {
    name: 'notebook_clear_outputs',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to .ipynb; may include ~' },
        cell_id: {
          type: 'string',
          description: 'Clear this one cell. Omit both to clear every code cell.',
        },
        index: {
          type: 'integer',
          description: 'Fallback zero-based index. Exactly one of cell_id / index.',
          minimum: 0,
        },
        expected_source_sha256: {
          type: 'string',
          description:
            'Fail if the targeted cell source no longer hashes to this value. Ignored when clearing every code cell.',
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

        let cellsAffected = 0;
        let outputsCleared = 0;

        if (params.cell_id !== undefined || params.index !== undefined) {
          const { cell, index } = resolveCellRef(nb, {
            ...(params.cell_id !== undefined ? { cell_id: params.cell_id } : {}),
            ...(params.index !== undefined ? { index: params.index } : {}),
          });
          assertFreshSource(cell, params.expected_source_sha256);
          if (cell.cell_type !== 'code') {
            return toolText(
              `Cell ${idOf(cell)} (index ${index}) is ${cell.cell_type}; nothing to clear.`,
            );
          }
          outputsCleared = outputsOf(cell).length;
          cellsAffected = 1;
          cell.outputs = [];
          cell.execution_count = null;
        } else {
          for (const cell of nb.cells) {
            if (cell.cell_type !== 'code') continue;
            if (outputsOf(cell).length === 0 && executionCountOf(cell) === null) continue;
            outputsCleared += outputsOf(cell).length;
            cellsAffected += 1;
            cell.outputs = [];
            cell.execution_count = null;
          }
        }

        await saveNotebook(path, nb);

        return toolText(
          `Cleared ${outputsCleared} output${outputsCleared === 1 ? '' : 's'} across ` +
            `${cellsAffected} code cell${cellsAffected === 1 ? '' : 's'}.`,
        );
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_clear_outputs', e, logger);
      }
    },
  };
}
