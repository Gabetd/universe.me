import { waterwayKind, waterwayName, type Region, type Waterway } from '@universe/core'
import type { Lake, River } from '@universe/procgen'
import { regionsHere, round } from './describe'
import { notFound, type WorldWater } from './host'
import type { ProjectModels } from './model'
import { htmlToText } from './text'

/**
 * A world's rivers and lakes (PLAN.md §9, M15) as the API tells of them:
 * worked out from its terrain as the app does (so with the same ids and
 * names), with what the user has given each (a name of its own, notes).
 */
export interface Waterways {
  water: WorldWater
  byKey: Map<string, River | Lake>
  /** What's been given each, by id. */
  own: Map<string, Waterway>
  /** The rivers running into each river or lake, biggest first. */
  feeders: Map<string, River[]>
}

/** What's worked out for a world's water and records, kept while neither changes. */
const worked = new WeakMap<WorldWater, { records: readonly Waterway[]; waterways: Waterways }>()

/** A world's rivers and lakes with what's been given them. */
export async function waterwaysOf(m: ProjectModels, worldId: string): Promise<Waterways> {
  const records = m.world(worldId).timeline.waterways
  const water = await m.water(worldId)
  const cached = worked.get(water)
  if (cached?.records === records) return cached.waterways
  const byKey = new Map<string, River | Lake>([...water.rivers, ...water.lakes].map((w) => [w.id, w]))
  const feeders = new Map<string, River[]>()
  for (const r of water.rivers) if (r.into.kind !== 'sea') feeders.set(r.into.id, [...(feeders.get(r.into.id) ?? []), r])
  const waterways = { water, byKey, own: new Map(records.map((w) => [w.key, w])), feeders }
  worked.set(water, { records, waterways })
  return waterways
}

/** A river or lake by its id, or a 404. */
export function waterwayOf(w: Waterways, key: string): River | Lake {
  const found = w.byKey.get(key)
  if (!found) throw notFound('river or lake on that world', key)
  return found
}

export const isRiver = (found: River | Lake): found is River => 'points' in found

/** What a river or lake is called. */
export const nameOf = (w: Waterways, key: string) => {
  const found = w.byKey.get(key)
  return found ? waterwayName(found.name, w.own.get(key)) : '(gone)'
}

/** Where a river or lake is: a river's middle, a lake's deepest point. */
const placeOf = (found: River | Lake) => (isRiver(found) ? found.points[Math.floor(found.points.length / 2)]! : found.center)

const place = (p: { lat: number; lon: number }) => ({ lat: round(p.lat, 3), lon: round(p.lon, 3) })

/** A river or lake in words and numbers; `full` adds a river's course and everything that feeds it. */
export function describeWaterway(w: Waterways, found: River | Lake, regions: Region[], full = false) {
  const own = w.own.get(found.id)
  const where = regionsHere(placeOf(found), regions).map((r) => r.name)
  const feeders = w.feeders.get(found.id) ?? []
  const notes = own?.notes ? htmlToText(own.notes) : ''
  return {
    id: found.id,
    kind: waterwayKind(found.id),
    name: waterwayName(found.name, own),
    ...(own?.name && { madeAs: found.name }),
    ...(isRiver(found)
      ? { lengthKm: found.lengthKm, runsInto: found.into.kind === 'sea' ? 'the sea' : nameOf(w, found.into.id), source: place(found.points[0]!), mouth: place(found.points.at(-1)!) }
      : { areaKm2: found.areaKm2, surfaceM: Math.round(found.level), center: place(found.center) }),
    ...(where.length && { region: where.join(', ') }),
    ...(feeders.length && { fedBy: full ? feeders.map((r) => ({ id: r.id, name: nameOf(w, r.id) })) : feeders.length }),
    ...(full && isRiver(found) && found.into.kind !== 'sea' && { runsIntoId: found.into.id }),
    ...(full && isRiver(found) && { course: found.points.map(place) }),
    ...(notes && { notes })
  }
}
