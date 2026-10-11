import { DEFAULT_TERRAIN, LANDFORMS, WORLD_RANGES, quantizeSettings, type Landform, type TerrainParams, type WorldRange } from '@universe/core'
import { hslToHex as hsl } from './biomes'
import { rng, subSeed } from './random'

/**
 * World seeds. A seed is any text; it decides the whole planet: the noise seed
 * for its shape and every option (water, land type, climate, colors, size).
 * A world code ("W1-…") is the exact encoding of a world's seed and options,
 * so a custom world can be recreated anywhere, too.
 */

/** What a seed or code decides: the node's noise seed, the planet's size, and its options. */
export interface SeededWorld {
  seed: number
  radiusKm: number
  terrain: TerrainParams
}

/** FNV-1a: turns seed text into a 32-bit number. Plain whole numbers are used as they are. */
export function seedNumber(text: string): number {
  const t = text.trim()
  if (/^\d{1,10}$/.test(t) && Number(t) <= 0xffffffff) return Number(t)
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/**
 * The world a seed number grows into. Mostly Earth-like, sometimes strange:
 * frozen, scorched, flooded, or with alien plants and seas.
 * Version 1: never change what it returns, or saved seeds would grow different worlds.
 */
export function deriveWorld(seed: number): SeededWorld {
  const r = rng(subSeed(seed, 0x5eed))
  const between = (a: number, b: number) => a + r() * (b - a)
  const pick = <T>(items: readonly T[], weights: number[]): T => {
    let x = r() * weights.reduce((a, b) => a + b, 0)
    for (let i = 0; i < items.length; i++) if ((x -= weights[i]!) < 0) return items[i]!
    return items[items.length - 1]!
  }
  const landform: Landform = pick(LANDFORMS, [6, 2, 2])
  const climate = pick(['temperate', 'cold', 'hot', 'wet', 'dry'] as const, [5, 1.5, 1.5, 1, 1])
  const alienPlants = r() < 0.2
  const alienSeas = r() < 0.15
  const settings = quantizeSettings({
    radiusKm: Math.round(between(2500, 11000)),
    seaLevel: 0,
    seedText: null,
    erosionSpeed: 1,
    terrain: {
      landform,
      water: climate === 'wet' ? between(0.8, 0.93) : climate === 'dry' ? between(0.15, 0.4) : between(0.45, 0.78),
      continentScale: between(0.9, 2.6),
      islands: between(0, 0.7),
      roughness: between(0.25, 0.85),
      mountains: between(0.2, 0.85),
      mountainHeight: between(2500, 11000),
      temperature: climate === 'cold' ? between(-28, -12) : climate === 'hot' ? between(10, 24) : between(-6, 6),
      aridity: climate === 'dry' ? between(0.75, 1) : climate === 'wet' ? between(0.05, 0.35) : between(0.3, 0.65),
      beaches: between(0, 0.5),
      vegetationColor: alienPlants ? hsl(between(0, 360), between(0.35, 0.7), between(0.3, 0.45)) : hsl(between(85, 135), between(0.3, 0.5), between(0.3, 0.42)),
      sandColor: r() < 0.15 ? hsl(between(0, 360), between(0.2, 0.5), between(0.55, 0.7)) : hsl(between(35, 50), between(0.4, 0.6), between(0.65, 0.78)),
      waterColor: alienSeas ? hsl(between(0, 360), between(0.4, 0.6), between(0.4, 0.55)) : hsl(between(195, 215), between(0.45, 0.6), between(0.45, 0.58))
    }
  })
  return { seed, radiusKm: settings.radiusKm, terrain: settings.terrain }
}

// World codes: every value as an integer digit of a mixed-radix number, in Crockford base 32.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const NUMERIC: Exclude<WorldRange, 'radiusKm'>[] = ['water', 'continentScale', 'islands', 'roughness', 'mountains', 'mountainHeight', 'temperature', 'aridity', 'beaches']
const steps = (key: WorldRange) => Math.round((WORLD_RANGES[key].max - WORLD_RANGES[key].min) / WORLD_RANGES[key].step) + 1
const COLORS = ['vegetationColor', 'sandColor', 'waterColor'] as const
const CODE_PREFIX = 'W1-'

/** The digits of a world, with each one's base. */
function digits(w: SeededWorld): [bigint, bigint][] {
  const index = (key: WorldRange, v: number) => BigInt(Math.round((v - WORLD_RANGES[key].min) / WORLD_RANGES[key].step))
  return [
    [BigInt(w.seed), 2n ** 32n],
    [index('radiusKm', w.radiusKm), BigInt(steps('radiusKm'))],
    [BigInt(LANDFORMS.indexOf(w.terrain.landform)), BigInt(LANDFORMS.length)],
    ...NUMERIC.map((k): [bigint, bigint] => [index(k, w.terrain[k] as number), BigInt(steps(k))]),
    ...COLORS.map((k): [bigint, bigint] => [BigInt(parseInt(w.terrain[k].slice(1), 16)), 2n ** 24n])
  ]
}

const checksum = (body: string) => ALPHABET[[...body].reduce((sum, ch, i) => sum + ALPHABET.indexOf(ch) * (i + 1), 0) % 32]!

/** The exact code for a world: "W1-" and seven groups of five characters, the last one a check character. */
export function encodeWorldCode(w: SeededWorld): string {
  let n = 0n
  for (const [value, base] of digits(w).reverse()) n = n * base + value
  let body = ''
  for (let i = 0; i < 34; i++, n /= 32n) body += ALPHABET[Number(n % 32n)]
  body += checksum(body)
  return CODE_PREFIX + body.match(/.{1,5}/g)!.join('-')
}

/** Reads a world code; undefined if it isn't one or a character is mistyped. Lenient about case, dashes and O/0, I/L/1. */
export function decodeWorldCode(code: string): SeededWorld | undefined {
  const text = code.trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (!text.startsWith('W1') || text.length !== 2 + 35) return undefined
  const body = text.slice(2, -1)
  if ([...body].some((ch) => !ALPHABET.includes(ch)) || checksum(body) !== text.at(-1)) return undefined
  let n = 0n
  for (const ch of [...body].reverse()) n = n * 32n + BigInt(ALPHABET.indexOf(ch))
  const template = digits({ seed: 0, radiusKm: 50, terrain: DEFAULT_TERRAIN })
  const values = template.map(([, base]) => {
    const v = n % base
    n /= base
    return Number(v)
  })
  const [seed, radius, landform, ...rest] = values as [number, number, number, ...number[]]
  if (landform >= LANDFORMS.length) return undefined
  const value = (key: WorldRange, i: number) => Number((WORLD_RANGES[key].min + i * WORLD_RANGES[key].step).toFixed(4))
  const terrain = { ...DEFAULT_TERRAIN, landform: LANDFORMS[landform]! }
  NUMERIC.forEach((k, i) => ((terrain as Record<string, unknown>)[k] = value(k, rest[i]!)))
  COLORS.forEach((k, i) => (terrain[k] = `#${rest[NUMERIC.length + i]!.toString(16).padStart(6, '0')}`))
  return { seed, radiusKm: value('radiusKm', radius), terrain }
}

/** What typing `text` as a world's seed gives: a world code is read exactly; anything else grows a world. */
export function readSeed(text: string): SeededWorld {
  return decodeWorldCode(text) ?? deriveWorld(seedNumber(text))
}

const SYLLABLES = ['ka', 'ro', 'vel', 'an', 'tor', 'mi', 'sa', 'dun', 'el', 'zor', 'th', 'ia', 'qu', 'ber', 'lo', 'nyx', 'or', 'ae', 'gal', 'tes']

/** A pronounceable random seed, e.g. "Kavelor". */
export function randomSeedName(random: () => number = Math.random): string {
  const count = 2 + Math.floor(random() * 2)
  const name = Array.from({ length: count }, () => SYLLABLES[Math.floor(random() * SYLLABLES.length)]).join('')
  return name[0]!.toUpperCase() + name.slice(1)
}

/** Starting points for custom worlds. */
/** A preset: its own options, and colours for its vegetation, sand and water (Earth's unless it has its own), so choosing one after another recolours the world too. */
const preset = (name: string, terrain: Partial<TerrainParams>) => ({
  name,
  terrain: { vegetationColor: DEFAULT_TERRAIN.vegetationColor, sandColor: DEFAULT_TERRAIN.sandColor, waterColor: DEFAULT_TERRAIN.waterColor, ...terrain }
})

export const WORLD_PRESETS: { name: string; terrain: Partial<TerrainParams> }[] = [
  preset('Earth-like', DEFAULT_TERRAIN),
  preset('Ocean world', { landform: 'archipelago', water: 0.9, islands: 0.8, aridity: 0.3, beaches: 0.4, waterColor: '#2f7fb8' }),
  preset('Desert world', { water: 0.2, aridity: 1, temperature: 12, sandColor: '#d8a86a', vegetationColor: '#7d8a46', beaches: 0 }),
  preset('Ice world', { water: 0.6, temperature: -30, aridity: 0.5, vegetationColor: '#5f7d62', sandColor: '#c8c3b4', waterColor: '#5a8fb0' }),
  preset('Jungle world', { water: 0.5, temperature: 12, aridity: 0.05, vegetationColor: '#2f7a2a', waterColor: '#3d8a96' }),
  preset('Supercontinent', { landform: 'supercontinent', water: 0.6, islands: 0.15 }),
  preset('Archipelago', { landform: 'archipelago', water: 0.78, islands: 0.9, beaches: 0.5, waterColor: '#3aa3c2' }),
  preset('Alien', { vegetationColor: '#7a3fa0', waterColor: '#3fa08a', sandColor: '#c7b1d9', temperature: 4 })
]
