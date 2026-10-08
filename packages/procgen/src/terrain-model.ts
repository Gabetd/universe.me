import {
  CUBE_FACES,
  LAYER_BYTES_PER_CELL,
  TERRAIN_RES,
  asBytes,
  bytesToBase64,
  readRect,
  type TerrainLayerName,
  type TerrainLayers,
  type TerrainPatch,
  type WorldSettings
} from '@universe/core'
import { biomeAt, climateTerms, polarity, wetBand, worldPalette, type Climate, type ClimateTerms, type Palette } from './biomes'
import { LATITUDE_TWIN, angleBetween, cellDirections, dirToFace, faceToDir, nearestCell, toGrid, type FacePoint, type Vec3 } from './cubesphere'
import { DEG, bilerp, clamp } from './math'
import type { BaseTerrain } from './generate'

/** What a star and orbit do to a world's climate: degrees warmer than Earth, and how strongly it cools toward the poles. */
export interface SkyClimate {
  offsetC: number
  gradient: number
}

/** A world's own climate settings shifted by its star and orbit. */
export function withSky(climate: Climate, sky: SkyClimate | undefined): Climate {
  return sky ? { ...climate, temperature: climate.temperature + sky.offsetC, gradient: sky.gradient } : climate
}

/** Identifies a sky climate, for knowing when it changed. */
export const skyKey = (sky: SkyClimate | undefined) => (sky ? `${sky.offsetC}:${sky.gradient}` : '')

export type BrushTool = 'raise' | 'lower' | 'smooth' | 'flatten' | 'paint' | 'erase'

export interface Brush {
  tool: BrushTool
  radiusKm: number
  /** 0–1. */
  strength: number
  /** Biome id for the paint tool. */
  biome?: number
}

export const brushLayer = (tool: BrushTool): TerrainLayerName => (tool === 'paint' || tool === 'erase' ? 'biome' : 'height')

/** Meters a full-strength raise/lower dab adds at the brush center. */
const RAISE_PER_DAB = 150
const CELLS = TERRAIN_RES * TERRAIN_RES

/** A rectangle of cells on a face, edges included. */
export interface CellRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The cells one dab changed on one face. */
export interface FaceRect extends CellRect {
  face: number
}

/** The parts of a cell's climate that come from its latitude alone (see biomeAt), so they're worked out once. */
interface LatitudeTerms {
  polar: Float64Array
  band: Float64Array
}

let latitudeCache: LatitudeTerms[] | undefined
/** Each face's latitude terms per cell; faces with the same latitudes (LATITUDE_TWIN) share them. */
function latitudeTerms(): LatitudeTerms[] {
  if (latitudeCache) return latitudeCache
  const dirs = cellDirections()
  const made = new Map<number, LatitudeTerms>()
  latitudeCache = LATITUDE_TWIN.map((twin) => {
    let terms = made.get(twin)
    if (!terms) made.set(twin, (terms = latitudeTermsOf(dirs[twin]!)))
    return terms
  })
  return latitudeCache
}

function latitudeTermsOf(dirs: Float32Array): LatitudeTerms {
  // A cell's latitude is asin(y) (as dirToLatLon has it); only its distance from the equator matters.
  const abs = new Float32Array(CELLS)
  for (let c = 0; c < CELLS; c++) abs[c] = Math.abs(Math.asin(dirs[c * 3 + 1]!) * DEG)
  const polar = new Float64Array(CELLS)
  const band = new Float64Array(CELLS)
  const half = TERRAIN_RES / 2
  for (let j = 0, c = 0; j < TERRAIN_RES; j++) {
    for (let i = 0; i < TERRAIN_RES; i++, c++) {
      // A face's quarters mirror each other: a cell with the same latitude as its mirror image in the first quarter (worked out already) reuses its terms.
      const m = (j < half ? j : TERRAIN_RES - 1 - j) * TERRAIN_RES + (i < half ? i : TERRAIN_RES - 1 - i)
      if (m !== c && abs[m] === abs[c]) {
        polar[c] = polar[m]!
        band[c] = band[m]!
      } else {
        polar[c] = polarity(abs[c]!)
        band[c] = wetBand(abs[c]!)
      }
    }
  }
  return { polar, band }
}

/** A face's display colours (RGBA, unlit): cut to bytes as the globe's texture has them, and rounded as a canvas stores them. */
interface FaceColors {
  truncated: Uint8Array
  rounded: Uint8ClampedArray
  /** 1 for each cell coloured since the colours last went stale. */
  colored: Uint8Array
  /** Every cell is coloured. */
  whole: boolean
}

const FACE_CENTERS = Array.from({ length: CUBE_FACES }, (_, f) => faceToDir(f, 0, 0))
/** Angle from a face's center to its corners: no cell on the face is farther. */
const FACE_REACH = Math.acos(1 / Math.sqrt(3))

/**
 * A world's terrain in memory: generated base + user edits, with brush
 * strokes that produce `terrain.patch` command payloads.
 */
export class TerrainModel {
  heightEdits: Int16Array[]
  biomeEdits: Uint8Array[]
  private stroke: { brush: Brush; target: number; dirty: Map<number, CellRect> } | undefined
  private palette: { for: WorldSettings; colors: Palette } | undefined
  /** The climate from the world's star and orbit, added to its own settings; undefined keeps it Earth-like. */
  private sky: SkyClimate | undefined
  private climateFor: { settings: WorldSettings; sky: SkyClimate | undefined; climate: Climate; terms: ClimateTerms } | undefined
  /** Each face's colours once asked for, and the settings and base they were made from. */
  private faceColorCache: (FaceColors | undefined)[] = []
  private colorsFor: { settings: WorldSettings; base: BaseTerrain } | undefined
  /** What `locate` fills in. */
  private located: FacePoint = { face: 0, s: 0, t: 0 }

  constructor(
    public settings: WorldSettings,
    public base: BaseTerrain,
    layers?: TerrainLayers
  ) {
    this.heightEdits = []
    this.biomeEdits = []
    this.setLayers(layers ?? {})
  }

  /** Replaces the edit layers, e.g. after an undo changed them in the project. */
  setLayers(layers: TerrainLayers): void {
    this.heightEdits = Array.from({ length: CUBE_FACES }, (_, f) => {
      const bytes = layers.height?.[f]
      // Copy, so the Int16 view is aligned and independent of the source buffer.
      return bytes ? new Int16Array(bytes.slice().buffer) : new Int16Array(CELLS)
    })
    this.biomeEdits = Array.from({ length: CUBE_FACES }, (_, f) => layers.biome?.[f]?.slice() ?? new Uint8Array(CELLS))
    this.staleColors()
  }

  /** A distance on the surface in km, as an angle in radians. */
  angularRadius(km: number): number {
    return km / this.settings.radiusKm
  }

  get isStroking(): boolean {
    return this.stroke !== undefined
  }

  height(face: number, cell: number): number {
    return this.base.height[face]![cell]! + this.heightEdits[face]![cell]!
  }

  /** Effective biome: painted, or derived from climate. */
  biome(face: number, cell: number): number {
    const painted = this.biomeEdits[face]![cell]!
    if (painted) return painted
    const lat = latitudeTerms()[face]!
    return biomeAt(lat.polar[cell]!, lat.band[cell]!, this.height(face, cell) - this.settings.seaLevel, this.base.moisture[face]![cell]!, this.climateState.terms)
  }

  /** Sets the star-and-orbit climate; true if that changes anything (then every face needs recolouring). */
  setSky(sky: SkyClimate | undefined): boolean {
    if (skyKey(sky) === skyKey(this.sky)) return false
    this.sky = sky
    this.staleColors()
    return true
  }

  /** The climate biomes follow: the world's own settings shifted by its star and orbit. */
  get climate(): Climate {
    return this.climateState.climate
  }

  private get climateState() {
    // Asked for every cell, so it's rebuilt only when the settings or the sky change.
    if (this.climateFor?.settings !== this.settings || this.climateFor.sky !== this.sky) {
      const climate = withSky(this.settings.terrain, this.sky)
      this.climateFor = { settings: this.settings, sky: this.sky, climate, terms: climateTerms(climate) }
    }
    return this.climateFor
  }

  /** The world's colours, rebuilt only when the settings object changes (a new one comes with every edit). */
  private get colors(): Palette {
    if (this.palette?.for !== this.settings) this.palette = { for: this.settings, colors: worldPalette(this.settings.terrain) }
    return this.palette.colors
  }

  /**
   * Where a direction falls on the cube, for `cellOf` and `heightOf` when
   * both are wanted. The same object is filled on every call, so read it
   * before the next.
   */
  locate(x: number, y: number, z: number): FacePoint {
    return dirToFace(x, y, z, this.located)
  }

  /** Nearest cell to a located point, on its face. */
  cellOf({ s, t }: FacePoint): number {
    return nearestCell(s, t)
  }

  /** Bilinearly interpolated height in meters at a located point. */
  heightOf({ face, s, t }: FacePoint): number {
    const gx = clamp(toGrid(s), 0, TERRAIN_RES - 1)
    const gy = clamp(toGrid(t), 0, TERRAIN_RES - 1)
    const i0 = Math.floor(gx)
    const j0 = Math.floor(gy)
    const i1 = Math.min(i0 + 1, TERRAIN_RES - 1)
    const r0 = j0 * TERRAIN_RES
    const r1 = Math.min(j0 + 1, TERRAIN_RES - 1) * TERRAIN_RES
    const base = this.base.height[face]!
    const edits = this.heightEdits[face]!
    return bilerp(base[r0 + i0]! + edits[r0 + i0]!, base[r0 + i1]! + edits[r0 + i1]!, base[r1 + i0]! + edits[r1 + i0]!, base[r1 + i1]! + edits[r1 + i1]!, gx - i0, gy - j0)
  }

  /** Nearest cell to a direction. */
  cellAt(x: number, y: number, z: number): { face: number; cell: number } {
    const p = this.locate(x, y, z)
    return { face: p.face, cell: this.cellOf(p) }
  }

  /** Bilinearly interpolated height in meters for any direction. */
  sampleHeight(x: number, y: number, z: number): number {
    return this.heightOf(this.locate(x, y, z))
  }

  /** Writes the cell's display color (no lighting) into `out` at `offset`. Colours just that cell if its face isn't coloured yet. */
  color(face: number, cell: number, out: Uint8Array | Uint8ClampedArray, offset: number): void {
    const colors = this.colorsOf(face)
    if (!colors.colored[cell]) {
      const x = cell % TERRAIN_RES
      const y = (cell - x) / TERRAIN_RES
      this.paint(colors, face, x, y, x, y)
    }
    // A canvas's pixels round and other bytes cut down: each gets what writing the colour itself would give.
    const from = out instanceof Uint8ClampedArray ? colors.rounded : colors.truncated
    for (let k = 0; k < 4; k++) out[offset + k] = from[cell * 4 + k]!
  }

  /**
   * Every cell's display colour on a face (RGBA, no lighting), as `color`
   * writes it into a Uint8Array: what the globe shows. It's kept up to date
   * (a dab recolours just the cells it changed, anything else the whole
   * face, once), so read it but don't write to it.
   */
  faceColors(face: number): Uint8Array {
    return this.wholeFace(face).truncated
  }

  /** faceColors rounded to the nearest byte rather than down, as `color` writes into a canvas's pixels: what the map shows. */
  roundedFaceColors(face: number): Uint8ClampedArray {
    return this.wholeFace(face).rounded
  }

  private wholeFace(face: number): FaceColors {
    const colors = this.colorsOf(face)
    if (!colors.whole) {
      this.paint(colors, face, 0, 0, TERRAIN_RES - 1, TERRAIN_RES - 1)
      colors.whole = true
    }
    return colors
  }

  /** A face's colour cache, current as far as it goes. */
  private colorsOf(face: number): FaceColors {
    this.checkColors()
    return (this.faceColorCache[face] ??= { truncated: new Uint8Array(CELLS * 4), rounded: new Uint8ClampedArray(CELLS * 4), colored: new Uint8Array(CELLS), whole: false })
  }

  /** Marks every face's colours stale if the settings or the base they were made from have been replaced. */
  private checkColors(): void {
    if (this.colorsFor?.settings === this.settings && this.colorsFor.base === this.base) return
    this.colorsFor = { settings: this.settings, base: this.base }
    this.staleColors()
  }

  private staleColors(): void {
    for (const colors of this.faceColorCache) {
      if (!colors) continue
      colors.colored.fill(0)
      colors.whole = false
    }
  }

  /** Recolours the cells of a face from (x0, y0) to (x1, y1): water by its depth, land by its biome and a little lighter up high. */
  private paint({ truncated, rounded, colored }: FaceColors, face: number, x0: number, y0: number, x1: number, y1: number): void {
    // Everything that's the same for every cell, looked up once.
    const { shallow, deep, biomes } = this.colors
    const terms = this.climateState.terms
    const sea = this.settings.seaLevel
    const height = this.base.height[face]!
    const moisture = this.base.moisture[face]!
    const edits = this.heightEdits[face]!
    const painted = this.biomeEdits[face]!
    const { polar, band } = latitudeTerms()[face]!
    for (let y = y0; y <= y1; y++) {
      for (let c = y * TERRAIN_RES + x0, end = y * TERRAIN_RES + x1; c <= end; c++) {
        const elevation = height[c]! + edits[c]! - sea
        let r: number, g: number, b: number
        if (elevation < 0) {
          const t = Math.sqrt(Math.min(1, -elevation / 4500))
          r = shallow[0] + (deep[0] - shallow[0]) * t
          g = shallow[1] + (deep[1] - shallow[1]) * t
          b = shallow[2] + (deep[2] - shallow[2]) * t
        } else {
          const rgb = biomes[painted[c] || biomeAt(polar[c]!, band[c]!, elevation, moisture[c]!, terms)]!
          const lift = 0.94 + 0.12 * Math.min(1, elevation / 5000)
          r = Math.min(255, rgb[0] * lift)
          g = Math.min(255, rgb[1] * lift)
          b = Math.min(255, rgb[2] * lift)
        }
        const o = c * 4
        truncated[o] = r
        truncated[o + 1] = g
        truncated[o + 2] = b
        truncated[o + 3] = 255
        rounded[o] = r
        rounded[o + 1] = g
        rounded[o + 2] = b
        rounded[o + 3] = 255
        colored[c] = 1
      }
    }
  }

  beginStroke(brush: Brush, dir: Vec3): void {
    this.stroke = { brush, target: this.sampleHeight(...dir), dirty: new Map() }
  }

  /**
   * Applies one dab of the current stroke centered on `dir` (unit vector).
   * Returns the faces it changed, so the caller can refresh just those.
   */
  dab(dir: Vec3): number[] {
    return this.dabRects(dir).map((r) => r.face)
  }

  /** Like dab, but returns the cells it changed on each face, so the caller can refresh just those. */
  dabRects(dir: Vec3): FaceRect[] {
    const stroke = this.stroke
    if (!stroke) return []
    const { brush, target } = stroke
    const radius = this.angularRadius(brush.radiusKm)
    const cosRadius = Math.cos(radius)
    const dirs = cellDirections()
    const touched: FaceRect[] = []

    for (let face = 0; face < CUBE_FACES; face++) {
      // Most dabs reach one or two faces; skip the rest without scanning their cells.
      if (angleBetween(FACE_CENTERS[face]!, dir) > radius + FACE_REACH) continue
      const d = dirs[face]!
      const heights = this.heightEdits[face]!
      const biomes = this.biomeEdits[face]!
      let rect: FaceRect | undefined
      for (let c = 0; c < CELLS; c++) {
        const dot = d[c * 3]! * dir[0] + d[c * 3 + 1]! * dir[1] + d[c * 3 + 2]! * dir[2]
        if (dot < cosRadius) continue
        const r = Math.acos(Math.min(1, dot)) / radius
        const falloff = (1 - r * r) ** 2
        switch (brush.tool) {
          case 'raise':
          case 'lower': {
            const sign = brush.tool === 'raise' ? 1 : -1
            heights[c] = clampInt16(heights[c]! + sign * RAISE_PER_DAB * brush.strength * falloff)
            break
          }
          case 'flatten': {
            const h = this.height(face, c)
            heights[c] = clampInt16(heights[c]! + (target - h) * Math.min(1, brush.strength * falloff * 0.6))
            break
          }
          case 'smooth': {
            const h = this.height(face, c)
            const avg = this.neighborAverage(face, c)
            heights[c] = clampInt16(heights[c]! + (avg - h) * Math.min(1, brush.strength * falloff))
            break
          }
          case 'paint':
            biomes[c] = brush.biome ?? 0
            break
          case 'erase':
            biomes[c] = 0
            break
        }
        const x = c % TERRAIN_RES
        const y = (c - x) / TERRAIN_RES
        if (rect) grow(rect, x, y)
        else rect = { face, x0: x, y0: y, x1: x, y1: y }
      }
      if (!rect) continue
      touched.push(rect)
      const dirty = stroke.dirty.get(face)
      if (dirty) {
        grow(dirty, rect.x0, rect.y0)
        grow(dirty, rect.x1, rect.y1)
      } else stroke.dirty.set(face, { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 })
    }
    // Keep the colours up to date: recolour what changed on faces that have been coloured.
    this.checkColors()
    for (const rect of touched) {
      const colors = this.faceColorCache[rect.face]
      if (colors) this.paint(colors, rect.face, rect.x0, rect.y0, rect.x1, rect.y1)
    }
    return touched
  }

  /** Ends the stroke and returns the command payload that records it, or undefined if nothing changed. */
  endStroke(worldId: string): { worldId: string; layer: TerrainLayerName; patches: TerrainPatch[] } | undefined {
    const stroke = this.stroke
    this.stroke = undefined
    if (!stroke || stroke.dirty.size === 0) return undefined
    const layer = brushLayer(stroke.brush.tool)
    const bytesPerCell = LAYER_BYTES_PER_CELL[layer]
    const patches: TerrainPatch[] = []
    for (const [face, r] of stroke.dirty) {
      const rect = { x: r.x0, y: r.y0, w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1 }
      const source = layer === 'height' ? asBytes(this.heightEdits[face]!) : this.biomeEdits[face]!
      patches.push({ face, ...rect, data: bytesToBase64(readRect(source, rect, bytesPerCell)) })
    }
    return { worldId, layer, patches }
  }

  private neighborAverage(face: number, cell: number): number {
    const i = cell % TERRAIN_RES
    const j = (cell - i) / TERRAIN_RES
    let sum = 0
    let n = 0
    for (const [di, dj] of NEIGHBORS) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || nj < 0 || ni >= TERRAIN_RES || nj >= TERRAIN_RES) continue
      sum += this.height(face, nj * TERRAIN_RES + ni)
      n++
    }
    return n ? sum / n : this.height(face, cell)
  }
}

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
] as const

const clampInt16 = (v: number) => clamp(Math.round(v), -32768, 32767)

/** Grows a rectangle to take in cell (x, y). */
function grow(r: CellRect, x: number, y: number): void {
  if (x < r.x0) r.x0 = x
  if (x > r.x1) r.x1 = x
  if (y < r.y0) r.y0 = y
  if (y > r.y1) r.y1 = y
}
