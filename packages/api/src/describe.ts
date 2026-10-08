import {
  BUILTIN_BLUEPRINTS,
  KIND_LABELS,
  STAGES,
  ageAt,
  characterAt,
  eventSpan,
  findBlueprint,
  insidePolygon,
  isActiveAt,
  regionsAt,
  stateAt,
  themeAt,
  type Character,
  type ConditionCurve,
  type LatLon,
  type Region,
  type SpatialNode,
  type Structure,
  type TimelineEvent
} from '@universe/core'
import { BIOMES } from '@universe/procgen'
import { moonPhase, moonsOf } from '@universe/sim'
import type { ProjectModels, WorldView } from './model'
import { htmlToText } from './text'

/**
 * Records as API clients read them: names rather than ids where it helps,
 * dates in the world's calendar, notes as plain text. Shared by the read
 * operations, the snapshot and the world bible.
 */

/** "Virgo › Milky Way › Sol › Terra": where a node is, from below the universe. */
export function nodePath(nodes: SpatialNode[], id: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const names: string[] = []
  for (let n = byId.get(id); n && n.parentId; n = n.parentId ? byId.get(n.parentId) : undefined) names.unshift(n.name)
  return names.join(' › ')
}

export const kindLabel = (node: SpatialNode) => KIND_LABELS[node.kind]

export const biomeName = (id: number) => BIOMES.find((b) => b.id === id)?.name ?? `Biome ${id}`

/** Biome ids from names a client wrote (or ids), case-insensitively. */
export function biomeIds(names: (string | number)[]): number[] {
  return names.map((n) => {
    if (typeof n === 'number') return n
    const b = BIOMES.find((x) => x.id > 0 && x.name.toLowerCase() === n.toLowerCase().trim())
    if (!b) throw new Error(`There is no biome “${n}”. Biomes: ${BIOMES.filter((x) => x.id > 0).map((x) => x.name).join(', ')}`)
    return b.id
  })
}

/** An event's dates at its precision: "1204", or "1204 – 1210". */
export function eventDates(m: ProjectModels, e: TimelineEvent): string {
  const [start, end] = eventSpan(e)
  const from = m.date(e.ownerId, start, e.precision)
  return end === start ? from : `${from} – ${m.date(e.ownerId, end, e.precision)}`
}

/** Where an event happens, in words: its regions' names, or coordinates. */
export function eventPlaces(e: TimelineEvent, regions: Region[]): string[] {
  return e.locations.map((loc) => (loc.kind === 'point' ? `${loc.lat.toFixed(2)}°, ${loc.lon.toFixed(2)}°` : (regions.find((r) => r.id === loc.regionId)?.name ?? 'a deleted region')))
}

export function describeEvent(m: ProjectModels, view: WorldView, e: TimelineEvent, regions: Region[], withNotes = false) {
  const group = e.groupId ? view.timeline.groups.find((g) => g.id === e.groupId)?.title : undefined
  const lane = e.laneId ? view.timeline.lanes.find((l) => l.id === e.laneId)?.name : undefined
  return {
    id: e.id,
    title: e.title,
    when: eventDates(m, e),
    ...(e.tags.length && { tags: e.tags }),
    ...(e.locations.length && { where: eventPlaces(e, regions) }),
    ...(group && { group }),
    ...(lane && { lane }),
    ...(withNotes && e.notes && { notes: htmlToText(e.notes) })
  }
}

/** The regions a point lies in. */
export const regionsHere = (place: LatLon, regions: Region[]) => regions.filter((r) => insidePolygon(place, r.points))

const STAGE_LABEL = Object.fromEntries([...STAGES.map((s) => [s.stage, s.label]), ['destroyed', 'Gone']])

export function blueprintName(view: WorldView, id: string): string {
  return findBlueprint(view.timeline.blueprints, id)?.name ?? 'Unknown blueprint'
}

/** A structure as of `t`: what it's called then, how it's holding up, whether anyone keeps it up. */
export function describeStructure(m: ProjectModels, view: WorldView, s: Structure, curve: ConditionCurve | undefined, t: number, regions: Region[]) {
  const state = curve ? stateAt(curve, t) : undefined
  const where = regionsHere(s, regions).map((r) => r.name)
  return {
    id: s.id,
    name: state?.name || s.name,
    blueprint: blueprintName(view, state?.blueprintId || s.blueprintId),
    built: m.date(s.ownerId, s.builtAt, 'year'),
    standing: state?.exists ?? false,
    condition: state ? Math.round(state.condition) : 0,
    stage: STAGE_LABEL[state?.stage ?? 'destroyed'],
    maintained: state?.maintained ?? s.maintained,
    ...(where.length && { region: where.join(', ') }),
    place: { lat: round(s.lat), lon: round(s.lon) },
    ...(s.tags.length && { tags: s.tags })
  }
}

/** A character as of `t`: alive or not, their age, where they are. */
export function describeCharacter(m: ProjectModels, c: Character, t: number, regions: Region[]) {
  const place = characterAt(c, t)
  const where = place ? regionsHere(place, regions).map((r) => r.name) : []
  return {
    id: c.id,
    name: c.name,
    born: m.date(c.ownerId, c.born, 'year'),
    ...(c.died !== null && { died: m.date(c.ownerId, c.died, 'year') }),
    alive: !!place,
    ...(place && { age: ageAt(c, t, m.calendar(c.ownerId)), place: { lat: round(place.lat), lon: round(place.lon) }, travelling: place.travelling }),
    ...(where.length && { region: where.join(', ') })
  }
}

/** The themes in force on a world at `t` (in a region, if given): their blend, the dominant one's tone and style guide. */
export function describeTheme(view: WorldView, t: number, regionId?: string) {
  const spans = view.timeline.themeSpans
  const look = themeAt(spans, view.timeline.themes, t, regionId ? [regionId] : [])
  if (!look) return null
  const d = look.dominant
  return {
    strength: round(look.strength),
    layers: look.layers.map((l) => ({ theme: l.theme.name, themeId: l.theme.id, showing: round(l.weight) })),
    dominant: { name: d.name, mood: d.mood, style: d.style, lighting: d.lighting, palette: d.palette, ambience: d.ambience, ...(d.notes && { notes: htmlToText(d.notes) }) }
  }
}

/** The moons over a world at `t`: each one's phase and how much of it is lit. */
export function describeMoons(m: ProjectModels, worldId: string, t: number) {
  const world = m.node(worldId)
  const system = m.system(worldId)
  const bodyId = world.parentId
  if (!system || !bodyId || !system.bodies.has(bodyId)) return []
  const names = new Map(m.data().nodes.map((n) => [n.id, n.name]))
  return moonsOf(system, bodyId).map((moon) => {
    const phase = moonPhase(system, moon, t)
    return { moon: names.get(moon.bodyId) ?? 'A moon', phase: phase.name, illuminated: round(phase.illumination) }
  })
}

/** Everything on a world at `t`: the date, what's happening, which regions exist, what stands, who's alive, the theme and the moons. */
export async function worldSnapshot(m: ProjectModels, worldId: string, t: number) {
  const view = m.world(worldId)
  const data = m.data()
  const regions = regionsAt(
    data.regions.filter((r) => r.worldId === worldId),
    view.timeline.changes,
    t
  )
  const { curves } = await m.structures(worldId)
  const happening = view.timeline.events.filter((e) => isActiveAt(e, t))
  const structures = view.timeline.structures.map((s) => describeStructure(m, view, s, curves.get(s.id), t, regions)).filter((s) => s.standing)
  return {
    world: view.node.name,
    date: m.date(worldId, t),
    happening: happening.map((e) => describeEvent(m, view, e, regions)),
    regions: regions.map((r) => ({ id: r.id, name: r.name })),
    structures,
    characters: view.timeline.characters.map((c) => describeCharacter(m, c, t, regions)).filter((c) => c.alive),
    theme: describeTheme(view, t),
    moons: describeMoons(m, worldId, t)
  }
}

export const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places

export const builtinBlueprintNames = () => BUILTIN_BLUEPRINTS.map((b) => b.name)
