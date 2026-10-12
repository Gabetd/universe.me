import { z } from 'zod'
import { Name, Notes, RecordMeta } from './schema'
import { HexColor, LatLon } from './world'

/**
 * Pins on a world's surface: a named point the user puts anywhere on the
 * globe, the map or the ground (right-click, Add a pin here), with notes of
 * its own. They belong to the world (`ownerId`) and sync with it.
 */
export const MapPin = z.object({
  ...RecordMeta,
  ...LatLon.shape,
  name: Name,
  color: HexColor,
  notes: Notes
})
export type MapPin = z.infer<typeof MapPin>

/** A new pin's colour, until it's given another. */
export const MAP_PIN_COLOR = '#e8524a'
