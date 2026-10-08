import type { EventLocation, Region } from '@universe/core'

export { eventDates, spanDates } from '@universe/core'

/** "📍 12.3°, 45.6°" for a point, "⬠ Aster" for a region. */
export const locationLabel = (loc: EventLocation, regions: Region[]): string =>
  loc.kind === 'point' ? `📍 ${loc.lat.toFixed(1)}°, ${loc.lon.toFixed(1)}°` : `⬠ ${regions.find((r) => r.id === loc.regionId)?.name ?? 'Deleted region'}`
