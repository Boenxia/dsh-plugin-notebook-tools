/**
 * Mechanical translation of the reference TypeBox fragments into raw JSON
 * Schema. TypeBox `Type.Union([Type.Literal(...)])` → `{ type: 'string',
 * enum: [...] }`; `required: true` on a property becomes an entry in the
 * parent's `required` array; `Type.Object` defaults to
 * `additionalProperties: false`; `Type.Record(Type.String(), Type.Unknown())`
 * becomes an open object.
 *
 * Fresh object per call so a host that mutates schemas cannot
 * cross-contaminate two tool descriptors.
 *
 * @param {string} [description]
 * @returns {{type: 'string', enum: string[], description?: string}}
 */
export function cellTypeSchema(description) {
  return {
    type: 'string',
    enum: ['code', 'markdown', 'raw'],
    ...(description ? { description } : {}),
  };
}

/**
 * Guard on the notebook's exact bytes: sha256 of the file as it is on disk,
 * the same digest `Get-FileHash` / `sha256sum` report. Tighter than
 * `expected_file_mtime_ms`, which cannot see a rewrite inside the same
 * millisecond.
 */
export function fileSha256Schema() {
  return {
    type: 'string',
    description:
      'Fail if the file bytes no longer hash to this value (sha256 over the raw file, newlines included).',
  };
}

/** Open-ended key/value object, i.e. TypeBox `Type.Record(Type.String(), Type.Unknown())`. */
export function anyObjectSchema(description) {
  return {
    type: 'object',
    ...(description ? { description } : {}),
    additionalProperties: true,
  };
}
