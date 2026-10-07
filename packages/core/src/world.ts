import { z } from 'zod'
import { Id } from './schema'
import { stripUndefined } from './util'

/**
 * World surfaces (PLAN.md §4.2). Terrain is a cube-sphere grid: 6 faces of
 * TERRAIN_RES × TERRAIN_RES cells. The generated base terrain comes from the
 * world's seed and `terrain` params; what's stored are the user's edits on top
 * of it (`height` = meters added to the base, `biome` = painted biome or 0 for auto).
 * Changing the seed or params regenerates the base and keeps the edits.
 */
export const TERRAIN_RES = 256
export const CUBE_FACES = 6

export const TerrainLayerName = z.enum(['height', 'biome'])
export type TerrainLayerName = z.infer<typeof TerrainLayerName>

export const LAYER_BYTES_PER_CELL: Record<TerrainLayerName, number> = { height: 2, biome: 1 }

/**
 * Numeric world options: range and step. The schema, the inspector's sliders
 * and world codes all use these, so a world code always round-trips exactly.
 */
export const WORLD_RANGES = {
  /** Fraction of the surface under water. */
  water: { min: 0.05, max: 0.95, step: 0.01 },
  /** Higher = more, smaller continents. */
  continentScale: { min: 0.2, max: 6, step: 0.1 },
  /** How many small islands rise from the seas, 0–1. */
  islands: { min: 0, max: 1, step: 0.05 },
  /** 0 = smooth, 1 = rugged. */
  roughness: { min: 0, max: 1, step: 0.05 },
  /** How much of the land has mountain ranges, 0–1. */
  mountains: { min: 0, max: 1, step: 0.05 },
  /** Peak height of mountain ranges, in meters. */
  mountainHeight: { min: 0, max: 15000, step: 250 },
  /** °C added to the whole planet's climate. */
  temperature: { min: -30, max: 30, step: 1 },
  /** 0 = lush, 0.5 = Earth-like, 1 = desert world. */
  aridity: { min: 0, max: 1, step: 0.05 },
  /** Width of sandy coasts, 0 (none) to 1. */
  beaches: { min: 0, max: 1, step: 0.05 },
  radiusKm: { min: 50, max: 200000, step: 1 }
} as const
export type WorldRange = keyof typeof WORLD_RANGES

/** How fast structures weather on a world, as a multiple of the material defaults. Not part of generation. */
export const EROSION_SPEED = { min: 0, max: 10, step: 0.1 } as const

const ranged = (key: WorldRange) => z.number().min(WORLD_RANGES[key].min).max(WORLD_RANGES[key].max)

/** Overall shape of the land: Earth-like continents, one supercontinent, or scattered islands. */
export const LANDFORMS = ['continents', 'supercontinent', 'archipelago'] as const
export const Landform = z.enum(LANDFORMS)
export type Landform = z.infer<typeof Landform>

export const HexColor = z.string().regex(/^#[0-9a-f]{6}$/i)

/** Everything that decides what a world looks like before anyone edits it. */
export const TerrainParams = z.object({
  landform: Landform,
  water: ranged('water'),
  continentScale: ranged('continentScale'),
  islands: ranged('islands'),
  roughness: ranged('roughness'),
  mountains: ranged('mountains'),
  mountainHeight: ranged('mountainHeight'),
  temperature: ranged('temperature'),
  aridity: ranged('aridity'),
  beaches: ranged('beaches'),
  vegetationColor: HexColor,
  sandColor: HexColor,
  waterColor: HexColor
})
export type TerrainParams = z.infer<typeof TerrainParams>

export const WorldSettings = z.object({
  radiusKm: ranged('radiusKm'),
  /** Meters added to the generated sea level: a later rise or fall of the seas. */
  seaLevel: z.number().min(-12000).max(12000),
  terrain: TerrainParams,
  /**
   * The seed the world was generated from (any text, or a world code). While
   * set, the world's options come from it and are locked; null = custom.
   */
  seedText: z.string().max(200).nullable(),
  erosionSpeed: z.number().min(EROSION_SPEED.min).max(EROSION_SPEED.max)
})
export type WorldSettings = z.infer<typeof WorldSettings>

export const DEFAULT_TERRAIN: TerrainParams = {
  landform: 'continents',
  water: 0.62,
  continentScale: 1.4,
  islands: 0.3,
  roughness: 0.5,
  mountains: 0.5,
  mountainHeight: 6000,
  temperature: 0,
  aridity: 0.5,
  beaches: 0,
  vegetationColor: '#4b8a3b',
  sandColor: '#dcc58c',
  waterColor: '#4a96c6'
}

export const DEFAULT_WORLD_SETTINGS: WorldSettings = {
  radiusKm: 6371,
  seaLevel: 0,
  terrain: DEFAULT_TERRAIN,
  seedText: null,
  erosionSpeed: 1
}

export const WorldSettingsPatch = z.object({
  radiusKm: WorldSettings.shape.radiusKm.optional(),
  seaLevel: WorldSettings.shape.seaLevel.optional(),
  terrain: TerrainParams.partial().optional(),
  seedText: WorldSettings.shape.seedText.optional(),
  erosionSpeed: WorldSettings.shape.erosionSpeed.optional()
})
export type WorldSettingsPatch = z.infer<typeof WorldSettingsPatch>

/** Applies a patch; also fills in options that settings saved by older versions don't have. */
export function mergeWorldSettings(base: WorldSettings, patch: WorldSettingsPatch): WorldSettings {
  return {
    radiusKm: patch.radiusKm ?? base.radiusKm,
    seaLevel: patch.seaLevel ?? base.seaLevel,
    terrain: { ...DEFAULT_TERRAIN, ...base.terrain, ...stripUndefined(patch.terrain ?? {}) },
    seedText: patch.seedText === undefined ? (base.seedText ?? null) : patch.seedText,
    erosionSpeed: patch.erosionSpeed ?? base.erosionSpeed ?? 1
  }
}

/** Rounds each option to its step, so stored worlds are exactly what a world code can express. */
export function quantizeSettings(s: WorldSettings): WorldSettings {
  const q = (key: WorldRange, v: number) => {
    const { min, max, step } = WORLD_RANGES[key]
    return Number(Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min)).toFixed(4))
  }
  const terrain: Record<string, unknown> = { ...s.terrain }
  for (const key of Object.keys(WORLD_RANGES) as WorldRange[]) if (key !== 'radiusKm') terrain[key] = q(key, s.terrain[key])
  for (const key of ['vegetationColor', 'sandColor', 'waterColor'] as const) terrain[key] = s.terrain[key].toLowerCase()
  const erosionSpeed = Number((Math.round(s.erosionSpeed / EROSION_SPEED.step) * EROSION_SPEED.step).toFixed(1))
  return { ...s, radiusKm: q('radiusKm', s.radiusKm), erosionSpeed, terrain: terrain as TerrainParams }
}

/** A rectangle of new cell values for one cube face, as base64 of the layer's bytes (row-major). */
export const TerrainPatch = z.object({
  face: z.number().int().min(0).max(CUBE_FACES - 1),
  x: z.number().int().min(0).max(TERRAIN_RES - 1),
  y: z.number().int().min(0).max(TERRAIN_RES - 1),
  w: z.number().int().min(1).max(TERRAIN_RES),
  h: z.number().int().min(1).max(TERRAIN_RES),
  data: z.string()
})
export type TerrainPatch = z.infer<typeof TerrainPatch>

export const LatLon = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
export type LatLon = z.infer<typeof LatLon>

/** Distinct, readable-on-dark colors handed out to new regions, events, eras and groups. */
export const PALETTE = ['#e8a33d', '#5fb3d9', '#d9605f', '#8bc34a', '#b37fe0', '#4fc3a1', '#f06292', '#c0ca33']

export const Region = z.object({
  id: Id,
  worldId: Id,
  name: z.string().min(1).max(200),
  color: HexColor,
  points: z.array(LatLon).min(3),
  notes: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable()
})
export type Region = z.infer<typeof Region>

export const RegionPatch = Region.pick({ name: true, color: true, points: true, notes: true }).partial()
export type RegionPatch = z.infer<typeof RegionPatch>

export interface WorldInfo {
  id: string
  settings: WorldSettings
  /** Increments on every terrain change, so viewers know to reload layers. */
  terrainRevision: number
}

/** A world's terrain edit layers: raw bytes per cube face (height = Int16 LE, biome = Uint8). A missing face has no edits. */
export interface TerrainLayers {
  height?: (Uint8Array | undefined)[]
  biome?: (Uint8Array | undefined)[]
}

/** A blank (all-zero, i.e. unedited) face buffer for a layer. */
export function emptyLayer(layer: TerrainLayerName): Uint8Array {
  return new Uint8Array(TERRAIN_RES * TERRAIN_RES * LAYER_BYTES_PER_CELL[layer])
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Copies a rectangle of cells out of a TERRAIN_RES² face buffer. */
export function readRect(face: Uint8Array, rect: Rect, bytesPerCell: number): Uint8Array {
  const out = new Uint8Array(rect.w * rect.h * bytesPerCell)
  const rowBytes = rect.w * bytesPerCell
  for (let row = 0; row < rect.h; row++) {
    const start = ((rect.y + row) * TERRAIN_RES + rect.x) * bytesPerCell
    out.set(face.subarray(start, start + rowBytes), row * rowBytes)
  }
  return out
}

/** Writes a rectangle of cells into a TERRAIN_RES² face buffer. */
export function writeRect(face: Uint8Array, rect: Rect, data: Uint8Array, bytesPerCell: number): void {
  const rowBytes = rect.w * bytesPerCell
  for (let row = 0; row < rect.h; row++) {
    face.set(data.subarray(row * rowBytes, (row + 1) * rowBytes), ((rect.y + row) * TERRAIN_RES + rect.x) * bytesPerCell)
  }
}
