import {
  RING_GRID,
  chunkBounds,
  chunkKey,
  modelSampler,
  ringBounds,
  ringCenter,
  sampleBaseGrid,
  worldPalette,
  type ChunkId,
  type GroundChunk,
  type GroundChunkInput,
  type GroundRing,
  type RingGround,
  type RingGroundInput,
  type TerrainModel,
  watersNear
} from '@universe/procgen'
import type { LatLon } from '@universe/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { workerCalls, workerPool } from '../workerCalls'
import type { AreaWaters } from './groundWater'
import GroundWorker from './ground.worker?worker'
import RingGroundWorker from './ring-ground.worker?worker'
import { failure } from './terrainSource'

/** Chunks are built two at a time: a view needs 25 of them at once. */
const build = workerPool<GroundChunkInput, GroundChunk>(() => new GroundWorker(), 2)
const buildRing = workerCalls<RingGroundInput, RingGround>(() => new RingGroundWorker())

/** Chunks kept around after leaving their area, so walking back is instant. */
const KEEP = 60

const generations = new WeakMap<object, number>()
let nextGeneration = 0
const generationOf = (o: object) => generations.get(o) ?? (generations.set(o, ++nextGeneration), nextGeneration)

/**
 * The ground chunks wanted around the view, built in a worker as they're
 * needed. Each chunk is built in a frame at its own south-west corner, so it
 * can be placed in any view frame. A new `generation` (the terrain changed)
 * builds them all again. `error` says why chunks failed to build, until one
 * builds (a failed one is tried again when it's wanted again).
 */
export function useGroundChunks(
  model: TerrainModel,
  generation: object,
  seed: number,
  wanted: ChunkId[],
  waters: AreaWaters | undefined
): { chunks: Map<string, GroundChunk>; error?: string } {
  const [built, setBuilt] = useState(() => new Map<string, GroundChunk>())
  const [error, setError] = useState<string>()
  const pending = useRef(new Set<string>())
  // A chunk is built again when the terrain changes, or the world's water (not as the view moves on to the next block's rivers: they're the same where they meet).
  const gen = `${generationOf(generation)}:${waters ? generationOf(waters.source) : 0}`
  const wantedKey = wanted.map(chunkKey).join(',')

  useEffect(() => {
    const radiusKm = model.settings.radiusKm
    const { palette, base } = sources(model)
    const keep = new Set(wanted.map((id) => `${gen}:${chunkKey(id)}`))
    for (const id of wanted) {
      const key = `${gen}:${chunkKey(id)}`
      if (built.has(key) || pending.current.has(key)) continue
      pending.current.add(key)
      const bounds = chunkBounds(id, radiusKm)
      void build({
        id,
        frame: { origin: { lat: bounds.lat0, lon: bounds.lon0 }, radiusKm },
        seed,
        grid: sampleBaseGrid(base, bounds),
        waters: waters && watersNear(waters, bounds, radiusKm),
        ...palette
      }).then(
        (chunk) => {
          pending.current.delete(key)
          setError(undefined)
          setBuilt((prev) => {
            const next = new Map(prev).set(key, chunk)
            // Forget the oldest chunks beyond what's kept, never ones in view.
            for (const old of next.keys()) if (next.size > KEEP && !keep.has(old)) next.delete(old)
            return next
          })
        },
        (err: unknown) => {
          pending.current.delete(key)
          setError(failure(err))
        }
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wantedKey` stands for `wanted`; `built` is only checked, not followed
  }, [wantedKey, model, gen, seed, waters])

  const chunks = useMemo(
    () => new Map(wanted.flatMap((id) => (built.has(`${gen}:${chunkKey(id)}`) ? [[chunkKey(id), built.get(`${gen}:${chunkKey(id)}`)!] as const] : []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wantedKey` stands for `wanted`
    [built, gen, wantedKey]
  )
  return { chunks, error }
}

/** What chunks, the distant ground and the minimap are built from: the world's colours (and its water's), its terrain and the scars on it at the playhead. */
export function sources(model: TerrainModel) {
  const palette = worldPalette(model.settings.terrain)
  return { palette: { biomeColors: palette.biomes, seabedColor: palette.shallow.map((c) => c * 0.7), scars: [...model.landScars] }, water: palette.shallow, base: modelSampler(model) }
}

/** Where the chunks are, for the pretty ring: within `chunksReach` metres of its middle each way, it grows no trees of its own. */
export interface ChunksCover {
  chunksReach: number
}

/**
 * One of the rings of ground beyond the chunks (see `GroundRing`), around
 * the view's chunk `center` (the pretty one) or its block (the others),
 * built in a worker, again as the view moves into another chunk or block.
 * Undefined until the first is built; while the next is, the last. Only the
 * pretty one is shaped by the rivers and lakes (`waters`).
 */
export function useRingGround(
  model: TerrainModel,
  generation: object,
  seed: number,
  ring: GroundRing,
  center: ChunkId,
  waters: AreaWaters | undefined,
  cover?: ChunksCover
): { middle: LatLon; ground: RingGround } | undefined {
  const [built, setBuilt] = useState<{ middle: LatLon; ground: RingGround }>()
  const radiusKm = model.settings.radiusKm
  const middle = ringCenter(ring, center, radiusKm)
  const key = `${middle.lat},${middle.lon}`
  useEffect(() => {
    let current = true
    const { palette, base } = sources(model)
    const bounds = ringBounds(ring, middle, radiusKm)
    void buildRing({
      ring,
      frame: { origin: middle, radiusKm },
      seed,
      grid: sampleBaseGrid(base, bounds, RING_GRID[ring]),
      waters: waters && watersNear(waters, bounds, radiusKm),
      ...cover,
      ...palette
    }).then(
      (ground) => current && setBuilt({ middle, ground }),
      // The chunks say when the ground can't be built; without the rings, the haze has it.
      () => {}
    )
    return () => void (current = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `middle`, and the cover's number for it
  }, [key, model, generation, seed, radiusKm, ring, waters, cover?.chunksReach])
  return built
}
