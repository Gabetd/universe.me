import { eventSpan, type TimelineEvent } from '@universe/core'

/** How far back the oldest nodes sit: a node never shrinks below 1 − MAX_RECEDE of its size, so it stays clickable. */
const MAX_RECEDE = 0.55

export interface NodeDepth {
  /** 0 at the front, rising toward 1 the longer ago the event ended. */
  depth: number
  /** Size relative to a node at the front. */
  scale: number
  when: 'past' | 'now' | 'future'
}

/**
 * How far into the canvas an event's node sits as of the playhead. Events
 * still to come and those happening now are at the front; finished ones recede
 * the longer ago they ended. `horizon` is the time it takes to get most of the
 * way back (the timeline's visible span), so zooming the timeline changes how
 * fast the past falls away.
 */
export function nodeDepth(event: TimelineEvent, playhead: number, horizon: number): NodeDepth {
  const [start, end] = eventSpan(event)
  if (playhead < start) return { depth: 0, scale: 1, when: 'future' }
  if (playhead <= end) return { depth: 0, scale: 1, when: 'now' }
  const depth = 1 - Math.exp(-(playhead - end) / Math.max(horizon, 1))
  return { depth, scale: 1 - MAX_RECEDE * depth, when: 'past' }
}

/** A point on the canvas plane pushed back by `scale`, toward the vanishing point `(vx, vy)`. */
export const project = (x: number, y: number, vx: number, vy: number, scale: number): [number, number] => [vx + (x - vx) * scale, vy + (y - vy) * scale]

/** Where the line from `from` to the box centred on `to` (half sizes hw × hh) meets the box's edge. */
export function boxEdge(from: [number, number], to: [number, number], hw: number, hh: number): [number, number] {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity, 1)
  return [to[0] - dx * t, to[1] - dy * t]
}
