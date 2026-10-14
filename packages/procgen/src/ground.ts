import type { LatLon } from '@universe/core'
import type { NoiseFunction3D } from 'simplex-noise'
import { BIOME } from './biomes'
import { latLonToDir, type Vec3 } from './cubesphere'
import { RAD, TAU, bilerp, clamp, clamp01, smoothstep, wrapLon } from './math'
import { seededNoise } from './noise'
import { cellSeed, rng, subSeed } from './random'
import { WaterShaper, type GroundWaters } from './ground-water'
import { ScarShaper, type LandScar, type ScarTouch } from './scars'
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
    // Without the globe's craters: the ground shapes its own, finer.
    elevation: (lat, lon) => model.heightOf(at(lat, lon), false) - model.settings.seaLevel,
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
  /** The kinds of land over tens of kilometres, mountains' ridges, steep hills, rough ground and cliffs. */
  private regions: NoiseFunction3D
  private mountains: NoiseFunction3D
  private steep: NoiseFunction3D
  private bumps: NoiseFunction3D
  private scarps: NoiseFunction3D
  /** The channels' network: the main ones some 2 km apart, their side gullies some 600 m, wandering (warped over about 3 km). */
  private channelFreq: number
  private gullyFreq: number
  private warpFreq: number
  /** What the last height asked for was shaped by (see `GroundShape`). */
  readonly shape: GroundShape = { bed: 0, arid: 0, wet: 0, shore: Infinity, surface: NaN }
  /** The rivers and lakes the land is shaped around, if any. */
  private water?: WaterShaper
  /** The scars on the land at the moment shown, if any (see scars.ts). */
  private scars?: ScarShaper
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
    waters?: GroundWaters,
    scars?: readonly LandScar[]
  ) {
    if (waters && (waters.courses.length || waters.lakes.length)) this.water = new WaterShaper(waters, radiusKm)
    const shaper = scars && new ScarShaper(scars, radiusKm)
    if (shaper?.any) this.scars = shaper
    this.hills = seededNoise(seed, 0x6a0d)
    this.patches = seededNoise(seed, 0x9a7c)
    this.channels = seededNoise(seed, 0x3c1d)
    this.warp = seededNoise(seed, 0x51f2)
    this.regions = seededNoise(seed, 0x2e61)
    this.mountains = seededNoise(seed, 0x7a3b)
    this.steep = seededNoise(seed, 0x45c9)
    this.bumps = seededNoise(seed, 0x18d4)
    this.scarps = seededNoise(seed, 0x6f0e)
    const metres = radiusKm * 1000
    this.channelFreq = metres / 2100
    this.gullyFreq = metres / 620
    this.warpFreq = metres / 3200
    this.patchFreq = metres / 380
    this.jitter = (CHUNK_M / metresPerDegLat(radiusKm)) * 0.6
  }

  /** -1 to 1, varying over `wavelength` metres: one octave of `noise`, offset by `salt`. */
  private wave(noise: NoiseFunction3D, d: Vec3, wavelength: number, salt: number): number {
    const f = (this.radiusKm * 1000) / wavelength
    return noise(d[0] * f + salt, d[1] * f, d[2] * f - salt)
  }

  /** `count` octaves of `noise` from `wavelength` metres down, each half as long and `gain` as strong, the first of strength 1; those shorter than twice `spacing` left out. */
  private layers(noise: NoiseFunction3D, d: Vec3, wavelength: number, count: number, gain: number, spacing: number): number {
    let [sum, amp, length] = [0, 1, wavelength]
    for (let o = 0; o < count && length >= 2 * spacing; o++, length /= 2.03, amp *= gain) sum += amp * this.wave(noise, d, length, o * 7.31)
    return sum
  }

  /** Ridged mountains, 0 to about 1: sharp crests where the noise crosses zero, each octave sharper where the last was high (a ridged multifractal, warped so ranges wind). */
  private ridges(d: Vec3, spacing: number): number {
    // Pushed about by up to 4 km, so ranges wind rather than run straight.
    const warp = (this.wave(this.warp, d, 30_000, 5.5) * 4000) / (this.radiusKm * 1000)
    const w: Vec3 = [d[0] + warp, d[1] - warp, d[2] + warp * 0.5]
    let [sum, weight, amp, length, total] = [0, 1, 1, 9000, 0]
    for (let o = 0; o < 5 && length >= 2 * spacing; o++, length /= 2.1, amp *= 0.4) {
      // Crests rounded, the small ones more, so they're ridges rather than rows of knife edges.
      const n = this.wave(this.mountains, w, length, o * 3.7)
      let v = 1 - Math.sqrt(n * n + 0.004 + 0.012 * o)
      v *= v * weight
      weight = clamp01(v * 1.8)
      sum += v * amp
      total += amp
    }
    return total > 0 ? sum / 1.6 : 0.3
  }

  /**
   * Sudden cliffs: the ground stepping down a couple of metres across lines
   * a few hundred metres apart (a few feet in the plains, more in hill
   * country), and in rough land, scarps of tens of metres between ledges.
   */
  private cliffs(d: Vec3, rough: number, hills: number): number {
    // Some country is cut by cliffs and some isn't: patches a few kilometres across.
    const cut = smoothstep(0.05, 0.4, this.wave(this.regions, d, 6000, 13.3))
    if (cut <= 0) return 0
    const bend = this.wave(this.warp, d, 2600, 8.8) * 0.35
    const small = this.wave(this.scarps, [d[0] + bend * 0.0004, d[1], d[2] - bend * 0.0004], 1100, 1.3)
    let lift = smoothstep(-0.025, 0.025, small) * (1.2 + 3 * hills + 5 * rough)
    const big = this.wave(this.scarps, d, 3200, 4.9) + bend * 0.3
    lift += smoothstep(-0.02, 0.02, big) * (20 + 35 * rough) * rough
    return lift * cut
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
   * left in `shape`. `spacing` (metres) leaves out hills too small to show
   * between points that far apart, which would only be noise there.
   */
  elevation(base: BaseSampler, lat: number, lon: number, detail = 1, fine = true, spacing = 0): number {
    const elevation = base.elevation(lat, lon)
    const shape = this.shape
    shape.bed = 0
    shape.arid = 0
    shape.wet = 0
    shape.shore = Infinity
    shape.surface = NaN
    if (detail <= 0) return elevation
    const y = this.landform(base, lat, lon, elevation, detail, fine, spacing)
    if (!this.water || detail < 1) return this.scarred(lat, lon, y, fine)
    // Rivers cut their valleys through it, and lakes lie in basins.
    const touch = this.water.shape(lat, lon, y)
    shape.wet = touch.wet
    shape.shore = touch.shore
    shape.surface = touch.surface
    return this.scarred(lat, lon, touch.y, fine)
  }

  /** A height with the scars' craters, and up close war's shell holes, in it. */
  private scarred(lat: number, lon: number, y: number, fine: boolean): number {
    if (!this.scars) return y
    const ragged = this.patch(lat, lon, 11)
    return y + this.scars.touchAt(lat, lon, ragged).dh + (fine ? this.scars.pocks(lat, lon, ragged) : 0)
  }

  /** What the scars do at a point (its colour, the plants that die there), if there are any. */
  scarAt(lat: number, lon: number): ScarTouch | undefined {
    return this.scars?.touchAt(lat, lon, this.patch(lat, lon, 11))
  }

  /** The land before the water: hills, and up close channels and ledges (see `elevation`). */
  private landform(base: BaseSampler, lat: number, lon: number, elevation: number, detail: number, fine: boolean, spacing: number): number {
    const shape = this.shape
    const d = this.dirAt(lat, lon)
    // What kind of land this is, over tens of kilometres: plains, hills, extreme hills or mountains; the higher the globe has it, the more mountainous.
    const high = clamp01(elevation / 2500)
    const mountains = smoothstep(0.2, 0.6, this.wave(this.regions, d, 41_000, 3.1) * 0.6 + high * 0.9 - 0.2)
    const hilly = this.wave(this.regions, d, 23_000, 9.7)
    const hills = smoothstep(-0.6, 0.15, hilly) * (1 - mountains * 0.5)
    const extreme = smoothstep(0.3, 0.7, hilly) * (1 - mountains)
    // Into the sea the land's shapes fade, so the sea bed stays gentle and the coast is where the globe has it.
    const coast = smoothstep(-40, 30, elevation) * detail
    let lift = 0
    // Rolling land everywhere (even the plains swell and dip), hills in hill country.
    lift += this.layers(this.hills, d, 2400, 4, 0.45, spacing) * (25 + 70 * hills + 30 * mountains + clamp(Math.abs(elevation) * 0.03, 0, 60))
    // Extreme hills: steep-sided, close together.
    if (extreme > 0) lift += this.layers(this.steep, d, 1300, 3, 0.5, spacing) * 170 * extreme
    // Mountains: ridges and peaks hundreds of metres to a kilometre and more over their valleys.
    if (mountains > 0) lift += (this.ridges(d, spacing) - 0.3) * (450 + 1400 * high) * mountains
    let y = elevation + coast * lift
    // Land stays land: what the globe has above the sea doesn't sink under it.
    if (elevation > 0) y = Math.max(y, Math.min(elevation, 2) * 0.5 + 0.3)
    const rough = clamp01(mountains + extreme * 0.7 + hills * 0.3)
    // Up close: rough ground, and sudden cliffs.
    if (fine && coast > 0) {
      y += this.layers(this.bumps, d, 150, 3, 0.5, spacing) * (0.8 + 2 * hills + 5 * rough) * coast
      y += this.cliffs(d, rough, hills) * coast
    }
    const inland = clamp01((elevation - 2) / 30)
    if (!fine || inland <= 0) return y
    const arid = (shape.arid = ARIDITY[this.biome(base, lat, lon)] ?? 0)

    // Ledges: dry land's slopes step into flats and cliffs (mesas and buttes).
    const ledges = clamp01(arid * 0.9 - 0.1) * (0.6 + 0.4 * rough) * inland * detail
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
    // Ravines deep in rough land, and side gullies shallow: the mountains and hills already give the land its shape.
    const deep = (4 + 6 * arid + 22 * rough * (1 - arid * 0.5)) * inland * detail
    const cut = Math.max(profile(main, 0.09 + 0.04 * arid) * deep, profile(gully, 0.07) * Math.min(deep, 8) * 0.4)
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
  [BIOME.taiga]: { conifer: [2800, 0.55], bush: [200, 0.5], grass: [600, 0.5], rock: [80, 0.2] },
  [BIOME.temperateForest]: { broadleaf: [2400, 0.6], conifer: [360, 0.6], bush: [520, 0.5], grass: [1600, 0.4], flower: [160, 0.8] },
  [BIOME.grassland]: { broadleaf: [90, 0.85], bush: [160, 0.6], grass: [4200, 0.2], flower: [700, 0.8] },
  [BIOME.shrubland]: { bush: [750, 0.4], broadleaf: [30, 0.7], grass: [1300, 0.4], rock: [70, 0.3] },
  [BIOME.desert]: { cactus: [55, 0.4], rock: [170, 0.4], snag: [15, 0.5], bush: [45, 0.5] },
  [BIOME.savanna]: { acacia: [80, 0.6], grass: [3200, 0.25], bush: [160, 0.5] },
  [BIOME.rainforest]: { broadleaf: [3600, 0.25], palm: [520, 0.5], bush: [1200, 0.3], grass: [600, 0.4] },
  [BIOME.swamp]: { broadleaf: [800, 0.6], reed: [2600, 0.5], bush: [300, 0.5], snag: [70, 0.5] },
  [BIOME.rock]: { rock: [650, 0.3], bush: [40, 0.6] },
  [BIOME.beach]: { palm: [45, 0.7], rock: [45, 0.4], grass: [300, 0.6] }
}

/** The trees among the plants. */
const TREES: Plant[] = ['broadleaf', 'conifer', 'palm', 'acacia']

/** How thick the woods are at a point, 0 to 1 (as the chunks' trees grow there): what the distant ground shows as canopy, its trees too far off to draw. */
function canopy(detail: GroundDetail, base: BaseSampler, lat: number, lon: number): number {
  const flora = FLORA[detail.biome(base, lat, lon)]
  const trees = TREES.reduce((sum, t) => sum + (flora?.[t]?.[0] ?? 0), 0)
  return clamp01(trees / 2400) * clamp01(0.5 + detail.patch(lat, lon, PLANTS.indexOf('broadleaf') + 4) * 1.4) * (1 - (detail.scarAt(lat, lon)?.kills ?? 0))
}

/** How tall the woods stand, seen from afar, and how much darker their canopy is than the ground. */
const CANOPY_M = 16
const CANOPY_SHADE = 0.4

/** Raises a far vertex by the woods there and darkens it to their canopy (its colour at `t`); returns its height. */
function withCanopy(detail: GroundDetail, base: BaseSampler, lat: number, lon: number, y: number, colors: Float32Array, t: number): number {
  if (y < 1.5) return y
  const woods = canopy(detail, base, lat, lon)
  for (let c = 0; c < 3; c++) colors[t * 3 + c]! *= 1 - CANOPY_SHADE * woods
  return y + CANOPY_M * woods
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

/** Vertices along a chunk edge, less one: about 10 m apart, so a cliff of a few metres is a cliff. */
export const CHUNK_SEGMENTS = 96

/**
 * Heights over a grid of `cols` × `rows` vertices (`rows` = `cols` unless
 * given) and one more all round (so normals at its edges match its
 * neighbours'), with what shaped each, and each vertex's normal and place in
 * the frame.
 */
function heightField(
  cols: number,
  at: (i: number, j: number) => { lat: number; lon: number },
  frame: LocalFrame,
  height: (lat: number, lon: number) => number,
  shape: GroundShape,
  rows = cols
) {
  const m = cols + 2
  const cells = cols * rows
  const heights = new Float64Array(m * (rows + 2))
  const xz = new Float64Array(m * (rows + 2) * 2)
  const beds = new Float32Array(cells)
  const arid = new Float32Array(cells)
  const wet = new Float32Array(cells)
  const shore = new Float32Array(cells)
  const surface = new Float32Array(cells)
  for (let j = -1, t = 0; j <= rows; j++) {
    for (let i = -1; i <= cols; i++, t++) {
      const { lat, lon } = at(i, j)
      heights[t] = height(lat, lon)
      const [x, z] = toLocal(frame, { lat, lon })
      xz[t * 2] = x
      xz[t * 2 + 1] = z
      if (i >= 0 && j >= 0 && i < cols && j < rows) {
        const k = j * cols + i
        beds[k] = shape.bed
        arid[k] = shape.arid
        wet[k] = shape.wet
        shore[k] = shape.shore
        surface[k] = shape.surface
      }
    }
  }
  const normals = new Float32Array(cells * 3)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = (j + 1) * m + i + 1
      const [e, w, n, s] = [c + 1, c - 1, c + m, c - m]
      const gx = (heights[e]! - heights[w]!) / (xz[e * 2]! - xz[w * 2]!)
      const gz = (heights[n]! - heights[s]!) / (xz[n * 2 + 1]! - xz[s * 2 + 1]!)
      const len = Math.hypot(gx, 1, gz)
      normals.set([-gx / len, 1 / len, -gz / len], (j * cols + i) * 3)
    }
  }
  /** A vertex of the grid (0 to cols − 1 across, rows − 1 down): its height and place. */
  const vertex = (i: number, j: number) => {
    const t = (j + 1) * m + i + 1
    return { x: xz[t * 2]!, y: heights[t]!, z: xz[t * 2 + 1]! }
  }
  /** What shaped the land at a vertex, for its colour. */
  const lay = (t: number, up = normals[t * 3 + 1]!): Lay => ({ up, bed: beds[t]!, arid: arid[t]!, wet: wet[t]!, shore: shore[t]! })
  return { vertex, normals, lay, surface }
}

/** Builds one chunk's ground mesh and plants. Pure: the same input always gives the same chunk. */
export function buildGroundChunk(input: GroundChunkInput): GroundChunk {
  const { id, frame, seed, grid } = input
  const detail = new GroundDetail(seed, frame.radiusKm, input.waters, input.scars)
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
    // Scarred: ash, churned mud, parched or sickly ground.
    const scar = detail.scarAt(lat, lon)
    if (scar) blend(rgb, scar.rgb, scar.tint)
    // Snow where it can lie, in drifts and patches near the snowline.
    blend(rgb, SNOW, smoothstep(SNOWLINE, SNOWLINE + 500, y + detail.patch(lat, lon, 8) * 350) * smoothstep(0.78, 0.92, lay.up))
  }
  const light = 0.86 + 0.12 * detail.patch(lat, lon, 3)
  for (let c = 0; c < 3; c++) out[t * 3 + c] = (rgb[c]! / 255) * light
}

export interface GroundMapInput extends GroundColors {
  /** The map's middle is the frame's origin. */
  frame: LocalFrame
  seed: number
  /** The globe's terrain over the map's area (see `groundMapBounds`). */
  grid: BaseGrid
  waters?: GroundWaters
  /** Its size in pixels, and how many metres a pixel is across. */
  width: number
  height: number
  metresPerPixel: number
  /** RGB (0–255) of the sea, rivers and lakes on it. */
  waterColor: number[]
}

/** The lat/lon edges of a map of the ground (see `buildGroundMap`). */
export function groundMapBounds({ frame, width, height, metresPerPixel }: Pick<GroundMapInput, 'frame' | 'width' | 'height' | 'metresPerPixel'>): ChunkBounds {
  const [halfX, halfZ] = [((width / 2 + 1) * metresPerPixel), ((height / 2 + 1) * metresPerPixel)]
  const a = fromLocal(frame, -halfX, halfZ)
  const b = fromLocal(frame, halfX, -halfZ)
  return { lat0: a.lat, lat1: b.lat, lon0: a.lon, lon1: a.lon + wrapLon(b.lon - a.lon) }
}

/**
 * A map of the ground around a point, seen from straight above: each pixel
 * the ground's colour there (as the chunks colour it, without what's too
 * small to see at the map's scale), shaded by its hills as if lit from the
 * north-west, and the sea, rivers and lakes in the water's colour. Pure, like
 * a chunk; RGBA, row by row from the north-west corner.
 */
export function buildGroundMap(input: GroundMapInput): Uint8ClampedArray {
  const { frame, width, height, metresPerPixel: mpp, waterColor } = input
  const detail = new GroundDetail(input.seed, frame.radiusKm, input.waters, input.scars)
  const base = gridSampler(input.grid)
  const place = (i: number, j: number) => fromLocal(frame, (i + 0.5 - width / 2) * mpp, (j + 0.5 - height / 2) * mpp)
  const field = heightField(width, place, frame, (lat, lon) => detail.elevation(base, lat, lon, 1, false, mpp), detail.shape, height)
  const land = new Float32Array(width * height * 3)
  const water = new Uint8Array(width * height)
  // Light from the north-west and above, as maps are shaded.
  const [lx, ly, lz] = [-0.5, 0.7, -0.5].map((v) => v / Math.hypot(0.5, 0.7, 0.5)) as [number, number, number]
  for (let j = 0, t = 0; j < height; j++) {
    for (let i = 0; i < width; i++, t++) {
      const { y } = field.vertex(i, j)
      const { lat, lon } = place(i, j)
      if (y < 0 || !Number.isNaN(field.surface[t]!)) {
        // Deeper sea darker.
        water[t] = 1
        const depth = y < 0 ? clamp01(-y / 400) : 0
        for (let c = 0; c < 3; c++) land[t * 3 + c] = (waterColor[c]! / 255) * (1 - 0.45 * depth)
        continue
      }
      groundColor(input, detail, base, lat, lon, y, field.lay(t), land, t)
      const [nx, ny, nz] = [field.normals[t * 3]!, field.normals[t * 3 + 1]!, field.normals[t * 3 + 2]!]
      // Exaggerated a little, so gentle hills show at a hundred metres a pixel.
      const shade = clamp(0.55 + 0.75 * (nx * lx * 3 + ny * ly + nz * lz * 3), 0.35, 1.35)
      for (let c = 0; c < 3; c++) land[t * 3 + c]! *= shade
    }
  }
  // The land's colours vary over a few pixels at this scale: softened (from the land around, never the water), so they read as country, not grain.
  const out = new Uint8ClampedArray(width * height * 4)
  for (let j = 0, t = 0; j < height; j++) {
    for (let i = 0; i < width; i++, t++) {
      const sum = [0, 0, 0]
      let weight = 0
      if (!water[t])
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const [ni, nj] = [i + di, j + dj]
            if (ni < 0 || nj < 0 || ni >= width || nj >= height || water[nj * width + ni]) continue
            const w = di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1
            for (let c = 0; c < 3; c++) sum[c]! += land[(nj * width + ni) * 3 + c]! * w
            weight += w
          }
      for (let c = 0; c < 3; c++) out[t * 4 + c] = (weight ? sum[c]! / weight : land[t * 3 + c]!) * 255
      out[t * 4 + 3] = 255
    }
  }
  return out
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
  /** The scars on the land at the moment shown, which colour it too. */
  scars?: LandScar[]
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
  const detail = new GroundDetail(input.seed, frame.radiusKm, input.waters, input.scars)
  const base = gridSampler(grid)
  const b = grid.bounds
  const n = FAR_SEGMENTS + 1
  const positions = new Float32Array(n * n * 3)
  const colors = new Float32Array(n * n * 3)
  const indices = new Uint32Array(FAR_SEGMENTS * FAR_SEGMENTS * 6)
  const place = (i: number, j: number) => ({ lat: b.lat0 + ((b.lat1 - b.lat0) * j) / FAR_SEGMENTS, lon: b.lon0 + ((b.lon1 - b.lon0) * i) / FAR_SEGMENTS })
  // Too coarse for channels and ledges (250 m apart), which would show as pits: the hills alone.
  const field = heightField(n, place, frame, (lat, lon) => detail.elevation(base, lat, lon, 1, false, FAR_M / (FAR_SEGMENTS / 2)), detail.shape)
  for (let j = 0, t = 0; j < n; j++) {
    for (let i = 0; i < n; i++, t++) {
      const { lat, lon } = place(i, j)
      const { x, y, z } = field.vertex(i, j)
      // The middle of the centre chunk is (CHUNK_M / 2, −CHUNK_M / 2) in its corner's frame.
      const under = Math.max(Math.abs(x - CHUNK_M / 2), Math.abs(z + CHUNK_M / 2)) < input.sinkWithin
      groundColor(input, detail, base, lat, lon, y, { ...field.lay(t), arid: ARIDITY[detail.biome(base, lat, lon)] ?? 0 }, colors, t)
      // Its trees, too far off to draw one by one, as the woods' canopy.
      const top = withCanopy(detail, base, lat, lon, y, colors, t)
      positions.set([x, under ? y - SUNK_M : top, z], t * 3)
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
  const detail = new GroundDetail(input.seed, frame.radiusKm, undefined, input.scars)
  const base = gridSampler(grid)
  const vertices = HORIZON_RINGS * HORIZON_SPOKES
  const positions = new Float32Array(vertices * 3)
  const colors = new Float32Array(vertices * 3)
  const indices = new Uint32Array((HORIZON_RINGS - 1) * HORIZON_SPOKES * 6)
  const grow = Math.pow(HORIZON_M / HORIZON_INNER_M, 1 / (HORIZON_RINGS - 1))
  for (let k = 0, t = 0; k < HORIZON_RINGS; k++) {
    const r = HORIZON_INNER_M * Math.pow(grow, k)
    // What's too small to show between the ring's points is left out: far off, the mountains and the biggest hills.
    const spacing = (r * TAU) / HORIZON_SPOKES
    for (let s = 0; s < HORIZON_SPOKES; s++, t++) {
      const a = (s / HORIZON_SPOKES) * TAU
      const [x, z] = [Math.cos(a) * r, Math.sin(a) * r]
      const { lat, lon } = fromLocal(frame, x, z)
      const y = detail.elevation(base, lat, lon, 1, false, spacing)
      // Under the distant ground (FAR_M each way from wherever the view's middle is in this block), sunk well out of the way.
      const under = Math.max(Math.abs(x), Math.abs(z)) < FAR_M - (HORIZON_STEP / 2 + 1) * CHUNK_M
      groundColor(input, detail, base, lat, lon, y, { up: 1, bed: 0, arid: ARIDITY[detail.biome(base, lat, lon)] ?? 0, wet: 0, shore: Infinity }, colors, t)
      const top = withCanopy(detail, base, lat, lon, y, colors, t)
      positions.set([x, under ? y - 400 : top, z], t * 3)
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

/** 0 to 1, the same for a plant at the same spot every time: whether a scar kills it. */
const scatterHash = (x: number, z: number, salt: number) => {
  const v = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453
  return v - Math.floor(v)
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
      // Where the land is scarred, some die: gone, or for trees maybe a bare trunk left standing.
      const scar = plant === 'rock' ? undefined : detail.scarAt(lat, lon)
      if (scar && scar.kills > 0) {
        const fate = scatterHash(x, z, PLANTS.indexOf(plant))
        if (fate < scar.kills) {
          if (TREES.includes(plant) && fate < scar.kills * scar.snags) (out.snag ??= []).push(x, y, z, SIZE.snag[0] + (SIZE.snag[1] - SIZE.snag[0]) * size, turn, tint)
          continue
        }
      }
      const [lo, hi] = SIZE[plant]
      ;(out[plant] ??= []).push(x, y, z, lo + (hi - lo) * size * size, turn, tint)
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Float32Array.from(v)]))
}
