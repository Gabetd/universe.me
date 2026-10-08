import type { Exposure } from '@universe/core'
import { BIOME, RAD, TAU, clamp01, latLonToDir, surfaceTemperature, type TerrainModel } from '@universe/procgen'
import type { WorldClimate } from './climate'

/**
 * The weather at a point on a world (PLAN.md §4.7, §7), as the erosion model
 * wants it: wetness from the terrain's moisture and the climate's aridity,
 * freeze–thaw when the average temperature sits within the seasons' swing of
 * freezing, heat, salt near the sea, and how fast plants grow there.
 */

const GROWTH: Partial<Record<number, number>> = {
  [BIOME.ice]: 0,
  [BIOME.tundra]: 0.2,
  [BIOME.taiga]: 0.6,
  [BIOME.temperateForest]: 0.8,
  [BIOME.grassland]: 0.5,
  [BIOME.shrubland]: 0.4,
  [BIOME.desert]: 0.05,
  [BIOME.savanna]: 0.45,
  [BIOME.rainforest]: 1,
  [BIOME.swamp]: 0.95,
  [BIOME.rock]: 0.1,
  [BIOME.beach]: 0.25
}

/** How far inland sea air carries salt, km. */
const SALT_KM = 25

export function exposureAt(model: TerrainModel, climate: WorldClimate | undefined, lat: number, lon: number): Exposure {
  const dir = latLonToDir(lat, lon)
  const at = model.locate(...dir)
  const { face } = at
  const cell = model.cellOf(at)
  const sea = model.settings.seaLevel
  const elevation = model.heightOf(at) - sea
  const c = model.climate
  const temperature = surfaceTemperature(lat, elevation, c)
  const swing = (climate?.seasonalSwingC ?? 12) * (0.4 + 0.6 * Math.sin(Math.abs(lat) * RAD))
  const biome = model.biome(face, cell)
  const moisture = clamp01(model.base.moisture[face]![cell]! * 0.9 + 0.1 - (c.aridity - 0.5) * 0.6 + (biome === BIOME.swamp || biome === BIOME.rainforest ? 0.25 : 0))
  // Sea within reach, in any of eight directions.
  const reach = model.angularRadius(SALT_KM)
  let seaSides = elevation < 0 ? 8 : 0
  if (!seaSides) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU
      const p = latLonToDir(lat + ((Math.cos(a) * reach * 180) / Math.PI), lon + ((Math.sin(a) * reach * 180) / Math.PI) / Math.max(0.1, Math.cos((lat * Math.PI) / 180)))
      if (model.sampleHeight(...p) < sea) seaSides++
    }
  }
  return {
    moisture,
    freezeThaw: clamp01(1 - Math.abs(temperature) / (swing + 4)),
    heat: clamp01((temperature - 15) / 20),
    salt: clamp01(seaSides / 4),
    growth: (GROWTH[biome] ?? 0.4) * (temperature < 0 ? 0.3 : 1)
  }
}
