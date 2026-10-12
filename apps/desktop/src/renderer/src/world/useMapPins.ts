import { useMemo } from 'react'
import { useOwnRecords, useUi } from '../store'

/** A world's pins (map-pins.ts), and which of them is selected, for the surface views to draw. */
export function useMapPins(worldId: string) {
  const pins = useOwnRecords('mapPins', worldId)
  const selectedId = useUi((s) => (s.timelineSelection?.kind === 'mapPin' ? s.timelineSelection.ids[0] : undefined))
  return useMemo(() => ({ pins, selectedId }), [pins, selectedId])
}

/** Selects a pin, as clicking it does. */
export const selectMapPin = (id: string) => useUi.getState().selectTimeline({ kind: 'mapPin', ids: [id] })
