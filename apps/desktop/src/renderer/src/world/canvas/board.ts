import type { Side } from '@universe/core'

/**
 * The world canvas's geometry, apart from React: boxes on the canvas plane,
 * where connections leave and reach them and the curves between, snapping to
 * the grid and to other boxes, aligning, and the boxes inside a group.
 */

export type Point = { x: number; y: number }
export interface Box extends Point {
  w: number
  h: number
}

/** The grid the board shows and snaps to, in px at 100%. */
export const GRID = 20
/** How near (on screen) an edge comes to another's before it snaps to it. */
export const SNAP_PX = 6

/** A box's bounds: the smallest box round them all. */
export function bounds(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.w))
  const y1 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export const inside = (inner: Box, outer: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
/** The box between two corners, either way round. */
export const boxBetween = (a: Point, b: Point): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })

/** The middle of a box's side, and which way out of the box it faces. */
export function sidePoint(b: Box, side: Side): { at: Point; out: Point } {
  switch (side) {
    case 'top':
      return { at: { x: b.x + b.w / 2, y: b.y }, out: { x: 0, y: -1 } }
    case 'right':
      return { at: { x: b.x + b.w, y: b.y + b.h / 2 }, out: { x: 1, y: 0 } }
    case 'bottom':
      return { at: { x: b.x + b.w / 2, y: b.y + b.h }, out: { x: 0, y: 1 } }
    case 'left':
      return { at: { x: b.x, y: b.y + b.h / 2 }, out: { x: -1, y: 0 } }
  }
}

/** The side of `from` that faces `to` most. */
export function facingSide(from: Box, to: Point): Side {
  const dx = (to.x - (from.x + from.w / 2)) / Math.max(1, from.w)
  const dy = (to.y - (from.y + from.h / 2)) / Math.max(1, from.h)
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top'
}

/** The side of a box nearest a point (which side a connection dropped there reaches). */
export function nearestSide(b: Box, p: Point): Side {
  const d: [Side, number][] = [
    ['top', Math.abs(p.y - b.y)],
    ['bottom', Math.abs(p.y - (b.y + b.h))],
    ['left', Math.abs(p.x - b.x)],
    ['right', Math.abs(p.x - (b.x + b.w))]
  ]
  return d.reduce((best, s) => (s[1] < best[1] ? s : best))[0]
}

export interface Curve {
  from: Point
  to: Point
  /** The two control points of a cubic Bézier. */
  c1: Point
  c2: Point
}

/**
 * A connection's curve, as Obsidian draws it: out of each box from the
 * middle of a side (the one given, or the one facing the other box), bending
 * away from it as far as the boxes are apart (within limits).
 */
export function connectionCurve(a: Box, b: Box, fromSide: Side | null, toSide: Side | null): Curve {
  const centre = (x: Box) => ({ x: x.x + x.w / 2, y: x.y + x.h / 2 })
  const start = sidePoint(a, fromSide ?? facingSide(a, centre(b)))
  const end = sidePoint(b, toSide ?? facingSide(b, centre(a)))
  const reach = Math.min(160, Math.max(30, Math.hypot(end.at.x - start.at.x, end.at.y - start.at.y) / 2.5))
  return {
    from: start.at,
    to: end.at,
    c1: { x: start.at.x + start.out.x * reach, y: start.at.y + start.out.y * reach },
    c2: { x: end.at.x + end.out.x * reach, y: end.at.y + end.out.y * reach }
  }
}

/** The curve as an SVG path. */
export const curvePath = ({ from, c1, c2, to }: Curve) => `M ${from.x} ${from.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`

/** A point along the curve, `t` from 0 (its start) to 1 (its end). */
export function curveAt({ from, c1, c2, to }: Curve, t: number): Point {
  const u = 1 - t
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return { x: a * from.x + b * c1.x + c * c2.x + d * to.x, y: a * from.y + b * c1.y + c * c2.y + d * to.y }
}

/** An arrowhead at the curve's end (`atEnd`) or start, `size` long, as an SVG polygon's points. */
export function arrowHead(curve: Curve, atEnd: boolean, size: number): string {
  const tip = atEnd ? curve.to : curve.from
  // It points along the curve as it arrives: from its nearest control point to its end (or, if they meet, from the other end).
  const back = atEnd ? (same(curve.c2, tip) ? curve.from : curve.c2) : same(curve.c1, tip) ? curve.to : curve.c1
  const len = Math.hypot(tip.x - back.x, tip.y - back.y) || 1
  const [ux, uy] = [(tip.x - back.x) / len, (tip.y - back.y) / len]
  const [bx, by] = [tip.x - ux * size, tip.y - uy * size]
  const [px, py] = [-uy * size * 0.5, ux * size * 0.5]
  return `${tip.x},${tip.y} ${bx + px},${by + py} ${bx - px},${by - py}`
}
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y

/** How far a point is from the curve (sampled), for picking a connection. */
export function distanceToCurve(curve: Curve, p: Point, steps = 24): number {
  let best = Infinity
  for (let i = 0; i <= steps; i++) {
    const q = curveAt(curve, i / steps)
    best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y))
  }
  return best
}

export const snapToGrid = (v: number) => Math.round(v / GRID) * GRID

/** Where a box `size` big centred on `at` can go without covering another: there if it's free, else the nearest free place round it (by steps of `step`). */
export function freeSpot(at: Point, size: { w: number; h: number }, others: readonly Box[], step = 40): Point {
  const free = (p: Point) => !others.some((o) => overlaps({ x: p.x - size.w / 2, y: p.y - size.h / 2, ...size }, o))
  for (let ring = 0; ring < 40; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]] as const) {
        const p = { x: at.x + dx * step, y: at.y + dy * step }
        if (free(p)) return p
      }
    }
  }
  return at
}

/**
 * Where a box being moved to `box` goes with snapping: its left, centre or
 * right onto another box's (and its top, middle or bottom), whichever is
 * within `slack` (canvas units), else onto the grid if asked. The guides are
 * the lines it snapped to, for the board to show.
 */
export function snapBox(box: Box, others: readonly Box[], { grid, objects, slack }: { grid: boolean; objects: boolean; slack: number }): { at: Point; guides: { x: number[]; y: number[] } } {
  const along = (start: number, size: number, edges: number[]) => {
    let best: { shift: number; line: number } | null = null
    for (const mine of [start, start + size / 2, start + size]) {
      for (const line of edges) {
        const shift = line - mine
        if (Math.abs(shift) <= slack && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, line }
      }
    }
    return best
  }
  const xs = objects ? others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w]) : []
  const ys = objects ? others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h]) : []
  const sx = along(box.x, box.w, xs)
  const sy = along(box.y, box.h, ys)
  return {
    at: { x: sx ? box.x + sx.shift : grid ? snapToGrid(box.x) : box.x, y: sy ? box.y + sy.shift : grid ? snapToGrid(box.y) : box.y },
    guides: { x: sx ? [sx.line] : [], y: sy ? [sy.line] : [] }
  }
}

export const ALIGNS = ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const
export type Align = (typeof ALIGNS)[number]

/** Where each box goes to line them up as asked, against the bounds of them all. */
export function align<B extends Box & { id: string }>(boxes: readonly B[], how: Align): Map<string, Point> {
  const all = bounds(boxes)
  const out = new Map<string, Point>()
  if (!all) return out
  for (const b of boxes) {
    const x = how === 'left' ? all.x : how === 'center' ? all.x + (all.w - b.w) / 2 : how === 'right' ? all.x + all.w - b.w : b.x
    const y = how === 'top' ? all.y : how === 'middle' ? all.y + (all.h - b.h) / 2 : how === 'bottom' ? all.y + all.h - b.h : b.y
    out.set(b.id, { x: Math.round(x), y: Math.round(y) })
  }
  return out
}
