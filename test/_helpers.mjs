import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

/**
 * Build a fake DSH ctx and run the plugin's composition root against it, so
 * every test exercises the real registration path (not a hand-picked adapter).
 */
export function makeCtx() {
  /** @type {any[]} */
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(tool) {
        registered.push(tool);
      },
    },
    registered,
  };
  apply(ctx, {});
  return ctx;
}

/** All 9 registered tool descriptors, keyed by name. */
export function registry() {
  const ctx = makeCtx();
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const tool of ctx.registered) map.set(tool.name, tool);
  return { ctx, map, tools: ctx.registered };
}

export const TOOL_NAMES = [
  'notebook_create',
  'notebook_read',
  'notebook_list_cells',
  'notebook_search',
  'notebook_validate',
  'notebook_edit_cell',
  'notebook_insert_cell',
  'notebook_delete_cell',
  'notebook_clear_outputs',
];

/**
 * Invoke a registered tool the way the host does: `execute(args, exec)`.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function call(name, args) {
  const tool = registry().map.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute(args, { signal: new AbortController().signal });
}

/** Invoke a tool and JSON.parse its returned text. */
export async function callJson(name, args) {
  return JSON.parse(await call(name, args));
}

/** Track temp dirs for cleanup. */
const created = [];

export async function tmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-nbt-'));
  created.push(dir);
  return dir;
}

export async function cleanupAll() {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Write a raw .ipynb file (for fixtures that tools cannot produce). */
export async function writeNotebook(path, notebook) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, JSON.stringify(notebook, null, 1), 'utf-8');
}

/** Read the raw JSON currently on disk. */
export async function readRaw(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

/** Names of temp artifacts left in a directory (should always be empty). */
export async function tempLeftovers(dir) {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(dir)).filter((n) => n.includes('.tmp-'));
}

/** Snapshot bytes + mtime for "file was not touched" assertions. */
export async function snapshot(path) {
  const s = await stat(path);
  return { bytes: await readFile(path, 'utf-8'), mtimeMs: s.mtimeMs, size: s.size };
}

export function nb(overrides = {}) {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells: [],
    ...overrides,
  };
}

export function codeCell(source, extra = {}) {
  return {
    cell_type: 'code',
    id: extra.id ?? `code${Math.random().toString(16).slice(2, 6)}`,
    source: Array.isArray(source) ? source : source.match(/[^\n]*\n|[^\n]+$/g) ?? [],
    metadata: {},
    execution_count: null,
    outputs: [],
    ...extra,
  };
}

export function markdownCell(source, extra = {}) {
  return {
    cell_type: 'markdown',
    id: extra.id ?? `md${Math.random().toString(16).slice(2, 6)}`,
    source: Array.isArray(source) ? source : source.match(/[^\n]*\n|[^\n]+$/g) ?? [],
    metadata: {},
    ...extra,
  };
}

/** Error thrown by an async fn, or null. */
export async function caught(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
