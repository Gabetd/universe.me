import { describe, expect, it } from 'vitest'
import { BIOME, BIOME_RGB } from './biomes'
import {
  CHUNK_M,
  CHUNK_SEGMENTS,
  INSTANCE_STRIDE,
  buildGroundChunk,
  chunkBounds,
  chunkOf,
  chunksAround,
  fromLocal,
  sampleBaseGrid,
  toLocal,
  type BaseSampler,
  type ChunkId,
  type LocalFrame
} from './ground'

const R = 6371
const flat =
  (biome: number, elevation = 120): BaseSampler =>
  () => ({ elevation, biome })

function chunk(id: ChunkId, base: BaseSampler, frame: LocalFrame = { origin: { lat: 45, lon: 7 }, radiusKm: R }) {
  return buildGroundChunk({
    id,
    frame,
    seed: 42,
    grid: sampleBaseGrid(base, chunkBounds(id, R)),
    biomeColors: BIOME_RGB.map((c) => [...c]),
    seabedColor: [40, 60, 80]
  })
}

describe('ground chunks', () => {
  it('tile the world in squares of about 1 km', () => {
    const p = { lat: 45.123, lon: 7.456 }
    const id = chunkOf(p, R)
    const b = chunkBounds(id, R)
    expect(p.lat).toBeGreaterThanOrEqual(b.lat0)
    expect(p.lat).toBeLessThan(b.lat1)
    expect(p.lon).toBeGreaterThanOrEqual(b.lon0)
    expect(p.lon).toBeLessThan(b.lon1)
    const frame = { origin: p, radiusKm: R }
    const [x0, z0] = toLocal(frame, { lat: b.lat0, lon: b.lon0 })
    const [x1, z1] = toLocal(frame, { lat: b.lat1, lon: b.lon1 })
    expect(Math.abs(x1 - x0)).toBeCloseTo(CHUNK_M, -1)
    expect(Math.abs(z1 - z0)).toBeCloseTo(CHUNK_M, -1)
    expect(chunksAround(p, R, 2)).toHaveLength(25)
    expect(chunksAround(p, R, 2)[0]).toEqual(id)
  })

  it('round-trip between lat/lon and the local frame, across the date line too', () => {
    const frame = { origin: { lat: -30, lon: 179.99 }, radiusKm: R }
    const p = { lat: -30.01, lon: -179.98 }
    const [x, z] = toLocal(frame, p)
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(5000)
    const back = fromLocal(frame, x, z)
    expect(back.lat).toBeCloseTo(p.lat, 8)
    expect(back.lon).toBeCloseTo(p.lon, 8)
  })

  it('are the same every time, and neighbours in a row meet along their edge', () => {
    const id = chunkOf({ lat: 45, lon: 7 }, R)
    const a = chunk(id, flat(BIOME.temperateForest))
    expect(chunk(id, flat(BIOME.temperateForest))).toEqual(a)
    const east = chunk({ ...id, col: id.col + 1 }, flat(BIOME.temperateForest))
    const n = CHUNK_SEGMENTS + 1
    for (let j = 0; j < n; j++) {
      const mine = (j * n + CHUNK_SEGMENTS) * 3
      const theirs = j * n * 3
      for (let k = 0; k < 3; k++) expect(a.positions[mine + k]).toBeCloseTo(east.positions[theirs + k]!, 3)
    }
  })

  it('grow the plants of their biome', () => {
    const id = chunkOf({ lat: 10, lon: 10 }, R)
    const count = (c: ReturnType<typeof chunk>, plant: string) => (c.plants[plant as 'grass']?.length ?? 0) / INSTANCE_STRIDE
    const forest = chunk(id, flat(BIOME.temperateForest))
    const desert = chunk(id, flat(BIOME.desert))
    expect(count(forest, 'broadleaf')).toBeGreaterThan(300)
    expect(count(desert, 'broadleaf')).toBe(0)
    expect(count(desert, 'cactus')).toBeGreaterThan(5)
    expect(count(chunk(id, flat(BIOME.taiga)), 'conifer')).toBeGreaterThan(300)
  })

  it('grow nothing under the sea', () => {
    const sea = chunk(chunkOf({ lat: 0, lon: 0 }, R), flat(BIOME.grassland, -400))
    expect(Object.keys(sea.plants)).toEqual([])
    expect(Math.max(...sea.positions.filter((_, i) => i % 3 === 1))).toBeLessThan(0)
  })
})
