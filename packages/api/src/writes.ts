import {
  AU_KM,
  BUILTIN_BLUEPRINTS,
  DIETS,
  EFFECT_TYPES,
  FACTION_KINDS,
  RELATION_TYPES,
  ECO_LINK_TYPES,
  HexColor,
  LIGHTING_PRESETS,
  LINK_TYPES,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  MATERIALS,
  sameFinding,
  POWER_TEMPLATES,
  POWER_TEMPLATE_INFO,
  aspectId,
  PRECISIONS,
  SPECIES_KINDS,
  THEME_PRESETS,
  TYPOGRAPHY,
  secondsPerYear,
  sphericalMean,
  type Command,
  type AspectValues,
  type LatLon,
  type PowerAspect
} from '@universe/core'
import { readSeed } from '@universe/procgen'
import { EARTH_ORBIT, luminosityOf } from '@universe/sim'
import { z } from 'zod'
import { biomeIds, partyName, partyOf, refName } from './describe'
import { ApiError, findOr404, type WriteOptions } from './host'
import { When, operation, written, type ApiContext } from './operation'
import type { WorldView } from './model'
import { textToHtml } from './text'

const newId = () => crypto.randomUUID()
const Place = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
const Tags = z.array(z.string().min(1).max(60))
const Notes = z.string().describe('Plain text: paragraphs separated by a blank line, "- " for list items')

/** The types of commands, batches opened up (before they're checked: a malformed one is the bus's to turn down). */
function commandTypes(commands: readonly unknown[]): string[] {
  return commands.flatMap((c) => {
    const { type, payload } = (c ?? {}) as { type?: unknown; payload?: { commands?: unknown } }
    return type === 'batch' && Array.isArray(payload?.commands) ? commandTypes(payload.commands) : [String(type)]
  })
}

/** Applies (or proposes) commands as one undoable step, and says what was done. */
function write(ctx: ApiContext, commands: Command[], summary: string, ids: Record<string, string> = {}, options?: WriteOptions) {
  const command: Command = commands.length === 1 ? commands[0]! : { type: 'batch', payload: { commands } }
  const outcome = ctx.host.write(command, summary, options)
  // What's read next sees the change.
  ctx.models.forget()
  return written(outcome, summary, ids)
}

/** A client's notes and tags as a record has them. */
const notesAndTags = (p: { notes?: string; tags?: string[] }) => ({ ...(p.notes && { notes: textToHtml(p.notes) }), ...(p.tags && { tags: p.tags }) })

/** Answers by question (label), as a system keeps them: questions it doesn't ask yet are added, and an empty answer clears one. */
function answered(aspects: readonly PowerAspect[], values: AspectValues, answers: Record<string, string>): { aspects: PowerAspect[]; values: AspectValues } {
  const out = { aspects: [...aspects], values: { ...values } }
  for (const [question, answer] of Object.entries(answers)) {
    let aspect = out.aspects.find((a) => a.label.toLowerCase() === question.trim().toLowerCase())
    if (!aspect) out.aspects.push((aspect = { id: aspectId(question, out.aspects.map((a) => a.id)), label: question.trim() }))
    if (answer.trim()) out.values[aspect.id] = answer.trim()
    else delete out.values[aspect.id]
  }
  return out
}

const Answers = z.record(z.string().min(1).max(200), z.string().max(20_000)).describe('Answers by question ("Source": "…"); a question it doesn’t ask yet is added; an empty answer clears one')

/** The lane called `name` on a world, made (by the returned commands) if it has none; no lane without a name. */
function laneFor(view: WorldView, name: string | undefined): { laneId: string | null; commands: Command[] } {
  if (!name) return { laneId: null, commands: [] }
  const lane = view.timeline.lanes.find((l) => l.name.toLowerCase() === name.toLowerCase())
  if (lane) return { laneId: lane.id, commands: [] }
  const laneId = newId()
  return { laneId, commands: [{ type: 'lane.create', payload: { id: laneId, ownerId: view.node.id, name } }] }
}

/** Where something goes: a point, or the middle of a region. */
function placeOf(ctx: ApiContext, worldId: string, place: LatLon | undefined, regionId: string | undefined): LatLon {
  if (place) return place
  if (regionId) return sphericalMean(ctx.models.region(worldId, regionId).points)
  throw new ApiError(400, 'Say where: a place {lat, lon} or a regionId')
}

/** A blueprint by id or (built-in or the project's) name. */
function blueprintId(ctx: ApiContext, nameOrId: string): string {
  const all = [...BUILTIN_BLUEPRINTS, ...ctx.models.data().timeline.blueprints]
  const b = all.find((x) => x.id === nameOrId) ?? all.find((x) => x.name.toLowerCase() === nameOrId.toLowerCase().trim())
  if (!b) throw new ApiError(404, `There is no blueprint “${nameOrId}”. list_blueprints names them`)
  return b.id
}

/** A faction on a world by id or name. */
function factionNamed(view: WorldView, nameOrId: string) {
  const all = view.timeline.factions
  const f = all.find((x) => x.id === nameOrId) ?? all.find((x) => x.name.toLowerCase() === nameOrId.trim().toLowerCase())
  if (!f) throw new ApiError(404, `There is no faction ${nameOrId} on ${view.node.name}${all.length ? ` (its factions: ${all.map((x) => x.name).join(', ')})` : ''}`)
  return f
}

const SpanInput = {
  from: When.optional().describe('When it begins; leave out for "from the start" (or from fromEventId’s date)'),
  until: When.optional().describe('When it ends; leave out for "still"'),
  fromEventId: z.string().optional().describe('The event that began it (its date is used if `from` isn’t given)'),
  untilEventId: z.string().optional().describe('The event that ended it')
}

/** A span's fields from a client's dates and events (an event's date standing in for one not given); the bus checks the rest. */
function spanOf(ctx: ApiContext, worldId: string, p: { from?: string | number; until?: string | number; fromEventId?: string; untilEventId?: string }) {
  const m = ctx.models
  const [begin, finish] = [p.fromEventId && m.event(p.fromEventId), p.untilEventId && m.event(p.untilEventId)]
  const start = p.from !== undefined ? m.when(worldId, p.from) : begin ? begin.start : null
  const end = p.until !== undefined ? m.when(worldId, p.until) : finish ? (finish.end ?? finish.start) : null
  return { start, end, startEventId: begin ? begin.id : null, endEventId: finish ? finish.id : null }
}

const Who = z.array(z.string()).describe('Characters’ and factions’ ids: who took part')

/** Where notes go, by the kind of thing an id names. */
function notesTarget(ctx: ApiContext, id: string): { type: string; notes: string; name: string } {
  const data = ctx.models.data()
  const node = data.nodes.find((n) => n.id === id)
  if (node) return { type: 'node.update', notes: node.notes, name: node.name }
  const region = data.regions.find((r) => r.id === id)
  if (region) return { type: 'region.update', notes: region.notes, name: region.name }
  const t = data.timeline
  const lists: [string, { id: string; notes: string; name?: string; title?: string }[]][] = [
    ['event.update', t.events],
    ['structure.update', t.structures],
    ['character.update', t.characters],
    ['species.update', t.lifeforms],
    ['theme.update', t.themes],
    ['group.update', t.groups],
    ['era.update', t.eras],
    ['faction.update', t.factions]
  ]
  for (const [type, list] of lists) {
    const r = list.find((x) => x.id === id)
    if (r) return { type, notes: r.notes, name: r.name ?? r.title ?? '' }
  }
  throw new ApiError(404, `Nothing with notes has the id ${id}`)
}

/** Operations that change the project: each one undoable in one step, tagged as the AI's, and held for review in review mode. */
export const WRITES = [
  operation({
    name: 'create_event',
    title: 'Create an event',
    description: 'Adds an event to a world’s timeline: a title, when (a moment, or a span with an end), where (regions and/or points), who took part (characters and factions), notes and tags. Returns its id.',
    input: z.object({
      worldId: z.string(),
      title: z.string().min(1).max(200),
      start: When,
      end: When.optional().describe('For a span; leave out for a moment'),
      precision: z.enum(PRECISIONS).optional().describe('How exactly the date is known; taken from how start is written by default'),
      notes: Notes.optional(),
      tags: Tags.optional(),
      regionIds: z.array(z.string()).optional(),
      places: z.array(Place).optional(),
      lane: z.string().optional().describe('A lane by name; made if the world has none called that'),
      color: HexColor.optional(),
      who: Who.optional()
    }),
    route: { method: 'POST', path: '/worlds/:worldId/events' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      const view = m.world(p.worldId)
      const start = m.parse(p.worldId, p.start)
      const end = p.end === undefined ? null : m.when(p.worldId, p.end)
      if (end !== null && end < start.t) throw new ApiError(400, 'The event ends before it starts')
      for (const id of p.regionIds ?? []) m.region(p.worldId, id)
      const id = newId()
      const precision = p.precision ?? start.precision
      const lane = laneFor(view, p.lane)
      const event: Command = {
        type: 'event.create',
        payload: {
          id,
          ownerId: p.worldId,
          title: p.title,
          start: start.t,
          end,
          precision,
          laneId: lane.laneId,
          ...(p.color && { color: p.color }),
          ...notesAndTags(p),
          locations: [...(p.regionIds ?? []).map((regionId) => ({ kind: 'region' as const, regionId })), ...(p.places ?? []).map((pl) => ({ kind: 'point' as const, ...pl }))],
          ...(p.who && { participants: p.who.map((x) => partyOf(view, x)) })
        }
      }
      return write(ctx, [...lane.commands, event], `Added the event “${p.title}” (${m.date(p.worldId, start.t, precision)})`, { eventId: id })
    }
  }),
  operation({
    name: 'update_event',
    title: 'Edit an event',
    description: 'Changes an event’s title, dates, tags, notes (they replace what’s there; use update_note to add to them) or who took part (the whole list).',
    input: z.object({ eventId: z.string(), title: z.string().min(1).max(200).optional(), start: When.optional(), end: z.union([When, z.null()]).optional(), tags: Tags.optional(), notes: Notes.optional(), who: Who.optional() }),
    route: { method: 'POST', path: '/events/:eventId' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      const e = m.event(p.eventId)
      const start = p.start === undefined ? undefined : m.parse(e.ownerId, p.start)
      const patch = {
        ...(p.title && { title: p.title }),
        ...(start && { start: start.t, precision: start.precision }),
        ...(p.end !== undefined && { end: p.end === null ? null : m.when(e.ownerId, p.end) }),
        ...notesAndTags(p),
        ...(p.who && { participants: p.who.map((x) => partyOf(m.world(e.ownerId), x)) })
      }
      return write(ctx, [{ type: 'event.update', payload: { id: e.id, patch } }], `Edited the event “${p.title ?? e.title}”`)
    }
  }),
  operation({
    name: 'link_events',
    title: 'Link two events',
    description: 'Says how two events on a world relate: one causes, enables, prevents or precedes the other, or they’re related.',
    input: z.object({ fromId: z.string(), toId: z.string(), type: z.enum(LINK_TYPES), note: z.string().optional() }),
    route: { method: 'POST', path: '/event-links' },
    write: true,
    run: (ctx, p) => {
      const [a, b] = [ctx.models.event(p.fromId), ctx.models.event(p.toId)]
      const id = newId()
      return write(ctx, [{ type: 'link.create', payload: { id, fromId: a.id, toId: b.id, type: p.type, ...(p.note && { note: p.note }) } }], `“${a.title}” ${p.type} “${b.title}”`, { linkId: id })
    }
  }),
  operation({
    name: 'group_events',
    title: 'Group events',
    description: 'Gathers events of one world into a named group ("The Great War"); its span is theirs.',
    input: z.object({ title: z.string().min(1).max(200), eventIds: z.array(z.string()).min(1) }),
    route: { method: 'POST', path: '/event-groups' },
    write: true,
    run: (ctx, p) => {
      const events = p.eventIds.map((id) => ctx.models.event(id))
      const id = newId()
      return write(ctx, [{ type: 'group.create', payload: { id, ownerId: events[0]!.ownerId, title: p.title, eventIds: p.eventIds } }], `Grouped ${events.length} events as “${p.title}”`, { groupId: id })
    }
  }),
  operation({
    name: 'create_era',
    title: 'Create an era',
    description: 'Adds an era (a named age: "The Long Winter") to a world’s timeline, from one date to another. Power systems can then be described age by age (describe_power_age).',
    input: z.object({ worldId: z.string(), name: z.string().min(1).max(200), start: When, end: When, color: HexColor.optional(), notes: Notes.optional() }),
    route: { method: 'POST', path: '/worlds/:worldId/eras' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      m.world(p.worldId)
      const [start, end] = [m.when(p.worldId, p.start), m.when(p.worldId, p.end)]
      if (end < start) throw new ApiError(400, 'The era ends before it starts')
      const id = newId()
      const payload = { id, ownerId: p.worldId, name: p.name, start, end, ...(p.color && { color: p.color }), ...notesAndTags(p) }
      return write(ctx, [{ type: 'era.create', payload }], `Added the era ${p.name} (${m.date(p.worldId, start, 'year')} to ${m.date(p.worldId, end, 'year')})`, { eraId: id })
    }
  }),
  operation({
    name: 'add_event_effect',
    title: 'Give an event an effect',
    description:
      'What an event does to structures at its start: build, damage or repair them (by condition points 0–100), destroy them, start or stop their maintenance, or rename or rebuild them. Targets: listed structures, everything in a region, or everything within km of the event’s place.',
    input: z.object({
      eventId: z.string(),
      type: z.enum(EFFECT_TYPES),
      structureIds: z.array(z.string()).optional(),
      regionId: z.string().optional(),
      radiusKm: z.number().positive().optional(),
      falloff: z.boolean().optional().describe('With radiusKm: weaker toward the edge'),
      amount: z.number().min(0).max(100).optional(),
      maintained: z.boolean().optional().describe('set_maintenance: maintained (true) or left to weather (false)'),
      rename: z.string().min(1).max(200).optional().describe('modify: the new name'),
      blueprint: z.string().optional().describe('modify: the new blueprint, by name or id'),
      onlyTags: Tags.optional(),
      onlyMaterials: z.array(z.enum(MATERIALS)).optional()
    }),
    route: { method: 'POST', path: '/events/:eventId/effects' },
    write: true,
    run: (ctx, p) => {
      const e = ctx.models.event(p.eventId)
      const target = p.structureIds
        ? { kind: 'structures' as const, ids: p.structureIds }
        : p.regionId
          ? { kind: 'region' as const, regionId: ctx.models.region(e.ownerId, p.regionId).id }
          : p.radiusKm
            ? { kind: 'radius' as const, km: p.radiusKm, falloff: p.falloff ?? true }
            : undefined
      if (!target) throw new ApiError(400, 'Say what it reaches: structureIds, a regionId, or a radiusKm around the event')
      const id = newId()
      return write(
        ctx,
        [
          {
            type: 'effect.create',
            payload: {
              id,
              eventId: e.id,
              type: p.type,
              target,
              filter: { tags: p.onlyTags ?? [], materials: p.onlyMaterials ?? [] },
              ...(p.amount !== undefined && { amount: p.amount }),
              ...(p.maintained !== undefined && { maintained: p.maintained }),
              ...(p.rename && { rename: p.rename }),
              ...(p.blueprint && { blueprintId: blueprintId(ctx, p.blueprint) })
            }
          }
        ],
        `“${e.title}” now has a ${p.type.replace('_', ' ')} effect`,
        { effectId: id }
      )
    }
  }),
  operation({
    name: 'create_structure',
    title: 'Place a structure',
    description: 'Builds a structure on a world from a blueprint (list_blueprints): where (a place, or the middle of a region), when it was built, and whether it’s maintained (castles usually are; standing stones weather).',
    input: z.object({
      worldId: z.string(),
      name: z.string().min(1).max(200),
      blueprint: z.string().describe('A blueprint’s name or id'),
      builtAt: When,
      place: Place.optional(),
      regionId: z.string().optional(),
      maintained: z.boolean().optional(),
      neverDecays: z.boolean().optional(),
      scale: z.number().positive().max(20).optional(),
      notes: Notes.optional(),
      tags: Tags.optional()
    }),
    route: { method: 'POST', path: '/worlds/:worldId/structures' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      m.world(p.worldId)
      const at = placeOf(ctx, p.worldId, p.place, p.regionId)
      const id = newId()
      const builtAt = m.when(p.worldId, p.builtAt)
      return write(
        ctx,
        [
          {
            type: 'structure.create',
            payload: {
              id,
              ownerId: p.worldId,
              name: p.name,
              blueprintId: blueprintId(ctx, p.blueprint),
              lat: at.lat,
              lon: at.lon,
              builtAt,
              ...(p.maintained !== undefined && { maintained: p.maintained }),
              ...(p.neverDecays !== undefined && { neverDecays: p.neverDecays }),
              ...(p.scale && { scale: p.scale }),
              ...notesAndTags(p)
            }
          }
        ],
        `Built ${p.name} (${m.date(p.worldId, builtAt, 'year')})`,
        { structureId: id }
      )
    }
  }),
  operation({
    name: 'set_maintenance',
    title: 'Maintain a structure, or stop',
    description: 'From a moment on, a structure is maintained (kept in repair) or left to weather; optionally because of an event.',
    input: z.object({ structureId: z.string(), at: When, maintained: z.boolean(), causeEventId: z.string().optional() }),
    route: { method: 'POST', path: '/structures/:structureId/maintenance' },
    write: true,
    run: (ctx, p) => {
      const s = ctx.models.structure(p.structureId)
      const at = ctx.models.when(s.ownerId, p.at)
      return write(
        ctx,
        [{ type: 'maintenance.set', payload: { structureId: s.id, at, maintained: p.maintained, ...(p.causeEventId && { causeEventId: ctx.models.event(p.causeEventId).id }) } }],
        `${s.name} is ${p.maintained ? 'maintained' : 'left to weather'} from ${ctx.models.date(s.ownerId, at, 'year')}`
      )
    }
  }),
  operation({
    name: 'create_character',
    title: 'Create a character',
    description: 'Adds a person to a world: born (and died) when, born where (a place or a region’s middle), with notes and tags.',
    input: z.object({ worldId: z.string(), name: z.string().min(1).max(200), born: When, died: When.optional(), place: Place.optional(), regionId: z.string().optional(), notes: Notes.optional(), tags: Tags.optional() }),
    route: { method: 'POST', path: '/worlds/:worldId/characters' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      m.world(p.worldId)
      const born = m.when(p.worldId, p.born)
      const at = placeOf(ctx, p.worldId, p.place, p.regionId)
      const id = newId()
      return write(
        ctx,
        [
          {
            type: 'character.create',
            payload: {
              id,
              ownerId: p.worldId,
              name: p.name,
              born,
              died: p.died === undefined ? null : m.when(p.worldId, p.died),
              stops: [{ at: born, lat: at.lat, lon: at.lon, travel: 0, eventId: null }],
              ...notesAndTags(p)
            }
          }
        ],
        `Added the character ${p.name}`,
        { characterId: id }
      )
    }
  }),
  operation({
    name: 'create_faction',
    title: 'Create a faction',
    description: `Adds a faction to a world: a kingdom, empire, house, clan, guild, order, faith, company or band (${FACTION_KINDS.join(', ')}), founded and dissolved when (or by which events), part of another faction (a house in a kingdom), with an emblem (an emoji or a letter or two), a summary and notes. Then add_member, hold_region and set_relationship.`,
    input: z.object({
      worldId: z.string(),
      name: z.string().min(1).max(200),
      kind: z.enum(FACTION_KINDS),
      founded: When.optional(),
      dissolved: When.optional(),
      foundedBy: z.string().optional().describe('The event that founded it'),
      dissolvedBy: z.string().optional().describe('The event that ended it'),
      partOf: z.string().optional().describe('The faction it belongs to, by name or id'),
      emblem: z.string().max(8).optional(),
      color: HexColor.optional(),
      summary: z.string().max(2000).optional(),
      notes: Notes.optional(),
      tags: Tags.optional()
    }),
    route: { method: 'POST', path: '/worlds/:worldId/factions' },
    write: true,
    run: (ctx, p) => {
      const view = ctx.models.world(p.worldId)
      const id = newId()
      const span = spanOf(ctx, p.worldId, { from: p.founded, until: p.dissolved, fromEventId: p.foundedBy, untilEventId: p.dissolvedBy })
      const payload = {
        id,
        ownerId: view.node.id,
        name: p.name,
        kind: p.kind,
        ...span,
        ...(p.partOf && { parentId: factionNamed(view, p.partOf).id }),
        ...(p.emblem && { emblem: p.emblem }),
        ...(p.color && { color: p.color }),
        ...(p.summary && { summary: p.summary }),
        ...notesAndTags(p)
      }
      return write(ctx, [{ type: 'faction.create', payload }], `Added the faction ${p.name}`, { factionId: id })
    }
  }),
  operation({
    name: 'update_faction',
    title: 'Edit a faction',
    description: 'Changes a faction’s name, kind, emblem, colour, summary, notes, what it’s part of (null: nothing), or when it was founded or dissolved (null: from the start, or still). Notes replace what’s there.',
    input: z.object({
      factionId: z.string(),
      name: z.string().min(1).max(200).optional(),
      kind: z.enum(FACTION_KINDS).optional(),
      founded: z.union([When, z.null()]).optional(),
      dissolved: z.union([When, z.null()]).optional(),
      partOf: z.union([z.string(), z.null()]).optional(),
      emblem: z.string().max(8).optional(),
      color: HexColor.optional(),
      summary: z.string().max(2000).optional(),
      notes: Notes.optional(),
      tags: Tags.optional()
    }),
    route: { method: 'POST', path: '/factions/:factionId' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      const f = findOr404(m.data().timeline.factions, p.factionId, 'faction')
      const view = m.world(f.ownerId)
      const date = (w: string | number | null) => (w === null ? null : m.when(f.ownerId, w))
      const patch = {
        ...(p.name && { name: p.name }),
        ...(p.kind && { kind: p.kind }),
        ...(p.founded !== undefined && { start: date(p.founded) }),
        ...(p.dissolved !== undefined && { end: date(p.dissolved) }),
        ...(p.partOf !== undefined && { parentId: p.partOf === null ? null : factionNamed(view, p.partOf).id }),
        ...(p.emblem !== undefined && { emblem: p.emblem }),
        ...(p.color && { color: p.color }),
        ...(p.summary !== undefined && { summary: p.summary }),
        ...notesAndTags(p)
      }
      return write(ctx, [{ type: 'faction.update', payload: { id: f.id, patch } }], `Edited the faction ${p.name ?? f.name}`)
    }
  }),
  operation({
    name: 'add_member',
    title: 'Add someone to a faction',
    description: 'Makes a character a member of a faction, perhaps with a role ("king", "master of coin"), from a date (or the event that made them one) until another (or for good). To end one, set its `end` with run_commands (membership.update).',
    input: z.object({ factionId: z.string(), characterId: z.string(), role: z.string().max(100).optional(), ...SpanInput }),
    route: { method: 'POST', path: '/factions/:factionId/members' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      const f = findOr404(m.data().timeline.factions, p.factionId, 'faction')
      const c = findOr404(m.world(f.ownerId).timeline.characters, p.characterId, 'character on that world')
      const id = newId()
      const payload = { id, factionId: f.id, characterId: c.id, ...(p.role && { role: p.role }), ...spanOf(ctx, f.ownerId, p) }
      return write(ctx, [{ type: 'membership.create', payload }], `${c.name} joins ${f.name}${p.role ? ` as ${p.role}` : ''}`, { membershipId: id })
    }
  }),
  operation({
    name: 'hold_region',
    title: 'Give a faction a region',
    description: 'Says a faction holds a region (its territory) from a date (or the event it was taken in) until another (or still). A region changing hands is one holding ending when the next begins.',
    input: z.object({ factionId: z.string(), regionId: z.string(), ...SpanInput }),
    route: { method: 'POST', path: '/factions/:factionId/territory' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      const f = findOr404(m.data().timeline.factions, p.factionId, 'faction')
      const region = m.region(f.ownerId, p.regionId)
      const id = newId()
      return write(ctx, [{ type: 'holding.create', payload: { id, factionId: f.id, regionId: region.id, ...spanOf(ctx, f.ownerId, p) } }], `${f.name} holds ${region.name}`, { holdingId: id })
    }
  }),
  operation({
    name: 'set_relationship',
    title: 'Relate two characters or factions',
    description: `Says how two characters or factions (or one of each) on a world stand: ${RELATION_TYPES.join(', ')}. For parent, mentor and liege, \`fromId\` is the parent, mentor or liege of \`toId\`; the others read the same both ways. A label of its own ("sworn brother") reads instead of the type. From a date (or event) until another (or still).`,
    input: z.object({ fromId: z.string(), toId: z.string(), type: z.enum(RELATION_TYPES), label: z.string().max(100).optional(), note: z.string().max(2000).optional(), ...SpanInput }),
    route: { method: 'POST', path: '/relationships' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      const t = m.data().timeline
      const owner = (t.characters.find((c) => c.id === p.fromId) ?? t.factions.find((f) => f.id === p.fromId))?.ownerId
      if (!owner) throw new ApiError(404, `There is no character or faction ${p.fromId}`)
      const view = m.world(owner)
      const [from, to] = [partyOf(view, p.fromId), partyOf(view, p.toId)]
      const id = newId()
      const payload = { id, ownerId: owner, from, to, type: p.type, ...(p.label && { label: p.label }), ...(p.note && { note: p.note }), ...spanOf(ctx, owner, p) }
      return write(ctx, [{ type: 'relationship.create', payload }], `${partyName(view, from)} and ${partyName(view, to)}: ${p.label || p.type}`, { relationshipId: id })
    }
  }),
  operation({
    name: 'create_region',
    title: 'Draw a region',
    description: 'Adds a named region (a country, a forest, a sea) to a world, as an outline of at least three points.',
    input: z.object({ worldId: z.string(), name: z.string().min(1).max(200), points: z.array(Place).min(3), notes: Notes.optional() }),
    route: { method: 'POST', path: '/worlds/:worldId/regions' },
    write: true,
    run: (ctx, p) => {
      ctx.models.world(p.worldId)
      const id = newId()
      return write(ctx, [{ type: 'region.create', payload: { id, worldId: p.worldId, name: p.name, points: p.points, ...notesAndTags(p) } }], `Drew the region ${p.name}`, {
        regionId: id
      })
    }
  }),
  operation({
    name: 'update_note',
    title: 'Write notes',
    description: 'Replaces or adds to the notes of anything that has them: a world or other node, a region, an event, a structure, a character, a species, a theme, an event group, an era or a faction.',
    input: z.object({ id: z.string(), text: Notes, mode: z.enum(['replace', 'append']).optional() }),
    route: { method: 'POST', path: '/notes/:id' },
    write: true,
    run: (ctx, p) => {
      const target = notesTarget(ctx, p.id)
      const notes = (p.mode === 'append' ? target.notes : '') + textToHtml(p.text)
      return write(ctx, [{ type: target.type, payload: { id: p.id, patch: { notes } } } as Command], `${p.mode === 'append' ? 'Added to' : 'Wrote'} the notes of ${target.name}`)
    }
  }),
  operation({
    name: 'create_species',
    title: 'Create a species',
    description: 'Adds a species to a world’s life: flora, fauna or fungi, its diet, the biomes it lives in (by name: Tundra, Temperate forest, Desert…), and what it eats (other species on the world).',
    input: z.object({
      worldId: z.string(),
      name: z.string().min(1).max(200),
      kind: z.enum(SPECIES_KINDS),
      diet: z.enum(DIETS),
      biomes: z.array(z.union([z.string(), z.number()])).optional(),
      eats: z.array(z.string()).optional().describe('Ids of species it eats'),
      notes: Notes.optional(),
      tags: Tags.optional()
    }),
    route: { method: 'POST', path: '/worlds/:worldId/species' },
    write: true,
    run: (ctx, p) => {
      const view = ctx.models.world(p.worldId)
      const biomes = biomeIds(p.biomes ?? [])
      for (const prey of p.eats ?? []) findOr404(view.timeline.lifeforms, prey, 'species on that world')
      const id = newId()
      return write(
        ctx,
        [
          { type: 'species.create', payload: { id, ownerId: p.worldId, name: p.name, kind: p.kind, diet: p.diet, biomes, ...notesAndTags(p) } },
          ...(p.eats ?? []).map((prey): Command => ({ type: 'ecolink.create', payload: { fromId: id, toId: prey, type: 'eats' } }))
        ],
        `Added the species ${p.name}`,
        { speciesId: id }
      )
    }
  }),
  operation({
    name: 'link_species',
    title: 'Link two species',
    description: 'A food-web link on a world: one species eats, pollinates, lives in symbiosis with or competes with another.',
    input: z.object({ fromId: z.string(), toId: z.string(), type: z.enum(ECO_LINK_TYPES) }),
    route: { method: 'POST', path: '/species-links' },
    write: true,
    run: (ctx, p) => {
      const all = ctx.models.data().timeline.lifeforms
      const [a, b] = [findOr404(all, p.fromId, 'species'), findOr404(all, p.toId, 'species')]
      const id = newId()
      return write(ctx, [{ type: 'ecolink.create', payload: { id, fromId: a.id, toId: b.id, type: p.type } }], `${a.name} ${p.type} ${b.name}`, { linkId: id })
    }
  }),
  operation({
    name: 'create_power_system',
    title: 'Create a power system',
    description: `Adds a power system to a world: how its magic, divine gifts, psionics, technology, politics or anything else works. A kind (${POWER_TEMPLATES.join(', ')}) starts it with questions to answer (magic: ${POWER_TEMPLATE_INFO.magic.aspects.map((a) => a.label).join(', ')}); answer them for every age in \`always\`, and use describe_power_age for what's different in an era.`,
    input: z.object({
      worldId: z.string(),
      kind: z.enum(POWER_TEMPLATES),
      name: z.string().min(1).max(200).optional(),
      summary: z.string().max(2000).optional().describe('What it is, in a line'),
      always: Answers.optional(),
      notes: Notes.optional()
    }),
    route: { method: 'POST', path: '/worlds/:worldId/powers' },
    write: true,
    run: (ctx, p) => {
      const view = ctx.models.world(p.worldId)
      const { aspects, values } = answered(POWER_TEMPLATE_INFO[p.kind].aspects, {}, p.always ?? {})
      const id = newId()
      const name = p.name ?? POWER_TEMPLATE_INFO[p.kind].name
      const payload = { id, ownerId: view.node.id, template: p.kind, name, aspects, values, ...(p.summary && { summary: p.summary }), ...notesAndTags(p) }
      return write(ctx, [{ type: 'power.create', payload }], `Added the power system ${name}`, { systemId: id })
    }
  }),
  operation({
    name: 'update_power_system',
    title: 'Edit a power system',
    description: 'Changes a power system’s name, summary, notes, or what holds in every age (answers by question; others stay as they are).',
    input: z.object({
      systemId: z.string(),
      name: z.string().min(1).max(200).optional(),
      summary: z.string().max(2000).optional(),
      always: Answers.optional(),
      notes: Notes.optional()
    }),
    route: { method: 'POST', path: '/powers/:systemId' },
    write: true,
    run: (ctx, p) => {
      const system = findOr404(ctx.models.data().timeline.powers, p.systemId, 'power system')
      const patch = { ...(p.name && { name: p.name }), ...(p.summary !== undefined && { summary: p.summary }), ...(p.always && answered(system.aspects, system.values, p.always)), ...notesAndTags(p) }
      return write(ctx, [{ type: 'power.update', payload: { id: system.id, patch } }], `Edited the power system ${p.name ?? system.name}`)
    }
  }),
  operation({
    name: 'describe_power_age',
    title: 'Describe a power system in an age',
    description: 'Says how a power system is different in one of its world’s eras (by name or id): a line on how things stand then, how strong or widespread it is (0–1, or null to unsay it), and answers that differ from what always holds (by question). What isn’t said stays as it was.',
    input: z.object({
      systemId: z.string(),
      era: z.string().describe('The era’s name or id'),
      summary: z.string().max(2000).optional(),
      strength: z.number().min(0).max(1).nullable().optional(),
      changes: Answers.optional()
    }),
    route: { method: 'POST', path: '/powers/:systemId/ages' },
    write: true,
    run: (ctx, p) => {
      const system = findOr404(ctx.models.data().timeline.powers, p.systemId, 'power system')
      const { eras, powerAges } = ctx.models.world(system.ownerId).timeline
      const era = eras.find((e) => e.id === p.era) ?? eras.find((e) => e.name.toLowerCase() === p.era.trim().toLowerCase())
      if (!era) throw new ApiError(404, `There is no era ${p.era} on that world${eras.length ? ` (its eras: ${eras.map((e) => e.name).join(', ')})` : ': add one with create_era'}`)
      const age = powerAges.find((a) => a.systemId === system.id && a.eraId === era.id)
      const commands: Command[] = []
      let values: AspectValues | undefined
      if (p.changes) {
        const next = answered(system.aspects, age?.values ?? {}, p.changes)
        values = next.values
        // A question the system didn't ask is one it asks now (with nothing that always holds).
        if (next.aspects.length !== system.aspects.length) commands.push({ type: 'power.update', payload: { id: system.id, patch: { aspects: next.aspects } } })
      }
      const patch = { ...(p.summary !== undefined && { summary: p.summary }), ...(p.strength !== undefined && { strength: p.strength }), ...(values && { values }) }
      commands.push({ type: 'powerAge.set', payload: { systemId: system.id, eraId: era.id, patch } })
      return write(ctx, commands, `Described ${system.name} in ${era.name}`)
    }
  }),
  operation({
    name: 'report_inconsistency',
    title: 'Report an inconsistency',
    description:
      'Flags something on a world that doesn’t fit with the rest: a contradiction (two things that can’t both be true), something unlikely (possible, but at odds with how the world works: its powers in that age, its calendar, its geography), or a question for the author. Say what it’s about (the ids of the events, characters, regions, structures, power systems… involved), explain why in a few sentences, and suggest a fix if there is one. It shows in the app’s Warnings with marks on what it’s about; it doesn’t change the world. One already reported (open, or dismissed as not a problem) isn’t reported again.',
    input: z.object({
      worldId: z.string(),
      severity: z.enum(FINDING_SEVERITIES),
      title: z.string().min(1).max(200).describe('What’s wrong, in a line ("Mira is in Tarn and Vel on the same day")'),
      explanation: z.string().min(1).max(20_000),
      about: z.array(z.object({ kind: z.enum(FINDING_KINDS), id: z.string() })).max(20).describe('What it’s about'),
      suggestion: z.string().max(20_000).optional()
    }),
    route: { method: 'POST', path: '/worlds/:worldId/inconsistencies' },
    write: true,
    run: (ctx, p) => {
      const view = ctx.models.world(p.worldId)
      const missing = p.about.filter((r) => refName(ctx.models, view, r) === undefined)
      if (missing.length) throw new ApiError(404, `Nothing on that world is ${missing.map((r) => `${r.kind} ${r.id}`).join(', ')}`)
      const before = sameFinding(view.timeline.findings, p.title)
      if (before) return { status: 'already reported', findingId: before.id, findingStatus: before.status, summary: before.status === 'dismissed' ? 'The author dismissed this as not a problem' : 'This is already open in Warnings' }
      const id = newId()
      const payload = { id, ownerId: view.node.id, severity: p.severity, title: p.title, explanation: p.explanation, refs: p.about, reporter: 'Claude', ...(p.suggestion && { suggestion: p.suggestion }) }
      return write(ctx, [{ type: 'finding.create', payload }], `Flagged: ${p.title}`, { findingId: id }, { advice: true })
    }
  }),
  operation({
    name: 'resolve_inconsistency',
    title: 'Resolve an inconsistency',
    description: 'Marks a reported inconsistency as resolved (fixed: say how), dismissed (not a problem after all), or open again.',
    input: z.object({ findingId: z.string(), status: z.enum(['resolved', 'dismissed', 'open']), note: z.string().max(2000).optional() }),
    route: { method: 'POST', path: '/inconsistencies/:findingId' },
    write: true,
    run: (ctx, p) => {
      const f = findOr404(ctx.models.data().timeline.findings, p.findingId, 'reported inconsistency')
      const patch = { status: p.status, ...(p.note !== undefined && { note: p.note }) }
      return write(ctx, [{ type: 'finding.update', payload: { id: f.id, patch } }], `${p.status === 'open' ? 'Reopened' : p.status === 'resolved' ? 'Resolved' : 'Dismissed'}: ${f.title}`, {}, { advice: true })
    }
  }),
  operation({
    name: 'create_theme',
    title: 'Create a theme',
    description: `Adds a theme (the look and tone of an age) to the project’s library, from a preset (${Object.keys(THEME_PRESETS).join(', ')}) or from scratch: palette, lighting, haze, type, mood words, a prose style guide for writing about it, ambience.`,
    input: z.object({
      name: z.string().min(1).max(200),
      preset: z.enum(Object.keys(THEME_PRESETS) as [string, ...string[]]).optional(),
      palette: z.object({ sky: HexColor, water: HexColor, land: HexColor, accent: HexColor }).optional(),
      lighting: z.enum(LIGHTING_PRESETS).optional(),
      atmosphere: z.number().min(0).max(1).optional().describe('How hazy the air is, 0–1'),
      typography: z.enum(TYPOGRAPHY).optional(),
      mood: Tags.optional(),
      style: z.string().max(4000).optional().describe('How to write about this age: voice, tense, words to use and avoid'),
      ambience: Tags.optional(),
      notes: Notes.optional()
    }),
    route: { method: 'POST', path: '/themes' },
    write: true,
    run: (ctx, { notes, ...p }) => {
      const id = newId()
      return write(ctx, [{ type: 'theme.create', payload: { id, ownerId: ctx.models.project().rootId, ...p, ...(notes && { notes: textToHtml(notes) }) } }], `Added the theme ${p.name}`, { themeId: id })
    }
  }),
  operation({
    name: 'assign_theme_span',
    title: 'Put a theme on a world',
    description: 'Puts a theme on a world (or one of its regions) from one date to another, fading in and out over some years; where spans overlap, the higher priority shows on top.',
    input: z.object({
      worldId: z.string(),
      themeId: z.string(),
      start: When,
      end: When,
      regionId: z.string().optional(),
      priority: z.number().int().min(-100).max(100).optional(),
      fadeInYears: z.number().min(0).optional(),
      fadeOutYears: z.number().min(0).optional()
    }),
    route: { method: 'POST', path: '/worlds/:worldId/theme-spans' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      m.world(p.worldId)
      const theme = findOr404(m.data().timeline.themes, p.themeId, 'theme')
      if (p.regionId) m.region(p.worldId, p.regionId)
      const [start, end] = [m.when(p.worldId, p.start), m.when(p.worldId, p.end)]
      const year = secondsPerYear(m.calendar(p.worldId))
      const id = newId()
      return write(
        ctx,
        [
          {
            type: 'themeSpan.create',
            payload: {
              id,
              ownerId: p.worldId,
              themeId: theme.id,
              start,
              end,
              regionId: p.regionId ?? null,
              priority: p.priority ?? 0,
              blendIn: (p.fadeInYears ?? 0) * year,
              blendOut: (p.fadeOutYears ?? 0) * year
            }
          }
        ],
        `${theme.name} from ${m.date(p.worldId, start, 'year')} to ${m.date(p.worldId, end, 'year')}`,
        { themeSpanId: id }
      )
    }
  }),
  operation({
    name: 'create_star_system',
    title: 'Create a star system',
    description: 'Adds a star system to a galaxy, optionally with its star’s mass (in Suns; brightness follows).',
    input: z.object({ galaxyId: z.string(), name: z.string().min(1).max(200), massSun: z.number().min(0.08).max(100).optional() }),
    route: { method: 'POST', path: '/star-systems' },
    write: true,
    run: (ctx, p) => {
      if (ctx.models.node(p.galaxyId).kind !== 'galaxy') throw new ApiError(400, 'A star system goes in a galaxy')
      const id = newId()
      const commands: Command[] = [{ type: 'node.create', payload: { id, parentId: p.galaxyId, kind: 'star_system', name: p.name } }]
      if (p.massSun) commands.push({ type: 'star.set', payload: { systemId: id, star: { massSun: p.massSun, luminositySun: luminosityOf(p.massSun) } } })
      return write(ctx, commands, `Added the star system ${p.name}`, { systemId: id })
    }
  }),
  operation({
    name: 'create_world',
    title: 'Create a world',
    description:
      'Adds a planet to a star system with a world surface to build on, optionally at a distance from its star (AU) and grown from a seed word (any text: the same text grows the same planet). Returns the world’s id.',
    input: z.object({ systemId: z.string(), name: z.string().min(1).max(200), distanceAu: z.number().positive().max(1000).optional(), seed: z.string().min(1).max(200).optional() }),
    route: { method: 'POST', path: '/worlds' },
    write: true,
    run: (ctx, p) => {
      if (ctx.models.node(p.systemId).kind !== 'star_system') throw new ApiError(400, 'A world’s planet goes in a star system')
      const [bodyId, worldId] = [newId(), newId()]
      const seeded = p.seed ? readSeed(p.seed) : undefined
      const commands: Command[] = [
        { type: 'node.create', payload: { id: bodyId, parentId: p.systemId, kind: 'body', name: p.name } },
        { type: 'node.create', payload: { id: worldId, parentId: bodyId, kind: 'world', name: `${p.name} Surface`, ...(seeded && { seed: seeded.seed }) } }
      ]
      if (seeded) commands.push({ type: 'world.update', payload: { id: worldId, patch: { seedText: p.seed!.trim(), radiusKm: seeded.radiusKm, terrain: seeded.terrain } } })
      if (p.distanceAu) commands.push({ type: 'orbit.set', payload: { bodyId, orbit: { ...EARTH_ORBIT, semiMajorAxisKm: p.distanceAu * AU_KM } } })
      return write(ctx, commands, `Added the world ${p.name}`, { bodyId, worldId })
    }
  }),
  operation({
    name: 'run_commands',
    title: 'Run commands',
    description:
      'Runs any of the app’s commands (describe_commands lists them and gives each one’s schema) as one undoable step: for what the other tools don’t cover, such as renaming, moving, editing or deleting things. Times are seconds on the world’s timeline; notes are HTML.',
    input: z.object({ commands: z.array(z.record(z.string(), z.unknown())).min(1).max(500), summary: z.string().min(1).max(300).describe('What these do, in a few words, for the user') }),
    route: { method: 'POST', path: '/commands' },
    write: true,
    destructive: true,
    run: (ctx, p) => {
      // What the commands are, not only what the client says they do: in review mode this is what the user decides on.
      // Batches inside are counted through, so one can't hide what it holds behind "batch".
      const counts = new Map<string, number>()
      for (const type of commandTypes(p.commands)) counts.set(type, (counts.get(type) ?? 0) + 1)
      const listed = [...counts].map(([type, n]) => (n > 1 ? `${type} ×${n}` : type))
      return write(ctx, p.commands as unknown as Command[], `${p.summary} [${listed.join(', ')}]`)
    }
  })
]
