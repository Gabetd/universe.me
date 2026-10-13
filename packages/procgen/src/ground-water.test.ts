import { TERRAIN_RES } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { dirToFace, latLonToDir, nearestCell } from './cubesphere'
import { GroundDetail, type BaseSampler } from './ground'
import { FALL_M, WaterShaper, riverCourses, watersNear, type GroundWaters } from './ground-water'
import { planetCell, type River } from './hydrology'
import { BIOME } from './biomes'

const R = 6371
const M_PER_DEG = (R * 1000 * Math.PI) / 180

/** A river running due north along longitude 10° from latitude 0° to 1° (about 111 km). */
const river = (): River => ({
  id: 'r',
  name: 'R',
  cells: [0, 1, 2, 3, 4],
  points: [0, 0.25, 0.5, 0.75, 1].map((lat) => ({ lat, lon: 10 })),
  flow: [1, 2, 4, 8, 16],
  into: { kind: 'sea' },
  lengthKm: 111
})

/** Land falling to the north by `drop` metres a metre, from 2000 m at the equator. */
const sloping = (drop: number): BaseSampler => ({ elevation: (lat) => 2000 - lat * M_PER_DEG * drop, biome: () => BIOME.grassland })

const fallsOf = (waters: GroundWaters) =>
  waters.courses.flatMap((c) => c.points.flatMap((p, k) => (k > 0 && p[0] === c.points[k - 1]![0] && p[1] === c.points[k - 1]![1] ? [c.points[k - 1]![2]! - p[2]!] : [])))

describe('rivers on the ground', () => {
  const center = { lat: 0.5, lon: 10 }

  it('run down their land, in steps of falls where it is steep and smoothly where it is gentle', () => {
    const steep = { courses: riverCourses([river()], sloping(0.02), center, 5000, R), lakes: [] }
    const falls = fallsOf(steep)
    expect(falls.length).toBeGreaterThan(5)
    for (const drop of falls) expect(drop, String(falls)).toBeGreaterThan(FALL_M * 0.5)
    // Downstream the water never rises.
    for (const c of steep.courses) for (let k = 1; k < c.points.length; k++) expect(c.points[k]![2]!).toBeLessThanOrEqual(c.points[k - 1]![2]! + 1e-6)
    expect(fallsOf({ courses: riverCourses([river()], sloping(0.0005), center, 5000, R), lakes: [] })).toEqual([])
  })

  it('are worked out the same whichever view they are for', () => {
    const a = riverCourses([river()], sloping(0.02), { lat: 0.45, lon: 10 }, 8000, R)[0]!.points
    const b = riverCourses([river()], sloping(0.02), { lat: 0.55, lon: 10 }, 8000, R)[0]!.points
    const key = (p: number[]) => p.map((v) => v.toFixed(7)).join()
    const shared = new Set(b.map(key))
    expect(a.filter((p) => shared.has(key(p))).length).toBeGreaterThan(a.length / 3)
  })

  it('cut a valley that holds their water, the land rising from its banks', () => {
    const base = sloping(0.0005)
    const waters = { courses: riverCourses([river()], base, center, 5000, R), lakes: [] }
    const shaper = new WaterShaper(waters, R)
    const at = (east: number) => ({ ...shaper.shape(0.5, 10 + east / (M_PER_DEG * Math.cos(0.5 * (Math.PI / 180))), base.elevation(0.5, 10)) })
    const middle = at(0)
    expect(middle.wet).toBe(1)
    expect(middle.y).toBeLessThan(middle.surface)
    const bank = at(200)
    expect(bank.wet).toBe(0)
    expect(bank.y).toBeGreaterThan(middle.surface)
    expect(at(2000).y).toBe(base.elevation(0.5, 10))
    // A stretch of ground well away from the river isn't handed it.
    expect(watersNear(waters, { lat0: 0.4, lat1: 0.41, lon0: 11, lon1: 11.01 }, R).courses).toEqual([])
  })
})

describe('lakes on the ground', () => {
  // A lake of one cell at 300 m, in land at 320 m.
  const p = { lat: 20.3, lon: 40.2 }
  const d = latLonToDir(p.lat, p.lon)
  const f = dirToFace(d[0], d[1], d[2])
  const g = planetCell(f.face, nearestCell(f.s, f.t))
  const shaper = new WaterShaper({ courses: [], lakes: [{ level: 300, cells: [g] }] }, R)
  const cellDeg = 90 / TERRAIN_RES

  it('lie in a basin, under their surface', () => {
    const t = shaper.shape(p.lat, p.lon, 320)
    expect(t.y).toBeLessThan(300)
    expect(t.surface).toBe(300)
  })

  it('are held in by a shore raised above them, back to the land beyond', () => {
    // Out from the middle, the first ground past the water.
    let north = 0
    while (!Number.isNaN(shaper.shape(p.lat + north, p.lon, 280).surface)) north += cellDeg / 200
    expect(shaper.shape(p.lat + north, p.lon, 280).y).toBeGreaterThan(300)
    expect(shaper.shape(p.lat + cellDeg * 3, p.lon, 280).y).toBe(280)
  })
})

describe('the land around water', () => {
  it('grows no trees in a river, and shapes the same heights for the view as for the chunks', () => {
    const base = sloping(0.0005)
    const waters = { courses: riverCourses([river()], base, { lat: 0.5, lon: 10 }, 5000, R), lakes: [] }
    const a = new GroundDetail(7, R, waters)
    const b = new GroundDetail(7, R, watersNear(waters, { lat0: 0.49, lat1: 0.51, lon0: 9.99, lon1: 10.01 }, R))
    expect(a.elevation(base, 0.5, 10.0001)).toBe(b.elevation(base, 0.5, 10.0001))
    expect(a.shape.wet).toBe(1)
  })
})
