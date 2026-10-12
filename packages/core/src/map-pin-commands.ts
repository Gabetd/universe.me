import { z } from 'zod'
import type { HandlerMap } from './commands'
import { MAP_PIN_COLOR, MapPin } from './map-pins'
import { NewId, create, recordCrud } from './record-kit'
import { Id } from './schema'

const MapPinFields = MapPin.pick({ name: true, lat: true, lon: true, color: true, notes: true })
export type MapPinPatch = Partial<z.infer<typeof MapPinFields>>

const pins = recordCrud('mapPin', MapPinFields)

export const MAP_PIN_COMMANDS = [
  /** A named pin at a point of a world's surface (its owner). */
  z.object({ type: z.literal('mapPin.create'), payload: MapPinFields.partial({ color: true, notes: true }).extend({ ...NewId, ownerId: Id }) }),
  ...pins.commands
] as const

type MapPinCommand = z.infer<(typeof MAP_PIN_COMMANDS)[number]>

export const mapPinHandlers: HandlerMap<MapPinCommand> = {
  'mapPin.create': (store, { id, ownerId, name, lat, lon, color, notes }, ctx) => create(store, 'mapPin', ctx, ownerId, id, { name, lat, lon, color: color ?? MAP_PIN_COLOR, notes: notes ?? '' }),
  'mapPin.update': pins.update,
  'mapPin.delete': pins.delete
}
