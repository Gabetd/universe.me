/**
 * Keeps what's drawn in space from overlapping on screen, at any zoom: each
 * thing (a disc where it's drawn) is placed in turn, most important first; one
 * that would overlap what's placed shrinks to fit the room there is, down to
 * `minR`; with less room than that, one that must show (`keep`: your own
 * things, a body on its orbit) is nudged clear of what's in its way, and a
 * generated speck is left out.
 */

export interface Disc {
  x: number
  y: number
  r: number
  /** Higher is placed first, and so keeps its size and place. */
  priority: number
  keep?: boolean
}

export interface Placed {
  x: number
  y: number
  r: number
  hidden: boolean
}

/** Screen pixels a side of the grid that finds what's near. */
const CELL = 32

export function declutter(discs: readonly Disc[], { minR = 2, gap = 2 }: { minR?: number; gap?: number } = {}): Placed[] {
  const out: Placed[] = discs.map((d) => ({ x: d.x, y: d.y, r: d.r, hidden: false }))
  const grid = new Map<string, number[]>()
  const cells = (x: number, y: number, reach: number) => {
    const keys: string[] = []
    for (let cy = Math.floor((y - reach) / CELL); cy <= Math.floor((y + reach) / CELL); cy++)
      for (let cx = Math.floor((x - reach) / CELL); cx <= Math.floor((x + reach) / CELL); cx++) keys.push(`${cx}:${cy}`)
    return keys
  }
  /** The placed disc that leaves least room at (x, y), and how much room it leaves (a radius). */
  const tightest = (x: number, y: number, r: number) => {
    let room = r
    let by = -1
    const seen = new Set<number>()
    for (const key of cells(x, y, r + gap))
      for (const j of grid.get(key) ?? []) {
        if (seen.has(j)) continue
        seen.add(j)
        const p = out[j]!
        const left = Math.hypot(p.x - x, p.y - y) - p.r - gap
        if (left < room) [room, by] = [left, j]
      }
    return { room, by }
  }
  const order = discs.map((_, i) => i).sort((a, b) => discs[b]!.priority - discs[a]!.priority)
  for (const i of order) {
    const d = discs[i]!
    const p = out[i]!
    let { room, by } = tightest(p.x, p.y, p.r)
    // Nudged out of the way, a few times over if it lands against something else.
    for (let tries = 0; room < minR && d.keep && by >= 0 && tries < 8; tries++) {
      const o = out[by]!
      const dx = p.x - o.x
      const dy = p.y - o.y
      const dist = Math.hypot(dx, dy) || 1
      const [ux, uy] = dist > 1e-6 && (dx || dy) ? [dx / dist, dy / dist] : [Math.cos(i * 2.399), Math.sin(i * 2.399)]
      const want = o.r + gap + Math.max(minR, Math.min(p.r, d.r))
      p.x = o.x + ux * want
      p.y = o.y + uy * want
      ;({ room, by } = tightest(p.x, p.y, p.r))
    }
    if (room < minR && !d.keep) {
      p.hidden = true
      continue
    }
    p.r = Math.max(minR, Math.min(p.r, room))
    for (const key of cells(p.x, p.y, p.r)) {
      const list = grid.get(key)
      if (list) list.push(i)
      else grid.set(key, [i])
    }
  }
  return out
}

/** Whether two placed discs overlap (for tests and checks). */
export const overlapping = (a: Placed, b: Placed, gap = 0) => !a.hidden && !b.hidden && Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + gap - 1e-6

/** How many pairs of shown discs overlap: none, after `declutter` (the views tell tests so). */
export function countOverlaps(placed: readonly Placed[]): number {
  const grid = new Map<string, number[]>()
  let count = 0
  placed.forEach((p, i) => {
    if (p.hidden) return
    const seen = new Set<number>()
    for (let cy = Math.floor((p.y - p.r) / CELL); cy <= Math.floor((p.y + p.r) / CELL); cy++)
      for (let cx = Math.floor((p.x - p.r) / CELL); cx <= Math.floor((p.x + p.r) / CELL); cx++) {
        const key = `${cx}:${cy}`
        for (const j of grid.get(key) ?? []) {
          if (seen.has(j)) continue
          seen.add(j)
          if (overlapping(placed[j]!, p)) count++
        }
        const list = grid.get(key)
        if (list) list.push(i)
        else grid.set(key, [i])
      }
  })
  return count
}

/** Keeps labels from covering each other: each box is shown only if it's clear of those shown before it (most important first). */
export function labelRoom(): (x: number, y: number, w: number, h: number) => boolean {
  const shown: [number, number, number, number][] = []
  return (x, y, w, h) => {
    const box: [number, number, number, number] = [x - w / 2, y - h, x + w / 2, y + 2]
    if (shown.some(([a, b, c, e]) => box[0] < c && box[2] > a && box[1] < e && box[3] > b)) return false
    shown.push(box)
    return true
  }
}
