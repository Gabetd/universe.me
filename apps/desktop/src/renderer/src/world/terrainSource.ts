import type { TerrainParams, WorldInfo } from '@universe/core'
import { TerrainModel, shapeKey, type BaseTerrain, type SkyClimate } from '@universe/procgen'
import type { GenerateRequest } from './terrain.worker'
import TerrainWorker from './terrain.worker?worker'

/** Where worlds' terrain comes from: the generated base (in a worker) plus the project's edit layers. */

let worker: Worker | undefined
let nextRequest = 0
const pending = new Map<number, (base: BaseTerrain) => void>()
/** Recently generated terrains, so switching between worlds doesn't regenerate. */
const baseCache = new Map<string, Promise<BaseTerrain>>()
const CACHE_SIZE = 4

export function generateBase(seed: number, params: TerrainParams): Promise<BaseTerrain> {
  const key = shapeKey(seed, params)
  const cached = baseCache.get(key)
  if (cached) return cached
  if (!worker) {
    worker = new TerrainWorker()
    worker.onmessage = (e: MessageEvent<{ id: number; base: BaseTerrain }>) => {
      pending.get(e.data.id)?.(e.data.base)
      pending.delete(e.data.id)
    }
  }
  const id = ++nextRequest
  const promise = new Promise<BaseTerrain>((resolve) => pending.set(id, resolve))
  worker.postMessage({ id, seed, params } satisfies GenerateRequest)
  baseCache.set(key, promise)
  if (baseCache.size > CACHE_SIZE) baseCache.delete(baseCache.keys().next().value!)
  return promise
}

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
