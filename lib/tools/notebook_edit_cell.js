import { idOf, normalizeSourceOut, resolveCellRef, setCellSource } from '../nb/cell.js';
import { InvalidParametersError, NotebookError } from '../nb/errors.js';
import { assertFreshFile, assertFreshFileSha, assertFreshSource, sourceSha256 } from '../nb/hash.js';
import { loadNotebook, statNotebook } from '../nb/load.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { saveNotebook } from '../nb/save.js';
import { internalError, stringOutput, toolText } from './result.js';
import { cellTypeSchema, fileSha256Schema } from './schema.js';

const DESCRIPTION =
  'Replace the source of a single cell. Optionally change cell type. Editing a code cell automatically clears its outputs and execution_count.';

/**
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookEditCellTool(logger) {
  return {
    name: 'notebook_edit_cell',
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
        new_source: { type: 'string', description: 'Replacement source text.' },
        new_cell_type: cellTypeSchema('Optionally change the cell type.'),
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
      required: ['path', 'new_source'],
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

        const oldSource = normalizeSourceOut(cell.source);
        const originalType = cell.cell_type;
        const newSource = params.new_source;

        setCellSource(cell, newSource);

        const typeChanged =
          params.new_cell_type !== undefined && params.new_cell_type !== originalType;
        if (typeChanged) {
          rebuildCellType(cell, params.new_cell_type);
        }

        const finalType = cell.cell_type;
        const cleared = finalType === 'code';
        if (cleared) {
          cell.outputs = [];
          cell.execution_count = null;
        }

        const typeNote = typeChanged
          ? ` cell_type ${originalType} → ${params.new_cell_type}.`
          : ` cell_type=${finalType}.`;
        const clearedNote = cleared ? ' Outputs cleared.' : '';

        await saveNotebook(path, nb);

        return toolText(
          `Edited cell ${idOf(cell)} (was index ${index}).${typeNote} ` +
            `Source: ${oldSource.length} → ${newSource.length} chars.${clearedNote} ` +
            `New source_sha256=${sourceSha256(cell)}.`,
        );
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_edit_cell', e, logger);
      }
    },
  };
}

/**
 * Re-shape a cell in place for a type change, preserving id, source and
 * metadata. Converting to `code` must introduce `outputs`/`execution_count`;
 * converting away from `code` drops them.
 *
 * @param {import('../nb/types.js').Cell} cell
 * @param {'code'|'markdown'|'raw'} newType
 */
function rebuildCellType(cell, newType) {
  if (newType === 'code') {
    cell.cell_type = 'code';
    cell.execution_count = null;
    cell.outputs = [];
    return;
  }
  const attachments = cell.attachments;
  delete cell.outputs;
  delete cell.execution_count;
  if (newType === 'markdown') {
    cell.cell_type = 'markdown';
    if (attachments) cell.attachments = attachments;
    return;
  }
  cell.cell_type = 'raw';
  if (attachments) cell.attachments = attachments;
}
