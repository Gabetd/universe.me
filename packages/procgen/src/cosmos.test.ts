import { describe, expect, it } from 'vitest'
import { STAR_CELL_LY, cellStars, cellsIn, clusterGalaxies, cosmicWeb, galaxyDensity, galaxyShape, landmarkStars, placeOf, universeClusters } from './cosmos'

describe('the cosmos from seeds', () => {
  it('gives each galaxy a shape, densest at its centre', () => {
    const shape = galaxyShape(7)
    expect(galaxyDensity(shape, 0, 0)).toBeGreaterThan(0.8)
    expect(galaxyDensity(shape, shape.radiusLy * 2, 0)).toBe(0)
    expect(galaxyShape(7)).toEqual(shape)
    const types = new Set(Array.from({ length: 200 }, (_, i) => galaxyShape(i).type))
    expect([...types].sort()).toEqual(['barred', 'elliptical', 'irregular', 'spiral'])
  })

  it('generates the same stars in a cell every time, more near the centre', () => {
    const shape = galaxyShape(11)
    const centre = cellStars(shape, 11, 0, 0)
    expect(cellStars(shape, 11, 0, 0)).toEqual(centre)
    expect(centre.length).toBeGreaterThan(5)
    for (const s of centre) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThan(STAR_CELL_LY)
    }
    const edge = Math.floor((shape.radiusLy * 1.5) / STAR_CELL_LY)
    expect(cellStars(shape, 11, edge, edge)).toEqual([])
    // Mostly small stars.
    const many = Array.from({ length: 20 }, (_, i) => cellStars(shape, 11, i - 10, 0)).flat()
    expect(many.filter((s) => s.massSun < 1).length).toBeGreaterThan(many.length * 0.6)
  })

  it('only lists cells for a view small enough to fill with single stars', () => {
    expect(cellsIn(0, 0, 2000, 1000)).toHaveLength(4 * 2)
    expect(cellsIn(-50_000, -50_000, 50_000, 50_000)).toBeUndefined()
  })

  it('scatters landmarks, galaxies and clusters, the same every time', () => {
    const shape = galaxyShape(3)
    expect(landmarkStars(shape, 3).length).toBeGreaterThan(100)
    expect(clusterGalaxies(5)).toEqual(clusterGalaxies(5))
    expect(new Set(clusterGalaxies(5).map((g) => g.seed)).size).toBe(36)
    expect(universeClusters(9)).toHaveLength(48)
    expect(cosmicWeb(9).length).toBeGreaterThan(5)
  })

  it('places nodes made before they had a place by their seed, and keeps a set place', () => {
    const galaxy = { kind: 'galaxy' as const, seed: 4 }
    const unplaced = { kind: 'star_system' as const, seed: 99, position: { x: 0, y: 0, z: 0 } }
    const p = placeOf(unplaced, galaxy)
    expect(placeOf(unplaced, galaxy)).toEqual(p)
    expect(galaxyDensity(galaxyShape(4), p.x, p.y)).toBeGreaterThan(0)
    expect(placeOf({ ...unplaced, position: { x: 5, y: 6, z: 0 } }, galaxy)).toEqual({ x: 5, y: 6 })
  })
})
