/**
 * dsh-plugin-notebook-tools — composition root.
 *
 * Registers the 9 cell-aware Jupyter notebook tools on the DSH host's tool
 * registry. This file contains NO business logic; it only wires adapters.
 *
 * The host contract (proven by the installed `billion-context` plugin) is a
 * PLAIN OBJECT descriptor: `{ name, description, parameters: <JSON Schema>,
 * output: { schema, render }, execute }`. We register raw JSON Schema, so no
 * `@deepseek-ai/*` package and no runtime dependency is needed.
 */

import { notebookClearOutputsTool } from './tools/notebook_clear_outputs.js';
import { notebookCreateTool } from './tools/notebook_create.js';
import { notebookDeleteCellTool } from './tools/notebook_delete_cell.js';
import { notebookEditCellTool } from './tools/notebook_edit_cell.js';
import { notebookInsertCellTool } from './tools/notebook_insert_cell.js';
import { notebookListCellsTool } from './tools/notebook_list_cells.js';
import { notebookReadTool } from './tools/notebook_read.js';
import { notebookSearchTool } from './tools/notebook_search.js';
import { notebookValidateTool } from './tools/notebook_validate.js';
import { normalizeLogger } from './tools/result.js';

export const name = 'notebook-tools';

export const inject = ['tools'];

/**
 * @param {{tools: {register(descriptor: unknown): unknown}, logger?: unknown}} ctx
 * @param {unknown} [_config]
 */
export function apply(ctx, _config) {
  const logger = normalizeLogger(ctx?.logger);
  const tools = [
    notebookCreateTool(logger),
    notebookReadTool(logger),
    notebookListCellsTool(logger),
    notebookSearchTool(logger),
    notebookValidateTool(logger),
    notebookEditCellTool(logger),
    notebookInsertCellTool(logger),
    notebookDeleteCellTool(logger),
    notebookClearOutputsTool(logger),
  ];
  for (const tool of tools) {
    ctx.tools.register(tool);
  }
}
