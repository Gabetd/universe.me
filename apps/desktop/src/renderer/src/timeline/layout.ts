import { eventSpan, groupSpan, type EventGroup, type Lane, type TimelineEvent } from '@universe/core'
import { TimeScale, type TimeRange } from './scale'

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

/**
 * A layout at one zoom level, with x in px from the time `origin`. Panning
 * doesn't change which row anything is on, so it's reused while the zoom
 * stays and only moved sideways ({@link placeTimeline}).
 */
export interface PackedTimeline extends TimelineLayout {
  origin: number
  secondsPerPx: number
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

/** Items by a key, in one pass. */
function bucket<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

/**
 * Lays the timeline out at a zoom level: a row band for groups on top, then
 * one band per lane (the default lane first), each with as many rows as its
 * events need. x is in px from the time `origin`.
 */
export function packTimeline(events: TimelineEvent[], groups: EventGroup[], lanes: Lane[], secondsPerPx: number, origin: number): PackedTimeline {
  const x = (t: number) => (t - origin) / secondsPerPx
  const anchors = new Map<string, PlacedItem<unknown>>()
  const members = bucket(events, (e) => e.groupId)
  const spanned = groups.flatMap((g) => {
    const span = groupSpan(g, members.get(g.id) ?? [])
    return span ? [{ g, span }] : []
  })
  const placedGroups = pack(
    spanned.map(({ g, span }) => {
      const x0 = x(span[0])
      const x1 = Math.max(x(span[1]), x0 + 4)
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

  const byLane = bucket(visible, (e) => e.laneId)
  const ordered: (Lane | null)[] = [null, ...[...lanes].sort((a, b) => a.order - b.order)]
  let y = groupsHeight
  const laneLayouts = ordered.map((lane) => {
    const rows = pack(
      (byLane.get(lane?.id ?? null) ?? []).map((e) => {
        const [start, end] = eventSpan(e)
        const x0 = x(start)
        const x1 = e.end === null ? x0 : Math.max(x(end), x0 + 4)
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
  return { groups: placedGroups, groupsHeight, lanes: laneLayouts, height: y, anchors, origin, secondsPerPx }
}

/** A packed layout moved to a view at its zoom level that starts at time `t0`: only x changes. */
export function placeTimeline(packed: PackedTimeline, t0: number): TimelineLayout {
  const dx = (packed.origin - t0) / packed.secondsPerPx
  if (dx === 0) return packed
  const moved = new Map<PlacedItem<unknown>, PlacedItem<unknown>>()
  const move = <T>(p: PlacedItem<T>): PlacedItem<T> => {
    const next = { ...p, x0: p.x0 + dx, x1: p.x1 + dx }
    moved.set(p, next)
    return next
  }
  const groups = packed.groups.map(move)
  const lanes = packed.lanes.map((l) => ({ ...l, events: l.events.map(move) }))
  const anchors = new Map([...packed.anchors].map(([id, p]) => [id, moved.get(p)!]))
  return { groups, groupsHeight: packed.groupsHeight, lanes, height: packed.height, anchors }
}

/**
 * What to pack a view `width` px wide at: its zoom level (rounded, so
 * panning keeps it) and an origin that stays put until the view has been
 * panned a long way, so x keeps its precision near what's shown.
 */
export function packingFor(range: TimeRange, width: number): { secondsPerPx: number; origin: number } {
  const secondsPerPx = Number(new TimeScale(range, width).secondsPerPx.toPrecision(12))
  const step = secondsPerPx * 2 ** 20
  return { secondsPerPx, origin: Math.floor(range.t0 / step) * step }
}

/** Lays the timeline out for a view (see {@link packTimeline}). */
export function layoutTimeline(events: TimelineEvent[], groups: EventGroup[], lanes: Lane[], scale: TimeScale): TimelineLayout {
  return packTimeline(events, groups, lanes, scale.secondsPerPx, scale.range.t0)
}

/**
 * Whether any of a bar shows in a track `width` px wide. Its label can run
 * past the estimated width (icons, wide letters), so there's room for that.
 */
export function onScreen(p: PlacedItem<{ title: string }>, width: number): boolean {
  return p.x0 <= width + 20 && Math.max(p.x1, p.x0 + 2 * labelWidth(p.item.title) + 120) >= 0
}

/** The lane under a y position in the lanes area (the default lane above the first one). */
export function laneAt(layout: TimelineLayout, y: number): Lane | null {
  return layout.lanes.find((l) => y >= l.y && y < l.y + l.height)?.lane ?? (y >= layout.height ? (layout.lanes.at(-1)?.lane ?? null) : null)
}
