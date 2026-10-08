import { clamp01 } from './math'
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

/** "#rrggbb" for whole 0–255 channel values. */
export const rgbToHex = (rgb: readonly number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`

/** The climate options that shape automatic biomes (see TerrainParams). */
export interface Climate {
  /** °C added everywhere. */
  temperature: number
  /** 0 lush, 0.5 Earth-like, 1 desert world. */
  aridity: number
  /** 0 no automatic beaches, 1 wide sandy coasts. */
  beaches: number
  /** How strongly it cools toward the poles (1 = Earth); the star system's axial tilt sets it (packages/sim). */
  gradient?: number
}

export const EARTH_CLIMATE: Climate = { temperature: 0, aridity: 0.5, beaches: 0 }

/** Average temperature (°C) at a latitude and height: warm at the equator, colder toward the poles and up mountains. */
export function surfaceTemperature(latDeg: number, elevation: number, climate: Climate = EARTH_CLIMATE): number {
  return climate.temperature + 30 - 55 * (climate.gradient ?? 1) * Math.pow(Math.abs(latDeg) / 90, 1.6) - (6.5 * Math.max(0, elevation)) / 1000
}

/**
 * Biomes from climate (a Whittaker-style chart): temperature from latitude
 * and altitude, moisture from noise plus wet/dry latitude bands (wet
 * equator, dry 30°, wet 60°). Beaches are a band just above sea level, up to
 * 40 m high at `beaches` = 1.
 */
export function autoBiome(latDeg: number, elevation: number, moisture: number, climate: Climate = EARTH_CLIMATE): number {
  const absLat = Math.abs(latDeg)
  const temperature = surfaceTemperature(latDeg, elevation, climate)
  if (elevation > 2800) return temperature < -4 ? BIOME.ice : BIOME.rock
  if (temperature < -8) return BIOME.ice
  if (temperature < -1) return BIOME.tundra
  if (elevation < climate.beaches * 40) return BIOME.beach

  const band = Math.cos((absLat * Math.PI) / 30)
  const wet = clamp01(moisture * 0.85 + band * 0.22 + 0.05 - (climate.aridity - 0.5) * 0.8)
  if (wet > 0.86 && elevation < 160 && temperature > 6) return BIOME.swamp
  if (temperature < 5) return wet > 0.3 ? BIOME.taiga : BIOME.tundra
  if (temperature < 18) return wet < 0.3 ? BIOME.shrubland : wet < 0.48 ? BIOME.grassland : BIOME.temperateForest
  return wet < 0.3 ? BIOME.desert : wet < 0.55 ? BIOME.savanna : BIOME.rainforest
}

type Rgb = [number, number, number]

function rgbToHsl([r, g, b]: readonly number[]): Rgb {
  const [rn, gn, bn] = [r! / 255, g! / 255, b! / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  return [h * 60, s, l]
}

/** "#rrggbb" for a hue (degrees), saturation and lightness (0–1). */
export const hslToHex = (h: number, s: number, l: number) => rgbToHex(hslToRgb([h, s, l]))

function hslToRgb([h, s, l]: Rgb): Rgb {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

/** Shifts `color` the way `reference` would have to move to become `target`: same hue turn, saturation and lightness change. */
function retint(color: readonly number[], reference: string, target: string): Rgb {
  const [h, s, l] = rgbToHsl(color)
  const [rh, rs, rl] = rgbToHsl(hexToRgb(reference))
  const [th, ts, tl] = rgbToHsl(hexToRgb(target))
  return hslToRgb([(h + th - rh + 360) % 360, clamp01(rs > 0 ? s * (ts / rs) : ts), clamp01(l + tl - rl)])
}

const VEGETATION = [BIOME.tundra, BIOME.taiga, BIOME.temperateForest, BIOME.grassland, BIOME.shrubland, BIOME.savanna, BIOME.rainforest, BIOME.swamp]
const SAND = [BIOME.desert, BIOME.beach]
const DEFAULT_VEGETATION = '#4b8a3b'
const DEFAULT_SAND = '#dcc58c'
const DEFAULT_WATER = '#4a96c6'

export interface Palette {
  /** RGB per biome id. */
  biomes: Rgb[]
  shallow: Rgb
  deep: Rgb
}

/**
 * A world's colors: the biome palette with its plants and sand retinted to
 * the world's vegetation and sand colors, plus its shallow and deep water.
 * The default colors give back the standard palette exactly.
 */
export function worldPalette(colors: { vegetationColor: string; sandColor: string; waterColor: string }): Palette {
  const biomes = BIOME_RGB.map((rgb, id) => {
    if (VEGETATION.includes(id as never) && colors.vegetationColor !== DEFAULT_VEGETATION) return retint(rgb, DEFAULT_VEGETATION, colors.vegetationColor)
    if (SAND.includes(id as never) && colors.sandColor !== DEFAULT_SAND) return retint(rgb, DEFAULT_SAND, colors.sandColor)
    return [...rgb] as Rgb
  })
  const shallow = hexToRgb(colors.waterColor)
  // Deep water: the default deep blue, retinted like the shallows.
  const deep = colors.waterColor === DEFAULT_WATER ? ([12, 38, 80] as Rgb) : retint([12, 38, 80], DEFAULT_WATER, colors.waterColor)
  return { biomes, shallow, deep }
}
