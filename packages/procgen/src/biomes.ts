/**
 * Biomes a cell can have. Id 0 ("auto") means "derive from climate"; painted
 * cells store any other id. M4 replaces `autoBiome`'s rough climate with the
 * real simulation; the ids are stored in project files, so never renumber them.
 */
export interface Biome {
  id: number
  name: string
  color: string
}

export const BIOMES: readonly Biome[] = [
  { id: 0, name: 'Auto (from climate)', color: '#7d8597' },
  { id: 1, name: 'Ice & snow', color: '#e9f1f4' },
  { id: 2, name: 'Tundra', color: '#9ba58e' },
  { id: 3, name: 'Taiga', color: '#3e6a50' },
  { id: 4, name: 'Temperate forest', color: '#4b8a3b' },
  { id: 5, name: 'Grassland', color: '#94b65a' },
  { id: 6, name: 'Shrubland', color: '#a9a066' },
  { id: 7, name: 'Desert', color: '#dcc58c' },
  { id: 8, name: 'Savanna', color: '#c4b35a' },
  { id: 9, name: 'Rainforest', color: '#2d7a34' },
  { id: 10, name: 'Swamp', color: '#55704b' },
  { id: 11, name: 'Bare rock', color: '#8a8179' },
  { id: 12, name: 'Beach', color: '#e3d6a6' }
]

export const BIOME = {
  auto: 0,
  ice: 1,
  tundra: 2,
  taiga: 3,
  temperateForest: 4,
  grassland: 5,
  shrubland: 6,
  desert: 7,
  savanna: 8,
  rainforest: 9,
  swamp: 10,
  rock: 11,
  beach: 12
} as const

/** RGB triples per biome id, for the hot coloring loops. */
export const BIOME_RGB: readonly (readonly [number, number, number])[] = BIOMES.map((b) => hexToRgb(b.color))

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Beaches are paint-only: at this grid size an automatic coastal band shows up as speckles.
 *
 * Placeholder climate until M4: temperature from latitude and altitude,
 * moisture from noise plus wet/dry latitude bands (wet equator, dry 30°, wet 60°).
 */
export function autoBiome(latDeg: number, elevation: number, moisture: number): number {
  const absLat = Math.abs(latDeg)
  const temperature = 30 - 55 * Math.pow(absLat / 90, 1.6) - (6.5 * Math.max(0, elevation)) / 1000
  if (elevation > 2800) return temperature < -4 ? BIOME.ice : BIOME.rock
  if (temperature < -8) return BIOME.ice
  if (temperature < -1) return BIOME.tundra

  const band = Math.cos((absLat * Math.PI) / 30)
  const wet = Math.max(0, Math.min(1, moisture * 0.85 + band * 0.22 + 0.05))
  if (wet > 0.86 && elevation < 160 && temperature > 6) return BIOME.swamp
  if (temperature < 5) return wet > 0.3 ? BIOME.taiga : BIOME.tundra
  if (temperature < 18) return wet < 0.3 ? BIOME.shrubland : wet < 0.48 ? BIOME.grassland : BIOME.temperateForest
  return wet < 0.3 ? BIOME.desert : wet < 0.55 ? BIOME.savanna : BIOME.rainforest
}
