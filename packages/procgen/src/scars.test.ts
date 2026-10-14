import { DEFAULT_WORLD_SETTINGS } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { BIOME, BIOME_RGB } from './biomes'
import { GroundDetail, buildGroundChunk, chunkBounds, chunkOf, sampleBaseGrid, type BaseSampler, type ChunkId } from './ground'
import { latLonToDir } from './cubesphere'
import { generateBase } from './generate'
import { scarField, type LandScar } from './scars'
import { TerrainModel } from './terrain-model'

const R = 6371
const P = { lat: 45, lon: 7 }
const flat = (biome: number, elevation = 300): BaseSampler => ({ elevation: () => elevation, biome: () => biome })
/** A point `m` metres north of P. */
const north = (m: number) => P.lat + m / (R * 1000 * (Math.PI / 180))
const scar = (kind: LandScar['kind'], extra: Partial<LandScar> = {}): LandScar => ({ id: `s-${kind}`, kind, ...P, radiusKm: 1, weight: 1, ...extra })

function chunk(id: ChunkId, base: BaseSampler, scars?: LandScar[]) {
  return buildGroundChunk({ id, frame: { origin: P, radiusKm: R }, seed: 7, grid: sampleBaseGrid(base, chunkBounds(id, R)), biomeColors: BIOME_RGB.map((c) => [...c]), seabedColor: [40, 60, 80], scars })
}
const count = (plants: Float32Array | undefined) => (plants?.length ?? 0) / 6

describe('scars on the ground', () => {
  it('a blast leaves a bowl a fifth as deep as it is wide across, with a raised rim; healed to nothing, the land is as it was', () => {
    const base = flat(BIOME.grassland)
    const whole = new GroundDetail(7, R)
    const blasted = new GroundDetail(7, R, undefined, [scar('crater')])
    const drop = (m: number, d = blasted) => whole.elevation(base, north(m), P.lon) - d.elevation(base, north(m), P.lon)
    expect(drop(0)).toBeGreaterThan(200)
    expect(drop(0)).toBeLessThan(240)
    // The rim stands over the land around, and past the thrown-out earth it's untouched.
    expect(drop(1000)).toBeLessThan(-20)
    expect(drop(2500)).toBeCloseTo(0, 3)
    expect(drop(0, new GroundDetail(7, R, undefined, [scar('crater', { weight: 0 })]))).toBe(0)
  })

  it('war pocks the ground with shell holes up close, not seen from afar', () => {
    const base = flat(BIOME.grassland)
    const whole = new GroundDetail(7, R)
    const war = new GroundDetail(7, R, undefined, [scar('war', { radiusKm: 2 })])
    // Across a patch of it, 3 m apart each way.
    const holes = Array.from({ length: 900 }, (_, k) => {
      const [lat, lon] = [north((k % 30) * 3), P.lon + Math.floor(k / 30) * 0.00004]
      return whole.elevation(base, lat, lon) - war.elevation(base, lat, lon)
    })
    expect(Math.max(...holes)).toBeGreaterThan(0.5)
    expect(war.elevation(base, P.lat, P.lon, 1, false, 250)).toBeCloseTo(whole.elevation(base, P.lat, P.lon, 1, false, 250), 6)
  })

  it('fire burns the woods to bare trunks and blackens the ground; drought parches it; a region scarred inside only', () => {
    const forest = flat(BIOME.temperateForest)
    const id = chunkOf(P, R)
    const green = chunk(id, forest)
    const burned = chunk(id, forest, [scar('burned', { radiusKm: 5 })])
    expect(count(green.plants.broadleaf)).toBeGreaterThan(500)
    expect(count(burned.plants.broadleaf)).toBeLessThan(count(green.plants.broadleaf) * 0.1)
    expect(count(burned.plants.snag)).toBeGreaterThan(count(green.plants.snag) + 200)
    const brightness = (c: Float32Array) => c.reduce((a, b) => a + b, 0) / c.length
    expect(brightness(burned.colors)).toBeLessThan(brightness(green.colors) * 0.6)
    const dry = chunk(id, forest, [scar('drought', { radiusKm: 5 })])
    expect(brightness(dry.colors)).toBeGreaterThan(brightness(green.colors))
    const d = 0.05
    const polygon = [{ lat: P.lat - d, lon: P.lon - d }, { lat: P.lat - d, lon: P.lon + d }, { lat: P.lat + d, lon: P.lon + d }, { lat: P.lat + d, lon: P.lon - d }]
    const region = new GroundDetail(7, R, undefined, [scar('poisoned', { polygon, radiusKm: 8 })])
    expect(region.scarAt(P.lat, P.lon)!.tint).toBeGreaterThan(0.3)
    expect(region.scarAt(P.lat + 0.08, P.lon)!.tint).toBe(0)
  })

  it('on the globe, a great blast lowers and darkens the cells it covers, and the ground is given the land without it (it shapes its own)', () => {
    const model = new TerrainModel(DEFAULT_WORLD_SETTINGS, generateBase(42, DEFAULT_WORLD_SETTINGS.terrain))
    const dir = latLonToDir(P.lat, P.lon)
    const { face, cell } = model.cellAt(...dir)
    const [before, colour] = [model.height(face, cell), model.faceColors(face).slice(cell * 4, cell * 4 + 3)]
    expect(scarField([scar('crater', { weight: 0 })], R)).toBeUndefined()
    expect(model.setScars(scarField([scar('crater', { radiusKm: 150 })], R))).toBe(true)
    expect(model.height(face, cell)).toBeLessThan(before - 1000)
    expect(model.height(face, cell, false)).toBe(before)
    const after = model.faceColors(face).slice(cell * 4, cell * 4 + 3)
    expect([...after]).not.toEqual([...colour])
    expect(model.setScars(undefined)).toBe(true)
    expect(model.height(face, cell)).toBe(before)
  })
})
