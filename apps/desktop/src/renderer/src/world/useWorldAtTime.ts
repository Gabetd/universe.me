import { isActiveAt, regionsAt, type Region } from '@universe/core'
import { useMemo } from 'react'
import { useUi } from '../store'
import { usePlayhead, useTimelineView } from '../timeline/timelineStore'

/** An event's point location, drawn as a pin on the globe and the map. */
export interface EventPin {
  eventId: string
  title: string
  color: string
  lat: number
  lon: number
  /** Happening at the playhead. */
  active: boolean
  selected: boolean
}

/**
 * The world as of the timeline's playhead: regions that exist then (renamed
 * and recolored as of then), pins for located events, and the regions to
 * highlight for the selected event.
 */
export function useWorldAtTime(worldId: string, regions: Region[]) {
  const timeline = useUi((s) => s.timeline)
  const selection = useUi((s) => s.timelineSelection)
  const playhead = usePlayhead(worldId)
  const range = useTimelineView((s) => s.ranges[worldId])

  return useMemo(() => {
    const changes = timeline.changes.filter((c) => c.ownerId === worldId)
    const selected = new Set(selection?.kind === 'event' ? selection.ids : [])
    // Instants count as "now" within 2% of the visible span, so they don't flash by while scrubbing.
    const slack = range ? (range.t1 - range.t0) * 0.02 : 0
    const events = timeline.events.filter((e) => e.ownerId === worldId)
    const pins: EventPin[] = events.flatMap((e) =>
      e.locations.flatMap((loc) =>
        loc.kind === 'point'
          ? [{ eventId: e.id, title: e.title, color: e.color, lat: loc.lat, lon: loc.lon, active: isActiveAt(e, playhead, slack), selected: selected.has(e.id) }]
          : []
      )
    )
    const highlightRegionIds = new Set(
      events.filter((e) => selected.has(e.id)).flatMap((e) => e.locations.flatMap((l) => (l.kind === 'region' ? [l.regionId] : [])))
    )
    return { regions: regionsAt(regions, changes, playhead), pins, highlightRegionIds, playhead }
  }, [timeline, selection, playhead, range, regions, worldId])
}
