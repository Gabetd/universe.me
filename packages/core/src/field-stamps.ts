import { changedFields, fieldsOf, isPlainObject, rowOf } from './fields'

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

/** A version of a row: what it holds, and its stamps. */
export interface StampedRow {
  data: unknown
  stamps: RowStamps
}

/** A stamp before every write (as sync stamps go): the fields of a row that was there before it was stamped, such as a world's default settings. */
export const ORIGIN_STAMP = '00000000000.00000.0'

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
 * A row's stamps after a write here, from its stamps (if it had any) and the
 * row before the write (undefined if there was none) and after: the fields
 * it changed get `next()`, the others keep theirs. A write that changed
 * nothing keeps the stamps it had (undefined), so it isn't sent to other
 * devices again.
 */
export function restamp(old: RowStamps | undefined, before: unknown, after: unknown, next: () => string): RowStamps | undefined {
  if (!isPlainObject(before) || !isPlainObject(after)) return { stamp: next() }
  const changed = changedFields(before, after)
  if (old && !changed.length) return undefined
  const stamp = next()
  const byField = stampsByField(old ?? { stamp: ORIGIN_STAMP }, fieldsOf(before))
  for (const path of changed) byField.set(path, stamp)
  const fields = listed(byField, stamp, fieldsOf(after))
  return fields ? { stamp, fields } : { stamp }
}

/** What merging two versions of a row comes to: one of them as it is, or a row of fields from each, with each field's stamp. */
export type FieldMerge = { keep: 'own' | 'theirs' } | { data: unknown; fields: Record<string, string> }

/**
 * Merges another device's version of a row with this copy's, field by field:
 * each field the version with its later stamp has it (or doesn't, if it was
 * taken out there). When one version is later in every field it's kept
 * whole, and when they tie, this copy's is.
 */
export function mergeFields(own: StampedRow, theirs: StampedRow): FieldMerge {
  const ownValues = fieldsOf(own.data)
  const theirValues = fieldsOf(theirs.data)
  const ownStamps = stampsByField(own.stamps, ownValues)
  const theirStamps = stampsByField(theirs.stamps, theirValues)
  const fields: Record<string, string> = {}
  const won: [path: string, value: unknown, stamp: string][] = []
  let ownWon = false
  let theirsWon = false
  for (const path of new Set([...ownStamps.keys(), ...theirStamps.keys()])) {
    const mine = ownStamps.get(path) ?? ''
    const yours = theirStamps.get(path) ?? ''
    ownWon ||= mine > yours
    theirsWon ||= yours > mine
    const [stamp, values] = yours > mine ? [yours, theirValues] : [mine, ownValues]
    fields[path] = stamp
    if (values.has(path)) won.push([path, values.get(path), stamp])
  }
  if (!theirsWon) return { keep: 'own' }
  if (!ownWon) return { keep: 'theirs' }
  // Set in the order they were written, a field made an object later replaces a value written before at its place, and the other way round.
  won.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0))
  return { data: rowOf(won.map(([path, value]) => [path, value] as const)), fields }
}

/** Whether two rows' stamps are the same: the same version of it. */
export function sameStamps(a: RowStamps, b: RowStamps): boolean {
  const af = Object.entries(a.fields ?? {})
  return a.stamp === b.stamp && af.length === Object.keys(b.fields ?? {}).length && af.every(([path, s]) => b.fields?.[path] === s)
}
