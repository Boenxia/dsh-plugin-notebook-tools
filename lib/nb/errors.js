/**
 * Typed domain errors. Every failure in the domain layer is thrown as a
 * `NotebookError` subclass carrying a stable `code` so the host can render a
 * predictable failure without parsing prose.
 */

export class NotebookError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'NOTEBOOK_ERROR') {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotebookNotFoundError extends NotebookError {
  /** @param {string} path */
  constructor(path) {
    super(`Notebook not found: ${path}`, 'NOTEBOOK_NOT_FOUND');
  }
}

export class NotebookAlreadyExistsError extends NotebookError {
  /** @param {string} path */
  constructor(path) {
    super(`Notebook already exists: ${path}. Pass overwrite=true to replace.`, 'NOTEBOOK_ALREADY_EXISTS');
  }
}

export class InvalidNotebookError extends NotebookError {
  /** @param {string} message */
  constructor(message) {
    super(message, 'INVALID_NOTEBOOK');
  }
}

export class UnsupportedNbformatError extends NotebookError {
  /** @param {number} version */
  constructor(version) {
    super(`Unsupported nbformat: v${version}. Only v4 supported.`, 'UNSUPPORTED_NBFORMAT');
  }
}

export class CellNotFoundError extends NotebookError {
  /** @param {{cell_id?: string, index?: number}} ref */
  constructor(ref) {
    const detail =
      ref.cell_id !== undefined ? `cell_id=${ref.cell_id}` : `index=${ref.index}`;
    super(`Cell not found: ${detail}`, 'CELL_NOT_FOUND');
  }
}

export class InvalidParametersError extends NotebookError {
  /** @param {string} message */
  constructor(message) {
    super(message, 'INVALID_PARAMETERS');
  }
}

export class StaleNotebookError extends NotebookError {
  /** @param {string} message */
  constructor(message) {
    super(message, 'STALE_NOTEBOOK');
  }
}
