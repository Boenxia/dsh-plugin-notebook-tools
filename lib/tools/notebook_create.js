import { access, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  InvalidParametersError,
  NotebookAlreadyExistsError,
  NotebookError,
} from '../nb/errors.js';
import { createNotebook } from '../nb/load.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { saveNotebook } from '../nb/save.js';
import { internalError, stringOutput, toolText } from './result.js';
import { anyObjectSchema, cellTypeSchema } from './schema.js';

const DESCRIPTION =
  'Create a new Jupyter notebook from structured cells. Use this when the user asks for a new notebook or an analysis scaffold. Do not overwrite an existing notebook unless overwrite=true is explicitly provided.';

/**
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookCreateTool(logger) {
  return {
    name: 'notebook_create',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to create; may include ~; must end in .ipynb',
        },
        cells: {
          type: 'array',
          description: 'Cells to create, in order. Default: [].',
          default: [],
          items: {
            type: 'object',
            properties: {
              cell_type: cellTypeSchema('Cell type.'),
              source: {
                type: 'string',
                description: 'Cell source. Default: empty string.',
                default: '',
              },
              metadata: anyObjectSchema('Cell metadata.'),
            },
            required: ['cell_type'],
            additionalProperties: false,
          },
        },
        kernel: {
          type: 'object',
          description: 'Kernelspec recorded in notebook metadata.',
          properties: {
            name: { type: 'string', description: 'Kernel name.', default: 'python3' },
            display_name: {
              type: 'string',
              description: 'Human-readable kernel name.',
              default: 'Python 3',
            },
            language: { type: 'string', description: 'Kernel language.', default: 'python' },
          },
          additionalProperties: false,
        },
        metadata: anyObjectSchema('Notebook-level metadata.'),
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing notebook. Default: false.',
          default: false,
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

        const exists = await pathExists(path);
        if (exists && !params.overwrite) {
          throw new NotebookAlreadyExistsError(path);
        }

        await assertParentDirectory(path);

        const cells = (params.cells ?? []).map((c) => {
          if (!isCellType(c.cell_type)) {
            throw new InvalidParametersError(`Invalid cell_type: ${String(c.cell_type)}`);
          }
          return {
            cell_type: c.cell_type,
            source: c.source ?? '',
            ...(c.metadata ? { metadata: c.metadata } : {}),
          };
        });

        const nb = createNotebook({
          cells,
          ...(params.kernel
            ? {
                kernel: {
                  name: params.kernel.name ?? 'python3',
                  display_name: params.kernel.display_name ?? 'Python 3',
                  language: params.kernel.language ?? 'python',
                },
              }
            : {}),
          ...(params.metadata ? { metadata: params.metadata } : {}),
        });

        await saveNotebook(path, nb);

        return toolText(
          `Created notebook ${path}. cells=${nb.cells.length}, overwritten=${exists}, kernel=${nb.metadata.kernelspec?.name ?? 'n/a'}.`,
        );
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_create', e, logger);
      }
    },
  };
}

/** @param {unknown} value */
function isCellType(value) {
  return value === 'code' || value === 'markdown' || value === 'raw';
}

/** @param {string} p */
async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The spec lists "parent directory missing" as a documented create error, so
 * we report it instead of silently creating directories the user did not ask
 * for. (The DSH host has its own directory-creation affordances.)
 *
 * @param {string} p
 */
async function assertParentDirectory(p) {
  const parent = dirname(p);
  try {
    const s = await stat(parent);
    if (!s.isDirectory()) {
      throw new InvalidParametersError(`Parent path is not a directory: ${parent}`);
    }
  } catch (err) {
    if (err instanceof NotebookError) throw err;
    if (isEnoent(err)) {
      throw new InvalidParametersError(`Parent directory does not exist: ${parent}`);
    }
    throw err;
  }
}

/** @param {unknown} err */
function isEnoent(err) {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    /** @type {{code: unknown}} */ (err).code === 'ENOENT'
  );
}
