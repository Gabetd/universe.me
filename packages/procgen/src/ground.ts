import type { LatLon } from '@universe/core'
import type { NoiseFunction3D } from 'simplex-noise'
import { BIOME } from './biomes'
import { latLonToDir, type Vec3 } from './cubesphere'
import { RAD, TAU, bilerp, clamp, clamp01, smoothstep, wrapLon } from './math'
import { octaves, seededNoise } from './noise'
import { cellSeed, rng, subSeed } from './random'
import { WaterShaper, type GroundWaters } from './ground-water'
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

/** The base terrain over an area (a chunk, the distant ground), sampled on a small grid; enough to rebuild it elsewhere (a worker). */
export interface BaseGrid {
  bounds: ChunkBounds
  /** size × size samples, row-major from (lat0, lon0). */
  elevation: number[]
  biome: number[]
}

/** Samples along a chunk's grid. */
const GRID = 5

export function sampleBaseGrid(base: BaseSampler, bounds: ChunkBounds, size = GRID): BaseGrid {
  const elevation: number[] = []
  const biome: number[] = []
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const lat = bounds.lat0 + ((bounds.lat1 - bounds.lat0) * j) / (size - 1)
      const lon = bounds.lon0 + ((bounds.lon1 - bounds.lon0) * i) / (size - 1)
      elevation.push(base.elevation(lat, lon))
      biome.push(base.biome(lat, lon))
    }
  }
  return { bounds, elevation, biome }
}

/** Reads a sampled grid back, interpolating heights (biomes: the nearest sample). */
export function gridSampler(grid: BaseGrid): BaseSampler {
  const { bounds: b, elevation: e, biome } = grid
  const size = Math.round(Math.sqrt(e.length))
  // Where a point is on the grid, in samples.
  const gx = (lon: number) => clamp(((lon - b.lon0) / (b.lon1 - b.lon0)) * (size - 1), 0, size - 1)
  const gy = (lat: number) => clamp(((lat - b.lat0) / (b.lat1 - b.lat0)) * (size - 1), 0, size - 1)
  return {
    elevation(lat, lon) {
      const x = gx(lon)
      const y = gy(lat)
      const i0 = Math.min(size - 2, Math.floor(x))
      const j0 = Math.min(size - 2, Math.floor(y))
      const k = j0 * size + i0
      return bilerp(e[k]!, e[k + 1]!, e[k + size]!, e[k + size + 1]!, x - i0, y - j0)
    },
    biome: (lat, lon) => biome[Math.round(gy(lat)) * size + Math.round(gx(lon))]!,
    only: biome.every((v) => v === biome[0]) ? biome[0] : undefined
  }
}

/** How dry each biome is, 0 to 1: dry land has wadis (flat-floored channels a flash flood cut) and steps into mesas and ledges. */
const ARIDITY: Partial<Record<number, number>> = {
  [BIOME.desert]: 1,
  [BIOME.shrubland]: 0.75,
  [BIOME.savanna]: 0.55,
  [BIOME.rock]: 0.3,
  [BIOME.beach]: 0.4,
  [BIOME.grassland]: 0.25,
  [BIOME.tundra]: 0.2
}

/** The shapes of the land at a point, besides its height: how deep it lies in a channel's bed, and how dry the land is. */
export interface GroundShape {
  /** 0 out of any channel, 1 on its floor. */
  bed: number
  arid: number
  /** 0 to 1: under a river or a lake, or on its bank or shore (see `WaterTouch`). */
  wet: number
  /** Metres from a river's bank or a lake's shore (Infinity far from them). */
  shore: number
  /** The water's surface over it, under a river or a lake (NaN elsewhere). */
  surface: number
}

/** Seeded noise for the fine detail, shared by every chunk of a world. */
export class GroundDetail {
  private hills: NoiseFunction3D
  private patches: NoiseFunction3D
  private channels: NoiseFunction3D
  private warp: NoiseFunction3D
  /** The channels' network: the main ones some 2 km apart, their side gullies some 600 m, wandering (warped over about 3 km). */
  private channelFreq: number
  private gullyFreq: number
  private warpFreq: number
  /** What the last height asked for was shaped by (see `GroundShape`). */
  readonly shape: GroundShape = { bed: 0, arid: 0, wet: 0, shore: Infinity, surface: NaN }
  /** The rivers and lakes the land is shaped around, if any. */
  private water?: WaterShaper
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
    readonly radiusKm: number,
    waters?: GroundWaters
  ) {
    if (waters && (waters.courses.length || waters.lakes.length)) this.water = new WaterShaper(waters, radiusKm)
    this.hills = seededNoise(seed, 0x6a0d)
    this.patches = seededNoise(seed, 0x9a7c)
    this.channels = seededNoise(seed, 0x3c1d)
    this.warp = seededNoise(seed, 0x51f2)
    const metres = radiusKm * 1000
    this.channelFreq = metres / 2100
    this.gullyFreq = metres / 620
    this.warpFreq = metres / 3200
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
   * hills and bumps, rougher where the land is high, scaled by `detail`. With
   * `fine` (up close), the land is also cut by channels: in dry land wadis,
   * flat-floored with steep banks, and where it's high and rough, ravines,
   * deep and V-shaped, with side gullies running into both; and dry or rough
   * land steps into ledges and mesas with cliffs between. What shaped it is
   * left in `shape`.
   */
  elevation(base: BaseSampler, lat: number, lon: number, detail = 1, fine = true): number {
    const elevation = base.elevation(lat, lon)
    const shape = this.shape
    shape.bed = 0
    shape.arid = 0
    shape.wet = 0
    shape.shore = Infinity
    shape.surface = NaN
    if (detail <= 0) return elevation
    const y = this.landform(base, lat, lon, elevation, detail, fine)
    if (!this.water || detail < 1) return y
    // Rivers cut their valleys through it, and lakes lie in basins.
    const touch = this.water.shape(lat, lon, y)
    shape.wet = touch.wet
    shape.shore = touch.shore
    shape.surface = touch.surface
    return touch.y
  }

  /** The land before the water: hills, and up close channels and ledges (see `elevation`). */
  private landform(base: BaseSampler, lat: number, lon: number, elevation: number, detail: number, fine: boolean): number {
    const shape = this.shape
    const d = this.dirAt(lat, lon)
    const relief = 9 + clamp(Math.abs(elevation) * 0.04, 0, 110)
    let y = elevation + detail * octaves(this.hills, d[0], d[1], d[2], this.hillFreqs, relief, 0.4)
    // Under the sea and along the shore the land is as it is.
    const inland = clamp01((elevation - 2) / 30)
    if (!fine || inland <= 0) return y
    const arid = (shape.arid = ARIDITY[this.biome(base, lat, lon)] ?? 0)
    const rough = clamp01((relief - 25) / 70)

    // Ledges: the hills' slopes step into flats and cliffs, mostly in dry land (mesas and buttes), a little in rough.
    const ledges = (clamp01(arid * 0.9 - 0.1) * (0.6 + 0.4 * rough) + 0.2 * rough * (1 - arid)) * inland * detail
    if (ledges > 0) {
      const step = 12 + 18 * rough
      const f = y / step
      const floor = Math.floor(f)
      y += ((floor + smoothstep(0.55, 0.9, f - floor)) * step - y) * ledges
    }

    // Channels, along where the warped noise crosses zero.
    const w = this.warpFreq
    const [wx, wz] = [this.warp(d[0] * w, d[1] * w, d[2] * w) * 0.9, this.warp(d[0] * w + 41.3, d[1] * w, d[2] * w) * 0.9]
    const c = this.channelFreq
    const main = Math.abs(this.channels(d[0] * c + wx, d[1] * c, d[2] * c + wz))
    const g = this.gullyFreq
    const gully = Math.abs(this.channels(d[0] * g + 17.7 + wz, d[1] * g, d[2] * g + wx))
    // Each channel's cross-section: dry land's flat floor between steep banks, rough land's V.
    const profile = (v: number, width: number) => {
      const wadi = 1 - smoothstep(width * 0.4, width, v)
      const ravine = Math.pow(1 - Math.min(1, v / width), 1.6)
      return wadi * arid + ravine * (1 - arid)
    }
    const deep = (4 + 6 * arid + 60 * rough * (1 - arid * 0.5)) * inland * detail
    const cut = Math.max(profile(main, 0.09 + 0.04 * arid) * deep, profile(gully, 0.08) * deep * 0.35)
    if (cut > 0) {
      y -= cut
      shape.bed = smoothstep(0.5, 0.95, cut / Math.max(deep, 1e-6))
    }
    return y
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

export interface GroundChunkInput extends GroundColors {
  id: ChunkId
  frame: LocalFrame
  seed: number
  grid: BaseGrid
  /** The rivers and lakes near it (see `watersNear`), for the land to be shaped around. */
  waters?: GroundWaters
}

export interface GroundChunk {
  id: ChunkId
  /** Triangle mesh in frame metres, with skirts hiding seams between rows. */
  positions: Float32Array
  colors: Float32Array
  /** Worked out from the heights around each vertex, its neighbours' included, so chunks shade alike along their edges. */
  normals: Float32Array
  indices: Uint32Array
  /** Instances per plant, in random order: drawing the first n gives an even thinner spread. */
  plants: Partial<Record<Plant, Float32Array>>
}

/** Bare ground showing through. */
const EARTH = [122, 102, 74]
/** Rock where the land is too steep to hold soil: grey, or sandstone in dry land. */
const ROCK = [116, 110, 104]
const SANDSTONE = [176, 118, 78]
/** A dry channel's floor of pale gravel and sand, and a wet one's of mossy stones. */
const GRAVEL = [204, 188, 156]
const STREAMBED = [92, 98, 76]
/** Snow on high ground, and grass drying out. */
const SNOW = [236, 240, 246]
const SHORE_SAND = [196, 182, 140]
const DRY_GRASS = [156, 146, 86]
/** Biomes where nothing much grows, whose ground has no grass or soil to vary. */
const BARE = new Set<number>([BIOME.ice, BIOME.rock, BIOME.desert, BIOME.beach])
/** Snow lies above this height (metres), on ground that isn't too steep. */
const SNOWLINE = 2400

/** How far chunk skirts hang below their edges. */
export const SKIRT_M = 6

/** Vertices along a chunk edge, less one: about 16 m apart. */
export const CHUNK_SEGMENTS = 64

/**
 * Heights over a grid of size × size vertices and one more all round (so
 * normals at its edges match its neighbours'), with what shaped each, and
 * each vertex's normal and place in the frame.
 */
function heightField(
  size: number,
  at: (i: number, j: number) => { lat: number; lon: number },
  frame: LocalFrame,
  height: (lat: number, lon: number) => number,
  shape: GroundShape
) {
  const m = size + 2
  const heights = new Float64Array(m * m)
  const xz = new Float64Array(m * m * 2)
  const beds = new Float32Array(size * size)
  const arid = new Float32Array(size * size)
  const wet = new Float32Array(size * size)
  const shore = new Float32Array(size * size)
  for (let j = -1, t = 0; j <= size; j++) {
    for (let i = -1; i <= size; i++, t++) {
      const { lat, lon } = at(i, j)
      heights[t] = height(lat, lon)
      const [x, z] = toLocal(frame, { lat, lon })
      xz[t * 2] = x
      xz[t * 2 + 1] = z
      if (i >= 0 && j >= 0 && i < size && j < size) {
        beds[j * size + i] = shape.bed
        arid[j * size + i] = shape.arid
        wet[j * size + i] = shape.wet
        shore[j * size + i] = shape.shore
      }
    }
  }
  const normals = new Float32Array(size * size * 3)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const c = (j + 1) * m + i + 1
      const [e, w, n, s] = [c + 1, c - 1, c + m, c - m]
      const gx = (heights[e]! - heights[w]!) / (xz[e * 2]! - xz[w * 2]!)
      const gz = (heights[n]! - heights[s]!) / (xz[n * 2 + 1]! - xz[s * 2 + 1]!)
      const len = Math.hypot(gx, 1, gz)
      normals.set([-gx / len, 1 / len, -gz / len], (j * size + i) * 3)
    }
  }
  /** A vertex of the grid (0 to size − 1 each way): its height and place. */
  const vertex = (i: number, j: number) => {
    const t = (j + 1) * m + i + 1
    return { x: xz[t * 2]!, y: heights[t]!, z: xz[t * 2 + 1]! }
  }
  /** What shaped the land at a vertex, for its colour. */
  const lay = (t: number, up = normals[t * 3 + 1]!): Lay => ({ up, bed: beds[t]!, arid: arid[t]!, wet: wet[t]!, shore: shore[t]! })
  return { vertex, normals, lay }
}

/** Builds one chunk's ground mesh and plants. Pure: the same input always gives the same chunk. */
export function buildGroundChunk(input: GroundChunkInput): GroundChunk {
  const { id, frame, seed, grid } = input
  const detail = new GroundDetail(seed, frame.radiusKm, input.waters)
  const base = gridSampler(grid)
  const b = grid.bounds
  const n = CHUNK_SEGMENTS + 1
  const field = heightField(
    n,
    (i, j) => ({ lat: b.lat0 + ((b.lat1 - b.lat0) * j) / CHUNK_SEGMENTS, lon: b.lon0 + ((b.lon1 - b.lon0) * i) / CHUNK_SEGMENTS }),
    frame,
    (lat, lon) => detail.elevation(base, lat, lon),
    detail.shape
  )
  // The grid's vertices, then two skirt vertices for each segment of the four edges.
  const vertices = n * n + 4 * CHUNK_SEGMENTS * 2
  const positions = new Float32Array(vertices * 3)
  const colors = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const indices = new Uint32Array(CHUNK_SEGMENTS * CHUNK_SEGMENTS * 6 + 4 * CHUNK_SEGMENTS * 12)
  normals.set(field.normals)

  for (let j = 0, t = 0; j < n; j++) {
    for (let i = 0; i < n; i++, t++) {
      const lat = b.lat0 + ((b.lat1 - b.lat0) * j) / CHUNK_SEGMENTS
      const lon = b.lon0 + ((b.lon1 - b.lon0) * i) / CHUNK_SEGMENTS
      const { x, y, z } = field.vertex(i, j)
      positions.set([x, y, z], t * 3)
      groundColor(input, detail, base, lat, lon, y, field.lay(t), colors, t)
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
    positions[next * 3 + 1] = positions[top * 3 + 1]! - SKIRT_M
    positions[next * 3 + 2] = positions[top * 3 + 2]!
    for (let k = 0; k < 3; k++) {
      colors[next * 3 + k] = colors[top * 3 + k]! * 0.75
      normals[next * 3 + k] = normals[top * 3 + k]!
    }
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

  return { id, positions, colors, normals, indices, plants: scatterPlants(input, detail, base) }
}

/** What a point's colour follows besides its biome: how level the ground is (its normal's up), and its channel and dryness. */
interface Lay {
  up: number
  bed: number
  arid: number
  wet: number
  shore: number
}

const blend = (rgb: number[], to: readonly number[], k: number) => {
  if (k > 0) for (let c = 0; c < 3; c++) rgb[c] = rgb[c]! + (to[c]! - rgb[c]!) * k
}

/**
 * The ground's colour at a point (at height `y`), lit, into `out` at vertex `t`.
 * The biome's colour varied so a field isn't one flat colour (lighter and
 * darker patches, drier grass, bare earth here and there), rock where it's
 * too steep for soil, gravel or stones along channels' floors, and snow high up.
 */
function groundColor(input: GroundColors, detail: GroundDetail, base: BaseSampler, lat: number, lon: number, y: number, lay: Lay, out: Float32Array, t: number): void {
  const biome = y < 0 ? -1 : y < 1.5 ? BIOME.beach : detail.biome(base, lat, lon)
  const rgb = [...(biome < 0 ? input.seabedColor : (input.biomeColors[biome] ?? input.seabedColor))]
  if (y >= 1.5) {
    // Where things grow: drier grass and bare earth here and there.
    if (!BARE.has(biome)) {
      blend(rgb, DRY_GRASS, clamp(detail.patch(lat, lon, 7) * 0.9 + lay.arid * 0.3 - 0.1, 0, 0.45) * (1 - lay.arid * 0.6))
      blend(rgb, EARTH, clamp(detail.patch(lat, lon, 5) * 1.6 - 0.7, 0, 0.45))
    }
    // A dry channel's floor shows; a wet one's is grassed over, a little darker.
    blend(rgb, lay.arid > 0.4 ? GRAVEL : STREAMBED, lay.bed * (lay.arid > 0.4 ? 0.85 : 0.25))
    // Rivers' banks of mud and stones, lakes' shores of sand, and what's under them.
    blend(rgb, STREAMBED, Math.max(lay.wet, smoothstep(14, 0, lay.shore) * 0.8))
    blend(rgb, SHORE_SAND, smoothstep(45, 5, lay.shore) * (1 - lay.wet) * 0.5)
    // Steep: soil can't hold, and the rock shows (a cliff, a ravine's walls).
    blend(rgb, lay.arid > 0.4 ? SANDSTONE : ROCK, smoothstep(0.86, 0.62, lay.up))
    // Snow where it can lie, in drifts and patches near the snowline.
    blend(rgb, SNOW, smoothstep(SNOWLINE, SNOWLINE + 500, y + detail.patch(lat, lon, 8) * 350) * smoothstep(0.78, 0.92, lay.up))
  }
  const light = 0.86 + 0.12 * detail.patch(lat, lon, 3)
  for (let c = 0; c < 3; c++) out[t * 3 + c] = (rgb[c]! / 255) * light
}

/** How far the distant ground reaches from the middle of the view, in metres. */
export const FAR_M = 12_000
/** Vertices along the distant ground's edge, less one: 250 m apart. */
export const FAR_SEGMENTS = 96
/** Samples of the globe's terrain along the distant ground's edge: 500 m apart. */
export const FAR_GRID = 49

/** The distant ground's lat/lon edges: a square FAR_M out from the middle of chunk `center` each way. */
export function farBounds(center: ChunkId, radiusKm: number): ChunkBounds {
  const c = chunkBounds(center, radiusKm)
  const [lat, lon] = [(c.lat0 + c.lat1) / 2, (c.lon0 + c.lon1) / 2]
  const dLat = FAR_M / metresPerDegLat(radiusKm)
  const dLon = dLat / Math.max(0.02, Math.cos(lat * RAD))
  return { lat0: Math.max(-90, lat - dLat), lat1: Math.min(90, lat + dLat), lon0: lon - dLon, lon1: lon + dLon }
}

interface GroundColors {
  /** RGB (0–255) per biome id, and for the sea bed. */
  biomeColors: number[][]
  seabedColor: number[]
}

export interface FarGroundInput extends GroundColors {
  /** The rivers and lakes over it (see `watersNear`), for the land to be shaped around. */
  waters?: GroundWaters
  /** The chunk in the middle of the view; the sheet is built in a frame at its south-west corner, like a chunk. */
  center: ChunkId
  frame: LocalFrame
  seed: number
  /** The globe's terrain over `farBounds`, FAR_GRID samples a side. */
  grid: BaseGrid
  /** Within this many metres of the middle of the view (each way), the sheet is sunk out of sight: the chunks are there. */
  sinkWithin: number
}

/** How far the distant ground is sunk where the chunks cover it. */
const SUNK_M = 60

/** A sheet of ground: a mesh in frame metres. */
export interface GroundSheet {
  positions: Float32Array
  colors: Float32Array
  indices: Uint32Array
  /** If known (otherwise the view works them out from the mesh). */
  normals?: Float32Array
}

/**
 * The ground beyond the chunks, out to FAR_M: one coarse sheet with the same
 * hills and colours (no plants), drawn behind the chunks. Pure, like a chunk.
 */
export function buildFarGround(input: FarGroundInput): GroundSheet {
  const { frame, grid } = input
  const detail = new GroundDetail(input.seed, frame.radiusKm, input.waters)
  const base = gridSampler(grid)
  const b = grid.bounds
  const n = FAR_SEGMENTS + 1
  const positions = new Float32Array(n * n * 3)
  const colors = new Float32Array(n * n * 3)
  const indices = new Uint32Array(FAR_SEGMENTS * FAR_SEGMENTS * 6)
  const place = (i: number, j: number) => ({ lat: b.lat0 + ((b.lat1 - b.lat0) * j) / FAR_SEGMENTS, lon: b.lon0 + ((b.lon1 - b.lon0) * i) / FAR_SEGMENTS })
  // Too coarse for channels and ledges (250 m apart), which would show as pits: the hills alone.
  const field = heightField(n, place, frame, (lat, lon) => detail.elevation(base, lat, lon, 1, false), detail.shape)
  for (let j = 0, t = 0; j < n; j++) {
    for (let i = 0; i < n; i++, t++) {
      const { lat, lon } = place(i, j)
      const { x, y, z } = field.vertex(i, j)
      // The middle of the centre chunk is (CHUNK_M / 2, −CHUNK_M / 2) in its corner's frame.
      const under = Math.max(Math.abs(x - CHUNK_M / 2), Math.abs(z + CHUNK_M / 2)) < input.sinkWithin
      positions.set([x, under ? y - SUNK_M : y, z], t * 3)
      groundColor(input, detail, base, lat, lon, y, { ...field.lay(t), arid: ARIDITY[detail.biome(base, lat, lon)] ?? 0 }, colors, t)
    }
  }
  for (let j = 0, index = 0; j < FAR_SEGMENTS; j++) {
    for (let i = 0; i < FAR_SEGMENTS; i++, index += 6) {
      const a = j * n + i
      indices.set([a, a + 1, a + n + 1, a, a + n + 1, a + n], index)
    }
  }
  return { positions, colors, indices, normals: field.normals }
}

/** How far the ground reaches, all told: the land beyond the distant ground, out to where the planet's curve hides even mountains. */
export const HORIZON_M = 160_000
/** The horizon's sheet starts this far out, inside the distant ground (which covers it there). */
const HORIZON_INNER_M = 6000
/** Rings of the horizon's sheet, spaced wider and wider outward, and the spokes across them. */
export const HORIZON_RINGS = 64
export const HORIZON_SPOKES = 192
/** Samples of the globe's terrain along the horizon's square's edge: about 4 km apart. */
export const HORIZON_GRID = 81
/** The horizon's sheet is built again when the view has moved this many chunks from its middle, each way. */
export const HORIZON_STEP = 8

/** The horizon's lat/lon edges: a square HORIZON_M out from `center` each way. */
export function horizonBounds(center: LatLon, radiusKm: number): ChunkBounds {
  const dLat = HORIZON_M / metresPerDegLat(radiusKm)
  const dLon = dLat / Math.max(0.02, Math.cos(center.lat * RAD))
  return { lat0: Math.max(-90, center.lat - dLat), lat1: Math.min(90, center.lat + dLat), lon0: center.lon - dLon, lon1: center.lon + dLon }
}

/** The middle of the horizon's sheet for a view whose middle is in chunk `id`: the corner of its block of HORIZON_STEP chunks. */
export function horizonCenter(id: ChunkId, radiusKm: number): LatLon {
  const step = (n: number) => Math.round(n / HORIZON_STEP) * HORIZON_STEP
  const b = chunkBounds({ row: step(id.row), col: step(id.col) }, radiusKm)
  return { lat: b.lat0, lon: b.lon0 }
}

export interface HorizonGroundInput extends GroundColors {
  /** The sheet's middle (see `horizonCenter`); it's built in a frame there. */
  frame: LocalFrame
  seed: number
  /** The globe's terrain over `horizonBounds`, HORIZON_GRID samples a side. */
  grid: BaseGrid
}

/**
 * The land beyond the distant ground, to the horizon: rings of ever wider
 * spacing around the middle, with the globe's terrain and colours and the
 * hills fading out as they get too small to see. It's drawn only where the
 * nearer ground isn't (and sinks under it); the planet's curve, drawn by the
 * view, takes it down behind the horizon. Pure, like a chunk.
 */
export function buildHorizonGround(input: HorizonGroundInput): GroundSheet {
  const { frame, grid } = input
  const detail = new GroundDetail(input.seed, frame.radiusKm)
  const base = gridSampler(grid)
  const vertices = HORIZON_RINGS * HORIZON_SPOKES
  const positions = new Float32Array(vertices * 3)
  const colors = new Float32Array(vertices * 3)
  const indices = new Uint32Array((HORIZON_RINGS - 1) * HORIZON_SPOKES * 6)
  const grow = Math.pow(HORIZON_M / HORIZON_INNER_M, 1 / (HORIZON_RINGS - 1))
  for (let k = 0, t = 0; k < HORIZON_RINGS; k++) {
    const r = HORIZON_INNER_M * Math.pow(grow, k)
    // The hills fade out as the rings grow too coarse to show them.
    const hills = 1 - clamp01((r - 14_000) / 26_000)
    for (let s = 0; s < HORIZON_SPOKES; s++, t++) {
      const a = (s / HORIZON_SPOKES) * TAU
      const [x, z] = [Math.cos(a) * r, Math.sin(a) * r]
      const { lat, lon } = fromLocal(frame, x, z)
      const y = detail.elevation(base, lat, lon, hills, false)
      // Under the distant ground (FAR_M each way from wherever the view's middle is in this block), sunk well out of the way.
      const under = Math.max(Math.abs(x), Math.abs(z)) < FAR_M - (HORIZON_STEP / 2 + 1) * CHUNK_M
      positions.set([x, under ? y - 400 : y, z], t * 3)
      groundColor(input, detail, base, lat, lon, y, { up: 1, bed: 0, arid: ARIDITY[detail.biome(base, lat, lon)] ?? 0, wet: 0, shore: Infinity }, colors, t)
    }
  }
  for (let k = 0, index = 0; k < HORIZON_RINGS - 1; k++) {
    for (let s = 0; s < HORIZON_SPOKES; s++, index += 6) {
      const a = k * HORIZON_SPOKES + s
      const b = k * HORIZON_SPOKES + ((s + 1) % HORIZON_SPOKES)
      // Counter-clockwise seen from above (x east, z south).
      indices.set([a, b, a + HORIZON_SPOKES, b, b + HORIZON_SPOKES, a + HORIZON_SPOKES], index)
    }
  }
  return { positions, colors, indices }
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
      // Reeds at the sea's edge and along rivers and lakes; nothing else in the water.
      const { wet, shore } = detail.shape
      if (WET.includes(plant) ? !(y > -0.6 && y < 2.5) && !(shore < 25 && wet < 0.9) : y < 0.4 || wet > 0.2) continue
      const [x, z] = toLocal(input.frame, { lat, lon })
      const [lo, hi] = SIZE[plant]
      list.push(x, y, z, lo + (hi - lo) * size * size, turn, tint)
    }
    if (list.length) out[plant] = list
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Float32Array.from(v)]))
}
