import type { WorldInfo } from '@universe/core'
import { erosionAt, erosionStep, type TerrainModel } from '@universe/procgen'
import { secondsPerYear } from '@universe/core'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { usePlayhead } from '../timeline/timelineStore'
import { workerCalls } from '../workerCalls'
import type { TerrainChange } from './useTerrain'
import { useCalendar } from './useSky'
import type { Water, WaterRequest } from './water.worker'
import WaterWorker from './water.worker?worker'

const work = workerCalls<WaterRequest, Water>(() => new WaterWorker())

/** Each world's water, once worked out (its rivers and lakes for the views, the inspector and the lists). */
export const useWaterOf = create<{ byWorld: Record<string, Water>; set(worldId: string, water: Water): void }>((set) => ({
  byWorld: {},
  set: (worldId, water) => set((s) => ({ byWorld: { ...s.byWorld, [worldId]: water } }))
}))

/** A world's rivers and lakes, when they've been worked out. */
export const useWater = (worldId: string): Water | undefined => useWaterOf((s) => s.byWorld[worldId])

const ids = new WeakMap<object, number>()
let nextId = 0
const idOf = (o: object) => ids.get(o) ?? (ids.set(o, ++nextId), nextId)

/** How long the terrain has to stay as it is before its water is worked out again: a stroke's dabs don't each start it. */
const SETTLE_MS = 400

/**
 * Keeps a world's water up to date (worked out in a worker when its terrain
 * is saved, or its sea level changes) and shows it in the model: lakes as
 * water, and the land worn down by as much erosion as has happened by the
 * playhead. `bump` redraws the views when either changes what they show.
 */
export function useWaterIn(worldId: string, seed: number, info: WorldInfo | undefined, model: TerrainModel | undefined, change: TerrainChange, bump: (faces: 'all') => void) {
  const water = useWater(worldId)
  const settings = info?.settings
  // What the water is worked out from: the terrain (generated and saved edits) and the sea.
  const source = model && settings ? `${idOf(model)}:${idOf(model.base)}:${info.terrainRevision}:${settings.seaLevel}:${settings.radiusKm}` : undefined
  const done = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!model || !source || model.isStroking || done.current === source) return
    const timer = setTimeout(() => {
      done.current = source
      const sculpted = model.heightEdits.map((edits) => Uint8Array.from(edits, (e) => (e ? 1 : 0)))
      work({ heights: model.heightsAboveSea(), moisture: model.base.moisture, sculpted, seed, radiusKm: model.settings.radiusKm }).then(
        (w) => useWaterOf.getState().set(worldId, w),
        // Tried again with the next change; the world shows without rivers meanwhile.
        () => (done.current = undefined)
      )
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [model, source, change, worldId, seed])

  // Lakes, and the land worn down as of the playhead (in steps, so it redraws only as it changes enough to see).
  const playhead = usePlayhead(worldId)
  const cal = useCalendar(worldId)
  const amount = erosionStep(erosionAt(playhead / secondsPerYear(cal), settings?.erosionSpeed ?? 1))
  useEffect(() => {
    if (!model) return
    const lakes = model.setLakes(water?.lakeLevel)
    const worn = model.setErosion(water?.erosion, amount)
    if (lakes || worn) bump('all')
  }, [model, water, amount, bump])
}
