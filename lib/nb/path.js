import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { InvalidParametersError } from './errors.js';

/**
 * Expand a leading `~`, resolve relative paths against the process CWD, and
 * return a normalized absolute path. Every tool response reports this form.
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizeNotebookPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new InvalidParametersError('path must be a non-empty string');
  }

  let expanded = path;
  if (expanded === '~') {
    expanded = homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = resolve(homedir(), expanded.slice(2));
  }

  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/**
 * @param {string} path
 */
export function assertIpynbExtension(path) {
  if (!path.toLowerCase().endsWith('.ipynb')) {
    throw new InvalidParametersError(`Notebook path must end in .ipynb (got: ${path})`);
  }
}
