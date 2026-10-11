import { waterwayKind, type Region, type Waterway } from '@universe/core'
import { isRiver, waterwayIndex, waterwayPlace, type Lake, type River, type WaterwayIndex, type WorldWater } from '@universe/procgen'
import { regionsHere, round } from './describe'
import { notFound } from './host'
import type { ProjectModels } from './model'
import { htmlToText } from './text'

/**
 * A world's rivers and lakes (PLAN.md §9, M15) as the API tells of them:
 * worked out from its terrain as the app does (so with the same ids and
 * names), with what the user has given each (a name of its own, notes).
 */
export type Waterways = WaterwayIndex & { water: WorldWater; records: readonly Waterway[] }

/** What's worked out for a world's water and records, kept while neither changes. */
const worked = new WeakMap<WorldWater, Waterways>()

/** A world's rivers and lakes with what's been given them. */
export async function waterwaysOf(m: ProjectModels, worldId: string): Promise<Waterways> {
  const records = m.world(worldId).timeline.waterways
  const water = await m.water(worldId)
  let w = worked.get(water)
  if (w?.records !== records) worked.set(water, (w = { ...waterwayIndex(water, records), water, records }))
  return w
}

/** A river or lake by its id, or a 404. */
export function waterwayOf(w: Waterways, key: string): River | Lake {
  const found = w.byKey.get(key)
  if (!found) throw notFound('river or lake on that world', key)
  return found
}

/** What a river or lake is called, for the API's answers. */
export const nameOf = (w: Waterways, key: string) => w.nameOf(key) ?? '(gone)'

const place = (p: { lat: number; lon: number }) => ({ lat: round(p.lat, 3), lon: round(p.lon, 3) })

/** A river or lake in words and numbers; `full` adds a river's course and everything that feeds it. */
export function describeWaterway(w: Waterways, found: River | Lake, regions: Region[], full = false) {
  const own = w.own.get(found.id)
  const where = regionsHere(waterwayPlace(found), regions).map((r) => r.name)
  const feeders = w.feeders.get(found.id) ?? []
  const notes = own?.notes ? htmlToText(own.notes) : ''
  return {
    id: found.id,
    kind: waterwayKind(found.id),
    name: nameOf(w, found.id),
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
