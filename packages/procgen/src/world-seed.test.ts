import { CUBE_FACES, DEFAULT_TERRAIN, TERRAIN_RES, WORLD_RANGES, type TerrainParams } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { BIOME_RGB, decodeWorldCode, deriveWorld, encodeWorldCode, generateBase, readSeed, seedNumber, worldPalette } from './index'

const extremes = (pick: 'min' | 'max'): TerrainParams => ({
  ...DEFAULT_TERRAIN,
  landform: pick === 'min' ? 'continents' : 'archipelago',
  ...Object.fromEntries((['water', 'continentScale', 'islands', 'roughness', 'mountains', 'mountainHeight', 'temperature', 'aridity', 'beaches'] as const).map((k) => [k, WORLD_RANGES[k][pick]])),
  vegetationColor: pick === 'min' ? '#000000' : '#ffffff',
  sandColor: pick === 'min' ? '#000000' : '#ffffff',
  waterColor: pick === 'min' ? '#000000' : '#ffffff'
})

describe('world codes', () => {
  it('round-trip a world exactly, even at the extremes', () => {
    for (const w of [
      deriveWorld(42),
      deriveWorld(seedNumber('Avalon')),
      { seed: 0, radiusKm: WORLD_RANGES.radiusKm.min, terrain: extremes('min') },
      { seed: 0xffffffff, radiusKm: WORLD_RANGES.radiusKm.max, terrain: extremes('max') }
    ]) {
      const code = encodeWorldCode(w)
      expect(code).toMatch(/^W1-([0-9A-Z]{5}-){6}[0-9A-Z]{5}$/)
      expect(decodeWorldCode(code)).toEqual(w)
      expect(decodeWorldCode(code.toLowerCase().replace(/-/g, ' '))).toEqual(w)
    }
  })

  it('rejects mistyped codes and non-codes', () => {
    const code = encodeWorldCode(deriveWorld(7))
    const i = 10
    const typo = code.slice(0, i) + (code[i] === 'A' ? 'B' : 'A') + code.slice(i + 1)
    expect(decodeWorldCode(typo)).toBeUndefined()
    expect(decodeWorldCode('Avalon')).toBeUndefined()
  })
})

describe('seeds', () => {
  it('grow the same world from the same text, and different worlds from different text', () => {
    expect(readSeed('Avalon')).toEqual(readSeed('Avalon'))
    expect(readSeed('Avalon')).not.toEqual(readSeed('Avalon2'))
    expect(readSeed('12345').seed).toBe(12345)
  })

  it('read a world code back as exactly that world', () => {
    const custom = { seed: 99, radiusKm: 4000, terrain: { ...DEFAULT_TERRAIN, water: 0.8, vegetationColor: '#8844aa' } }
    expect(readSeed(encodeWorldCode(custom))).toEqual(custom)
  })

  it('stay within every option’s range and step', () => {
    for (let s = 0; s < 50; s++) {
      const { terrain, radiusKm } = deriveWorld(s * 7919)
      expect(radiusKm).toBeGreaterThanOrEqual(WORLD_RANGES.radiusKm.min)
      expect(decodeWorldCode(encodeWorldCode({ seed: s, radiusKm, terrain }))?.terrain).toEqual(terrain)
    }
  })
})

describe('generation options', () => {
  const landFraction = (terrain: TerrainParams) => {
    const base = generateBase(5, terrain)
    let land = 0
    for (let f = 0; f < CUBE_FACES; f++) for (const h of base.height[f]!) if (h > 0) land++
    return land / (CUBE_FACES * TERRAIN_RES * TERRAIN_RES)
  }

  it('puts exactly the chosen share of the surface under water', () => {
    expect(landFraction({ ...DEFAULT_TERRAIN, water: 0.3 })).toBeCloseTo(0.7, 2)
    expect(landFraction({ ...DEFAULT_TERRAIN, landform: 'archipelago', water: 0.85 })).toBeCloseTo(0.15, 2)
  })

  it('keeps the standard palette for the default colors and retints plants', () => {
    expect(worldPalette(DEFAULT_TERRAIN).biomes).toEqual(BIOME_RGB.map((c) => [...c]))
    const purple = worldPalette({ ...DEFAULT_TERRAIN, vegetationColor: '#7a3fa0' }).biomes[4]!
    expect(purple[2]).toBeGreaterThan(purple[1]) // the forest is now more blue than green
  })
})
