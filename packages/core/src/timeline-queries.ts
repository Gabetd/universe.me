import type { SpatialNode } from './schema'
import type { Time } from './time'
import { ORDERED_LINKS, type EntityChange, type EventGroup, type EventLink, type TimelineData, type TimelineEvent } from './timeline'
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

/** A group spans all of its events. Undefined for an empty group. */
export function groupSpan(group: EventGroup, events: TimelineEvent[]): [Time, Time] | undefined {
  const members = events.filter((e) => e.groupId === group.id)
  if (!members.length) return undefined
  return [Math.min(...members.map((e) => e.start)), Math.max(...members.map((e) => eventSpan(e)[1]))]
}

/** Whether an event is happening at `t`. Instants count within `slack` seconds of their moment. */
export function isActiveAt(e: TimelineEvent, t: Time, slack = 0): boolean {
  const [start, end] = eventSpan(e)
  return t >= start - slack && t <= end + slack
}

/** A region as of time `t`, or undefined if it doesn't exist then. */
export function regionAt(region: Region, changes: EntityChange[], t: Time): Region | undefined {
  const own = changes.filter((c) => c.entityId === region.id).sort((a, b) => a.at - b.at)
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
  // Index the links once, so the walk is linear in the number of links.
  const next = new Map<string, string[]>()
  for (const l of links) {
    const [a, b] = direction === 'down' ? [l.fromId, l.toId] : [l.toId, l.fromId]
    next.set(a, [...(next.get(a) ?? []), b])
  }
  const seen = new Set<string>()
  const stack = [eventId]
  while (stack.length) {
    for (const id of next.get(stack.pop()!) ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      if (id !== eventId) stack.push(id)
    }
  }
  return seen
}

export interface Warning {
  message: string
  /** Records the warning is about, so the UI can select them. */
  refs: { kind: 'event' | 'link' | 'change' | 'region'; id: string }[]
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
  const reported = new Set<string>()
  for (const e of data.events) {
    if (reported.has(e.id) || !causalChain(ordered, e.id, 'down').has(e.id)) continue
    const loop = [...causalChain(ordered, e.id, 'down')].filter((id) => id !== e.id && causalChain(ordered, id, 'down').has(e.id))
    loop.forEach((id) => reported.add(id))
    reported.add(e.id)
    warnings.push({
      message: `Causal loop: ${[e, ...loop.map((id) => events.get(id)!)].map((x) => `“${x.title}”`).join(' → ')} lead back to each other`,
      refs: [e.id, ...loop].map((id) => ({ kind: 'event' as const, id }))
    })
  }

  const regionNames = new Map(regions.map((r) => [r.id, r.name]))
  for (const c of data.changes) {
    const cause = c.causeEventId ? events.get(c.causeEventId) : undefined
    if (!cause) continue
    const [start, end] = eventSpan(cause)
    if (c.at < start || c.at > end) {
      const what = { appear: 'appears', vanish: 'disappears', update: 'changes' }[c.change]
      warnings.push({
        message: `${regionNames.get(c.entityId) ?? 'A region'} ${what} outside the time of “${cause.title}”, its cause`,
        refs: [{ kind: 'change', id: c.id }, { kind: 'event', id: cause.id }]
      })
    }
  }

  for (const e of data.events) {
    for (const loc of e.locations) {
      if (loc.kind !== 'region') continue
      const region = regions.find((r) => r.id === loc.regionId)
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
