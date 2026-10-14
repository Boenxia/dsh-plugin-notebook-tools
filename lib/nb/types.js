/**
 * Hand-rolled nbformat v4 typings. No `@jupyterlab/nbformat` — the surface we
 * need is tiny and hand-rolling keeps the package dependency-free.
 *
 * @typedef {'code'|'markdown'|'raw'} CellType
 */

/** @type {Set<string>} */
export const SUPPORTED_CELL_TYPES = new Set(['code', 'markdown', 'raw']);

/**
 * @typedef {object} CodeCell
 * @property {'code'} cell_type
 * @property {string} id
 * @property {string|string[]} source
 * @property {Record<string, unknown>} metadata
 * @property {number|null} execution_count
 * @property {CellOutput[]} outputs
 */

/**
 * @typedef {object} MarkdownCell
 * @property {'markdown'} cell_type
 * @property {string} id
 * @property {string|string[]} source
 * @property {Record<string, unknown>} metadata
 * @property {Record<string, unknown>} [attachments]
 */

/**
 * @typedef {object} RawCell
 * @property {'raw'} cell_type
 * @property {string} id
 * @property {string|string[]} source
 * @property {Record<string, unknown>} metadata
 * @property {Record<string, unknown>} [attachments]
 */

/** @typedef {CodeCell|MarkdownCell|RawCell} Cell */

/**
 * @typedef {object} StreamOutput
 * @property {'stream'} output_type
 * @property {'stdout'|'stderr'} name
 * @property {string|string[]} text
 */

/**
 * @typedef {object} DisplayDataOutput
 * @property {'display_data'} output_type
 * @property {Record<string, unknown>} data
 * @property {Record<string, unknown>} metadata
 */

/**
 * @typedef {object} ExecuteResultOutput
 * @property {'execute_result'} output_type
 * @property {Record<string, unknown>} data
 * @property {Record<string, unknown>} metadata
 * @property {number|null} execution_count
 */

/**
 * @typedef {object} ErrorOutput
 * @property {'error'} output_type
 * @property {string} ename
 * @property {string} evalue
 * @property {string[]} traceback
 */

/** @typedef {StreamOutput|DisplayDataOutput|ExecuteResultOutput|ErrorOutput} CellOutput */

/**
 * @typedef {object} KernelSpec
 * @property {string} [name]
 * @property {string} [display_name]
 * @property {string} [language]
 */

/**
 * @typedef {object} NotebookMetadata
 * @property {KernelSpec} [kernelspec]
 * @property {Record<string, unknown>} [language_info]
 */

/**
 * @typedef {object} Notebook
 * @property {4} nbformat
 * @property {number} nbformat_minor
 * @property {NotebookMetadata} metadata
 * @property {Cell[]} cells
 */

export {};
