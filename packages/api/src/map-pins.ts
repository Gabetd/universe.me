import { HexColor, stripUndefined } from '@universe/core'
import { z } from 'zod'
import { findOr404 } from './host'
import { Place, operation } from './operation'
import { htmlToText, textToHtml } from './text'
import { newId, write } from './writes'

/** Pins on a world's surface (core map-pins.ts) for AI clients: what's pinned where, and pinning, naming and moving, as right-clicking the surface does in the app. */

const Fields = { name: z.string().min(1).max(200).optional(), color: HexColor.optional().describe('A #rrggbb colour'), notes: z.string().max(500_000).optional().describe('Plain text') }

export const MAP_PIN_OPERATIONS = [
  operation({
    name: 'list_map_pins',
    title: 'List a world’s pins',
    description: 'The pins the user (or you) put on a world’s surface: each one’s id, name, place (lat, lon), colour and notes.',
    input: z.object({ worldId: z.string() }),
    route: { method: 'GET', path: '/worlds/:worldId/pins' },
    run: ({ models: m }, { worldId }) => ({
      pins: m.world(worldId).timeline.mapPins.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, color: p.color, ...(p.notes && { notes: htmlToText(p.notes) }) }))
    })
  }),
  operation({
    name: 'add_map_pin',
    title: 'Pin a place on a world',
    description: 'Puts a named pin at a point of a world’s surface (lat, lon), with a colour and notes if given. Returns its id.',
    input: z.object({ worldId: z.string(), ...Place.shape, ...Fields, name: z.string().min(1).max(200) }),
    route: { method: 'POST', path: '/worlds/:worldId/pins' },
    write: true,
    run: (ctx, p) => {
      ctx.models.world(p.worldId)
      const id = newId()
      const payload = { id, ownerId: p.worldId, name: p.name, lat: p.lat, lon: p.lon, ...stripUndefined({ color: p.color }), ...(p.notes && { notes: textToHtml(p.notes) }) }
      return write(ctx, [{ type: 'mapPin.create', payload }], `Pinned ${p.name}`, { pinId: id })
    }
  }),
  operation({
    name: 'update_map_pin',
    title: 'Rename, move or note a pin',
    description: 'Changes a pin on a world’s surface (by its id from list_map_pins): its name, place, colour or notes; what isn’t given stays.',
    input: z.object({ worldId: z.string(), pinId: z.string(), lat: Place.shape.lat.optional(), lon: Place.shape.lon.optional(), ...Fields }),
    route: { method: 'POST', path: '/worlds/:worldId/pins/:pinId' },
    write: true,
    run: (ctx, p) => {
      const pin = findOr404(ctx.models.world(p.worldId).timeline.mapPins, p.pinId, 'pin')
      const patch = stripUndefined({ name: p.name, lat: p.lat, lon: p.lon, color: p.color, notes: p.notes === undefined ? undefined : textToHtml(p.notes) })
      return write(ctx, [{ type: 'mapPin.update', payload: { id: pin.id, patch } }], `Changed the pin ${p.name ?? pin.name}`)
    }
  })
]
