import { sameValue, valueAt } from './fields'

/**
 * What one step on the undo stack left in the rows it wrote, field by field
 * (and in terrain, cell by cell: PLAN.md §6.7). Undoing the step, or redoing it, leaves alone a
 * field that holds something else by then (someone's change since, merged
 * from another device) and undoes the rest, so undo is per person: it never
 * takes back someone else's change. Each write it lets through notes what it
 * left in turn, so a step that patches the same field twice is undone twice.
 */
export class Footprint {
  /** By row and path. */
  private readonly left = new Map<string, unknown>()
  /** A face of terrain's cells, by row, then cell: the cell's bytes as one number. */
  private readonly cells = new Map<string, Map<number, number>>()

  /** Whether `row` (named `key`) still holds at `path` what this step left there; at a path it didn't write, it does. */
  holds(key: string, row: unknown, path: string): boolean {
    const at = JSON.stringify([key, path])
    if (!this.left.has(at)) return true
    const [now, left] = [valueAt(row, path), this.left.get(at)]
    // Deleted or not is what counts, not when: a row deleted again (by a step undone since) still holds this step's delete.
    return path === '/deletedAt' ? (now === null) === (left === null) : sameValue(now, left)
  }

  /** Notes what a write left at each path it set in a row. */
  wrote(key: string, row: unknown, paths: Iterable<string>): void {
    for (const path of paths) this.left.set(JSON.stringify([key, path]), valueAt(row, path))
  }

  /** Whether a face of terrain (`key`) still holds in cell `cell` (its bytes as one number) what this step left there; one it didn't write, it does. */
  holdsCell(key: string, cell: number, value: number): boolean {
    const left = this.cells.get(key)?.get(cell)
    return left === undefined || left === value
  }

  /** Notes what a write left in cells of a face of terrain. */
  wroteCells(key: string, cells: Iterable<readonly [cell: number, value: number]>): void {
    let left = this.cells.get(key)
    if (!left) this.cells.set(key, (left = new Map()))
    for (const [cell, value] of cells) left.set(cell, value)
  }

  /** Steps made one: what the latest of them left at each path and cell. */
  static of(steps: readonly Footprint[]): Footprint {
    const joined = new Footprint()
    for (const step of steps) {
      for (const [at, value] of step.left) joined.left.set(at, value)
      for (const [key, cells] of step.cells) joined.wroteCells(key, cells)
    }
    return joined
  }
}
