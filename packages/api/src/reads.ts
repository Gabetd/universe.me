import {
  AU_KM,
  Command,
  FINDING_STATUSES,
  ECO_LINK_TYPES,
  STAGES,
  causalChain,
  secondsPerYear,
  erodesAt,
  ruinAt,
  stateAt,
  structureWarnings,
  timelineWarnings,
  ecosystemWarnings,
  factionWarnings,
  relationshipsAt,
  BUILTIN_BLUEPRINTS,
  type SpatialNode
} from '@universe/core'
import { formatPeriod, deriveCalendar, moonsOf, skyEvents } from '@universe/sim'
import { z } from 'zod'
import { exportWorldBible } from './bible'
import { biomeName, describeCalendar, describeCharacter, describeEvent, describeFactionAt, describeFactionHistory, describeFinding, describeRelationFrom, describeRelationship, describeMoons, describePowerAt, describePowerSystem, describeStructure, describeTheme, kindLabel, nodePath, round, worldSnapshot } from './describe'
import { ApiError, notFound } from './host'
import { QueryFlag, QueryList, QueryNumber, When, operation, type ApiContext } from './operation'
import { htmlToText } from './text'

/** Stages as the API names them. */
const STAGE_LABELS: [string, ...string[]] = ['Gone', ...STAGES.map((s) => s.label)]

const WorldId = z.string().describe('The world surface’s id (from list_worlds)')

/** A world's stats, for lists. */
function worldSummary({ models: m }: ApiContext, node: SpatialNode) {
  const view = m.world(node.id)
  const t = view.timeline
  return {
    id: node.id,
    name: node.name,
    path: nodePath(m.data().nodes, node.id),
    now: m.date(node.id, m.now(node.id), 'year'),
    counts: { events: t.events.length, structures: t.structures.length, characters: t.characters.length, factions: t.factions.length, regions: view.regions.length, species: t.lifeforms.length }
  }
}

/** Every structure on a world as of `t`, with how it's holding up. */
async function structuresAt(ctx: ApiContext, worldId: string, t: number) {
  const { models: m } = ctx
  const view = m.world(worldId)
  const { curves } = await m.structures(worldId)
  const regions = m.regionsAt(worldId, t)
  return { view, regions, curves, list: view.timeline.structures.map((s) => describeStructure(m, view, s, curves.get(s.id), t, regions)) }
}

/** A record's notes as text, worked out once per version of the record (the host keeps unchanged records between reads). */
const noteTexts = new WeakMap<object, string>()
function noteText(record: { notes: string }): string {
  let text = noteTexts.get(record)
  if (text === undefined) noteTexts.set(record, (text = htmlToText(record.notes)))
  return text
}

/** Read-only operations: what an AI needs to know a world before it writes about it or adds to it. */
export const READS = [
  operation({
    name: 'list_worlds',
    title: 'List worlds',
    description: 'Every world surface in the open project, with where it is in the universe, its "now" and how much is on it. Start here: the other tools take a world’s id.',
    input: z.object({}),
    route: { method: 'GET', path: '/worlds' },
    run: (ctx) => {
      const { name, data } = ctx.models.project()
      return { project: name, worlds: data.nodes.filter((n) => n.kind === 'world').map((n) => worldSummary(ctx, n)) }
    }
  }),
  operation({
    name: 'get_tree',
    title: 'Universe tree',
    description: 'The zoom tree of the universe (clusters, galaxies, star systems, planets and moons, world surfaces) from a node down (the universe by default), as names, kinds and ids.',
    input: z.object({ nodeId: z.string().optional().describe('Where to start; the universe if left out'), depth: QueryNumber.int().min(1).max(10).optional() }),
    route: { method: 'GET', path: '/tree' },
    run: ({ models: m }, { nodeId, depth = 6 }) => {
      const { rootId, data } = m.project()
      const branch = (n: SpatialNode, d: number): object => {
        const children = data.nodes.filter((c) => c.parentId === n.id)
        return { id: n.id, name: n.name, kind: kindLabel(n), ...(children.length && (d > 1 ? { children: children.map((c) => branch(c, d - 1)) } : { more: children.length })) }
      }
      return branch(m.node(nodeId ?? rootId), depth)
    }
  }),
  operation({
    name: 'get_world',
    title: 'World overview',
    description: 'A world in full: its size, seed and climate, its calendar (months, day and year length), its "now", regions, lanes, eras, the theme library in use, its notes and counts. Dates in every tool are written in this calendar.',
    input: z.object({ worldId: WorldId }),
    route: { method: 'GET', path: '/worlds/:worldId' },
    run: (ctx, { worldId }) => {
      const { models: m } = ctx
      const view = m.world(worldId)
      const climate = m.climate(worldId)
      const s = view.info.settings
      return {
        ...worldSummary(ctx, view.node),
        notes: htmlToText(view.node.notes),
        tags: view.node.tags,
        surface: { radiusKm: s.radiusKm, seed: s.seedText, landform: s.terrain.landform, water: s.terrain.water, seaLevelM: s.seaLevel, erosionSpeed: s.erosionSpeed },
        ...(climate && { climate: { meanTempC: round(climate.meanTempC, 1), distanceAu: round(climate.distanceAu, 3), inHabitableZone: climate.inHabitableZone } }),
        calendar: describeCalendar(m.calendar(worldId)),
        regions: m.world(worldId).regions.map((r) => ({ id: r.id, name: r.name, ...(r.notes && { notes: htmlToText(r.notes) }) })),
        lanes: view.timeline.lanes.map((l) => l.name),
        eras: view.timeline.eras.map((e) => ({ id: e.id, name: e.name, when: m.spanDates(worldId, e) })),
        themeSpans: view.timeline.themeSpans.map((sp) => ({
          id: sp.id,
          theme: view.timeline.themes.find((t) => t.id === sp.themeId)?.name,
          when: m.spanDates(worldId, sp),
          ...(sp.regionId && { region: m.world(worldId).regions.find((r) => r.id === sp.regionId)?.name })
        }))
      }
    }
  }),
  operation({
    name: 'get_world_snapshot',
    title: 'World at a moment',
    description: 'A world as it is at one moment: the date, the events happening, the regions that exist, the structures standing (with condition), the characters alive (age, where), the theme in force and the moons’ phases.',
    input: z.object({ worldId: WorldId, at: When }),
    route: { method: 'GET', path: '/worlds/:worldId/snapshot' },
    run: ({ models: m }, { worldId, at }) => worldSnapshot(m, worldId, m.when(worldId, at))
  }),
  operation({
    name: 'search',
    title: 'Search',
    description: 'Finds anything in the project by name, title, notes or tags: nodes, regions, events, structures, characters, species, themes, eras, event groups and factions.',
    input: z.object({ q: z.string().min(1), limit: QueryNumber.int().min(1).max(200).optional() }),
    route: { method: 'GET', path: '/search' },
    run: ({ models: m }, { q, limit = 50 }) => {
      const data = m.data()
      const needle = q.toLowerCase()
      const has = (x: string | undefined) => !!x && x.toLowerCase().includes(needle)
      // Names, titles and tags first; a record's notes are read as text only if those don't match.
      const hit = (r: { notes: string }, ...texts: (string | string[] | undefined)[]) => texts.flat().some(has) || has(noteText(r))
      const t = data.timeline
      const results = [
        ...data.nodes.filter((n) => hit(n, n.name, n.tags)).map((n) => ({ kind: kindLabel(n), id: n.id, name: n.name, path: nodePath(data.nodes, n.id) })),
        ...data.regions.filter((r) => hit(r, r.name)).map((r) => ({ kind: 'Region', id: r.id, name: r.name, worldId: r.worldId })),
        ...t.events.filter((e) => hit(e, e.title, e.tags)).map((e) => ({ kind: 'Event', id: e.id, name: e.title, worldId: e.ownerId, when: m.date(e.ownerId, e.start, e.precision) })),
        ...t.structures.filter((s) => hit(s, s.name, s.tags)).map((s) => ({ kind: 'Structure', id: s.id, name: s.name, worldId: s.ownerId })),
        ...t.characters.filter((c) => hit(c, c.name, c.tags)).map((c) => ({ kind: 'Character', id: c.id, name: c.name, worldId: c.ownerId })),
        ...t.lifeforms.filter((s) => hit(s, s.name, s.tags)).map((s) => ({ kind: 'Species', id: s.id, name: s.name, worldId: s.ownerId })),
        ...t.themes.filter((th) => hit(th, th.name, th.style, th.mood)).map((th) => ({ kind: 'Theme', id: th.id, name: th.name })),
        ...t.eras.filter((e) => hit(e, e.name)).map((e) => ({ kind: 'Era', id: e.id, name: e.name, worldId: e.ownerId })),
        ...t.groups.filter((g) => hit(g, g.title)).map((g) => ({ kind: 'Event group', id: g.id, name: g.title, worldId: g.ownerId })),
        ...t.factions.filter((f) => hit(f, f.name, f.summary, f.tags)).map((f) => ({ kind: 'Faction', id: f.id, name: f.name, worldId: f.ownerId }))
      ]
      return { count: results.length, results: results.slice(0, limit) }
    }
  }),
  operation({
    name: 'list_events',
    title: 'List events',
    description: 'A world’s events in time order, optionally between two dates and with any of some tags: title, dates, tags, places, group and lane.',
    input: z.object({ worldId: WorldId, from: When.optional(), to: When.optional(), tags: QueryList.optional(), limit: QueryNumber.int().min(1).max(1000).optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/events' },
    run: (ctx, { worldId, from, to, tags, limit = 200 }) => {
      const { models: m } = ctx
      const view = m.world(worldId)
      const t0 = from === undefined ? -Infinity : m.when(worldId, from)
      const t1 = to === undefined ? Infinity : m.when(worldId, to)
      const events = view.timeline.events
        .filter((e) => (e.end ?? e.start) >= t0 && e.start <= t1 && (!tags?.length || e.tags.some((x) => tags.includes(x))))
        .sort((a, b) => a.start - b.start)
      const regions = m.world(worldId).regions
      return { count: events.length, events: events.slice(0, limit).map((e) => describeEvent(m, view, e, regions)) }
    }
  }),
  operation({
    name: 'get_event',
    title: 'Event in full',
    description: 'One event with its notes, the events it causes and is caused by (and other links), its group, and its effects on structures.',
    input: z.object({ eventId: z.string() }),
    route: { method: 'GET', path: '/events/:eventId' },
    run: (ctx, { eventId }) => {
      const { models: m } = ctx
      const e = m.event(eventId)
      const view = m.world(e.ownerId)
      const title = (id: string) => view.timeline.events.find((x) => x.id === id)?.title ?? 'a deleted event'
      const links = view.timeline.links.filter((l) => l.fromId === e.id || l.toId === e.id)
      return {
        ...describeEvent(m, view, e, m.world(e.ownerId).regions, true),
        worldId: e.ownerId,
        links: links.map((l) => (l.fromId === e.id ? { id: l.id, this: l.type, event: title(l.toId), eventId: l.toId } : { id: l.id, event: title(l.fromId), eventId: l.fromId, [l.type]: 'this' })),
        effects: view.timeline.effects
          .filter((x) => x.eventId === e.id)
          .map((x) => ({ id: x.id, type: x.type, target: x.target, ...(x.amount && { amount: x.amount }), ...(x.rename && { rename: x.rename }) }))
      }
    }
  }),
  operation({
    name: 'get_event_chain',
    title: 'Causes and consequences',
    description: 'Everything an event leads to (direction "effects") or comes from ("causes") along its links, in time order.',
    input: z.object({ eventId: z.string(), direction: z.enum(['causes', 'effects']).optional() }),
    route: { method: 'GET', path: '/events/:eventId/chain' },
    run: (ctx, { eventId, direction = 'effects' }) => {
      const { models: m } = ctx
      const e = m.event(eventId)
      const view = m.world(e.ownerId)
      const ids = causalChain(view.timeline.links, e.id, direction === 'effects' ? 'down' : 'up')
      const regions = m.world(e.ownerId).regions
      const chain = view.timeline.events.filter((x) => ids.has(x.id) && x.id !== e.id).sort((a, b) => a.start - b.start)
      return { event: e.title, direction, chain: chain.map((x) => describeEvent(m, view, x, regions)) }
    }
  }),
  operation({
    name: 'get_theme_at',
    title: 'Theme at a moment',
    description: 'The theme in force on a world (or in one of its regions) at a moment: the themes blending, and the dominant one’s mood, prose style guide, lighting and palette. Write in its style.',
    input: z.object({ worldId: WorldId, at: When, regionId: z.string().optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/theme' },
    run: ({ models: m }, { worldId, at, regionId }) => {
      const t = m.when(worldId, at)
      return { date: m.date(worldId, t), theme: describeTheme(m.world(worldId), t, regionId) }
    }
  }),
  operation({
    name: 'list_themes',
    title: 'Theme library',
    description: 'The project’s themes (look and tone for an age): name, palette, lighting, mood, style guide, and the worlds and dates they’re used on.',
    input: z.object({}),
    route: { method: 'GET', path: '/themes' },
    run: ({ models: m }) => {
      const data = m.data()
      return data.timeline.themes.map((th) => ({
        id: th.id,
        name: th.name,
        mood: th.mood,
        style: th.style,
        lighting: th.lighting,
        palette: th.palette,
        usedOn: data.timeline.themeSpans
          .filter((s) => s.themeId === th.id)
          .map((s) => ({ world: data.nodes.find((n) => n.id === s.ownerId)?.name, when: m.spanDates(s.ownerId, s) }))
      }))
    }
  }),
  operation({
    name: 'list_power_systems',
    title: 'Power systems',
    description:
      'How a world’s powers work (magic, divine gifts, psionics, technology, politics…): for each system, the questions it answers, what holds in every age, and each age (era) where it’s different, with how strong it is then. With `at`, also how each stands at that moment. Keep what you write true to them.',
    input: z.object({ worldId: WorldId, at: When.optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/powers' },
    run: ({ models: m }, { worldId, at }) => {
      const view = m.world(worldId)
      const t = at === undefined ? undefined : m.when(worldId, at)
      return {
        ...(t !== undefined && { date: m.date(worldId, t) }),
        systems: view.timeline.powers.map((p) => ({ ...describePowerSystem(m, view, p), ...(t !== undefined && { atThatMoment: describePowerAt(view, p, t) }) }))
      }
    }
  }),
  operation({
    name: 'list_structures',
    title: 'List structures',
    description: 'A world’s structures as of a moment ("now" by default): name, blueprint, when built, condition (0–100) and stage, maintained or weathering, region. Filter by region or stage.',
    input: z.object({
      worldId: WorldId,
      at: When.optional(),
      regionId: z.string().optional(),
      stage: z.enum(STAGE_LABELS).optional(),
      includeGone: QueryFlag.optional()
    }),
    route: { method: 'GET', path: '/worlds/:worldId/structures' },
    run: async (ctx, { worldId, at, regionId, stage, includeGone }) => {
      const m = ctx.models
      const t = m.whenOrNow(worldId, at)
      const { list, regions } = await structuresAt(ctx, worldId, t)
      const region = regionId ? regions.find((r) => r.id === regionId)?.name : undefined
      if (regionId && !region) throw notFound('region at that time', regionId)
      return {
        date: m.date(worldId, t),
        structures: list.filter((s) => (includeGone || s.standing || stage === 'Gone') && (!stage || s.stage === stage) && (!region || s.region?.split(', ').includes(region)))
      }
    }
  }),
  operation({
    name: 'get_structure_condition',
    title: 'Structure condition',
    description: 'How a structure is at a moment and why: condition and stage overall and per material, maintained or weathering, and its history so far (built, damaged, repaired, renamed, maintenance changes) with the events behind each.',
    input: z.object({ structureId: z.string(), at: When.optional() }),
    route: { method: 'GET', path: '/structures/:structureId/condition' },
    run: async (ctx, { structureId, at }) => {
      const { models: m } = ctx
      const s = m.structure(structureId)
      const view = m.world(s.ownerId)
      const t = m.whenOrNow(s.ownerId, at)
      const { curves } = await m.structures(s.ownerId)
      const curve = curves.get(s.id)!
      const state = stateAt(curve, t)
      const title = (id?: string) => (id ? view.timeline.events.find((e) => e.id === id)?.title : undefined)
      return {
        ...describeStructure(m, view, s, curve, t, m.world(s.ownerId).regions),
        date: m.date(s.ownerId, t),
        materials: Object.fromEntries(Object.entries(state.materials).map(([k, v]) => [k, Math.round(v!)])),
        history: curve.steps
          .filter((st) => st.at <= t)
          .map((st) => ({
            when: m.date(s.ownerId, st.at, 'year'),
            what: st.kind === 'maintenance' ? (st.maintained ? 'maintained from then on' : 'left to weather from then on') : st.kind,
            ...(st.amount && { amount: Math.round(st.amount) }),
            ...(st.rename && { renamed: st.rename }),
            ...(title(st.eventId) && { because: title(st.eventId) })
          })),
        ...(s.notes && { notes: htmlToText(s.notes) })
      }
    }
  }),
  operation({
    name: 'project_decay',
    title: 'Project decay',
    description: 'If a structure is left to weather from a moment on ("now" by default), when it falls into ruin and when it erodes away entirely. Maintained structures don’t decay.',
    input: z.object({ structureId: z.string(), from: When.optional() }),
    route: { method: 'GET', path: '/structures/:structureId/decay' },
    run: async (ctx, { structureId, from }) => {
      const { models: m } = ctx
      const s = m.structure(structureId)
      const t = m.whenOrNow(s.ownerId, from)
      const curve = (await m.structures(s.ownerId)).curves.get(s.id)!
      const state = stateAt(curve, t)
      const ruin = ruinAt(curve, t)
      const gone = erodesAt(curve, t)
      return {
        name: state.name || s.name,
        from: m.date(s.ownerId, t, 'year'),
        condition: Math.round(state.condition),
        maintained: state.maintained,
        ruin: ruin === undefined ? null : m.date(s.ownerId, ruin, 'year'),
        erodedAway: gone === undefined ? null : m.date(s.ownerId, gone, 'year'),
        ...(state.maintained && { note: 'It is maintained then, so it doesn’t decay. Use set_maintenance to leave it to weather.' })
      }
    }
  }),
  operation({
    name: 'list_blueprints',
    title: 'Blueprints',
    description: 'What structures can be built from: the built-in blueprints (castles, villages, a walled city, camps, harbours…) and the project’s own, with their materials and whether they start maintained.',
    input: z.object({}),
    route: { method: 'GET', path: '/blueprints' },
    run: ({ models: m }) =>
      [...BUILTIN_BLUEPRINTS, ...m.data().timeline.blueprints].map((b) => ({
        id: b.id,
        name: b.name,
        materials: [...new Set(b.model ? [b.model.material] : b.parts.map((p) => p.material))],
        maintainedByDefault: b.maintainedByDefault,
        ...(b.tags.length && { tags: b.tags })
      }))
  }),
  operation({
    name: 'get_ecosystem',
    title: 'Ecosystem',
    description: 'A world’s species (kind, diet, biomes) and food web (who eats, pollinates, competes with whom), with warnings such as predators without prey. Filter by biome name.',
    input: z.object({ worldId: WorldId, biome: z.string().optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/ecosystem' },
    run: ({ models: m }, { worldId, biome }) => {
      const view = m.world(worldId)
      const species = view.timeline.lifeforms.filter((s) => !biome || s.biomes.some((b) => biomeName(b).toLowerCase() === biome.toLowerCase()))
      const names = new Map(view.timeline.lifeforms.map((s) => [s.id, s.name]))
      const ids = new Set(species.map((s) => s.id))
      return {
        species: species.map((s) => ({ id: s.id, name: s.name, kind: s.kind, diet: s.diet, biomes: s.biomes.map(biomeName), ...(s.notes && { notes: htmlToText(s.notes) }) })),
        links: view.timeline.ecolinks.filter((l) => ids.has(l.fromId) || ids.has(l.toId)).map((l) => ({ id: l.id, from: names.get(l.fromId), type: l.type, to: names.get(l.toId) })),
        linkTypes: ECO_LINK_TYPES,
        warnings: ecosystemWarnings(view.timeline.lifeforms, view.timeline.ecolinks).map((w) => w.message)
      }
    }
  }),
  operation({
    name: 'get_star_system',
    title: 'Star system',
    description: 'The star system a node is in (a world, planet, moon or the system itself): the star (mass, temperature, habitable zone) and each planet and moon’s orbit, year and day, and the worlds on them.',
    input: z.object({ nodeId: z.string() }),
    route: { method: 'GET', path: '/nodes/:nodeId/system' },
    run: ({ models: m }, { nodeId }) => {
      const system = m.system(nodeId)
      if (!system) throw new ApiError(400, `${m.node(nodeId).name} is not in a star system`)
      const nodes = m.data().nodes
      const name = (id: string) => nodes.find((n) => n.id === id)?.name ?? '?'
      const star = system.star
      return {
        system: name(system.systemId),
        star: { massSun: round(star.massSun), luminositySun: round(star.luminositySun, 3), temperatureK: Math.round(star.temperatureK), habitableZoneAu: star.habitableAu.map((a) => round(a, 2)) },
        bodies: [...system.bodies.values()].map((b) => {
          const world = nodes.find((n) => n.parentId === b.bodyId && n.kind === 'world')
          const derived = world ? deriveCalendar(system, b.bodyId) : undefined
          return {
            id: b.bodyId,
            name: name(b.bodyId),
            orbits: b.parentBodyId ? name(b.parentBodyId) : 'the star',
            distance: b.parentBodyId ? `${Math.round(b.semiMajorAxisKm).toLocaleString('en')} km` : `${round(b.semiMajorAxisKm / AU_KM, 3)} AU`,
            year: formatPeriod(b.periodS),
            dayHours: round(b.rotationHours, 1),
            axialTiltDeg: round(b.axialTiltDeg, 1),
            massEarth: round(b.massEarth, 3),
            moons: moonsOf(system, b.bodyId).map((x) => name(x.bodyId)),
            ...(world && { world: { id: world.id, name: world.name, daysPerYear: round(derived!.yearDays, 1), hoursPerDay: round(derived!.dayHours, 2) } })
          }
        })
      }
    }
  }),
  operation({
    name: 'get_moon_phase',
    title: 'Moon phases',
    description: 'The phase of each moon over a world at a moment, and the new and full moons and eclipses in the following year.',
    input: z.object({ worldId: WorldId, at: When }),
    route: { method: 'GET', path: '/worlds/:worldId/moons' },
    run: ({ models: m }, { worldId, at }) => {
      const t = m.when(worldId, at)
      const system = m.system(worldId)
      const bodyId = m.world(worldId).node.parentId
      const year = secondsPerYear(m.calendar(worldId))
      const names = new Map(m.data().nodes.map((n) => [n.id, n.name]))
      const coming = system && bodyId && system.bodies.has(bodyId) ? skyEvents(system, bodyId, t, t + year) : []
      return {
        date: m.date(worldId, t),
        moons: describeMoons(m, worldId, t),
        comingYear: coming.map((e) => ({ when: m.date(worldId, e.at), what: e.kind.replace('-', ' '), moon: names.get(e.moonId), ...(e.extent && { extent: e.extent }) }))
      }
    }
  }),
  operation({
    name: 'check_consistency',
    title: 'Check consistency',
    description: 'Things on a world that are allowed but probably mistakes: effects that start before their causes, causal loops, events in regions that don’t exist yet, structure effects that reach nothing, repairs of ruins, maintenance before a structure is built, predators with nothing to eat, people in a faction before they’re born or before it’s founded, a region held by two factions at once, allies who are enemies at the same time.',
    input: z.object({ worldId: WorldId }),
    route: { method: 'GET', path: '/worlds/:worldId/consistency' },
    run: async (ctx, { worldId }) => {
      const { models: m } = ctx
      const view = m.world(worldId)
      const { world, curves } = await m.structures(worldId)
      const warnings = [
        ...timelineWarnings(view.timeline, m.world(worldId).regions).map((w) => ({ area: 'timeline', message: w.message, refs: w.refs })),
        ...structureWarnings(world, curves).map((w) => ({ area: 'structures', message: w.message, refs: w.refs })),
        ...ecosystemWarnings(view.timeline.lifeforms, view.timeline.ecolinks).map((w) => ({ area: 'ecosystem', message: w.message, refs: w.ids.map((id) => ({ kind: 'species', id })) })),
        ...factionWarnings(view.timeline, view.regions).map((w) => ({ area: 'factions', message: w.message, refs: w.refs }))
      ]
      return { ok: warnings.length === 0, warnings }
    }
  }),
  operation({
    name: 'list_inconsistencies',
    title: 'Inconsistencies found',
    description:
      'What’s been reported as inconsistent on a world (with report_inconsistency): open ones, resolved ones (fixed), and dismissed ones (not a problem: don’t raise them again). Read it before reviewing a world, so nothing is reported twice.',
    input: z.object({ worldId: WorldId, status: z.enum(FINDING_STATUSES).optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/inconsistencies' },
    run: ({ models: m }, { worldId, status }) => {
      const view = m.world(worldId)
      return { findings: view.timeline.findings.filter((f) => !status || f.status === status).map((f) => describeFinding(m, view, f)) }
    }
  }),
  operation({
    name: 'list_characters',
    title: 'List characters',
    description: 'A world’s characters as of a moment ("now" by default): born, died, alive or not, age, where they are and in which region.',
    input: z.object({ worldId: WorldId, at: When.optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/characters' },
    run: (ctx, { worldId, at }) => {
      const { models: m } = ctx
      const t = m.whenOrNow(worldId, at)
      const view = m.world(worldId)
      const regions = m.regionsAt(worldId, t)
      return { date: m.date(worldId, t), characters: view.timeline.characters.map((c) => describeCharacter(m, c, t, regions)) }
    }
  }),
  operation({
    name: 'list_factions',
    title: 'List factions',
    description:
      'A world’s factions (kingdoms, houses, guilds, faiths…) as of a moment ("now" by default): founded and dissolved when, what they’re part of, whether they exist then, their members (with roles), the regions they hold (their parts’ too) and how they stand with others. With history: true, everything over time instead, each with when.',
    input: z.object({ worldId: WorldId, at: When.optional(), history: QueryFlag.optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/factions' },
    run: ({ models: m }, { worldId, at, history }) => {
      const view = m.world(worldId)
      if (history) return { factions: view.timeline.factions.map((f) => describeFactionHistory(m, view, f)) }
      const t = m.whenOrNow(worldId, at)
      return { date: m.date(worldId, t), factions: view.timeline.factions.map((f) => describeFactionAt(m, view, f, t)) }
    }
  }),
  operation({
    name: 'get_relationships',
    title: 'Who’s related to whom',
    description:
      'The relationships on a world in force at a moment ("now" by default): kin (parent, spouse, sibling), friends, allies, rivals, enemies, mentors and students, lieges and vassals, between characters and factions. Of one character or faction (by id) if given, read from their side ("Child", "Vassal").',
    input: z.object({ worldId: WorldId, at: When.optional(), of: z.string().optional().describe('A character’s or faction’s id') }),
    route: { method: 'GET', path: '/worlds/:worldId/relationships' },
    run: ({ models: m }, { worldId, at, of }) => {
      const view = m.world(worldId)
      const t = m.whenOrNow(worldId, at)
      const tl = view.timeline
      if (!of) return { date: m.date(worldId, t), relationships: relationshipsAt(tl.relationships, t).map((r) => describeRelationship(m, view, r)) }
      const kind = tl.factions.some((f) => f.id === of) ? 'faction' : tl.characters.some((c) => c.id === of) ? 'character' : undefined
      if (!kind) throw new ApiError(404, `There is no character or faction ${of} on that world`)
      const side = { kind, id: of } as const
      return { date: m.date(worldId, t), relationships: relationshipsAt(tl.relationships, t, side).map((r) => describeRelationFrom(m, view, r, side)) }
    }
  }),
  operation({
    name: 'export_world_bible',
    title: 'World bible',
    description: 'A whole world written up as one Markdown document (a "world bible"): overview, calendar, regions, history in order, structures, characters, factions and who’s related to whom, species, themes and style guides. Or as JSON with format "json".',
    input: z.object({ worldId: WorldId, format: z.enum(['markdown', 'json']).optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/export' },
    run: (ctx, { worldId, format = 'markdown' }) => exportWorldBible(ctx, worldId, format)
  }),
  operation({
    name: 'describe_commands',
    title: 'Command reference',
    description: 'The commands run_commands accepts (every change the app can make: renaming, editing, deleting, moving…): their types, or the JSON Schema of one.',
    input: z.object({ type: z.string().optional() }),
    route: { method: 'GET', path: '/commands' },
    run: (_ctx, { type }) => {
      const options = Command.options
      if (!type) return { types: options.map((o) => o.shape.type.value), note: 'Pass a type for its JSON Schema. Every command is validated and can be undone.' }
      const found = options.find((o) => o.shape.type.value === type)
      if (!found) throw new ApiError(404, `There is no command ${type}`)
      return z.toJSONSchema(found, { unrepresentable: 'any' })
    }
  })
]
