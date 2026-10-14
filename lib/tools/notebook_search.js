import { NotebookError } from '../nb/errors.js';
import { loadNotebook } from '../nb/load.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { searchCells } from '../nb/search.js';
import { internalError, stringOutput, toolJson } from './result.js';
import { cellTypeSchema } from './schema.js';

const DESCRIPTION =
  'Search cell sources and return matching cells with stable ids. Use this before editing when the target cell is known by text, heading, variable name, or code fragment.';

/**
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookSearchTool(logger) {
  return {
    name: 'notebook_search',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to .ipynb; may include ~' },
        query: { type: 'string', description: 'Literal text or regular expression.' },
        regex: {
          type: 'boolean',
          description: 'Treat query as a JavaScript regex. Default: false.',
          default: false,
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Match case-sensitively. Default: false.',
          default: false,
        },
        cell_type: cellTypeSchema('Restrict to one cell type.'),
        max_matches: {
          type: 'integer',
          description: 'Maximum matches to return. Default: 20.',
          default: 20,
          minimum: 1,
        },
        context_lines: {
          type: 'integer',
          description: 'Context lines around each match. Default: 1.',
          default: 1,
          minimum: 0,
          maximum: 5,
        },
      },
      required: ['path', 'query'],
      additionalProperties: false,
    },
    output: stringOutput(),
    async execute(args, _exec) {
      const params = args ?? {};
      try {
        const path = normalizeNotebookPath(params.path);
        assertIpynbExtension(path);
        const nb = await loadNotebook(path);
        const matches = searchCells(nb, {
          query: params.query,
          regex: params.regex ?? false,
          case_sensitive: params.case_sensitive ?? false,
          ...(params.cell_type ? { cell_type: params.cell_type } : {}),
          max_matches: params.max_matches ?? 20,
          context_lines: params.context_lines ?? 1,
        });
        return toolJson({ path, query: params.query, matches });
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_search', e, logger);
      }
    },
  };
}
