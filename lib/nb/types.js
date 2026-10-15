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
 * @property {string} [id] Absent below nbformat 4.5; `idOf()` resolves a stable one.
 * @property {string|string[]} [source]
 * @property {Record<string, unknown>} [metadata]
 * @property {number|null} [execution_count]
 * @property {CellOutput[]} [outputs]
 */

/**
 * @typedef {object} MarkdownCell
 * @property {'markdown'} cell_type
 * @property {string} [id]
 * @property {string|string[]} [source]
 * @property {Record<string, unknown>} [metadata]
 * @property {Record<string, unknown>} [attachments]
 */

/**
 * @typedef {object} RawCell
 * @property {'raw'} cell_type
 * @property {string} [id]
 * @property {string|string[]} [source]
 * @property {Record<string, unknown>} [metadata]
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
 * @typedef {object} DumpStyle
 * @property {number} indent Spaces per JSON level; `0` is compact.
 * @property {boolean} sortKeys Sort object keys when serializing.
 */

/**
 * @typedef {object} Notebook
 * @property {4} nbformat
 * @property {number} nbformat_minor
 * @property {NotebookMetadata} metadata
 * @property {Cell[]} cells The very array held by `json` — mutate it in place.
 * @property {Record<string, unknown>} [json] Document as parsed; what `saveNotebook` serializes.
 * @property {Buffer} [bytes] Raw bytes as last read or written.
 * @property {string} [text] Source text with newlines normalized to LF.
 * @property {DumpStyle} [style] Layout detected on load and reproduced on save.
 * @property {'\n'|'\r\n'} [newline]
 * @property {boolean} [trailingNewline]
 * @property {number} [backfilled] Cells given a derived id on this load.
 */

export {};
