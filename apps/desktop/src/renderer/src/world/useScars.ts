import { greatCircleKm, scarStep, scarWeight, secondsPerYear, type Region, type Scar } from '@universe/core'
import type { LandScar, TerrainModel } from '@universe/procgen'
import { useEffect, useMemo } from 'react'
import { useOwnRecords, useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'
import { useByValue } from '../useByValue'
import { useCalendar } from './useSky'

/**
 * A world's scars (core scars.ts) as the land shows them at the playhead:
 * each with how much of it there is then (in sixteenths, so the land is drawn
 * again only as that changes enough to see), and a region's outline for one
 * over a region. The same list until something in it changes.
 */
export function useLandScars(worldId: string, regions: readonly Region[], radiusKm: number | undefined): LandScar[] {
  const scars = useOwnRecords('scars', worldId)
  const playhead = usePlayhead(worldId)
  const year = secondsPerYear(useCalendar(worldId))
  const list = useMemo(
    () =>
      scars.flatMap((s): LandScar[] => {
        const weight = scarStep(scarWeight(s, playhead, year))
        if (!weight) return []
        if (!s.regionId) return [{ id: s.id, kind: s.kind, lat: s.lat, lon: s.lon, radiusKm: s.radiusKm, weight }]
        const region = regions.find((r) => r.id === s.regionId)
        if (!region || !radiusKm) return []
        // It reaches the region's farthest corner from its middle.
        const reach = Math.max(...region.points.map((p) => greatCircleKm(s, p, radiusKm)))
        return [{ id: s.id, kind: s.kind, lat: s.lat, lon: s.lon, radiusKm: reach, weight, polygon: region.points }]
      }),
    [scars, playhead, year, regions, radiusKm]
  )
  return useByValue(list)
}

/** Shows a world's scars at the playhead in its terrain model; `bump` redraws the views when they change. Returns them, for the views to mark. */
export function useScarsIn(worldId: string, regions: readonly Region[], model: TerrainModel | undefined, bump: (faces: 'all') => void): LandScar[] {
  const scars = useLandScars(worldId, regions, model?.settings.radiusKm)
  useEffect(() => {
    if (model?.setScars(scars)) bump('all')
  }, [model, scars, bump])
  return scars
}

/** The scar selected in the inspector, if one is. */
export const useSelectedScarId = () => useUi((s) => (s.timelineSelection?.kind === 'scar' ? s.timelineSelection.ids[0] : undefined))

/** Selects a scar, as clicking it does. */
export const selectScar = (id: string) => useUi.getState().selectTimeline({ kind: 'scar', ids: [id] })

/** A scar's record by id, from the project. */
export const scarById = (id: string): Scar | undefined => useUi.getState().timeline.scars.find((s) => s.id === id)
