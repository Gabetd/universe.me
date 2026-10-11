import { sameValue, valueAt } from './fields'
import { refKey, type SyncRef } from './sync'

/**
 * What one step on the undo stack left in the rows it patched, field by
 * field (PLAN.md §6.7). Undoing the step, or redoing it, leaves alone a
 * field that holds something else by then (someone's change since, merged
 * from another device) and undoes the rest, so undo is per person: it never
 * takes back someone else's change. Each write it lets through notes what it
 * left in turn, so a step that patches the same field twice is undone twice.
 */
export class Footprint {
  /** By row and path. */
  private readonly left = new Map<string, unknown>()

  /** Whether `row` (named `key`) still holds at `path` what this step left there; at a path it didn't write, it does. */
  holds(key: string, row: unknown, path: string): boolean {
    const at = JSON.stringify([key, path])
    return !this.left.has(at) || sameValue(valueAt(row, path), this.left.get(at))
  }

  /** Notes what a write left at each path it set in a row. */
  wrote(key: string, row: unknown, paths: Iterable<string>): void {
    for (const path of paths) this.left.set(JSON.stringify([key, path]), valueAt(row, path))
  }

  /** Steps made one: what the latest of them left at each path. */
  static of(steps: readonly Footprint[]): Footprint {
    const joined = new Footprint()
    for (const step of steps) for (const [at, value] of step.left) joined.left.set(at, value)
    return joined
  }
}

/**
 * Patches a row (`ref`, as it is now: `row`) as a step does each time it's
 * made, undone or redone: of the fields it asks for (each by its path
 * first), those the step still holds (all of them, the first time) are
 * written by `write`, which gives back the row as written, and noted as what
 * the step left there. With none left (each changed since, by someone else),
 * nothing is written (undefined); a patch that asks for nothing still is.
 */
export function patchThrough<E extends readonly [path: string, ...rest: unknown[]], R>(
  footprint: Footprint | undefined,
  ref: SyncRef,
  row: unknown,
  asked: readonly E[],
  write: (kept: readonly E[]) => R
): { kept: readonly E[]; written: R } | undefined {
  const key = refKey(ref)
  const kept = footprint ? asked.filter(([path]) => footprint.holds(key, row, path)) : asked
  if (asked.length && !kept.length) return undefined
  const written = write(kept)
  footprint?.wrote(key, written, kept.map(([path]) => path))
  return { kept, written }
}
