import { CUBE_FACES, TERRAIN_RES } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { cellDirections } from './cubesphere'
import { PLANET_CELLS, RIVER_FLOW, hydrology, neighbours, type Hydrology } from './hydrology'

const CELLS = TERRAIN_RES * TERRAIN_RES

/** Land rising to the north of the equator (sea to the south), with a bowl sunk into it at (x, y, z) = (0, 0.6, 0.8). */
function planet(): { heights: Float32Array[]; moisture: Float32Array[] } {
  const dirs = cellDirections()
  const heights = Array.from({ length: CUBE_FACES }, (_, f) => {
    const out = new Float32Array(CELLS)
    for (let c = 0; c < CELLS; c++) {
      const [x, y, z] = [dirs[f]![c * 3]!, dirs[f]![c * 3 + 1]!, dirs[f]![c * 3 + 2]!]
      const bowl = Math.hypot(x, y - 0.6, z - 0.8)
      // A ripple, so the land isn't one smooth slope, and the bowl deep enough to hold water.
      out[c] = 2000 * y - 100 + 40 * Math.sin(x * 40) * Math.cos(z * 40) - (bowl < 0.08 ? 600 * (1 - bowl / 0.08) : 0)
    }
    return out
  })
  const moisture = Array.from({ length: CUBE_FACES }, () => new Float32Array(CELLS).fill(0.5))
  return { heights, moisture }
}

let cached: Hydrology | undefined
const water = () => (cached ??= hydrology({ ...planet(), seed: 7, radiusKm: 6371 }))

describe('hydrology', () => {
  it('finds every cell’s neighbours, across the cube’s edges too', () => {
    const out = new Int32Array(8)
    for (const g of [0, CELLS - 1, 3 * CELLS + 5, 5 * CELLS + TERRAIN_RES * 10]) {
      const n = neighbours(g, out)
      expect(n).toBeGreaterThanOrEqual(7)
      for (const nb of out.subarray(0, n)) {
        expect(nb).not.toBe(g)
        expect(nb).toBeGreaterThanOrEqual(0)
        expect(nb).toBeLessThan(PLANET_CELLS)
        // Neighbours are neighbourly: each sees the other.
        const back = new Int32Array(8)
        expect([...back.subarray(0, neighbours(nb, back))]).toContain(g)
      }
    }
  })

  it('sends all the water to the sea, filling the basin it can’t leave as a lake', () => {
    const { rivers, lakes, receiver, flow } = water()
    expect(lakes.length).toBeGreaterThan(0)
    const lake = lakes[0]!
    expect(lake.name).toMatch(/^Lake [A-Z]/)
    expect(lake.level).toBeGreaterThan(0)
    expect(lake.center.lat).toBeCloseTo(36.9, -1)

    expect(rivers.length).toBeGreaterThan(0)
    for (const r of rivers) {
      // Each step of a river goes where its water goes, and it gathers more on the way.
      for (let k = 0; k < r.cells.length - (r.into.kind === 'river' ? 2 : 1); k++) {
        expect(receiver[r.cells[k]!]).toBe(r.cells[k + 1])
        expect(flow[r.cells[k + 1]!]).toBeGreaterThanOrEqual(flow[r.cells[k]!]!)
      }
      expect(r.flow[0]).toBeGreaterThanOrEqual(1)
      expect(r.points).toHaveLength(r.cells.length)
    }
    // The biggest river comes first, and reaches the sea; and something flows into the lake.
    expect(rivers[0]!.into.kind).toBe('sea')
    expect(rivers.some((r) => r.into.kind === 'lake')).toBe(true)
    expect(rivers.some((r) => r.into.kind === 'river')).toBe(true)
  })

  it('is the same every time, names and all', () => {
    const again = hydrology({ ...planet(), seed: 7, radiusKm: 6371 })
    expect(again.rivers.map((r) => [r.id, r.name, r.cells.length])).toEqual(water().rivers.map((r) => [r.id, r.name, r.cells.length]))
    expect(again.lakes.map((l) => l.id)).toEqual(water().lakes.map((l) => l.id))
    expect(RIVER_FLOW).toBeGreaterThan(0)
  })
})
