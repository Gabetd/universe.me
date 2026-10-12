/**
 * What came before each field of a row (PLAN.md §6.7, M20): the stamps of
 * the versions a field's value was written over, newest first, so a merge
 * can tell a change made on top of another (taken as it is) from two made
 * apart (a conflict: notes merged line by line, terrain cell by cell, and
 * otherwise the later kept and the other kept as a conflict note).
 *
 * Only versions since `from` are known: a row from before lineage starts
 * knowing at its first write since, and a version older than that is taken
 * as one the field was written on top of, as before lineage (no conflict is
 * ever made up from a missing history). A row whose lineage isn't known at
 * all (from a device from before it) has none of its fields' known.
 */

/** The versions kept before each field's, at most: one older than all of them, with the list full, is taken as before them too. */
export const LINEAGE_CAP = 8

/** A stamp before every write (as sync stamps go): the fields of a row that was there before it was stamped, such as a world's default settings. */
export const ORIGIN_STAMP = '00000000000.00000.0'

/** The path of a row kept whole (terrain, a file): the row's own history. */
export const WHOLE = ''

export interface Lineage {
  /** The first write it knows of: the history of a field written at or after it is known. */
  from: string
  /** Each field's earlier stamps, newest first (a field not listed has none: it's as first written). */
  paths: Record<string, string[]>
}

/** A row new here: every field's history is known (it has none). */
export const NEW_LINEAGE: Lineage = { from: ORIGIN_STAMP, paths: {} }

/** A version of a field: its stamp, and the stamps before it back to `from` (undefined: not known). */
export interface FieldLine {
  stamp: string
  before?: readonly string[]
  from?: string
}

/** A field's line in a version of a row, from the row's lineage. */
export function lineOf(lineage: Lineage | undefined, path: string, stamp: string): FieldLine {
  return lineage && stamp >= lineage.from ? { stamp, before: lineage.paths[path] ?? [], from: lineage.from } : { stamp }
}

/** Whether the version stamped `earlier` is one `later` was written on top of (or can't be told not to be). */
export function descends(later: FieldLine, earlier: string): boolean {
  const { before, from = ORIGIN_STAMP } = later
  if (earlier === later.stamp || !before || earlier < from || earlier === ORIGIN_STAMP) return true
  return before.includes(earlier) || (before.length >= LINEAGE_CAP && earlier < before.at(-1)!)
}

/** The latest version two lines both came from, if both are known and they meet. */
export function meeting(a: FieldLine, b: FieldLine): string | undefined {
  if (!a.before || !b.before) return undefined
  const bs = new Set([b.stamp, ...b.before])
  return [a.stamp, ...a.before].find((s) => bs.has(s))
}

/** The line of a version made of two (merged here): after both of them and all they came from. */
export function joined(a: FieldLine, b: FieldLine): string[] {
  return [...new Set([a.stamp, b.stamp, ...(a.before ?? []), ...(b.before ?? [])])].sort().reverse().slice(0, LINEAGE_CAP)
}

/** A field's line after a write over the version stamped `previous`. */
export const grown = (previous: string, before: readonly string[] = []): string[] => [previous, ...before.filter((s) => s !== previous)].slice(0, LINEAGE_CAP)

/** A lineage keeping only the fields given (the others are gone from the row), without empty lines. */
export function kept(lineage: Lineage, paths: Iterable<string>): Lineage {
  const out: Record<string, string[]> = {}
  for (const path of paths) {
    const line = lineage.paths[path]
    if (line?.length) out[path] = line
  }
  return { from: lineage.from, paths: out }
}

/**
 * The paths a merge works out line by line or keeps an earlier version of:
 * text people write at length (notes, a change's note, a canvas card's
 * text), and a row kept whole (a face of terrain).
 */
export const isBased = (path: string): boolean => path === WHOLE || /\/(notes|note|text)$/.test(path)
