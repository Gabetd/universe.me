import { chunkBounds, chunkKey, modelSampler, sampleBaseGrid, worldPalette, type ChunkId, type GroundChunk, type TerrainModel } from '@universe/procgen'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChunkRequest } from './ground.worker'
import GroundWorker from './ground.worker?worker'

let worker: Worker | undefined
let nextRequest = 0
const waiting = new Map<number, (chunk: GroundChunk) => void>()

function build(request: Omit<ChunkRequest, 'id'>): Promise<GroundChunk> {
  if (!worker) {
    worker = new GroundWorker()
    worker.onmessage = (e: MessageEvent<{ id: number; chunk: GroundChunk }>) => {
      waiting.get(e.data.id)?.(e.data.chunk)
      waiting.delete(e.data.id)
    }
  }
  const id = ++nextRequest
  const done = new Promise<GroundChunk>((resolve) => waiting.set(id, resolve))
  worker.postMessage({ id, ...request } satisfies ChunkRequest)
  return done
}

/** Chunks kept around after leaving their area, so walking back is instant. */
const KEEP = 60

const generations = new WeakMap<object, number>()
let nextGeneration = 0
const generationOf = (o: object) => generations.get(o) ?? (generations.set(o, ++nextGeneration), nextGeneration)

/**
 * The ground chunks wanted around the view, built in a worker as they're
 * needed. Each chunk is built in a frame at its own south-west corner, so it
 * can be placed in any view frame. A new `generation` (the terrain changed)
 * builds them all again.
 */
export function useGroundChunks(model: TerrainModel, generation: object, seed: number, wanted: ChunkId[]): Map<string, GroundChunk> {
  const [built, setBuilt] = useState(() => new Map<string, GroundChunk>())
  const pending = useRef(new Set<string>())
  const gen = generationOf(generation)
  const wantedKey = wanted.map(chunkKey).join(',')

  useEffect(() => {
    const radiusKm = model.settings.radiusKm
    const palette = worldPalette(model.settings.terrain)
    const base = modelSampler(model)
    const keep = new Set(wanted.map((id) => `${gen}:${chunkKey(id)}`))
    for (const id of wanted) {
      const key = `${gen}:${chunkKey(id)}`
      if (built.has(key) || pending.current.has(key)) continue
      pending.current.add(key)
      const bounds = chunkBounds(id, radiusKm)
      void build({
        input: {
          id,
          frame: { origin: { lat: bounds.lat0, lon: bounds.lon0 }, radiusKm },
          seed,
          grid: sampleBaseGrid(base, bounds),
          biomeColors: palette.biomes,
          seabedColor: palette.shallow.map((c) => c * 0.7)
        }
      }).then((chunk) => {
        pending.current.delete(key)
        setBuilt((prev) => {
          const next = new Map(prev).set(key, chunk)
          // Forget the oldest chunks beyond what's kept, never ones in view.
          for (const old of next.keys()) if (next.size > KEEP && !keep.has(old)) next.delete(old)
          return next
        })
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wantedKey` stands for `wanted`; `built` is only checked, not followed
  }, [wantedKey, model, gen, seed])

  return useMemo(
    () => new Map(wanted.flatMap((id) => (built.has(`${gen}:${chunkKey(id)}`) ? [[chunkKey(id), built.get(`${gen}:${chunkKey(id)}`)!] as const] : []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wantedKey` stands for `wanted`
    [built, gen, wantedKey]
  )
}
