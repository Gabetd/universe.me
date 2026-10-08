import type { TerrainModel } from '@universe/procgen'
import { create } from 'zustand'

/**
 * The terrain of each world whose editor has loaded it, for things that need
 * it outside the views (the weather at each structure, for erosion). `version`
 * changes when the terrain does, once a stroke is finished.
 */
export const useLoadedTerrain = create<{ models: Record<string, { model: TerrainModel; version: number }>; publish(worldId: string, model: TerrainModel): void }>((set) => ({
  models: {},
  publish: (worldId, model) => set((s) => ({ models: { ...s.models, [worldId]: { model, version: (s.models[worldId]?.version ?? 0) + 1 } } }))
}))
