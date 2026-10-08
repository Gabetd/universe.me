import type { LatLon } from '@universe/core'
import { createNoise3D, type NoiseFunction3D } from 'simplex-noise'
import { BIOME } from './biomes'
import { latLonToDir } from './cubesphere'
import { clamp } from './math'
import { rng, subSeed } from './random'
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
const RAD = Math.PI / 180

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
  const dLon = ((((p.lon - f.origin.lon + 180) % 360) + 360) % 360) - 180
  return [dLon * m * Math.cos(f.origin.lat * RAD), -(p.lat - f.origin.lat) * m]
}

export function fromLocal(f: LocalFrame, x: number, z: number): LatLon {
  const m = metresPerDegLat(f.radiusKm)
  const lat = clamp(f.origin.lat - z / m, -90, 90)
  const lon = f.origin.lon + x / (m * Math.max(0.02, Math.cos(f.origin.lat * RAD)))
  return { lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180 }
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

/** The globe-scale terrain at a point: metres above sea level and the biome there. */
export type BaseSampler = (lat: number, lon: number) => { elevation: number; biome: number }

/** The base terrain from a live model (in the UI thread). */
export function modelSampler(model: TerrainModel): BaseSampler {
  const dir: [number, number, number] = [0, 0, 0]
  return (lat, lon) => {
    latLonToDir(lat, lon, dir)
    const { face, cell } = model.cellAt(...dir)
    return { elevation: model.sampleHeight(...dir) - model.settings.seaLevel, biome: model.biome(face, cell) }
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
      const s = base(bounds.lat0 + ((bounds.lat1 - bounds.lat0) * j) / (GRID - 1), bounds.lon0 + ((bounds.lon1 - bounds.lon0) * i) / (GRID - 1))
      elevation.push(s.elevation)
      biome.push(s.biome)
    }
  }
  return { bounds, elevation, biome }
}

/** Reads a sampled grid back, interpolating heights (biomes: the nearest sample). */
export function gridSampler(grid: BaseGrid): BaseSampler {
  const { bounds: b } = grid
  return (lat, lon) => {
    const gx = clamp(((lon - b.lon0) / (b.lon1 - b.lon0)) * (GRID - 1), 0, GRID - 1)
    const gy = clamp(((lat - b.lat0) / (b.lat1 - b.lat0)) * (GRID - 1), 0, GRID - 1)
    const i0 = Math.min(GRID - 2, Math.floor(gx))
    const j0 = Math.min(GRID - 2, Math.floor(gy))
    const fx = gx - i0
    const fy = gy - j0
    const e = (i: number, j: number) => grid.elevation[j * GRID + i]!
    const elevation = (e(i0, j0) * (1 - fx) + e(i0 + 1, j0) * fx) * (1 - fy) + (e(i0, j0 + 1) * (1 - fx) + e(i0 + 1, j0 + 1) * fx) * fy
    return { elevation, biome: grid.biome[Math.round(gy) * GRID + Math.round(gx)]! }
  }
}

/** Seeded noise for the fine detail, shared by every chunk of a world. */
export class GroundDetail {
  private hills: NoiseFunction3D
  private patches: NoiseFunction3D

  constructor(
    seed: number,
    readonly radiusKm: number
  ) {
    this.hills = createNoise3D(rng(subSeed(seed, 0x6a0d)))
    this.patches = createNoise3D(rng(subSeed(seed, 0x9a7c)))
  }

  private point(lat: number, lon: number, wavelength: number): [number, number, number] {
    const d = latLonToDir(lat, lon)
    const k = (this.radiusKm * 1000) / wavelength
    return [d[0] * k, d[1] * k, d[2] * k]
  }

  /**
   * Height in metres above sea level: the globe's smooth terrain plus rolling
   * hills and bumps, rougher where the land is high.
   */
  elevation(base: BaseSampler, lat: number, lon: number): number {
    const { elevation } = base(lat, lon)
    const amp = 9 + clamp(Math.abs(elevation) * 0.04, 0, 110)
    let h = 0
    let a = amp
    let wavelength = 1800
    for (let o = 0; o < 4; o++) {
      h += a * this.hills(...this.point(lat, lon, wavelength))
      a *= 0.4
      wavelength /= 3.2
    }
    return elevation + h
  }

  /** −1 to 1, varying over a few hundred metres: woods and clearings, patches of flowers. */
  patch(lat: number, lon: number, salt: number): number {
    const [x, y, z] = this.point(lat, lon, 380)
    return this.patches(x + salt * 17.3, y, z)
  }

  /** The biome at a point, with edges made ragged so they don't follow the globe's grid. */
  biome(base: BaseSampler, lat: number, lon: number): number {
    const jitter = (CHUNK_M / (this.radiusKm * 1000 * RAD)) * 0.6
    return base(lat + this.patch(lat, lon, 1) * jitter, lon + this.patch(lat, lon, 2) * jitter).biome
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
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []

  const vertex = (lat: number, lon: number, drop = 0) => {
    const [x, z] = toLocal(frame, { lat, lon })
    const y = detail.elevation(base, lat, lon)
    positions.push(x, y - drop, z)
    const rgb = y < 0 ? input.seabedColor : y < 1.5 ? (input.biomeColors[BIOME.beach] ?? input.seabedColor) : input.biomeColors[detail.biome(base, lat, lon)]!
    // Some variation, so a field isn't one flat colour: lighter and darker patches, and bare earth here and there.
    const v = 0.86 + 0.12 * detail.patch(lat, lon, 3) + (drop ? -0.25 : 0)
    const bare = y < 1.5 ? 0 : clamp(detail.patch(lat, lon, 5) * 1.6 - 0.7, 0, 0.45)
    for (let k = 0; k < 3; k++) colors.push(((rgb[k]! * (1 - bare) + EARTH[k]! * bare) / 255) * v)
    return positions.length / 3 - 1
  }

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) vertex(b.lat0 + ((b.lat1 - b.lat0) * j) / CHUNK_SEGMENTS, b.lon0 + ((b.lon1 - b.lon0) * i) / CHUNK_SEGMENTS)
  }
  // North is −z, so with i east and j north these wind counter-clockwise seen from above.
  for (let j = 0; j < CHUNK_SEGMENTS; j++) {
    for (let i = 0; i < CHUNK_SEGMENTS; i++) {
      const a = j * n + i
      indices.push(a, a + 1, a + n + 1, a, a + n + 1, a + n)
    }
  }
  // Skirts: a strip hanging down from each edge, so neighbours that sample their shared edge differently never show a gap.
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
      const lat = (j: number) => b.lat0 + ((b.lat1 - b.lat0) * j) / CHUNK_SEGMENTS
      const lon = (i: number) => b.lon0 + ((b.lon1 - b.lon0) * i) / CHUNK_SEGMENTS
      const low0 = vertex(lat(j0), lon(i0), SKIRT_M)
      const low1 = vertex(lat(j1), lon(i1), SKIRT_M)
      indices.push(top0, low0, low1, top0, low1, top1, top0, low1, low0, top0, top1, low1)
    }
  }

  return {
    id,
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colors),
    indices: Uint32Array.from(indices),
    plants: scatterPlants(input, detail, base)
  }
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
    const random = rng(subSeed(input.seed ^ Math.imul(input.id.row, 73856093) ^ Math.imul(input.id.col, 19349663), PLANTS.indexOf(plant) + 1))
    const most = Math.max(...[...new Set(input.grid.biome)].map((biome) => FLORA[biome]?.[plant]?.[0] ?? 0))
    const list: number[] = []
    for (let k = 0; k < most; k++) {
      const lat = b.lat0 + random() * (b.lat1 - b.lat0)
      const lon = b.lon0 + random() * (b.lon1 - b.lon0)
      const keep = random()
      const size = random()
      const turn = random() * Math.PI * 2
      const tint = random()
      const [count, clump] = FLORA[detail.biome(base, lat, lon)]?.[plant] ?? [0, 0]
      // Thinned to this spot's biome, and gathered into woods and meadows with clearings between.
      const patchiness = 1 - clump + clump * clamp(0.5 + detail.patch(lat, lon, PLANTS.indexOf(plant) + 4) * 1.4, 0, 1)
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
