import { changedFields, fieldsOf, isPlainObject } from './fields'

/**
 * A row's sync stamps (PLAN.md §6.7): its last write's, and each field's
 * that's older. A field of the row that isn't listed is at the row's stamp,
 * and one that's listed but isn't in the row was taken out at its stamp; one
 * neither listed nor there was never set. Rows from before field stamps list
 * none: every field is at the row's stamp.
 */
export interface RowStamps {
  stamp: string
  /** By path (see `fieldsOf`). */
  fields?: Record<string, string>
}

/** Every field's stamp, and the stamps fields were taken out with, from a row's stamps and its fields. */
function stampsByField({ stamp, fields = {} }: RowStamps, values: ReadonlyMap<string, unknown>): Map<string, string> {
  const out = new Map(Object.entries(fields))
  for (const path of values.keys()) if (!out.has(path)) out.set(path, stamp)
  return out
}

/** The field stamps a row keeps listed: all but those of fields it has at the row's own stamp (none: undefined). */
function listed(byField: ReadonlyMap<string, string>, stamp: string, values: ReadonlyMap<string, unknown>): Record<string, string> | undefined {
  const kept = [...byField].filter(([path, s]) => s !== stamp || !values.has(path))
  return kept.length ? Object.fromEntries(kept) : undefined
}

/**
 * A row's stamps after a write here, from the row before it (undefined if
 * there was none) and after: the fields it changed get `next()`, the others
 * keep theirs. A write that changed nothing keeps the stamps it had
 * (undefined), so it isn't sent to other devices again.
 */
export function restamp(old: RowStamps | undefined, before: unknown, after: unknown, next: () => string): RowStamps | undefined {
  if (!old || !isPlainObject(before) || !isPlainObject(after)) return { stamp: next() }
  const changed = changedFields(before, after)
  if (!changed.length) return undefined
  const stamp = next()
  const byField = stampsByField(old, fieldsOf(before))
  for (const path of changed) byField.set(path, stamp)
  const fields = listed(byField, stamp, fieldsOf(after))
  return fields ? { stamp, fields } : { stamp }
}
