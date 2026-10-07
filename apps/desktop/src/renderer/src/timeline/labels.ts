import { formatTime, type EventLocation, type Region, type TimelineEvent } from '@universe/core'

/** "📍 12.3°, 45.6°" for a point, "⬠ Aster" for a region. */
export const locationLabel = (loc: EventLocation, regions: Region[]): string =>
  loc.kind === 'point' ? `📍 ${loc.lat.toFixed(1)}°, ${loc.lon.toFixed(1)}°` : `⬠ ${regions.find((r) => r.id === loc.regionId)?.name ?? 'Deleted region'}`

/** "1204" or "1204 – 1210", at the event's precision. */
export const eventDates = (e: TimelineEvent): string =>
  e.end === null || e.end === e.start ? formatTime(e.start, e.precision) : `${formatTime(e.start, e.precision)} – ${formatTime(e.end, e.precision)}`
