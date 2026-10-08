import { DEFAULT_CALENDAR, secondsPerYear, type EventGroup, type Lane, type TimelineEvent } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { ROW_H, laneAt, layoutTimeline, onScreen, packTimeline, packingFor, placeTimeline, type TimelineLayout } from './layout'
import { TimeScale, fitRange, panRange, snap, zoomRange } from './scale'

const YEAR = secondsPerYear(DEFAULT_CALENDAR)
const meta = { ownerId: 'w', createdAt: '', updatedAt: '', deletedAt: null }
const ev = (id: string, startYear: number, endYear: number | null, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  ...meta, id, title: id, start: startYear * YEAR, end: endYear === null ? null : endYear * YEAR, precision: 'year',
  laneId: null, groupId: null, color: '#ffffff', notes: '', tags: [], locations: [], ...extra
})
const scale = new TimeScale({ t0: 0, t1: 100 * YEAR }, 1000)

describe('TimeScale', () => {
  it('maps time to pixels and back', () => {
    expect(scale.x(50 * YEAR)).toBe(500)
    expect(scale.t(250)).toBe(25 * YEAR)
  })

  it('zooms around a point and snaps to round units', () => {
    expect(zoomRange({ t0: 0, t1: 100 * YEAR }, 25 * YEAR, 0.5)).toEqual({ t0: 12.5 * YEAR, t1: 62.5 * YEAR })
    expect(snap(1234.4 * YEAR, YEAR / 2)).toBe(1234 * YEAR)
    expect(fitRange(0, 0).t1 - fitRange(0, 0).t0).toBeCloseTo(120 * YEAR)
  })
})

describe('layoutTimeline', () => {
  it('stacks overlapping events and leaves separate ones on one row', () => {
    const layout = layoutTimeline([ev('a', 10, 30), ev('b', 20, 40), ev('c', 60, 70)], [], [], scale)
    const rows = Object.fromEntries(layout.lanes[0]!.events.map((p) => [p.item.id, p.y / ROW_H]))
    expect(rows).toEqual({ a: 0, b: 1, c: 0 })
    expect(layout.lanes[0]!.height).toBe(2 * ROW_H)
  })

  it('orders lanes and puts collapsed groups’ events behind their group bar', () => {
    const lanes: Lane[] = [
      { ...meta, id: 'l2', name: 'Second', order: 2 },
      { ...meta, id: 'l1', name: 'First', order: 1 }
    ]
    const group: EventGroup = { ...meta, id: 'g', title: 'War', color: '#ffffff', notes: '', collapsed: true }
    const events = [ev('a', 10, 20, { groupId: 'g', laneId: 'l2' }), ev('b', 30, null, { groupId: 'g' })]
    const layout = layoutTimeline(events, [group], lanes, scale)
    expect(layout.lanes.map((l) => l.lane?.name ?? 'default')).toEqual(['default', 'First', 'Second'])
    expect(layout.groups[0]).toMatchObject({ x0: 100, x1: 300, y: 0 })
    expect(layout.lanes.every((l) => l.events.length === 0)).toBe(true)
    expect(layout.anchors.get('a')).toBe(layout.groups[0])
    expect(laneAt(layout, ROW_H + 1)).toBeNull()
    expect(laneAt(layout, 2 * ROW_H + 1)?.id).toBe('l1')
  })

  it('spans a group over its events in every lane and leaves out events in a lane that’s gone', () => {
    const lanes: Lane[] = [{ ...meta, id: 'l1', name: 'First', order: 1 }]
    const group: EventGroup = { ...meta, id: 'g', title: 'War', color: '#ffffff', notes: '', collapsed: false }
    const events = [ev('a', 10, 20, { groupId: 'g' }), ev('b', 50, 70, { groupId: 'g', laneId: 'l1' }), ev('c', 30, null, { laneId: 'gone' })]
    const layout = layoutTimeline(events, [group], lanes, scale)
    expect(layout.groups[0]).toMatchObject({ x0: 100, x1: 700, y: 0 })
    expect(layout.lanes.map((l) => l.events.map((p) => p.item.id))).toEqual([['a'], ['b']])
    expect(layout.anchors.has('c')).toBe(false)
  })

  it('reuses a packing while panning: rows stay, x moves with the view', () => {
    const events = [ev('a', 10, 30), ev('b', 20, 40), ev('c', 60, null)]
    const group: EventGroup = { ...meta, id: 'g', title: 'War', color: '#ffffff', notes: '', collapsed: true }
    const grouped = [...events, ev('d', 80, 90, { groupId: 'g' })]
    const panned = new TimeScale(panRange(scale.range, 7.3 * YEAR), 1000)
    expect(packingFor(panned)).toEqual(packingFor(scale))
    const { secondsPerPx, origin } = packingFor(scale)
    const reused = placeTimeline(packTimeline(grouped, [group], [], secondsPerPx, origin), panned)
    const fresh = layoutTimeline(grouped, [group], [], panned)
    const xs = (l: TimelineLayout) => [...l.groups, ...l.lanes.flatMap((lane) => lane.events)].map((p) => [p.y, Math.round(p.x0 * 1e6) / 1e6, Math.round(p.x1 * 1e6) / 1e6])
    expect(xs(reused)).toEqual(xs(fresh))
    expect(reused.lanes[0]!.events[0]!.x0).toBeCloseTo(100 - 73)
    expect(reused.anchors.get('d')).toBe(reused.groups[0])
    expect(reused.anchors.get('a')).toBe(reused.lanes[0]!.events.find((p) => p.item.id === 'a'))
    // Zooming packs again.
    expect(packingFor(new TimeScale(zoomRange(scale.range, 0, 0.5), 1000)).secondsPerPx).not.toBe(secondsPerPx)
  })

  it('tells which bars show in the track, labels included', () => {
    const at = (x0: number, x1: number, title = 'Founding') => ({ item: { title }, x0, x1, y: 0 })
    expect(onScreen(at(500, 600), 1000)).toBe(true)
    expect(onScreen(at(-100, -50, 'Founding of the Northern Kingdom'), 1000)).toBe(true) // its label runs on into view
    expect(onScreen(at(-400, -50), 1000)).toBe(false)
    expect(onScreen(at(-2000, -1500), 1000)).toBe(false)
    expect(onScreen(at(1100, 1200), 1000)).toBe(false)
    expect(onScreen(at(-900, 1900), 1000)).toBe(true)
  })
})
