import type { TerrainParams, WorldInfo } from '@universe/core'
import { TerrainModel, shapeKey, type BaseTerrain, type SkyClimate } from '@universe/procgen'
import { workerCalls } from '../workerCalls'
import type { GenerateRequest } from './terrain.worker'
import TerrainWorker from './terrain.worker?worker'

/** Where worlds' terrain comes from: the generated base (in a worker) plus the project's edit layers. */

const generate = workerCalls<GenerateRequest, BaseTerrain>(() => new TerrainWorker())
/** Recently generated terrains, so switching between worlds doesn't regenerate. */
const baseCache = new Map<string, Promise<BaseTerrain>>()
const CACHE_SIZE = 4

export function generateBase(seed: number, params: TerrainParams): Promise<BaseTerrain> {
  const key = shapeKey(seed, params)
  const cached = baseCache.get(key)
  if (cached) return cached
  const promise = generate({ seed, params })
  baseCache.set(key, promise)
  if (baseCache.size > CACHE_SIZE) baseCache.delete(baseCache.keys().next().value!)
  // A failure isn't kept: the next ask tries again.
  promise.catch(() => baseCache.get(key) === promise && baseCache.delete(key))
  return promise
}

/** What went wrong, from whatever a failed call rejected with (an Error, a worker's error event, a string). */
export const failure = (err: unknown): string => String((err as { message?: unknown } | null | undefined)?.message ?? err)

export async function fetchLayers(worldId: string) {
  const result = await window.universe.getTerrain(worldId)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/** A world's terrain as it is now, for views that only show it (the system and moon views). */
export async function loadTerrain(world: WorldInfo, seed: number, sky?: SkyClimate): Promise<TerrainModel> {
  const [base, layers] = await Promise.all([generateBase(seed, world.settings.terrain), fetchLayers(world.id)])
  const model = new TerrainModel(world.settings, base, layers)
  model.setSky(sky)
  return model
}
