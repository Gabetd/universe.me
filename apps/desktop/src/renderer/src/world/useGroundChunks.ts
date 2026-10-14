import {
  FAR_GRID,
  HORIZON_GRID,
  chunkBounds,
  chunkKey,
  farBounds,
  horizonBounds,
  horizonCenter,
  modelSampler,
  sampleBaseGrid,
  worldPalette,
  type ChunkId,
  type GroundChunk,
  type GroundChunkInput,
  type GroundSheet,
  type TerrainModel,
  watersNear
} from '@universe/procgen'
import type { LatLon } from '@universe/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { workerCalls, workerPool } from '../workerCalls'
import type { DistanceInput } from './far-ground.worker'
import type { AreaWaters } from './groundWater'
import FarGroundWorker from './far-ground.worker?worker'
import GroundWorker from './ground.worker?worker'
import { failure } from './terrainSource'

/** Chunks are built two at a time: a view needs 25 of them at once. */
const build = workerPool<GroundChunkInput, GroundChunk>(() => new GroundWorker(), 2)
const buildDistance = workerCalls<DistanceInput, GroundSheet>(() => new FarGroundWorker())

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

/**
 * The ground beyond the chunks, out to 12 km, around chunk `center` (built in
 * a worker, again as the middle of the view moves into another chunk), sunk
 * out of sight within `sinkWithin` metres of it. Until the first is built,
 * undefined; while the next is, the last.
 */
export function useFarGround(
  model: TerrainModel,
  generation: object,
  seed: number,
  center: ChunkId,
  sinkWithin: number,
  waters: AreaWaters | undefined
): { center: ChunkId; sheet: GroundSheet } | undefined {
  const [far, setFar] = useState<{ center: ChunkId; sheet: GroundSheet }>()
  const key = chunkKey(center)
  useEffect(() => {
    let current = true
    const radiusKm = model.settings.radiusKm
    const { palette, base } = sources(model)
    const corner = chunkBounds(center, radiusKm)
    void buildDistance({
      kind: 'far',
      center,
      frame: { origin: { lat: corner.lat0, lon: corner.lon0 }, radiusKm },
      seed,
      grid: sampleBaseGrid(base, farBounds(center, radiusKm), FAR_GRID),
      waters: waters && watersNear(waters, farBounds(center, radiusKm), radiusKm),
      sinkWithin,
      ...palette
    }).then(
      (sheet) => current && setFar({ center, sheet }),
      // The chunks say when the ground can't be built; without the distance, the fog has it.
      () => {}
    )
    return () => void (current = false)
    // Again with the next block's waters too: the same where they meet, but they reach farther that way.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `center`
  }, [key, model, generation, seed, sinkWithin, waters])
  return far
}

/**
 * The land beyond the distant ground, to the horizon, around the corner of
 * the block of chunks the view's middle `center` is in (built in a worker,
 * again as the view moves into another block). Undefined until the first is
 * built; while the next is, the last.
 */
export function useHorizonGround(model: TerrainModel, generation: object, seed: number, center: ChunkId): { middle: LatLon; sheet: GroundSheet } | undefined {
  const [horizon, setHorizon] = useState<{ middle: LatLon; sheet: GroundSheet }>()
  const radiusKm = model.settings.radiusKm
  const middle = horizonCenter(center, radiusKm)
  const key = `${middle.lat},${middle.lon}`
  useEffect(() => {
    let current = true
    const { palette, base } = sources(model)
    void buildDistance({ kind: 'horizon', frame: { origin: middle, radiusKm }, seed, grid: sampleBaseGrid(base, horizonBounds(middle, radiusKm), HORIZON_GRID), ...palette }).then(
      (sheet) => current && setHorizon({ middle, sheet }),
      // Without the horizon, the sky shows past the distant ground.
      () => {}
    )
    return () => void (current = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `middle`
  }, [key, model, generation, seed, radiusKm])
  return horizon
}
