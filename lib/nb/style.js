/**
 * Serialization fidelity: reproduce a notebook's existing byte layout instead of
 * re-writing every file in one house style.
 *
 * `JSON.parse` preserves key order and `JSON.stringify` re-emits it, so the key
 * order of a file we did not reformat is preserved for free. What has to be
 * matched deliberately is the **indentation width**; everything else is either
 * inherited (key order) or unavoidable.
 *
 * Deliberate limits, both imposed by `JSON.stringify`:
 *   - only space indentation can be produced, never tabs;
 *   - `\uXXXX`-escaped non-ASCII (what Python's `json.dump(..., ensure_ascii=True)`
 *     emits) cannot be produced — such a file is re-emitted with raw UTF-8
 *     characters, which is content-identical but not byte-identical.
 *
 * A file we cannot reproduce falls back to `DEFAULT_STYLE`, which is the
 * Jupyter convention (`nbformat.writes` uses `indent=1, sort_keys=True`).
 */

/**
 * @typedef {object} DumpStyle
 * @property {number} indent Number of spaces per level. `0` means compact.
 * @property {boolean} sortKeys Sort object keys on the way out.
 */

/** @type {DumpStyle} */
export const DEFAULT_STYLE = { indent: 1, sortKeys: true };

/** Indent widths probed when the first nested line does not reveal the width. */
const FALLBACK_INDENTS = [1, 2, 0];

/**
 * Serialize a parsed notebook with an explicit style.
 *
 * @param {unknown} value
 * @param {DumpStyle} style
 * @returns {string}
 */
export function serializeWith(value, style) {
  const payload = style.sortKeys ? sortDeep(value) : value;
  return JSON.stringify(payload, null, style.indent);
}

/**
 * Work out how an already-serialized file was formatted, so writing it back
 * changes nothing. `text` must be newline-normalized (LF) and is compared
 * including its trailing newline, mirroring what `saveNotebook` writes.
 *
 * @param {unknown} value Parsed value, exactly as parsed — before any mutation.
 * @param {string} text
 * @returns {DumpStyle}
 */
export function detectStyle(value, text) {
  const trailing = text.endsWith('\n') ? '\n' : '';
  const probed = probeIndent(text);
  /** @type {number[]} */
  const indents = [];
  for (const candidate of [probed, ...FALLBACK_INDENTS]) {
    if (typeof candidate === 'number' && !indents.includes(candidate)) indents.push(candidate);
  }

  for (const indent of indents) {
    for (const sortKeys of [false, true]) {
      const style = { indent, sortKeys };
      if (serializeWith(value, style) + trailing === text) return style;
    }
  }
  return { ...DEFAULT_STYLE };
}

/**
 * Width of the first nested line of a pretty-printed object, or `null` when the
 * text is compact, tab-indented, or not an object at all.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function probeIndent(text) {
  const match = /^\{\n([ \t]+)/.exec(text);
  if (!match) return null;
  const whitespace = match[1];
  return whitespace.includes('\t') ? null : whitespace.length;
}

/**
 * Deep copy with object keys sorted, for the `sortKeys` styles. Arrays keep
 * their order — only object keys are sorted, and nested values are recursed.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
  return out;
}

/**
 * Collapse CRLF and lone CR to LF, so everything above can compare against one
 * canonical form.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * The newline style to write back. CRLF only when *every* LF is part of a CRLF;
 * a mixed file is normalized to LF.
 *
 * @param {string} text Raw (not newline-normalized) text.
 * @returns {'\n'|'\r\n'}
 */
export function detectNewline(text) {
  const lf = countOccurrences(text, '\n');
  const crlf = countOccurrences(text, '\r\n');
  return lf > 0 && crlf === lf ? '\r\n' : '\n';
}

/**
 * @param {string} text
 * @param {'\n'|'\r\n'} newline
 * @returns {string}
 */
export function toDiskNewline(text, newline) {
  return newline === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
