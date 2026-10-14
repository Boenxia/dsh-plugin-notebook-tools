const TRUNCATION_MARKER = '…[truncated]';

/**
 * @typedef {object} TruncateOptions
 * @property {number} maxChars
 * @property {number} maxItems
 */

/**
 * Render outputs for `notebook_read` with conservative size caps. Images and
 * vendor MIME blobs are elided to keep the agent's token budget under control.
 *
 * @param {import('./types.js').CellOutput[]} outputs
 * @param {TruncateOptions} options
 * @returns {import('./types.js').CellOutput[]}
 */
export function truncateOutputs(outputs, { maxChars, maxItems }) {
  if (maxItems <= 0) return [];

  const kept = outputs.slice(0, maxItems).map((o) => truncateOne(o, maxChars));
  const overflow = outputs.length - kept.length;
  if (overflow > 0) {
    kept.push({
      output_type: 'stream',
      name: 'stdout',
      text: `[+${overflow} more output${overflow === 1 ? '' : 's'} elided]`,
    });
  }
  return kept;
}

/**
 * @param {import('./types.js').CellOutput} output
 * @param {number} maxChars
 * @returns {import('./types.js').CellOutput}
 */
function truncateOne(output, maxChars) {
  if (output.output_type === 'stream') {
    const text = Array.isArray(output.text) ? output.text.join('') : output.text;
    return {
      output_type: 'stream',
      name: output.name,
      text: truncateText(text, maxChars),
    };
  }
  if (output.output_type === 'error') {
    return {
      output_type: 'error',
      ename: output.ename,
      evalue: output.evalue,
      traceback: output.traceback.map((line) => truncateText(line, maxChars)),
    };
  }
  if (output.output_type === 'display_data' || output.output_type === 'execute_result') {
    /** @type {Record<string, unknown>} */
    const data = {};
    for (const [mime, payload] of Object.entries(output.data)) {
      data[mime] = renderMime(mime, payload, maxChars);
    }
    if (output.output_type === 'execute_result') {
      return {
        output_type: 'execute_result',
        data,
        metadata: output.metadata,
        execution_count: output.execution_count,
      };
    }
    return { output_type: 'display_data', data, metadata: output.metadata };
  }
  return output;
}

/**
 * @param {string} mime
 * @param {unknown} payload
 * @param {number} maxChars
 * @returns {unknown}
 */
function renderMime(mime, payload, maxChars) {
  if (mime.startsWith('image/')) {
    const size = approxSize(payload);
    return `<image: ${size} bytes elided>`;
  }
  if (mime === 'text/plain' || mime === 'text/markdown' || mime === 'text/html') {
    const text = Array.isArray(payload)
      ? /** @type {string[]} */ (payload).join('')
      : typeof payload === 'string'
        ? payload
        : JSON.stringify(payload);
    return truncateText(text, maxChars);
  }
  if (mime === 'application/json') {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return truncateText(text, maxChars);
  }
  if (mime.startsWith('application/vnd.')) {
    return `<${mime}: elided>`;
  }
  // Fallback: stringify and truncate.
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return truncateText(text, maxChars);
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncateText(text, maxChars) {
  if (maxChars <= 0) return TRUNCATION_MARKER;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}${TRUNCATION_MARKER}`;
}

/**
 * @param {unknown} payload
 * @returns {number}
 */
function approxSize(payload) {
  if (typeof payload === 'string') return payload.length;
  if (Array.isArray(payload)) return payload.join('').length;
  return JSON.stringify(payload ?? '').length;
}
