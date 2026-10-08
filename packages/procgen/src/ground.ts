import type { LatLon } from '@universe/core'
import type { NoiseFunction3D } from 'simplex-noise'
import { BIOME } from './biomes'
import { latLonToDir, type Vec3 } from './cubesphere'
import { RAD, TAU, bilerp, clamp, clamp01, wrapLon } from './math'
import { octaves, seededNoise } from './noise'
import { cellSeed, rng, subSeed } from './random'
import type { TerrainModel } from './terrain-model'

/**
 * The ground up close (PLAN.md §5.2, the Surface level): the world in square
 * chunks of about 1 km, each with terrain detail far finer than the globe's
 * cells and the plants of its biome, all generated from the world's seed so a
 * spot always looks the same.
 *
 * Chunks lie on a global grid: rows 1 km apart from the equator, and in each
 * row, columns 1 km apart along it. Positions are metres in a local flat
 * frame around a point (x east, z south, y up from sea level); within a few
 * km the curvature of the planet doesn't show.
 */

export const CHUNK_M = 1000

export interface ChunkId {
  row: number
  col: number
}

export const chunkKey = (id: ChunkId) => `${id.row}:${id.col}`

/** Lat/lon edges of a chunk. Longitudes may run past ±180 at the date line. */
export interface ChunkBounds {
  lat0: number
  lat1: number
  lon0: number
  lon1: number
}

const metresPerDegLat = (radiusKm: number) => radiusKm * 1000 * RAD
/** Columns use the cosine at the row's middle, so every chunk of a row is the same size. */
const rowCos = (row: number, radiusKm: number) => Math.max(0.02, Math.cos((((row + 0.5) * CHUNK_M) / metresPerDegLat(radiusKm)) * RAD))

export function chunkOf(p: LatLon, radiusKm: number): ChunkId {
  const row = Math.floor((p.lat * metresPerDegLat(radiusKm)) / CHUNK_M)
  return { row, col: Math.floor((p.lon * metresPerDegLat(radiusKm) * rowCos(row, radiusKm)) / CHUNK_M) }
}

export function chunkBounds({ row, col }: ChunkId, radiusKm: number): ChunkBounds {
  const dLat = CHUNK_M / metresPerDegLat(radiusKm)
  const dLon = dLat / rowCos(row, radiusKm)
  return { lat0: row * dLat, lat1: (row + 1) * dLat, lon0: col * dLon, lon1: (col + 1) * dLon }
}

/** A flat frame around `origin`, in metres. */
export interface LocalFrame {
  origin: LatLon
  radiusKm: number
}

/** A point's place in the frame: [east, south]. Longitude is taken the short way round. */
export function toLocal(f: LocalFrame, p: LatLon): [number, number] {
  const m = metresPerDegLat(f.radiusKm)
  const dLon = wrapLon(p.lon - f.origin.lon)
  return [dLon * m * Math.cos(f.origin.lat * RAD), -(p.lat - f.origin.lat) * m]
}

export function fromLocal(f: LocalFrame, x: number, z: number): LatLon {
  const m = metresPerDegLat(f.radiusKm)
  const lat = clamp(f.origin.lat - z / m, -90, 90)
  const lon = f.origin.lon + x / (m * Math.max(0.02, Math.cos(f.origin.lat * RAD)))
  return { lat, lon: wrapLon(lon) }
}

/** Chunks within `ring` chunks of the one containing `p` (a (2·ring+1)² block, nearest first). */
export function chunksAround(p: LatLon, radiusKm: number, ring: number): ChunkId[] {
  const center = chunkOf(p, radiusKm)
  const out: { id: ChunkId; d: number }[] = []
  for (let dr = -ring; dr <= ring; dr++) {
    const row = center.row + dr
    // The row's own column under the point: rows have different column widths.
    const col = chunkOf({ lat: ((row + 0.5) * CHUNK_M) / metresPerDegLat(radiusKm), lon: p.lon }, radiusKm).col
    for (let dc = -ring; dc <= ring; dc++) out.push({ id: { row, col: col + dc }, d: Math.max(Math.abs(dr), Math.abs(dc)) })
  }
  return out.sort((a, b) => a.d - b.d).map((o) => o.id)
}

/** The globe-scale terrain: metres above sea level, and the biome, at a point. Heights are wanted far more often, so they come alone. */
export interface BaseSampler {
  elevation(lat: number, lon: number): number
  biome(lat: number, lon: number): number
  /** The biome everywhere, if there's only one (a chunk inside one biome): then its edges needn't be worked out. */
  only?: number
}

/** The base terrain from a live model (in the UI thread). */
export function modelSampler(model: TerrainModel): BaseSampler {
  const dir: Vec3 = [0, 0, 0]
  const at = (lat: number, lon: number) => {
    latLonToDir(lat, lon, dir)
    return model.locate(dir[0], dir[1], dir[2])
  }
  return {
    elevation: (lat, lon) => model.heightOf(at(lat, lon)) - model.settings.seaLevel,
    biome: (lat, lon) => {
      const p = at(lat, lon)
      return model.biome(p.face, model.cellOf(p))
    }
  }
}

/** The base terrain over a chunk, sampled on a small grid; enough to rebuild it elsewhere (a worker). */
export interface BaseGrid {
  bounds: ChunkBounds
  /** GRID × GRID samples, row-major from (lat0, lon0). */
  elevation: number[]
  biome: number[]
}

const GRID = 5

export function sampleBaseGrid(base: BaseSampler, bounds: ChunkBounds): BaseGrid {
  const elevation: number[] = []
  const biome: number[] = []
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const lat = bounds.lat0 + ((bounds.lat1 - bounds.lat0) * j) / (GRID - 1)
      const lon = bounds.lon0 + ((bounds.lon1 - bounds.lon0) * i) / (GRID - 1)
      elevation.push(base.elevation(lat, lon))
      biome.push(base.biome(lat, lon))
    }
  }
  return { bounds, elevation, biome }
}

/** Reads a sampled grid back, interpolating heights (biomes: the nearest sample). */
export function gridSampler(grid: BaseGrid): BaseSampler {
  const { bounds: b, elevation: e, biome } = grid
  // Where a point is on the grid, in samples.
  const gx = (lon: number) => clamp(((lon - b.lon0) / (b.lon1 - b.lon0)) * (GRID - 1), 0, GRID - 1)
  const gy = (lat: number) => clamp(((lat - b.lat0) / (b.lat1 - b.lat0)) * (GRID - 1), 0, GRID - 1)
  return {
    elevation(lat, lon) {
      const x = gx(lon)
      const y = gy(lat)
      const i0 = Math.min(GRID - 2, Math.floor(x))
      const j0 = Math.min(GRID - 2, Math.floor(y))
      const k = j0 * GRID + i0
      return bilerp(e[k]!, e[k + 1]!, e[k + GRID]!, e[k + GRID + 1]!, x - i0, y - j0)
    },
    biome: (lat, lon) => biome[Math.round(gy(lat)) * GRID + Math.round(gx(lon))]!,
    only: biome.every((v) => v === biome[0]) ? biome[0] : undefined
  }
}

/** Seeded noise for the fine detail, shared by every chunk of a world. */
export class GroundDetail {
  private hills: NoiseFunction3D
  private patches: NoiseFunction3D
  /** The hills' octaves, as multiples of a direction: wavelengths from 1800 m down, each 3.2 times shorter. */
  private hillFreqs: number[] = []
  /** Patches vary over about 380 m. */
  private patchFreq: number
  /** How far biome edges are pushed about, in degrees. */
  private jitter: number
  /** The last point asked about and its direction: a vertex asks for its height, biome and patches at the same spot. */
  private dir: Vec3 = [0, 0, 0]
  private dirLat = NaN
  private dirLon = NaN

  constructor(
    seed: number,
    readonly radiusKm: number
  ) {
    this.hills = seededNoise(seed, 0x6a0d)
    this.patches = seededNoise(seed, 0x9a7c)
    const metres = radiusKm * 1000
    for (let o = 0, wavelength = 1800; o < 4; o++, wavelength /= 3.2) this.hillFreqs.push(metres / wavelength)
    this.patchFreq = metres / 380
    this.jitter = (CHUNK_M / metresPerDegLat(radiusKm)) * 0.6
  }

  private dirAt(lat: number, lon: number): Vec3 {
    if (lat !== this.dirLat || lon !== this.dirLon) {
      latLonToDir(lat, lon, this.dir)
      this.dirLat = lat
      this.dirLon = lon
    }
    return this.dir
  }

  /**
   * Height in metres above sea level: the globe's smooth terrain plus rolling
   * hills and bumps, rougher where the land is high.
   */
  elevation(base: BaseSampler, lat: number, lon: number): number {
    const elevation = base.elevation(lat, lon)
    const d = this.dirAt(lat, lon)
    return elevation + octaves(this.hills, d[0], d[1], d[2], this.hillFreqs, 9 + clamp(Math.abs(elevation) * 0.04, 0, 110), 0.4)
  }

  /** −1 to 1, varying over a few hundred metres: woods and clearings, patches of flowers. */
  patch(lat: number, lon: number, salt: number): number {
    const d = this.dirAt(lat, lon)
    const k = this.patchFreq
    return this.patches(d[0] * k + salt * 17.3, d[1] * k, d[2] * k)
  }

  /** The biome at a point, with edges made ragged so they don't follow the globe's grid. */
  biome(base: BaseSampler, lat: number, lon: number): number {
    if (base.only !== undefined) return base.only
    return base.biome(lat + this.patch(lat, lon, 1) * this.jitter, lon + this.patch(lat, lon, 2) * this.jitter)
  }
}

export const PLANTS = ['broadleaf', 'conifer', 'palm', 'acacia', 'bush', 'grass', 'flower', 'cactus', 'rock', 'reed', 'snag'] as const
export type Plant = (typeof PLANTS)[number]

/** Values per instance: x, y, z, scale, turn (radians), tint (0–1). */
export const INSTANCE_STRIDE = 6

/** How many of each plant (and rock) grow per km² in each biome, and how much they gather into patches (0 even, 1 clumped). */
const FLORA: Partial<Record<number, Partial<Record<Plant, [count: number, clump: number]>>>> = {
  [BIOME.ice]: { rock: [40, 0.3] },
  [BIOME.tundra]: { bush: [160, 0.6], grass: [1400, 0.4], rock: [140, 0.3], flower: [120, 0.8] },
  [BIOME.taiga]: { conifer: [1600, 0.5], bush: [160, 0.5], grass: [600, 0.5], rock: [50, 0.2] },
  [BIOME.temperateForest]: { broadleaf: [1300, 0.55], conifer: [160, 0.6], bush: [420, 0.5], grass: [1600, 0.4], flower: [160, 0.8] },
  [BIOME.grassland]: { broadleaf: [30, 0.8], bush: [110, 0.6], grass: [4200, 0.2], flower: [700, 0.8] },
  [BIOME.shrubland]: { bush: [750, 0.4], broadleaf: [30, 0.7], grass: [1300, 0.4], rock: [70, 0.3] },
  [BIOME.desert]: { cactus: [55, 0.4], rock: [170, 0.4], snag: [15, 0.5], bush: [45, 0.5] },
  [BIOME.savanna]: { acacia: [80, 0.6], grass: [3200, 0.25], bush: [160, 0.5] },
  [BIOME.rainforest]: { broadleaf: [2200, 0.25], palm: [320, 0.5], bush: [950, 0.3], grass: [600, 0.4] },
  [BIOME.swamp]: { broadleaf: [520, 0.6], reed: [2600, 0.5], bush: [300, 0.5], snag: [70, 0.5] },
  [BIOME.rock]: { rock: [650, 0.3], bush: [40, 0.6] },
  [BIOME.beach]: { palm: [45, 0.7], rock: [45, 0.4], grass: [300, 0.6] }
}

/** Metres tall (or across, for rocks) at scale 1, before each one's random size. */
const SIZE: Record<Plant, [min: number, max: number]> = {
  broadleaf: [8, 19],
  conifer: [10, 26],
  palm: [7, 14],
  acacia: [5, 9],
  bush: [0.8, 2.4],
  grass: [0.3, 0.8],
  flower: [0.2, 0.45],
  cactus: [1.5, 5],
  rock: [0.4, 3.2],
  reed: [1.2, 2.4],
  snag: [4, 10]
}

/** Plants that grow at the water's edge or in it rather than on dry land. */
const WET: Plant[] = ['reed']

export interface GroundChunkInput {
  id: ChunkId
  frame: LocalFrame
  seed: number
  grid: BaseGrid
  /** RGB (0–255) per biome id, and for the sea bed. */
  biomeColors: number[][]
  seabedColor: number[]
}

export interface GroundChunk {
  id: ChunkId
  /** Triangle mesh in frame metres, with skirts hiding seams between rows. */
  positions: Float32Array
  colors: Float32Array
  indices: Uint32Array
  /** Instances per plant, in random order: drawing the first n gives an even thinner spread. */
  plants: Partial<Record<Plant, Float32Array>>
}

/** Bare ground showing through. */
const EARTH = [122, 102, 74]

/** How far chunk skirts hang below their edges. */
export const SKIRT_M = 6

/** Vertices along a chunk edge. */
export const CHUNK_SEGMENTS = 48

/** Builds one chunk's ground mesh and plants. Pure: the same input always gives the same chunk. */
export function buildGroundChunk(input: GroundChunkInput): GroundChunk {
  const { id, frame, seed, grid } = input
  const detail = new GroundDetail(seed, frame.radiusKm)
  const base = gridSampler(grid)
  const b = grid.bounds
  const n = CHUNK_SEGMENTS + 1
  // The grid's vertices, then two skirt vertices for each segment of the four edges.
  const vertices = n * n + 4 * CHUNK_SEGMENTS * 2
  const positions = new Float32Array(vertices * 3)
  const colors = new Float32Array(vertices * 3)
  const indices = new Uint32Array(CHUNK_SEGMENTS * CHUNK_SEGMENTS * 6 + 4 * CHUNK_SEGMENTS * 12)
  // Per grid vertex, for the skirt below it: its height, its colour before light and shade, and its light.
  const heights = new Float64Array(n * n)
  const ground = new Float64Array(n * n * 3)
  const light = new Float64Array(n * n)

  for (let j = 0, t = 0; j < n; j++) {
    for (let i = 0; i < n; i++, t++) {
      const lat = b.lat0 + ((b.lat1 - b.lat0) * j) / CHUNK_SEGMENTS
      const lon = b.lon0 + ((b.lon1 - b.lon0) * i) / CHUNK_SEGMENTS
      const [x, z] = toLocal(frame, { lat, lon })
      const y = detail.elevation(base, lat, lon)
      positions[t * 3] = x
      positions[t * 3 + 1] = heights[t] = y
      positions[t * 3 + 2] = z
      const rgb = y < 0 ? input.seabedColor : y < 1.5 ? (input.biomeColors[BIOME.beach] ?? input.seabedColor) : input.biomeColors[detail.biome(base, lat, lon)]!
      // Some variation, so a field isn't one flat colour: lighter and darker patches, and bare earth here and there.
      const v = (light[t] = 0.86 + 0.12 * detail.patch(lat, lon, 3))
      const bare = y < 1.5 ? 0 : clamp(detail.patch(lat, lon, 5) * 1.6 - 0.7, 0, 0.45)
      for (let k = 0; k < 3; k++) colors[t * 3 + k] = (ground[t * 3 + k] = (rgb[k]! * (1 - bare) + EARTH[k]! * bare) / 255) * v
    }
  }
  let next = n * n
  let index = 0
  // North is −z, so with i east and j north these wind counter-clockwise seen from above.
  for (let j = 0; j < CHUNK_SEGMENTS; j++) {
    for (let i = 0; i < CHUNK_SEGMENTS; i++) {
      const a = j * n + i
      indices.set([a, a + 1, a + n + 1, a, a + n + 1, a + n], index)
      index += 6
    }
  }
  // Skirts: a strip hanging down from each edge, so neighbours that sample their shared edge differently never show a gap.
  // A skirt vertex is the one above it, dropped and in shadow.
  const skirt = (top: number) => {
    positions[next * 3] = positions[top * 3]!
    positions[next * 3 + 1] = heights[top]! - SKIRT_M
    positions[next * 3 + 2] = positions[top * 3 + 2]!
    for (let k = 0; k < 3; k++) colors[next * 3 + k] = ground[top * 3 + k]! * (light[top]! - 0.25)
    return next++
  }
  const edges: [number, number][][] = [
    Array.from({ length: n }, (_, i) => [0, i]),
    Array.from({ length: n }, (_, i) => [CHUNK_SEGMENTS, CHUNK_SEGMENTS - i]),
    Array.from({ length: n }, (_, j) => [CHUNK_SEGMENTS - j, 0]),
    Array.from({ length: n }, (_, j) => [j, CHUNK_SEGMENTS])
  ]
  for (const edge of edges) {
    for (let k = 0; k < edge.length - 1; k++) {
      const [j0, i0] = edge[k]!
      const [j1, i1] = edge[k + 1]!
      const top0 = j0 * n + i0
      const top1 = j1 * n + i1
      const low0 = skirt(top0)
      const low1 = skirt(top1)
      indices.set([top0, low0, low1, top0, low1, top1, top0, low1, low0, top0, top1, low1], index)
      index += 12
    }
  }

  return { id, positions, colors, indices, plants: scatterPlants(input, detail, base) }
}

/** Plants and rocks for a chunk, by its biomes; none in the sea, reeds only at the water's edge. */
function scatterPlants(input: GroundChunkInput, detail: GroundDetail, base: BaseSampler): GroundChunk['plants'] {
  const b = input.grid.bounds
  const out: Partial<Record<Plant, number[]>> = {}
  // Which plants this chunk can have: those of any biome sampled on it.
  const kinds = new Set<Plant>()
  for (const biome of new Set(input.grid.biome)) for (const p of Object.keys(FLORA[biome] ?? {})) kinds.add(p as Plant)
  for (const plant of PLANTS) {
    if (!kinds.has(plant)) continue
    const random = rng(subSeed(cellSeed(input.seed, input.id.row, input.id.col), PLANTS.indexOf(plant) + 1))
    const most = Math.max(...[...new Set(input.grid.biome)].map((biome) => FLORA[biome]?.[plant]?.[0] ?? 0))
    const list: number[] = []
    for (let k = 0; k < most; k++) {
      const lat = b.lat0 + random() * (b.lat1 - b.lat0)
      const lon = b.lon0 + random() * (b.lon1 - b.lon0)
      const keep = random()
      const size = random()
      const turn = random() * TAU
      const tint = random()
      const [count, clump] = FLORA[detail.biome(base, lat, lon)]?.[plant] ?? [0, 0]
      // Thinned to this spot's biome (patchiness is at most 1, so this one goes whatever its patch)…
      if (keep * most >= count) continue
      // …and gathered into woods and meadows with clearings between.
      const patchiness = 1 - clump + clump * clamp01(0.5 + detail.patch(lat, lon, PLANTS.indexOf(plant) + 4) * 1.4)
      if (keep * most >= count * patchiness) continue
      const y = detail.elevation(base, lat, lon)
      if (WET.includes(plant) ? y < -0.6 || y > 2.5 : y < 0.4) continue
      const [x, z] = toLocal(input.frame, { lat, lon })
      const [lo, hi] = SIZE[plant]
      list.push(x, y, z, lo + (hi - lo) * size * size, turn, tint)
    }
    if (list.length) out[plant] = list
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Float32Array.from(v)]))
}
