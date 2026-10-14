import { SCAR_KINDS, SCAR_LOOKS, scarName, scarWeight, secondsPerYear, stripUndefined } from '@universe/core'
import { z } from 'zod'
import { findOr404 } from './host'
import { Place, When, operation } from './operation'
import { htmlToText, textToHtml } from './text'
import { newId, write } from './writes'

/**
 * Scars on a world's land (core scars.ts) for AI clients: craters, war,
 * fire, drought, radiation and poison, where and when, as the app's 💥 tool
 * and an event's "Leave a scar" make them.
 */

const Kind = z.enum(SCAR_KINDS).describe(SCAR_KINDS.map((k) => `${k}: ${SCAR_LOOKS[k].label}`).join('; '))
const Fields = {
  name: z.string().max(200).optional(),
  radiusKm: z.number().positive().max(20_000).optional().describe('How far it reaches from its middle, in km'),
  regionId: z.string().nullable().optional().describe('Over this region of the world instead of a circle (from list_regions)'),
  eventId: z.string().nullable().optional().describe('The event that made it (from list_events)'),
  recoverYears: z.number().min(0).max(10_000_000).optional().describe('Years it takes to heal after it ends; 0 never heals'),
  strength: z.number().min(0).max(1).optional().describe('How bad it is, 0–1'),
  notes: z.string().max(500_000).optional().describe('Plain text')
}

export const SCAR_OPERATIONS = [
  operation({
    name: 'list_scars',
    title: 'List the scars on a world’s land',
    description:
      'The craters, war-torn, burned, droughted, irradiated and poisoned land of a world: each one’s id, kind, name, place (lat, lon, how far it reaches, or the region it covers), when it came, until when it was at its worst, how long it takes to heal, how bad it is, the event that made it, and how much of it there is at `at` (a date; the playhead if left out).',
    input: z.object({ worldId: z.string(), at: When.optional() }),
    route: { method: 'GET', path: '/worlds/:worldId/scars' },
    run: ({ models: m }, { worldId, at }) => {
      const world = m.world(worldId)
      const t = at === undefined ? m.now(worldId) : m.when(worldId, at)
      const year = secondsPerYear(m.calendar(worldId))
      return {
        date: m.date(worldId, t, 'year'),
        scars: world.timeline.scars.map((s) => ({
          id: s.id,
          kind: s.kind,
          name: scarName(s),
          lat: s.lat,
          lon: s.lon,
          ...(s.regionId ? { regionId: s.regionId } : { radiusKm: s.radiusKm }),
          from: m.date(worldId, s.start, 'year'),
          worstUntil: s.end === null ? 'for good' : m.date(worldId, s.end, 'year'),
          recoverYears: s.recoverYears,
          strength: s.strength,
          now: Math.round(scarWeight(s, t, year) * 100) / 100,
          ...(s.eventId && { eventId: s.eventId }),
          ...(s.notes && { notes: htmlToText(s.notes) })
        }))
      }
    }
  }),
  operation({
    name: 'add_scar',
    title: 'Scar a world’s land',
    description:
      'Leaves a scar on a world’s land at a point (lat, lon), or over a region: a crater from a blast, land torn by war, burned by fire, parched by drought, irradiated or poisoned. It comes at `from`; a crater or a fire is over in a moment, a war or a drought lasts until `until` (for good if left out). Its size, healing time and how bad it is follow its kind unless given. Craters, war and fire damage structures where they reach (a crater destroys those at its heart). Returns its id.',
    input: z.object({ worldId: z.string(), kind: Kind, ...Place.shape, from: When, until: z.union([When, z.null()]).optional().describe('Until when it’s at its worst; null for good'), ...Fields }),
    route: { method: 'POST', path: '/worlds/:worldId/scars' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      m.world(p.worldId)
      const id = newId()
      const payload = {
        id,
        ownerId: p.worldId,
        kind: p.kind,
        lat: p.lat,
        lon: p.lon,
        start: m.when(p.worldId, p.from),
        ...(p.until !== undefined && { end: p.until === null ? null : m.when(p.worldId, p.until) }),
        ...stripUndefined({ name: p.name, radiusKm: p.radiusKm, regionId: p.regionId, eventId: p.eventId, recoverYears: p.recoverYears, strength: p.strength }),
        ...(p.notes && { notes: textToHtml(p.notes) })
      }
      return write(ctx, [{ type: 'scar.create', payload }], `Left ${p.name || SCAR_LOOKS[p.kind].label.toLowerCase()} on the land`, { scarId: id })
    }
  }),
  operation({
    name: 'update_scar',
    title: 'Change a scar on the land',
    description: 'Changes a scar (by its id from list_scars): its kind, name, place, reach, when it came or stops being at its worst, healing, strength, event or notes; what isn’t given stays.',
    input: z.object({
      worldId: z.string(),
      scarId: z.string(),
      kind: Kind.optional(),
      lat: Place.shape.lat.optional(),
      lon: Place.shape.lon.optional(),
      from: When.optional(),
      until: z.union([When, z.null()]).optional(),
      ...Fields
    }),
    route: { method: 'POST', path: '/worlds/:worldId/scars/:scarId' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      const scar = findOr404(m.world(p.worldId).timeline.scars, p.scarId, 'scar')
      const patch = stripUndefined({
        kind: p.kind,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        radiusKm: p.radiusKm,
        regionId: p.regionId,
        eventId: p.eventId,
        recoverYears: p.recoverYears,
        strength: p.strength,
        start: p.from === undefined ? undefined : m.when(p.worldId, p.from),
        notes: p.notes === undefined ? undefined : textToHtml(p.notes)
      })
      const end = p.until === undefined ? {} : { end: p.until === null ? null : m.when(p.worldId, p.until) }
      return write(ctx, [{ type: 'scar.update', payload: { id: scar.id, patch: { ...patch, ...end } } }], `Changed ${scarName({ ...scar, ...patch })}`)
    }
  })
]
