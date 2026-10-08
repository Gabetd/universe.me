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
import { autoBiome, worldPalette, type Climate, type Palette } from './biomes'
import { angleBetween, cellDirections, dirToFace, faceToDir, toGrid, type FacePoint, type Vec3 } from './cubesphere'
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

interface DirtyRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

let latCache: Float32Array[] | undefined
function cellLatitudes(): Float32Array[] {
  latCache ??= cellDirections().map((d) => {
    const lat = new Float32Array(CELLS)
    // Latitude is asin(y) alone (as dirToLatLon has it).
    for (let c = 0; c < CELLS; c++) lat[c] = Math.asin(d[c * 3 + 1]!) * DEG
    return lat
  })
  return latCache
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
  private stroke: { brush: Brush; target: number; dirty: Map<number, DirtyRect> } | undefined
  private palette: { for: WorldSettings; colors: Palette } | undefined
  /** The climate from the world's star and orbit, added to its own settings; undefined keeps it Earth-like. */
  private sky: SkyClimate | undefined
  private climateFor: { settings: WorldSettings; sky: SkyClimate | undefined; climate: Climate } | undefined
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
    return autoBiome(cellLatitudes()[face]![cell]!, this.height(face, cell) - this.settings.seaLevel, this.base.moisture[face]![cell]!, this.climate)
  }

  /** Sets the star-and-orbit climate; true if that changes anything (then every face needs recolouring). */
  setSky(sky: SkyClimate | undefined): boolean {
    if (skyKey(sky) === skyKey(this.sky)) return false
    this.sky = sky
    return true
  }

  /** The climate biomes follow: the world's own settings shifted by its star and orbit. */
  get climate(): Climate {
    // Asked for every cell when recolouring, so it's rebuilt only when the settings or the sky change.
    if (this.climateFor?.settings !== this.settings || this.climateFor.sky !== this.sky) {
      this.climateFor = { settings: this.settings, sky: this.sky, climate: withSky(this.settings.terrain, this.sky) }
    }
    return this.climateFor.climate
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
    return clampCell(Math.round(toGrid(t))) * TERRAIN_RES + clampCell(Math.round(toGrid(s)))
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

  /** Writes the cell's display color (no lighting) into `out` at `offset`. */
  color(face: number, cell: number, out: Uint8Array | Uint8ClampedArray, offset: number): void {
    // Rebuilt only when the settings object changes (a new one comes with every edit).
    if (this.palette?.for !== this.settings) this.palette = { for: this.settings, colors: worldPalette(this.settings.terrain) }
    const { shallow, deep, biomes } = this.palette.colors
    const elevation = this.height(face, cell) - this.settings.seaLevel
    if (elevation < 0) {
      const t = Math.sqrt(Math.min(1, -elevation / 4500))
      out[offset] = shallow[0] + (deep[0] - shallow[0]) * t
      out[offset + 1] = shallow[1] + (deep[1] - shallow[1]) * t
      out[offset + 2] = shallow[2] + (deep[2] - shallow[2]) * t
    } else {
      const rgb = biomes[this.biome(face, cell)]!
      const lift = 0.94 + 0.12 * Math.min(1, elevation / 5000)
      out[offset] = Math.min(255, rgb[0] * lift)
      out[offset + 1] = Math.min(255, rgb[1] * lift)
      out[offset + 2] = Math.min(255, rgb[2] * lift)
    }
    out[offset + 3] = 255
  }

  beginStroke(brush: Brush, dir: Vec3): void {
    this.stroke = { brush, target: this.sampleHeight(...dir), dirty: new Map() }
  }

  /**
   * Applies one dab of the current stroke centered on `dir` (unit vector).
   * Returns the faces it changed, so the caller can refresh just those.
   */
  dab(dir: Vec3): number[] {
    const stroke = this.stroke
    if (!stroke) return []
    const { brush, target } = stroke
    const radius = this.angularRadius(brush.radiusKm)
    const cosRadius = Math.cos(radius)
    const dirs = cellDirections()
    const touched: number[] = []

    for (let face = 0; face < CUBE_FACES; face++) {
      // Most dabs reach one or two faces; skip the rest without scanning their cells.
      if (angleBetween(FACE_CENTERS[face]!, dir) > radius + FACE_REACH) continue
      const d = dirs[face]!
      const heights = this.heightEdits[face]!
      const biomes = this.biomeEdits[face]!
      let changed = false
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
        changed = true
        markDirty(stroke.dirty, face, c % TERRAIN_RES, Math.floor(c / TERRAIN_RES))
      }
      if (changed) touched.push(face)
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

const clampCell = (v: number) => clamp(v, 0, TERRAIN_RES - 1)
const clampInt16 = (v: number) => clamp(Math.round(v), -32768, 32767)

function markDirty(dirty: Map<number, DirtyRect>, face: number, x: number, y: number): void {
  const r = dirty.get(face)
  if (!r) dirty.set(face, { x0: x, y0: y, x1: x, y1: y })
  else {
    if (x < r.x0) r.x0 = x
    if (x > r.x1) r.x1 = x
    if (y < r.y0) r.y0 = y
    if (y > r.y1) r.y1 = y
  }
}
