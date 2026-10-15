import { idOf } from '../nb/cell.js';
import { buildNewCell, loadNotebook, statNotebook } from '../nb/load.js';
import { CellNotFoundError, InvalidParametersError, NotebookError } from '../nb/errors.js';
import { assertFreshFile, assertFreshFileSha, assertFreshSource } from '../nb/hash.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { saveNotebook } from '../nb/save.js';
import { internalError, stringOutput, toolText } from './result.js';
import { anyObjectSchema, cellTypeSchema, fileSha256Schema } from './schema.js';

const DESCRIPTION =
  'Insert a new cell. Position is specified relative to an anchor cell (before / after an anchor_id or anchor_index), or at an absolute position. New cells get a freshly generated id.';

/**
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookInsertCellTool(logger) {
  return {
    name: 'notebook_insert_cell',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to .ipynb; may include ~' },
        cell_type: cellTypeSchema('Type of the new cell.'),
        source: {
          type: 'string',
          description: 'Source for the new cell. Default: empty string.',
          default: '',
        },
        metadata: anyObjectSchema('Metadata for the new cell.'),
        position: {
          type: 'integer',
          description: 'Absolute insertion index. Mutually exclusive with the anchor options.',
          minimum: 0,
        },
        anchor_id: { type: 'string', description: 'Anchor cell id.' },
        anchor_index: {
          type: 'integer',
          description: 'Anchor cell index.',
          minimum: 0,
        },
        placement: {
          type: 'string',
          enum: ['before', 'after'],
          description: 'Insert relative to the anchor. Default: after. Anchor-based only.',
          default: 'after',
        },
        expected_source_sha256: {
          type: 'string',
          description:
            'Fail if the anchor cell source no longer hashes to this value. Ignored with an absolute position.',
        },
        expected_file_sha256: fileSha256Schema(),
        expected_file_mtime_ms: {
          type: 'number',
          description: 'Fail if the file mtime no longer matches.',
        },
      },
      required: ['path', 'cell_type'],
      additionalProperties: false,
    },
    output: stringOutput(),
    async execute(args, _exec) {
      const params = args ?? {};
      try {
        const path = normalizeNotebookPath(params.path);
        assertIpynbExtension(path);

        const provided = [params.position, params.anchor_id, params.anchor_index].filter(
          (v) => v !== undefined && v !== null,
        );
        if (provided.length !== 1) {
          throw new InvalidParametersError(
            'Provide exactly one of: position, anchor_id, or anchor_index.',
          );
        }

        const stats = await statNotebook(path);
        assertFreshFile(stats.mtimeMs, params.expected_file_mtime_ms);

        const nb = await loadNotebook(path);
        assertFreshFileSha(nb.bytes, params.expected_file_sha256);

        let insertIndex;
        /** @type {import('../nb/types.js').Cell|undefined} */
        let anchor;
        if (params.position !== undefined) {
          const pos = params.position;
          if (pos < 0 || pos > nb.cells.length) {
            throw new InvalidParametersError(
              `position ${pos} out of bounds (notebook has ${nb.cells.length} cells)`,
            );
          }
          insertIndex = pos;
        } else if (params.anchor_id !== undefined) {
          const anchorIdx = nb.cells.findIndex((c) => idOf(c) === params.anchor_id);
          if (anchorIdx < 0) {
            throw new CellNotFoundError({ cell_id: params.anchor_id });
          }
          anchor = nb.cells[anchorIdx];
          insertIndex = (params.placement ?? 'after') === 'before' ? anchorIdx : anchorIdx + 1;
        } else {
          const anchorIdx = params.anchor_index;
          if (anchorIdx < 0 || anchorIdx >= nb.cells.length) {
            throw new InvalidParametersError(
              `anchor_index ${anchorIdx} out of bounds (notebook has ${nb.cells.length} cells)`,
            );
          }
          anchor = nb.cells[anchorIdx];
          insertIndex = (params.placement ?? 'after') === 'before' ? anchorIdx : anchorIdx + 1;
        }
        if (anchor) assertFreshSource(anchor, params.expected_source_sha256);

        const cell = buildNewCell(
          params.cell_type,
          params.source ?? '',
          params.metadata ?? {},
        );
        nb.cells.splice(insertIndex, 0, cell);

        await saveNotebook(path, nb);

        return toolText(
          `Inserted ${params.cell_type} cell ${idOf(cell)} at index ${insertIndex}. ` +
            `Notebook now has ${nb.cells.length} cells.`,
        );
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_insert_cell', e, logger);
      }
    },
  };
}
