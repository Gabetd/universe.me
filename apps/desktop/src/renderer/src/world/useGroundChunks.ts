import {
  FAR_GRID,
  chunkBounds,
  chunkKey,
  farBounds,
  modelSampler,
  sampleBaseGrid,
  worldPalette,
  type ChunkId,
  type FarGroundInput,
  type GroundChunk,
  type GroundChunkInput,
  type GroundSheet,
  type TerrainModel
} from '@universe/procgen'
import { useEffect, useMemo, useRef, useState } from 'react'
import { workerCalls } from '../workerCalls'
import FarGroundWorker from './far-ground.worker?worker'
import GroundWorker from './ground.worker?worker'
import { failure } from './terrainSource'

const build = workerCalls<GroundChunkInput, GroundChunk>(() => new GroundWorker())
const buildFar = workerCalls<FarGroundInput, GroundSheet>(() => new FarGroundWorker())

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
export function useGroundChunks(model: TerrainModel, generation: object, seed: number, wanted: ChunkId[]): { chunks: Map<string, GroundChunk>; error?: string } {
  const [built, setBuilt] = useState(() => new Map<string, GroundChunk>())
  const [error, setError] = useState<string>()
  const pending = useRef(new Set<string>())
  const gen = generationOf(generation)
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
  }, [wantedKey, model, gen, seed])

  const chunks = useMemo(
    () => new Map(wanted.flatMap((id) => (built.has(`${gen}:${chunkKey(id)}`) ? [[chunkKey(id), built.get(`${gen}:${chunkKey(id)}`)!] as const] : []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wantedKey` stands for `wanted`
    [built, gen, wantedKey]
  )
  return { chunks, error }
}

/** What chunks and the distant ground are built from: the world's colours and its terrain. */
function sources(model: TerrainModel) {
  const palette = worldPalette(model.settings.terrain)
  return { palette: { biomeColors: palette.biomes, seabedColor: palette.shallow.map((c) => c * 0.7) }, base: modelSampler(model) }
}

/**
 * The ground beyond the chunks, out to 12 km, around chunk `center` (built in
 * a worker, again as the middle of the view moves into another chunk), sunk
 * out of sight within `sinkWithin` metres of it. Until the first is built,
 * undefined; while the next is, the last.
 */
export function useFarGround(model: TerrainModel, generation: object, seed: number, center: ChunkId, sinkWithin: number): { center: ChunkId; sheet: GroundSheet } | undefined {
  const [far, setFar] = useState<{ center: ChunkId; sheet: GroundSheet }>()
  const key = chunkKey(center)
  useEffect(() => {
    let current = true
    const radiusKm = model.settings.radiusKm
    const { palette, base } = sources(model)
    const corner = chunkBounds(center, radiusKm)
    void buildFar({
      center,
      frame: { origin: { lat: corner.lat0, lon: corner.lon0 }, radiusKm },
      seed,
      grid: sampleBaseGrid(base, farBounds(center, radiusKm), FAR_GRID),
      sinkWithin,
      ...palette
    }).then(
      (sheet) => current && setFar({ center, sheet }),
      // The chunks say when the ground can't be built; without the distance, the fog has it.
      () => {}
    )
    return () => void (current = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `center`
  }, [key, model, generation, seed, sinkWithin])
  return far
}
