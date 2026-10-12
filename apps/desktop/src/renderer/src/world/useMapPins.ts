import { useMemo } from 'react'
import { useOwnRecords, useUi } from '../store'

/** A world's pins (map-pins.ts), and which of them is selected, for the surface views to draw. */
export function useMapPins(worldId: string) {
  const pins = useOwnRecords('mapPins', worldId)
  const selectedId = useUi((s) => (s.timelineSelection?.kind === 'mapPin' ? s.timelineSelection.ids[0] : undefined))
  return useMemo(() => ({ pins, selectedId }), [pins, selectedId])
}

/** A point on a world as words: "12.50° N, 40.00° W". */
export const latLonLabel = ({ lat, lon }: { lat: number; lon: number }) => `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'W' : 'E'}`

/** Selects a pin, as clicking it does. */
export const selectMapPin = (id: string) => useUi.getState().selectTimeline({ kind: 'mapPin', ids: [id] })
