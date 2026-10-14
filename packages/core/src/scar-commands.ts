import { z } from 'zod'
import type { HandlerMap } from './commands'
import { NewId, create, recordCrud } from './record-kit'
import { SCAR_LOOKS, Scar } from './scars'
import { Id } from './schema'

const ScarFields = Scar.pick({ name: true, kind: true, lat: true, lon: true, radiusKm: true, regionId: true, eventId: true, start: true, end: true, recoverYears: true, strength: true, notes: true })
export type ScarPatch = Partial<z.infer<typeof ScarFields>>

const scars = recordCrud('scar', ScarFields)

export const SCAR_COMMANDS = [
  /** A scar on a world's land (its owner) of a kind, at a point (or over a region) from `start`; the rest as its kind has it unless given. */
  z.object({
    type: z.literal('scar.create'),
    payload: ScarFields.partial({ name: true, radiusKm: true, regionId: true, eventId: true, end: true, recoverYears: true, strength: true, notes: true }).extend({ ...NewId, ownerId: Id })
  }),
  ...scars.commands
] as const

type ScarCommand = z.infer<(typeof SCAR_COMMANDS)[number]>

export const scarHandlers: HandlerMap<ScarCommand> = {
  'scar.create': (store, { id, ownerId, ...p }, ctx) => {
    const look = SCAR_LOOKS[p.kind]
    return create(store, 'scar', ctx, ownerId, id, {
      name: p.name ?? '',
      kind: p.kind,
      lat: p.lat,
      lon: p.lon,
      radiusKm: p.radiusKm ?? look.radiusKm,
      regionId: p.regionId ?? null,
      eventId: p.eventId ?? null,
      start: p.start,
      // A blast is over in a moment; a war or a drought goes on until it's given an end.
      end: p.end !== undefined ? p.end : look.lasting ? null : p.start,
      recoverYears: p.recoverYears ?? look.recoverYears,
      strength: p.strength ?? 1,
      notes: p.notes ?? ''
    })
  },
  'scar.update': scars.update,
  'scar.delete': scars.delete
}
