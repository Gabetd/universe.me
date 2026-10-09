import {
  daysPerYear,
  KIND_LABELS,
  STAGES,
  ageAt,
  characterAt,
  erasInOrder,
  powerAt,
  findBlueprint,
  polygonTester,
  isActiveAt,
  stateAt,
  themeAt,
  type Calendar,
  type Character,
  type ConditionCurve,
  type LatLon,
  type AspectValues,
  type Finding,
  type FindingRef,
  type PowerSystem,
  type Region,
  type SpatialNode,
  type Structure,
  type TimelineEvent
} from '@universe/core'
import { BIOMES } from '@universe/procgen'
import { moonPhase, moonsOf } from '@universe/sim'
import { ApiError } from './host'
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
    if (!b) throw new ApiError(400, `There is no biome “${n}”. Biomes: ${BIOMES.filter((x) => x.id > 0).map((x) => x.name).join(', ')}`)
    return b.id
  })
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
    when: m.eventDates(e),
    ...(e.tags.length && { tags: e.tags }),
    ...(e.locations.length && { where: eventPlaces(e, regions) }),
    ...(group && { group }),
    ...(lane && { lane }),
    ...(withNotes && e.notes && { notes: htmlToText(e.notes) })
  }
}

/** Whether a point is in a region, from a test made once per region outline (lists ask it of every structure and character). */
const testers = new WeakMap<LatLon[], (p: LatLon) => boolean>()
function inRegion(place: LatLon, region: Region): boolean {
  let test = testers.get(region.points)
  if (!test) testers.set(region.points, (test = polygonTester(region.points)))
  return test(place)
}

/** The regions a point lies in. */
export const regionsHere = (place: LatLon, regions: Region[]) => regions.filter((r) => inRegion(place, r))

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
    stage: t < s.builtAt && !state?.exists ? 'Not yet built' : STAGE_LABEL[state?.stage ?? 'destroyed'],
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

/** A system's answers by question, leaving out what isn't answered. */
const answers = (system: PowerSystem, values: AspectValues) => Object.fromEntries(system.aspects.flatMap((a) => (values[a.id] ? [[a.label, values[a.id]!]] : [])))

/** A power system as a whole: what it is, what holds in every age, and each age that's different (in time order) with how strong it is then. */
export function describePowerSystem(m: ProjectModels, view: WorldView, system: PowerSystem) {
  const ages = view.timeline.powerAges.filter((a) => a.systemId === system.id)
  return {
    id: system.id,
    name: system.name,
    kind: system.template,
    ...(system.summary && { summary: system.summary }),
    questions: system.aspects.map((a) => a.label),
    always: answers(system, system.values),
    ages: erasInOrder(view.timeline.eras).flatMap((e) => {
      const age = ages.find((a) => a.eraId === e.id)
      if (!age) return []
      return [{ era: e.name, eraId: e.id, when: m.spanDates(view.node.id, e), ...(age.summary && { summary: age.summary }), ...(age.strength !== null && { strength: round(age.strength) }), changes: answers(system, age.values) }]
    }),
    ...(system.notes && { notes: htmlToText(system.notes) })
  }
}

/** A power system as it stands at `t`: the age it's in, and each answer then (that age's, or what always holds). */
export function describePowerAt(view: WorldView, system: PowerSystem, t: number) {
  const p = powerAt(system, view.timeline.powerAges, view.timeline.eras, t)
  return {
    system: system.name,
    kind: system.template,
    age: p.era?.name ?? null,
    ...(p.summary && { summary: p.summary }),
    ...(p.strength !== null && { strength: round(p.strength) }),
    howItWorks: Object.fromEntries(p.aspects.flatMap((a) => (a.value ? [[a.label, a.value]] : [])))
  }
}

/** What a finding (or anything on a world) refers to, by name; undefined if there's no such thing there. */
export function refName(m: ProjectModels, view: WorldView, { kind, id }: FindingRef): string | undefined {
  const t = view.timeline
  const find = <T extends { id: string }>(list: readonly T[]) => list.find((r) => r.id === id)
  const title = (eventId: string) => find(t.events)?.title ?? t.events.find((e) => e.id === eventId)?.title ?? '?'
  switch (kind) {
    case 'node':
      return find(m.data().nodes)?.name
    case 'region':
      return find(view.regions)?.name
    case 'event':
      return find(t.events)?.title
    case 'era':
      return find(t.eras)?.name
    case 'group':
      return find(t.groups)?.title
    case 'link': {
      const link = find(t.links)
      return link && `${title(link.fromId)} → ${title(link.toId)}`
    }
    case 'structure':
      return find(t.structures)?.name
    case 'character':
      return find(t.characters)?.name
    case 'species':
      return find(t.lifeforms)?.name
    case 'theme':
      return find(t.themes)?.name
    case 'themeSpan': {
      const span = find(t.themeSpans)
      return span && (t.themes.find((x) => x.id === span.themeId)?.name ?? 'A theme span')
    }
    case 'power':
      return find(t.powers)?.name
  }
}

/** A finding as a client reads it: what it's about by name (what's since been deleted says so). */
export function describeFinding(m: ProjectModels, view: WorldView, f: Finding) {
  return {
    id: f.id,
    severity: f.severity,
    title: f.title,
    explanation: f.explanation,
    ...(f.suggestion && { suggestion: f.suggestion }),
    about: f.refs.map((r) => ({ ...r, name: refName(m, view, r) ?? '(deleted)' })),
    status: f.status,
    ...(f.note && { note: f.note }),
    ...(f.reporter && { reportedBy: f.reporter }),
    reportedAt: f.createdAt
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

/** Everything on a world at `t`: the date, what's happening, which regions exist, what stands, who's alive, the theme, how its powers work then and the moons. */
export async function worldSnapshot(m: ProjectModels, worldId: string, t: number) {
  const view = m.world(worldId)
  const regions = m.regionsAt(worldId, t)
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
    powers: view.timeline.powers.map((p) => describePowerAt(view, p, t)),
    moons: describeMoons(m, worldId, t)
  }
}

export const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places

/** A calendar in words: its months and their lengths, and how long its days are. */
export const describeCalendar = (cal: Calendar) => ({
  months: cal.months.map((x) => `${x.name} (${x.days} days)`),
  daysPerYear: daysPerYear(cal),
  hoursPerDay: round(cal.secondsPerDay / 3600)
})
