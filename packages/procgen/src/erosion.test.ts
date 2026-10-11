import { CUBE_FACES, DEFAULT_WORLD_SETTINGS, TERRAIN_RES } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { erosionAt, erosionField, erosionStep } from './erosion'
import { generateBase } from './generate'
import { PLANET_CELLS, hydrology } from './hydrology'
import { worldWater } from './water'
import { TerrainModel } from './terrain-model'

const CELLS = TERRAIN_RES * TERRAIN_RES

describe('erosion', () => {
  const base = generateBase(42, DEFAULT_WORLD_SETTINGS.terrain)
  const heights = base.height.map((f) => f.map((v) => v - DEFAULT_WORLD_SETTINGS.seaLevel))
  const water = hydrology({ heights, moisture: base.moisture, seed: 42, radiusKm: 6371 })

  it('cuts valleys where rivers run and slumps steep slopes, but not at sea, under lakes or where sculpted', () => {
    const river = water.rivers.reduce((a, b) => (b.cells.length > a.cells.length ? b : a))
    const sculpted = river.cells[0]!
    const field = erosionField({ heights, water, radiusKm: 6371, sculpted: heights.map((_, f) => Uint8Array.from({ length: CELLS }, (_, c) => (f * CELLS + c === sculpted ? 1 : 0))) })
    const depthAt = (g: number) => field[Math.floor(g / CELLS)]![g % CELLS]!
    expect(field).toHaveLength(CUBE_FACES)
    // Along the biggest river (past its sculpted source), the land wears down; it stays land.
    const along = river.cells.slice(1, -1).map(depthAt)
    expect(Math.max(...along)).toBeGreaterThan(5)
    for (const g of river.cells) expect(heights[Math.floor(g / CELLS)]![g % CELLS]! - depthAt(g)).toBeGreaterThan(0)
    expect(depthAt(sculpted)).toBe(0)
    for (const g of water.lakes[0]!.cells) expect(depthAt(g)).toBe(0)
    let sea = 0
    for (let f = 0; f < CUBE_FACES; f++) for (let c = 0; c < CELLS; c++) if (heights[f]![c]! <= 0) sea = Math.max(sea, field[f]![c]!)
    expect(sea).toBe(0)
  })

  it('happens over the years, faster at a higher erosion speed, never before the timeline begins', () => {
    expect(erosionAt(-100, 1)).toBe(0)
    expect(erosionAt(0, 1)).toBe(0)
    expect(erosionAt(1000, 0)).toBe(0)
    expect(erosionAt(1000, 1)).toBeGreaterThan(0)
    expect(erosionAt(1000, 1)).toBeLessThan(erosionAt(5000, 1))
    expect(erosionAt(1000, 2)).toBeCloseTo(erosionAt(2000, 1))
    expect(erosionAt(1e9, 1)).toBeCloseTo(1)
    expect(erosionStep(0.51)).toBe(0.5)
  })
})

describe('the terrain model, worn and with lakes', () => {
  const base = generateBase(42, DEFAULT_WORLD_SETTINGS.terrain)
  it('wears its land down by as much of the erosion as has happened, and colours lakes as water', () => {
    const model = new TerrainModel(DEFAULT_WORLD_SETTINGS, base)
    const water = worldWater(model.waterInput(42), { erosion: true })
    const field = water.erosion!
    let worst = 0
    for (let c = 1; c < CELLS; c++) if (field[0]![c]! > field[0]![worst]!) worst = c
    const before = model.height(0, worst)
    expect(model.setErosion(field, 0.5)).toBe(true)
    expect(model.setErosion(field, 0.5)).toBe(false)
    expect(model.height(0, worst)).toBeCloseTo(before - field[0]![worst]! * 0.5, 3)
    // What rivers and weathering are worked out from isn't worn.
    expect(worldWater(model.waterInput(42)).rivers).toEqual(water.rivers)
    expect(model.unworn(() => model.height(0, worst))).toBeCloseTo(before, 3)
    model.setErosion(field, 0)
    expect(model.height(0, worst)).toBeCloseTo(before, 3)

    const lake = water.lakes[0]!.cells[0]!
    const [face, cell] = [Math.floor(lake / CELLS), lake % CELLS]
    const land = new Uint8Array(4)
    model.color(face, cell, land, 0)
    expect(model.setLakes(water.lakeLevel)).toBe(true)
    const wet = new Uint8Array(4)
    model.color(face, cell, wet, 0)
    // Bluer than the land it covers.
    expect(wet[2]! - wet[0]!).toBeGreaterThan(land[2]! - land[0]!)
    expect(water.lakeLevel).toHaveLength(PLANET_CELLS)
    // A whole planet's water, twice: about a second alone, more beside the other packages' tests.
  }, 30_000)
})
