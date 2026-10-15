import { readFile } from 'node:fs/promises';

import { NotebookError } from '../nb/errors.js';
import { auditNotebookShape } from '../nb/load.js';
import { assertIpynbExtension, normalizeNotebookPath } from '../nb/path.js';
import { internalError, stringOutput, toolJson } from './result.js';

const DESCRIPTION =
  'Validate notebook JSON and nbformat assumptions without changing the file. Use after mutations as a cheap verification gate.';

/**
 * Deliberately reports expected validation failures as `valid=false` data
 * rather than throwing, so the agent gets facts instead of a stack trace.
 *
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} [logger]
 */
export function notebookValidateTool(logger) {
  return {
    name: 'notebook_validate',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to .ipynb; may include ~' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: stringOutput(),
    async execute(args, _exec) {
      const params = args ?? {};
      let path;
      try {
        path = normalizeNotebookPath(params.path);
        assertIpynbExtension(path);
      } catch (e) {
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_validate', e, logger);
      }

      /** @type {string} */
      let raw;
      try {
        raw = await readFile(path, 'utf-8');
      } catch (e) {
        if (isEnoent(e)) {
          return toolJson({
            path,
            valid: false,
            nbformat: null,
            nbformat_minor: null,
            cell_count: 0,
            missing_cell_ids_backfillable: 0,
            warnings: [],
            errors: [`Notebook not found: ${path}`],
          });
        }
        if (e instanceof NotebookError) throw e;
        throw internalError('notebook_validate', e, logger);
      }

      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return toolJson({
          path,
          valid: false,
          nbformat: null,
          nbformat_minor: null,
          cell_count: 0,
          missing_cell_ids_backfillable: 0,
          warnings: [],
          errors: ['Invalid notebook: not parseable as JSON'],
        });
      }

      try {
        const result = auditNotebookShape(parsed);
        const record = isPlainObject(parsed) ? parsed : {};
        const cellCount = Array.isArray(record['cells'])
          ? /** @type {unknown[]} */ (record['cells']).length
          : 0;
        return toolJson({
          path,
          valid: result.valid,
          nbformat: typeof record['nbformat'] === 'number' ? record['nbformat'] : null,
          nbformat_minor:
            typeof record['nbformat_minor'] === 'number' ? record['nbformat_minor'] : null,
          cell_count: cellCount,
          missing_cell_ids_backfillable: result.missing_cell_ids_backfillable,
          warnings: result.warnings,
          errors: result.errors,
        });
      } catch (e) {
        throw internalError('notebook_validate', e, logger);
      }
    },
  };
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
