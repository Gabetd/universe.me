/**
 * A row as fields (PLAN.md §6.7): the values at the paths into its nested
 * plain objects, such as /terrain/water in a world's settings. An array, an
 * empty object or anything else is a value of its own, one field. Sync
 * stamps each field, so two devices changing different fields of one row
 * both keep their change, and undo leaves alone a field changed since.
 */

/** A field's path: each key from the row down after a /, with ~ and / in a key written ~0 and ~1 (as in a JSON pointer). */
export const pathOf = (keys: readonly string[]): string => keys.map((key) => `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')

const keysOf = (path: string): string[] => (path ? path.slice(1).split('/').map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~')) : [])

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/** The keys of an object that hold something (a key set to undefined is as good as missing, as it is in JSON). */
const definedEntries = (value: Record<string, unknown>) => Object.entries(value).filter(([, v]) => v !== undefined)

/** A row's fields: each path, and the value there. */
export function fieldsOf(row: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const visit = (value: unknown, keys: string[]) => {
    const entries = isPlainObject(value) ? definedEntries(value) : []
    if (!entries.length) out.set(pathOf(keys), value)
    for (const [key, v] of entries) visit(v, [...keys, key])
  }
  visit(row, [])
  return out
}

/**
 * A row made of fields, set in the order given: a later one replaces what's
 * in its way (a value where it needs an object, or an object where it is a
 * value). The row's objects are all new, so nothing given is changed.
 */
export function rowOf(fields: Iterable<readonly [string, unknown]>): unknown {
  const top: Record<string, unknown> = {}
  for (const [path, value] of fields) {
    let at = top
    let key = 'row'
    for (const next of keysOf(path)) {
      if (!isPlainObject(at[key])) at[key] = {}
      at = at[key] as Record<string, unknown>
      key = next
    }
    // An object that's a field of its own is an empty one.
    at[key] = isPlainObject(value) ? {} : value
  }
  return top.row
}

/** What a row has at a path (undefined: nothing). */
export function valueAt(row: unknown, path: string): unknown {
  let at = row
  for (const key of keysOf(path)) at = isPlainObject(at) ? at[key] : undefined
  return at
}

/** Whether two values (as JSON has them) are the same, however their objects' keys are ordered. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const entries = definedEntries(a)
  return entries.length === definedEntries(b).length && entries.every(([key, v]) => sameValue(v, b[key]))
}

/** The paths whose values differ between two versions of a row: changed, added, or taken out. */
export function changedFields(before: unknown, after: unknown): string[] {
  const was = fieldsOf(before)
  const now = fieldsOf(after)
  const changed = [...now].filter(([path, value]) => !was.has(path) || !sameValue(was.get(path), value)).map(([path]) => path)
  return [...changed, ...[...was.keys()].filter((path) => !now.has(path))]
}
