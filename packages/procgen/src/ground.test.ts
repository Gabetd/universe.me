import { describe, expect, it } from 'vitest'
import { BIOME, BIOME_RGB } from './biomes'
import {
  CHUNK_M,
  CHUNK_SEGMENTS,
  GROUND_RINGS,
  INSTANCE_STRIDE,
  GroundDetail,
  HORIZON_M,
  RING_GRID,
  RING_STEP,
  buildGroundChunk,
  buildGroundMap,
  buildRingGround,
  groundMapBounds,
  ringBounds,
  ringCenter,
  ringRadii,
  type GroundRing,
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
const flat = (biome: number, elevation = 120): BaseSampler => ({ elevation: () => elevation, biome: () => biome })

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

  it('shade alike along a row’s shared edge: their normals come from the heights on both sides', () => {
    const id = chunkOf({ lat: 45, lon: 7 }, R)
    const hills: BaseSampler = { elevation: (lat, lon) => 400 + 300 * Math.sin(lat * 40) * Math.cos(lon * 30), biome: () => BIOME.grassland }
    const a = chunk(id, hills)
    const east = chunk({ ...id, col: id.col + 1 }, hills)
    const n = CHUNK_SEGMENTS + 1
    for (let j = 0; j < n; j += 8)
      for (let k = 0; k < 3; k++) expect(a.normals[(j * n + CHUNK_SEGMENTS) * 3 + k]).toBeCloseTo(east.normals[j * n * 3 + k]!, 2)
  })

  it('are cut by flat-floored wadis in dry land, and by shallower channels where it is wet', () => {
    const deepest = (biome: number) => {
      const detail = new GroundDetail(42, R)
      const base = flat(biome, 300)
      let cut = 0
      let floor = 0
      for (let i = 0; i < 120; i++)
        for (let j = 0; j < 120; j++) {
          const [lat, lon] = [10 + i * 0.0002, 20 + j * 0.0002]
          const rough = detail.elevation(base, lat, lon, 1, false)
          cut = Math.max(cut, rough - detail.elevation(base, lat, lon))
          floor = Math.max(floor, detail.shape.bed)
        }
      return { cut, floor }
    }
    const desert = deepest(BIOME.desert)
    expect(desert.cut).toBeGreaterThan(6)
    expect(desert.floor).toBeGreaterThan(0.9)
    expect(deepest(BIOME.temperateForest).cut).toBeLessThan(desert.cut)
  })

  it('are never flat: plains swell, high land rises into mountains, and cliffs drop the ground suddenly', () => {
    const detail = new GroundDetail(42, R)
    const m = (R * 1000 * Math.PI) / 180
    /** Heights along 6 km due east from a point, 2 m apart. */
    const along = (lat: number, lon: number, elevation: number) =>
      Array.from({ length: 3000 }, (_, k) => detail.elevation(flat(BIOME.grassland, elevation), lat, lon + (k * 2) / (m * Math.cos((lat * Math.PI) / 180))))
    const span = (ys: number[]) => Math.max(...ys) - Math.min(...ys)
    // Lowland: hills and dips of tens of metres, never under the sea.
    const plains = [along(10, 20, 150), along(-35, 140, 150), along(50, -100, 150)]
    for (const ys of plains) {
      expect(span(ys)).toBeGreaterThan(15)
      expect(Math.min(...ys)).toBeGreaterThan(0)
    }
    // High land: mountains, hundreds of metres from valley to peak somewhere along the way.
    const high = [10, 25, 40, 55].map((lat) => span(along(lat, 70, 2500)))
    expect(Math.max(...high)).toBeGreaterThan(300)
    // Somewhere, a step of more than a metre between points 2 m apart: a cliff.
    const steps = plains.flatMap((ys) => ys.slice(1).map((y, k) => Math.abs(y - ys[k]!)))
    expect(Math.max(...steps)).toBeGreaterThan(1)
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

describe('the rings of ground beyond the chunks', () => {
  const id = chunkOf({ lat: 45.1, lon: 7.4 }, R)
  const ring = (which: GroundRing, base: BaseSampler, chunks = { chunksReach: 2500 }) => {
    const middle = ringCenter(which, id, R)
    return buildRingGround({
      ring: which,
      frame: { origin: middle, radiusKm: R },
      seed: 42,
      grid: sampleBaseGrid(base, ringBounds(which, middle, R), RING_GRID[which]),
      biomeColors: BIOME_RGB.map((c) => [...c]),
      seabedColor: [40, 60, 80],
      ...(which === 'pretty' && chunks)
    })
  }
  const radiiOf = (positions: Float32Array) => Array.from({ length: positions.length / 3 }, (_, t) => Math.hypot(positions[t * 3]!, positions[t * 3 + 2]!))

  it('reach 20, 40 and 80 km, each finer than the next, and the next starts under the last', () => {
    expect([GROUND_RINGS.pretty.outer, GROUND_RINGS.medium.outer, GROUND_RINGS.low.outer]).toEqual([20_000, 40_000, 80_000])
    expect(HORIZON_M).toBe(80_000)
    expect(GROUND_RINGS.pretty.spokes).toBeGreaterThan(GROUND_RINGS.medium.spokes)
    expect(GROUND_RINGS.medium.spokes).toBeGreaterThan(GROUND_RINGS.low.spokes)
    // The pretty ring moves with the view's chunk; the others with its block, up to this far from it: the next always reaches under the last.
    const blockShift = Math.SQRT2 * ((RING_STEP / 2) * CHUNK_M + CHUNK_M / 2)
    expect(GROUND_RINGS.medium.from).toBeLessThanOrEqual(GROUND_RINGS.pretty.outer - blockShift)
    expect(GROUND_RINGS.low.from).toBeLessThanOrEqual(GROUND_RINGS.medium.outer)
    for (const which of ['pretty', 'medium', 'low'] as const) {
      const radii = ringRadii(GROUND_RINGS[which])
      expect(radii.at(-1)).toBeCloseTo(GROUND_RINGS[which].outer, 6)
      // Points about as far apart across the rings as along them.
      const along = (radii.at(-1)! * 2 * Math.PI) / GROUND_RINGS[which].spokes
      expect(radii.at(-1)! - radii.at(-2)!).toBeLessThan(along * 1.3)
    }
  })

  it('are built as far out as they reach, the same every time, above the sea out there and sunk in their holes', () => {
    const base = flat(BIOME.grassland)
    for (const which of ['pretty', 'medium', 'low'] as const) {
      const { positions, indices } = ring(which, base)
      const spec = GROUND_RINGS[which]
      expect(indices.length).toBe((ringRadii(spec).length - 1) * spec.spokes * 6)
      const radii = radiiOf(positions)
      expect(Math.max(...radii)).toBeCloseTo(spec.outer, -2)
      let outerLowest = Infinity
      let holeHighest = -Infinity
      radii.forEach((r, t) => {
        if (r > spec.from + 1) outerLowest = Math.min(outerLowest, positions[t * 3 + 1]!)
        if (spec.hole && r < spec.from - 1) holeHighest = Math.max(holeHighest, positions[t * 3 + 1]!)
      })
      expect(outerLowest).toBeGreaterThan(0)
      if (spec.hole) expect(holeHighest).toBeLessThan(-100)
      expect(ring(which, base).positions).toEqual(positions)
    }
  })

  it('have trees standing one by one only in the pretty ring, beyond the chunks, where there are woods', () => {
    const woods = flat(BIOME.temperateForest)
    const pretty = ring('pretty', woods)
    const trees = Object.values(pretty.trees).flatMap((list) => Array.from({ length: list.length / INSTANCE_STRIDE }, (_, k) => [list[k * INSTANCE_STRIDE]!, list[k * INSTANCE_STRIDE + 2]!]))
    expect(trees.length).toBeGreaterThan(1000)
    for (const [x, z] of trees) expect(Math.max(Math.abs(x!), Math.abs(z!))).toBeGreaterThan(2400)
    expect(Object.keys(ring('medium', woods).trees)).toEqual([])
    expect(Object.keys(ring('pretty', flat(BIOME.desert)).trees)).toEqual([])
  })
})

describe('the map of the ground around', () => {
  const map = (base: BaseSampler) => {
    const size = { frame: { origin: { lat: 10, lon: 20 }, radiusKm: R }, width: 40, height: 20, metresPerPixel: 150 }
    return buildGroundMap({ ...size, seed: 42, grid: sampleBaseGrid(base, groundMapBounds(size), 9), biomeColors: BIOME_RGB.map((c) => [...c]), seabedColor: [40, 60, 80], waterColor: [30, 90, 200] })
  }

  it('is as big as asked, the sea in the water’s colour and the land in its own', () => {
    const sea = map(flat(BIOME.grassland, -300))
    expect(sea).toHaveLength(40 * 20 * 4)
    expect(sea[2]).toBeGreaterThan(sea[0]! + 40)
    const land = map(flat(BIOME.grassland, 300))
    expect(land[1]).toBeGreaterThan(land[2]!)
    expect(map(flat(BIOME.grassland, 300))).toEqual(land)
  })
})
