import { describe, expect, it } from 'vitest'
import { GALAXY_SCALE, GLOW_REACH, STAR_CELL_LY, cellStars, cellsIn, clusterGalaxies, dustField, galaxyConstellations, galaxyDensity, galaxyFeatures, galaxyGlowPixels, galaxyShape, landmarkStars, levelExtent, placeOf, spreadApart, universeClusters } from './cosmos'

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

  it("draws a galaxy's glow from its stars, brightest in the middle, the same every time", () => {
    const shape = galaxyShape(21)
    const pixels = galaxyGlowPixels(shape, 21, 64, 4000)
    expect(pixels).toHaveLength(64 * 64 * 4)
    expect(galaxyGlowPixels(shape, 21, 64, 4000)).toEqual(pixels)
    const alpha = (x: number, y: number) => pixels[(y * 64 + x) * 4 + 3]!
    let middle = 0
    let corner = 0
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        middle += alpha(28 + x, 28 + y)
        corner += alpha(x, y)
      }
    }
    expect(middle).toBeGreaterThan(corner)
    expect(levelExtent('galaxy', 21)).toBeCloseTo(shape.radiusLy * 1.25)
  })

  it('only lists cells for a view small enough to fill with single stars', () => {
    expect(cellsIn(0, 0, 2000, 1000)).toHaveLength(4 * 2)
    expect(cellsIn(-50_000, -50_000, 50_000, 50_000)).toBeUndefined()
  })

  it('scatters landmarks, galaxies and clusters, the same every time', () => {
    const shape = galaxyShape(3)
    expect(landmarkStars(shape, 3).length).toBeGreaterThan(90)
    expect(clusterGalaxies(5)).toEqual(clusterGalaxies(5))
    expect(new Set(clusterGalaxies(5).map((g) => g.seed)).size).toBe(36)
    expect(universeClusters(9)).toHaveLength(48)
  })

  it('places nodes made before they had a place by their seed, and keeps a set place', () => {
    const galaxy = { kind: 'galaxy' as const, seed: 4 }
    const unplaced = { kind: 'star_system' as const, seed: 99, position: { x: 0, y: 0, z: 0 } }
    const p = placeOf(unplaced, galaxy)
    expect(placeOf(unplaced, galaxy)).toEqual(p)
    expect(galaxyDensity(galaxyShape(4), p.x, p.y)).toBeGreaterThan(0)
    expect(placeOf({ ...unplaced, position: { x: 5, y: 6, z: 0 } }, galaxy)).toEqual({ x: 5, y: 6 })
  })

  it('never lets a level’s clusters or galaxies overlap, as they’re drawn', () => {
    const apart = <T extends { x: number; y: number }>(list: T[], radius: (t: T) => number) =>
      list.every((a, i) => list.every((b, j) => j <= i || Math.hypot(a.x - b.x, a.y - b.y) >= radius(a) + radius(b) - 1e-6))
    for (const seed of [1, 9, 77]) {
      expect(apart(universeClusters(seed), (c) => c.sizeMly * 0.7)).toBe(true)
      expect(apart(clusterGalaxies(seed), (g) => (g.shape.radiusLy / 1e6) * GALAXY_SCALE * GLOW_REACH)).toBe(true)
    }
    // Even things exactly on top of each other come apart, the same way each time.
    const piled = spreadApart([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], () => 1, 0)
    expect(piled).toEqual(spreadApart([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], () => 1, 0))
    expect(Math.hypot(piled[0]!.x - piled[1]!.x, piled[0]!.y - piled[1]!.y)).toBeGreaterThanOrEqual(2 - 1e-6)
  })

  it('draws constellations among a galaxy’s bright stars: each a few stars joined without loops but now and then one, the same every time', () => {
    const shape = galaxyShape(12)
    const stars = landmarkStars(shape, 12)
    const constellations = galaxyConstellations(shape, 12, stars)
    expect(constellations.length).toBeGreaterThanOrEqual(5)
    expect(galaxyConstellations(shape, 12, stars)).toEqual(constellations)
    const seeds = new Set(stars.map((s) => s.seed))
    const seen = new Set<number>()
    for (const c of constellations) {
      expect(c.name).toMatch(/^\S/)
      expect(c.stars.length).toBeGreaterThanOrEqual(3)
      expect(c.links.length).toBeGreaterThanOrEqual(c.stars.length - 1)
      expect(c.links.length).toBeLessThanOrEqual(c.stars.length)
      for (const s of c.stars) {
        expect(seeds.has(s)).toBe(true)
        // A star is in one constellation only.
        expect(seen.has(s)).toBe(false)
        seen.add(s)
      }
    }
  })

  it('fills a galaxy with nebulae, dust, supernova remnants and clusters, and darkens dust lanes in its arms; an elliptical has only old ones', () => {
    const spiral = galaxyShape([...Array(50).keys()].find((i) => galaxyShape(i).type === 'spiral')!)
    const features = galaxyFeatures(spiral, 1)
    expect(features.length).toBeGreaterThan(40)
    expect(new Set(features.map((f) => f.kind))).toEqual(new Set(['emission', 'reflection', 'dark', 'supernova', 'planetary', 'cluster']))
    const dust = dustField(spiral)
    let dusty = 0
    for (let i = 0; i < 400; i++) dusty = Math.max(dusty, dust(Math.cos(i) * spiral.radiusLy * 0.5, Math.sin(i) * spiral.radiusLy * 0.5))
    expect(dusty).toBeGreaterThan(0.5)
    const elliptical = galaxyShape([...Array(50).keys()].find((i) => galaxyShape(i).type === 'elliptical')!)
    expect(new Set(galaxyFeatures(elliptical, 2).map((f) => f.kind)).has('emission')).toBe(false)
    expect(dustField(elliptical)(0, 0)).toBe(0)
  })
})
