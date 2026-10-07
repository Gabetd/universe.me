import { eventSpan, groupSpan, type EventGroup, type Lane, type TimelineEvent } from '@universe/core'
import type { TimeScale } from './scale'

export const ROW_H = 26
/** Rough width of a title in the timeline's 12px font, for packing labels without overlap. */
const labelWidth = (title: string) => 18 + title.length * 6.6

export interface PlacedItem<T> {
  item: T
  x0: number
  x1: number
  /** Top of the item's row, from the top of the lanes area. */
  y: number
}

export interface LaneLayout {
  /** Null for the default lane (events without one). */
  lane: Lane | null
  y: number
  height: number
  events: PlacedItem<TimelineEvent>[]
}

export interface TimelineLayout {
  groups: PlacedItem<EventGroup>[]
  groupsHeight: number
  lanes: LaneLayout[]
  height: number
  /** Where each visible event — or, if it's in a collapsed group, its group bar — is drawn. */
  anchors: Map<string, PlacedItem<unknown>>
}

/** Puts each item in the first row where it doesn't overlap the items already there. */
function pack<T>(items: { item: T; x0: number; x1: number; extent: number }[]): { item: T; x0: number; x1: number; row: number }[] {
  const rowEnds: number[] = []
  return [...items]
    .sort((a, b) => a.x0 - b.x0)
    .map((it) => {
      let row = rowEnds.findIndex((end) => end <= it.x0)
      if (row === -1) row = rowEnds.push(0) - 1
      rowEnds[row] = it.extent + 6
      return { ...it, row }
    })
}

/**
 * Lays the timeline out: a row band for groups on top, then one band per
 * lane (the default lane first), each with as many rows as its events need.
 */
export function layoutTimeline(events: TimelineEvent[], groups: EventGroup[], lanes: Lane[], scale: TimeScale): TimelineLayout {
  const anchors = new Map<string, PlacedItem<unknown>>()
  const spanned = groups.flatMap((g) => {
    const span = groupSpan(g, events)
    return span ? [{ g, span }] : []
  })
  const placedGroups = pack(
    spanned.map(({ g, span }) => {
      const x0 = scale.x(span[0])
      const x1 = Math.max(scale.x(span[1]), x0 + 4)
      return { item: g, x0, x1, extent: Math.max(x1, x0 + labelWidth(g.title) + 16) }
    })
  ).map((p) => ({ item: p.item, x0: p.x0, x1: p.x1, y: p.row * ROW_H }))
  const groupRows = Math.max(0, ...placedGroups.map((p) => p.y / ROW_H + 1))
  const groupsHeight = groupRows * ROW_H

  const collapsed = new Map(placedGroups.filter((p) => p.item.collapsed).map((p) => [p.item.id, p]))
  const visible = events.filter((e) => !(e.groupId && collapsed.has(e.groupId)))
  for (const e of events) {
    const group = e.groupId ? collapsed.get(e.groupId) : undefined
    if (group) anchors.set(e.id, group)
  }

  const ordered: (Lane | null)[] = [null, ...[...lanes].sort((a, b) => a.order - b.order)]
  let y = groupsHeight
  const laneLayouts = ordered.map((lane) => {
    const own = visible.filter((e) => e.laneId === (lane?.id ?? null))
    const rows = pack(
      own.map((e) => {
        const [start, end] = eventSpan(e)
        const x0 = scale.x(start)
        const x1 = e.end === null ? x0 : Math.max(scale.x(end), x0 + 4)
        return { item: e, x0, x1, extent: Math.max(x1, x0 + labelWidth(e.title)) }
      })
    )
    const height = Math.max(1, ...rows.map((r) => r.row + 1)) * ROW_H
    const placed = rows.map((r) => ({ item: r.item, x0: r.x0, x1: r.x1, y: y + r.row * ROW_H }))
    placed.forEach((p) => anchors.set(p.item.id, p))
    const layout = { lane, y, height, events: placed }
    y += height
    return layout
  })
  return { groups: placedGroups, groupsHeight, lanes: laneLayouts, height: y, anchors }
}

/** The lane under a y position in the lanes area (the default lane above the first one). */
export function laneAt(layout: TimelineLayout, y: number): Lane | null {
  return layout.lanes.find((l) => y >= l.y && y < l.y + l.height)?.lane ?? (y >= layout.height ? (layout.lanes.at(-1)?.lane ?? null) : null)
}
