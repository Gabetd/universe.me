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

export const TerrainParams = z.object({
  /** Higher = more, smaller continents. */
  continentScale: z.number().min(0.2).max(6),
  /** 0 = smooth, 1 = rugged. */
  roughness: z.number().min(0).max(1),
  /** Peak height of generated mountain ranges, in meters. */
  mountainHeight: z.number().min(0).max(15000)
})
export type TerrainParams = z.infer<typeof TerrainParams>

export const WorldSettings = z.object({
  radiusKm: z.number().min(50).max(200000),
  /** Meters relative to the generated terrain's zero. */
  seaLevel: z.number().min(-12000).max(12000),
  terrain: TerrainParams
})
export type WorldSettings = z.infer<typeof WorldSettings>

export const DEFAULT_WORLD_SETTINGS: WorldSettings = {
  radiusKm: 6371,
  seaLevel: 0,
  terrain: { continentScale: 1.4, roughness: 0.5, mountainHeight: 6000 }
}

export const WorldSettingsPatch = z.object({
  radiusKm: WorldSettings.shape.radiusKm.optional(),
  seaLevel: WorldSettings.shape.seaLevel.optional(),
  terrain: TerrainParams.partial().optional()
})
export type WorldSettingsPatch = z.infer<typeof WorldSettingsPatch>

export function mergeWorldSettings(base: WorldSettings, patch: WorldSettingsPatch): WorldSettings {
  return {
    radiusKm: patch.radiusKm ?? base.radiusKm,
    seaLevel: patch.seaLevel ?? base.seaLevel,
    terrain: { ...base.terrain, ...stripUndefined(patch.terrain ?? {}) }
  }
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

export const HexColor = z.string().regex(/^#[0-9a-f]{6}$/i)

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

export interface Rect {
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
