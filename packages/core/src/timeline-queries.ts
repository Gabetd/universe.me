import type { SpatialNode } from './schema'
import type { Time } from './time'
import type { TimelineData } from './records'
import { ORDERED_LINKS, type EntityChange, type EventGroup, type EventLink, type TimelineEvent } from './timeline'
import { byId, memoize } from './util'
import type { LatLon, Region } from './world'

/**
 * The node whose timeline goes with a selection: a world's own, the world of
 * a body that has one (a planet and its surface share a history), otherwise
 * the node's own.
 */
export function timelineOwner(nodes: SpatialNode[], selectedId: string | null): SpatialNode | undefined {
  const node = nodes.find((n) => n.id === selectedId)
  if (!node || node.kind === 'world') return node
  return nodes.find((n) => n.parentId === node.id && n.kind === 'world') ?? node
}

/** One owner's slice of the project's timeline records. */
export function timelineOf(data: TimelineData, ownerId: string): TimelineData {
  const own = Object.fromEntries(Object.entries(data).map(([key, list]) => [key, (list as { ownerId: string }[]).filter((r) => r.ownerId === ownerId)]))
  return own as TimelineData
}

/** Start and end of an event; an instant ends where it starts. */
export const eventSpan = (e: TimelineEvent): [Time, Time] => [e.start, e.end ?? e.start]

/** Every group's span (see `groupSpan`), from one pass over the events, once per array. Empty groups are missing. */
export const groupSpans = memoize((events: TimelineEvent[]): ReadonlyMap<string, readonly [Time, Time]> => {
  const spans = new Map<string, [Time, Time]>()
  for (const e of events) {
    if (!e.groupId) continue
    const [start, end] = eventSpan(e)
    const span = spans.get(e.groupId)
    if (!span) spans.set(e.groupId, [start, end])
    else spans.set(e.groupId, [Math.min(span[0], start), Math.max(span[1], end)])
  }
  return spans
})

/** A group spans all of its events. Undefined for an empty group. */
export function groupSpan(group: EventGroup, events: TimelineEvent[]): [Time, Time] | undefined {
  const span = groupSpans(events).get(group.id)
  return span && [span[0], span[1]]
}

/** Whether an event is happening at `t`. Instants count within `slack` seconds of their moment. */
export function isActiveAt(e: TimelineEvent, t: Time, slack = 0): boolean {
  const [start, end] = eventSpan(e)
  return t >= start - slack && t <= end + slack
}

/** Each entity's changes in time order, sorted once per array of changes. */
export const indexChanges = memoize((changes: EntityChange[]): ReadonlyMap<string, readonly EntityChange[]> => {
  const byEntity = new Map<string, EntityChange[]>()
  for (const c of changes) {
    const list = byEntity.get(c.entityId)
    if (list) list.push(c)
    else byEntity.set(c.entityId, [c])
  }
  for (const list of byEntity.values()) list.sort((a, b) => a.at - b.at)
  return byEntity
})

/** A region as of time `t`, or undefined if it doesn't exist then. */
export function regionAt(region: Region, changes: EntityChange[], t: Time): Region | undefined {
  const own = indexChanges(changes).get(region.id) ?? []
  // A region with a founding date doesn't exist before it; otherwise it always has.
  let exists = !own.some((c) => c.change === 'appear')
  let state = region
  for (const c of own) {
    if (c.at > t) break
    if (c.change === 'appear') exists = true
    else if (c.change === 'vanish') exists = false
    else state = { ...state, ...c.patch }
  }
  return exists ? state : undefined
}

export function regionsAt(regions: Region[], changes: EntityChange[], t: Time): Region[] {
  return regions.flatMap((r) => regionAt(r, changes, t) ?? [])
}

/**
 * Every event reachable from `eventId` along links, upstream (its causes) or
 * downstream (its effects). Contains `eventId` itself only if it's in a loop.
 */
export function causalChain(links: EventLink[], eventId: string, direction: 'up' | 'down'): Set<string> {
  return reach(linkGraph(links, direction), eventId)
}

/** Each event's neighbours along links, downstream (its effects) or upstream (its causes), in link order. */
function linkGraph(links: EventLink[], direction: 'up' | 'down'): Map<string, string[]> {
  const next = new Map<string, string[]>()
  for (const l of links) {
    const [a, b] = direction === 'down' ? [l.fromId, l.toId] : [l.toId, l.fromId]
    const list = next.get(a)
    if (list) list.push(b)
    else next.set(a, [b])
  }
  return next
}

/** What a walk from `start` finds, in the order it finds them, going only to nodes that pass `within`. */
function reach(next: Map<string, string[]>, start: string, within: (id: string) => boolean = () => true): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length) {
    for (const id of next.get(stack.pop()!) ?? []) {
      if (seen.has(id) || !within(id)) continue
      seen.add(id)
      if (id !== start) stack.push(id)
    }
  }
  return seen
}

/**
 * The strongly connected components of a graph (Tarjan's algorithm, with an
 * explicit stack so long chains can't overflow the call stack): each node's
 * component number, and which components are loops (more than one node, or
 * a node leading to itself).
 */
function components(next: Map<string, string[]>): { component: Map<string, number>; loops: Set<number> } {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const component = new Map<string, number>()
  const loops = new Set<number>()
  // Nodes visited but not yet in a component, and the walk's path: each node with the next link to follow.
  const open: string[] = []
  const work: [string, number][] = []
  const visit = (id: string) => {
    index.set(id, index.size)
    low.set(id, index.get(id)!)
    open.push(id)
    work.push([id, 0])
  }
  let count = 0
  for (const root of next.keys()) {
    if (index.has(root)) continue
    visit(root)
    while (work.length) {
      const top = work[work.length - 1]!
      const [v, i] = top
      const out = next.get(v) ?? []
      if (i < out.length) {
        top[1]++
        const w = out[i]!
        if (!index.has(w)) visit(w)
        else if (!component.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent[0], Math.min(low.get(parent[0])!, low.get(v)!))
      if (low.get(v) !== index.get(v)) continue
      let size = 0
      let w: string
      do {
        w = open.pop()!
        component.set(w, count)
        size++
      } while (w !== v)
      if (size > 1 || out.includes(v)) loops.add(count)
      count++
    }
  }
  return { component, loops }
}

/**
 * Causal loops: for each, the first of `events` in it, then the rest of it
 * in the order a walk downstream from that event finds them. Only links
 * inside a loop lead back into it, so walking those alone keeps that order.
 */
function causalLoops(events: TimelineEvent[], next: Map<string, string[]>): [TimelineEvent, string[]][] {
  const { component, loops } = components(next)
  const reported = new Set<number>()
  const out: [TimelineEvent, string[]][] = []
  for (const e of events) {
    const c = component.get(e.id)
    if (c === undefined || !loops.has(c) || reported.has(c)) continue
    reported.add(c)
    out.push([e, [...reach(next, e.id, (id) => component.get(id) === c)].filter((id) => id !== e.id)])
  }
  return out
}

export interface Warning {
  message: string
  /** Records the warning is about, so the UI can select them. */
  refs: { kind: 'event' | 'link' | 'change' | 'region' | 'structure' | 'effect'; id: string }[]
}

/**
 * Things that are allowed but probably mistakes (PLAN.md §4.4): effects that
 * start before their cause, causal loops, and changes that don't line up with
 * the event said to cause them.
 */
export function timelineWarnings(data: Pick<TimelineData, 'events' | 'links' | 'changes'>, regions: Region[]): Warning[] {
  const events = new Map(data.events.map((e) => [e.id, e]))
  const warnings: Warning[] = []

  for (const link of data.links) {
    const from = events.get(link.fromId)
    const to = events.get(link.toId)
    if (!from || !to || !ORDERED_LINKS.includes(link.type)) continue
    if (to.start < from.start) {
      warnings.push({
        message: `“${to.title}” starts before “${from.title}”, which ${link.type} it`,
        refs: [{ kind: 'link', id: link.id }, { kind: 'event', id: to.id }]
      })
    }
  }

  const ordered = data.links.filter((l) => ORDERED_LINKS.includes(l.type))
  for (const [e, loop] of causalLoops(data.events, linkGraph(ordered, 'down'))) {
    warnings.push({
      message: `Causal loop: ${[e, ...loop.map((id) => events.get(id)!)].map((x) => `“${x.title}”`).join(' → ')} lead back to each other`,
      refs: [e.id, ...loop].map((id) => ({ kind: 'event' as const, id }))
    })
  }

  const regionById = byId(regions)
  for (const c of data.changes) {
    const cause = c.causeEventId ? events.get(c.causeEventId) : undefined
    if (!cause) continue
    const [start, end] = eventSpan(cause)
    if (c.at < start || c.at > end) {
      const what = { appear: 'appears', vanish: 'disappears', update: 'changes' }[c.change]
      warnings.push({
        message: `${regionById.get(c.entityId)?.name ?? 'A region'} ${what} outside the time of “${cause.title}”, its cause`,
        refs: [{ kind: 'change', id: c.id }, { kind: 'event', id: cause.id }]
      })
    }
  }

  for (const e of data.events) {
    for (const loc of e.locations) {
      if (loc.kind !== 'region') continue
      const region = regionById.get(loc.regionId)
      if (region && !regionAt(region, data.changes, e.start)) {
        warnings.push({ message: `“${e.title}” happens in ${region.name}, which doesn't exist at that time`, refs: [{ kind: 'event', id: e.id }, { kind: 'region', id: region.id }] })
      }
    }
  }
  return warnings
}

/**
 * Where an event happened, as one point: its first point location, or the
 * middle of its first region (averaged on the sphere, so it works across the
 * date line). Undefined if it has no location.
 */
export function eventPlace(event: TimelineEvent, regions: Region[]): LatLon | undefined {
  for (const loc of event.locations) {
    if (loc.kind === 'point') return { lat: loc.lat, lon: loc.lon }
    const points = regions.find((r) => r.id === loc.regionId)?.points
    if (points?.length) return sphericalMean(points)
  }
  return undefined
}

function sphericalMean(points: LatLon[]): LatLon {
  let x = 0
  let y = 0
  let z = 0
  for (const p of points) {
    const lat = (p.lat * Math.PI) / 180
    const lon = (p.lon * Math.PI) / 180
    x += Math.cos(lat) * Math.cos(lon)
    y += Math.cos(lat) * Math.sin(lon)
    z += Math.sin(lat)
  }
  return { lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI }
}
