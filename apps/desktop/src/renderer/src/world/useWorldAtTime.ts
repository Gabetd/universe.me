import { eventPlace, holdersAt, isActiveAt, regionsAt, timelineOf, type Faction, type Region } from '@universe/core'
import { useMemo } from 'react'
import { useUi } from '../store'
import { usePlayhead, useTimelineView } from '../timeline/timelineStore'
import { useEditor } from './editorStore'

/** A region no faction holds, with territory shown. */
const UNHELD = '#5b6275'

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
 * and recolored as of then, or coloured by who holds them with `territory`
 * on), pins for located events, and the regions to highlight for the
 * selected event, and where that event happened.
 */
export function useWorldAtTime(worldId: string, regions: Region[]) {
  const timeline = useUi((s) => s.timeline)
  const selection = useUi((s) => s.timelineSelection)
  const playhead = usePlayhead(worldId)
  const range = useTimelineView((s) => s.ranges[worldId])
  const focusSeq = useEditor((s) => s.focusSeq)
  const territory = useEditor((s) => s.territory)

  return useMemo(() => {
    const { events, changes } = timelineOf(timeline, worldId)
    const selected = new Set(selection?.kind === 'event' ? selection.ids : [])
    // Instants count as "now" within 2% of the visible span, so they don't flash by while scrubbing.
    const slack = range ? (range.t1 - range.t0) * 0.02 : 0
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
    const focusEvent = events.find((e) => selected.has(e.id))
    const place = focusEvent && eventPlace(focusEvent, regions)
    const focus = place && { ...place, key: `${focusEvent.id}:${place.lat}:${place.lon}:${focusSeq}` }
    const now = regionsAt(regions, changes, playhead)
    const holders = territory ? holdersAt(timeline.factions.filter((f) => f.ownerId === worldId), timeline.holdings, playhead) : new Map<string, Faction>()
    const shown = territory ? now.map((r) => ({ ...r, color: holders.get(r.id)?.color ?? UNHELD })) : now
    return { regions: shown, holders, pins, highlightRegionIds, focus, playhead }
  }, [timeline, selection, playhead, range, regions, worldId, focusSeq, territory])
}
