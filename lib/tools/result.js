import { NotebookError } from '../nb/errors.js';

/**
 * DSH `ctx.tools.register()` takes a plain-object descriptor whose `execute`
 * MUST resolve to a string, and whose `output.render` turns that string into
 * the tool result content array. There is no `isError` field — failures throw.
 *
 * @param {string} text
 * @returns {string}
 */
export function toolText(text) {
  return text;
}

/**
 * Same contract as `toolText`, but pretty-prints a structured payload the way
 * the reference implementation's `toolJson` did.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function toolJson(payload) {
  return JSON.stringify(payload, null, 2);
}

/**
 * Fresh output descriptor per tool — never share one object across tools so a
 * host that mutates/instruments schemas cannot cross-contaminate them.
 *
 * @returns {{schema: {type: 'string'}, render: (args: unknown, value: unknown) => Array<{type: 'text', text: string}>}}
 */
export function stringOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : String(value ?? '') },
    ],
  };
}

/** @type {{info: Function, warn: Function, error: Function, debug: Function}} */
export const nullLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Accept whatever the host exposes as a logger; fall back to a no-op so the
 * adapters never crash while reporting an error.
 *
 * @param {unknown} candidate
 * @returns {{info: Function, warn: Function, error: Function, debug: Function}}
 */
export function normalizeLogger(candidate) {
  if (!candidate || typeof candidate !== 'object') return nullLogger;
  /** @type {Record<string, unknown>} */
  const c = /** @type {Record<string, unknown>} */ (candidate);
  return {
    info: typeof c['info'] === 'function' ? /** @type {Function} */ (c['info']) : () => {},
    warn: typeof c['warn'] === 'function' ? /** @type {Function} */ (c['warn']) : () => {},
    error: typeof c['error'] === 'function' ? /** @type {Function} */ (c['error']) : () => {},
    debug: typeof c['debug'] === 'function' ? /** @type {Function} */ (c['debug']) : () => {},
  };
}

/**
 * Build (never swallow) the error thrown when something unexpected happened.
 * Mirrors the reference: log it, then surface it as a `NotebookError` so the
 * host reports a stable, non-leaking message.
 *
 * @param {string} toolName
 * @param {unknown} err
 * @param {{error: Function}} logger
 * @returns {NotebookError}
 */
export function internalError(toolName, err, logger) {
  const message = err instanceof Error ? err.message : String(err);
  normalizeLogger(logger).error(`${toolName} unexpected: ${message}`);
  return new NotebookError(`Internal error: ${message}`);
}
