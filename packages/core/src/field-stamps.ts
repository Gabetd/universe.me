import { changedFields, fieldsOf, isPlainObject, rowOf, sameValue } from './fields'
import { mergeLines } from './line-merge'
import { NEW_LINEAGE, ORIGIN_STAMP, WHOLE, descends, grown, isBased, joined, kept, lineOf, meeting, type FieldLine, type Lineage } from './lineage'

/**
 * A row's sync stamps (PLAN.md §6.7): its last write's, and each field's
 * that's older. A field of the row that isn't listed is at the row's stamp,
 * and one that's listed but isn't in the row was taken out at its stamp; one
 * neither listed nor there was never set. Rows from before field stamps list
 * none: every field is at the row's stamp.
 */
export interface RowStamps {
  stamp: string
  fields?: FieldStamps
  /** What each field was written over (lineage.ts); undefined: not known (a row from before it). */
  lineage?: Lineage
}

/** Fields' stamps, by path (see `fieldsOf`). */
export type FieldStamps = Record<string, string>

/**
 * The stamps a merge gives the row it writes: another device's as they are,
 * or (for a mix of both versions) the fields' alone, the row to get a new
 * stamp (a field not listed, merged here from both, is at that stamp).
 */
export type MergedStamps = RowStamps | { fields: FieldStamps; lineage?: Lineage }

/** A row's stamps, without a `fields` or `lineage` when there are none. */
export const rowStamps = (stamp: string, fields: FieldStamps | undefined, lineage?: Lineage): RowStamps => ({ stamp, ...(fields && { fields }), ...(lineage && { lineage }) })


/** Every field's stamp, and the stamps fields were taken out with, from a row's stamps and its fields. */
export function stampsByField({ stamp, fields = {} }: RowStamps, values: ReadonlyMap<string, unknown>): Map<string, string> {
  const out = new Map(Object.entries(fields))
  for (const path of values.keys()) if (!out.has(path)) out.set(path, stamp)
  return out
}

/** The field stamps a row keeps listed: all but those of fields it has at the row's own stamp (none: undefined). */
function listed(byField: ReadonlyMap<string, string>, stamp: string, values: ReadonlyMap<string, unknown>): FieldStamps | undefined {
  const kept = [...byField].filter(([path, s]) => s !== stamp || !values.has(path))
  return kept.length ? Object.fromEntries(kept) : undefined
}

/** A lineage to grow at a write stamped `stamp`: the row's own, or (one from before lineage) one that knows from this write on. */
const lineageAt = (old: RowStamps | undefined, stamp: string): Lineage => (old ? (old.lineage ?? { from: stamp, paths: {} }) : NEW_LINEAGE)

/**
 * A row's stamps after a write here, from its stamps (if it had any) and the
 * row before the write (undefined if there was none) and after: the fields
 * it changed get `next()`, each with the stamp it had before in its line,
 * the others keep theirs. A write that changed nothing keeps the stamps it
 * had (undefined), so it isn't sent to other devices again. Fields of a new
 * row in `unset` (left at their defaults) are stamped as if never written,
 * so another device's choice for them wins (a record made apart on two
 * devices with the same id, such as a world's timeline settings).
 */
export function restamp(old: RowStamps | undefined, before: unknown, after: unknown, next: () => string, unset: readonly string[] = []): RowStamps | undefined {
  if (!isPlainObject(after)) return { stamp: next(), lineage: NEW_LINEAGE }
  if (!isPlainObject(before)) {
    const stamp = next()
    const now = fieldsOf(after)
    return rowStamps(stamp, listed(new Map(unset.filter((path) => now.has(path)).map((path) => [path, ORIGIN_STAMP])), stamp, now), NEW_LINEAGE)
  }
  const [was, now] = [fieldsOf(before), fieldsOf(after)]
  const changed = changedFields(was, now)
  if (old && !changed.length) return undefined
  const stamp = next()
  const byField = stampsByField(old ?? { stamp: ORIGIN_STAMP }, was)
  const lineage = lineageAt(old, stamp)
  const paths = { ...lineage.paths }
  for (const path of changed) {
    const previous = byField.get(path)
    if (previous) paths[path] = grown(previous, paths[path])
    byField.set(path, stamp)
  }
  return rowStamps(stamp, listed(byField, stamp, now), kept({ from: lineage.from, paths }, byField.keys()))
}

/** A row kept whole (terrain, a file)'s stamps after a write here: its line grows by the stamp it had. */
export function restampWhole(old: RowStamps | undefined, stamp: string): RowStamps {
  const lineage = lineageAt(old, stamp)
  return { stamp, lineage: old ? { from: lineage.from, paths: { [WHOLE]: grown(old.stamp, lineage.paths[WHOLE]) } } : lineage }
}

/** A version of a row: what it holds, and its stamps. */
export interface StampedRow {
  data: unknown
  stamps: RowStamps
}

/** A field one version lost in a merge, kept as a conflict note (conflicts.ts): what it had there (undefined: it had taken it out), at what stamp, and the stamp of what was kept. */
export interface LostField {
  path: string
  value: unknown
  stamp: string
  kept: string
}

/** A version of a field a merge kept earlier, by its stamp (a based path's: lineage.ts `isBased`), if it's still kept. */
export type Bases = (path: string, stamp: string) => unknown

/** What merging two versions of a row comes to: one of them as it is or a row of fields from each (with each field's stamps), and what the other version lost. */
export interface FieldMerge {
  outcome: { keep: 'own' | 'theirs' } | { data: unknown; fields: FieldStamps; lineage?: Lineage }
  lost: LostField[]
}

/** A version of a field in a merge: its line, its value, and whose it is. */
interface Side {
  line: FieldLine
  value: unknown
  side: 'own' | 'theirs'
}

/** What a field comes to: one version's (as it is), or (both changed it apart) a merge of both's lines, at the merged row's stamp. */
type FieldOutcome = { side: 'own' | 'theirs' } | { merged: string; line: string[] }

/**
 * Two versions of a field made apart: text merged line by line from the
 * version both came from (if it's kept), the later one's lines kept where
 * both changed the same; anything else, the later version. What the earlier
 * loses is told (`lost`), to be kept as a conflict note.
 */
function apart(path: string, earlier: Side, later: Side, bases: Bases | undefined, lost: LostField[]): FieldOutcome {
  const text = typeof earlier.value === 'string' && typeof later.value === 'string' && isBased(path)
  const base = text ? meeting(earlier.line, later.line) : undefined
  const was = base !== undefined ? bases?.(path, base) : undefined
  const merged = typeof was === 'string' ? mergeLines(was, earlier.value as string, later.value as string) : undefined
  if (!merged?.clean) lost.push({ path, value: earlier.value, stamp: earlier.line.stamp, kept: later.line.stamp })
  if (!merged || merged.text === later.value) return { side: later.side }
  return { merged: merged.text, line: joined(earlier.line, later.line) }
}

/** Paths no conflict is kept for: when a row was made and last changed, which every write changes. */
const BOOKKEEPING = new Set(['/createdAt', '/updatedAt'])

/** Whether two versions of a field are one: the same stamp or value, or the later written on top of the earlier (or not known not to be). */
const together = (path: string, earlier: Side, later: Side) =>
  earlier.line.stamp === later.line.stamp || !earlier.line.stamp || BOOKKEEPING.has(path) || sameValue(earlier.value, later.value) || descends(later.line, earlier.line.stamp)

/**
 * Merges another device's version of a row with this copy's, field by field:
 * each field the version with its later stamp has it (or doesn't, if it was
 * taken out there). Where both changed a field apart from each other (as
 * their lineage tells), notes are merged line by line from the version both
 * came from (`bases`), and otherwise what the earlier lost is told
 * (`lost`). When one version is kept in every field it's kept whole, and
 * when they tie, this copy's is.
 */
export function mergeFields(own: StampedRow, theirs: StampedRow, bases?: Bases): FieldMerge {
  const values = { own: fieldsOf(own.data), theirs: fieldsOf(theirs.data) }
  const stamps = { own: stampsByField(own.stamps, values.own), theirs: stampsByField(theirs.stamps, values.theirs) }
  const lineages = { own: own.stamps.lineage, theirs: theirs.stamps.lineage }
  const fields: FieldStamps = {}
  const lines: Record<string, string[]> = {}
  const won: [path: string, value: unknown, stamp: string][] = []
  const lost: LostField[] = []
  const wonBy = { own: false, theirs: false, both: false }
  for (const path of new Set([...stamps.own.keys(), ...stamps.theirs.keys()])) {
    const side = (s: 'own' | 'theirs'): Side => ({ line: lineOf(lineages[s], path, stamps[s].get(path) ?? ''), value: values[s].get(path), side: s })
    const [mine, yours] = [side('own'), side('theirs')]
    const [earlier, later] = yours.line.stamp > mine.line.stamp ? [mine, yours] : [yours, mine]
    const outcome = together(path, earlier, later) ? { side: later.side } : apart(path, earlier, later, bases, lost)
    if ('merged' in outcome) {
      // At the merged row's own stamp: not listed.
      wonBy.both = true
      lines[path] = outcome.line
      won.push([path, outcome.merged, '~'])
      continue
    }
    const kept = outcome.side === 'own' ? mine : yours
    if (earlier.line.stamp !== later.line.stamp) wonBy[outcome.side] = true
    fields[path] = kept.line.stamp
    const line = lineages[outcome.side]?.paths[path]
    if (line?.length) lines[path] = line
    if (values[outcome.side].has(path)) won.push([path, kept.value, kept.line.stamp])
  }
  if (!wonBy.both && !wonBy.theirs) return { outcome: { keep: 'own' }, lost }
  if (!wonBy.both && !wonBy.own) return { outcome: { keep: 'theirs' }, lost }
  // Set in the order they were written, a field made an object later replaces a value written before at its place, and the other way round (one merged here comes last).
  won.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0))
  const [a, b] = [lineages.own, lineages.theirs]
  const lineage = a && b ? { from: a.from > b.from ? a.from : b.from, paths: lines } : undefined
  return { outcome: { data: rowOf(won.map(([path, value]) => [path, value] as const)), fields, ...(lineage && { lineage }) }, lost }
}

/** Whether two rows' stamps are the same: the same version of it. */
export function sameStamps(a: RowStamps, b: RowStamps): boolean {
  const af = Object.entries(a.fields ?? {})
  return a.stamp === b.stamp && af.length === Object.keys(b.fields ?? {}).length && af.every(([path, s]) => b.fields?.[path] === s)
}
