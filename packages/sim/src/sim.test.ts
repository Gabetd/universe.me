import { AU_KM, DEFAULT_CALENDAR, orbitId, type Orbit, type SpatialNode } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { DAY_S, EARTH_ORBIT, MOON_ORBIT, claimGenerated, claimPlanet, deriveCalendar, generatedPlanets, luminosityOf, moonPhase, orbitPosition, skyEvents, starInfo, systemModel, unclaimedPlanets, worldCalendar, worldClimate } from './index'

const node = (id: string, parentId: string | null, kind: SpatialNode['kind']): SpatialNode => ({
  id, parentId, kind, name: id, seed: 7, position: { x: 0, y: 0, z: 0 }, notes: '', tags: [], createdAt: '', updatedAt: '', deletedAt: null
})
const nodes = [node('sys', null, 'star_system'), node('earth', 'sys', 'body'), node('moon', 'earth', 'body'), node('w', 'earth', 'world'), node('mars', 'sys', 'body')]
const orbit = (bodyId: string, fields: Partial<Orbit>): Orbit =>
  ({ ...EARTH_ORBIT, ...fields, id: orbitId(bodyId), ownerId: bodyId, createdAt: '', updatedAt: '', deletedAt: null }) as Orbit
const earthOrbit = orbit('earth', {})
const system = (orbits: Orbit[] = [earthOrbit]) => systemModel(nodes, { stars: [], orbits }, 'sys')

describe('stars', () => {
  it('the Sun is the Sun', () => {
    const sun = starInfo()
    expect(sun.luminositySun).toBe(1)
    expect(sun.temperatureK).toBeCloseTo(5772, 0)
    expect(sun.habitableAu[0]).toBeLessThan(1)
    expect(sun.habitableAu[1]).toBeGreaterThan(1)
    expect(luminosityOf(2)).toBeGreaterThan(10)
  })
})

describe('orbits', () => {
  it('Earth goes round in a year and the Moon in 27.3 days', () => {
    const s = system()
    expect(s.bodies.get('earth')!.periodS / DAY_S).toBeCloseTo(365.25, 0)
    expect(s.bodies.get('moon')!.periodS / DAY_S).toBeCloseTo(27.3, 0)
    // Unedited bodies have defaults: the moon Moon-like, the bare planet farther out.
    expect(s.bodies.get('moon')!.isDefault).toBe(true)
    expect(s.bodies.get('mars')!.semiMajorAxisKm / AU_KM).toBeCloseTo(0.4, 5)
  })

  it('follow Kepler: perihelion is closest, aphelion farthest', () => {
    const o = { ...system().bodies.get('earth')!, phaseDeg: 0, eccentricity: 0.2 }
    const near = Math.hypot(...orbitPosition(o, 0))
    const far = Math.hypot(...orbitPosition(o, o.periodS / 2))
    expect(near).toBeCloseTo(o.semiMajorAxisKm * 0.8, -2)
    expect(far).toBeCloseTo(o.semiMajorAxisKm * 1.2, -2)
  })

  it('a system’s seed generates its planets: the same each time, spaced out, closer in round dimmer stars', () => {
    const sys = nodes[0]!
    const planets = generatedPlanets(sys, starInfo())
    expect(generatedPlanets(sys, starInfo())).toEqual(planets)
    expect(planets.length).toBeGreaterThanOrEqual(2)
    expect(planets[0]!.name).toBe('sys b')
    const axes = planets.map((p) => p.orbit.semiMajorAxisKm)
    axes.slice(1).forEach((a, i) => expect(a / axes[i]!).toBeGreaterThan(1.4))
    // Giants only beyond the frost line.
    for (const p of planets) if (p.giant) expect(p.orbit.semiMajorAxisKm / AU_KM).toBeGreaterThan(2.5)
    for (const p of planets) expect(p.giant).toBe(p.orbit.massEarth > 10)
    const dim = generatedPlanets(sys, starInfo({ massSun: 0.4, luminositySun: null }))
    expect(dim[0]!.orbit.semiMajorAxisKm).toBeLessThan(axes[0]!)
    // A year goes with the distance (Kepler's third law): 1 AU round the Sun is about 365 days.
    const p = planets[0]!.orbit
    expect(p.periodS / DAY_S).toBeCloseTo(365.25 * (p.semiMajorAxisKm / AU_KM) ** 1.5, -1)
  })

  it('claimed planets, and orbits a planet already takes, leave the generated ones', () => {
    const s = system()
    const sys = nodes[0]!
    const all = generatedPlanets(sys, s.star)
    const left = unclaimedPlanets(s, sys, nodes)
    for (const g of left) for (const o of s.bodies.values()) if (!o.parentBodyId) expect(Math.abs(g.orbit.semiMajorAxisKm / o.semiMajorAxisKm - 1)).toBeGreaterThan(0.2)
    const claim = { ...node('claimed', 'sys', 'body'), seed: left[0]!.seed }
    expect(unclaimedPlanets(systemModel([...nodes, claim], { stars: [], orbits: [earthOrbit] }, 'sys'), sys, [...nodes, claim]).map((g) => g.seed)).not.toContain(left[0]!.seed)
    expect(all.length).toBeGreaterThanOrEqual(left.length)
  })

  it('claiming a planet, a star or a galaxy stores what was generated, and lands on it', async () => {
    const { CommandBus, MemoryStore, createRootUniverse } = await import('@universe/core')
    const { cellStars, clusterGalaxies, galaxyShape } = await import('@universe/procgen')
    const store = new MemoryStore()
    let n = 0
    const newId = () => `id-${++n}`
    const bus = new CommandBus(store, { log: { append: () => {} }, context: { newId, randomSeed: () => 5, now: () => '2026-01-01T00:00:00Z' } })
    const root = createRootUniverse(store, 'U')
    const cluster = bus.execute({ type: 'node.create', payload: { parentId: root.id, kind: 'galaxy_cluster' } }).targetId!
    const generatedGalaxy = clusterGalaxies(store.nodes.get(cluster)!.seed)[0]!
    const galaxyClaim = claimGenerated({ id: cluster, kind: 'galaxy_cluster' }, generatedGalaxy, newId)
    expect(bus.execute(galaxyClaim.command).targetId).toBe(galaxyClaim.id)
    const galaxy = store.nodes.get(galaxyClaim.id)!
    expect(galaxy).toMatchObject({ kind: 'galaxy', seed: generatedGalaxy.seed, name: generatedGalaxy.name, position: { x: generatedGalaxy.x, y: generatedGalaxy.y, z: 0 } })
    const star = cellStars(galaxyShape(galaxy.seed), galaxy.seed, 0, 0)[0]!
    const starClaim = claimGenerated({ id: galaxy.id, kind: 'galaxy' }, star, newId)
    bus.execute(starClaim.command)
    const system = store.nodes.get(starClaim.id)!
    const records = () => ({ stars: store.records('star').all(), orbits: store.records('orbit').all() })
    const model = systemModel(store.nodes.all(), records(), system.id)
    expect(model.star.massSun).toBeCloseTo(star.massSun, 2)

    // A rocky planet with its world: the orbit it had while generated, and its seed's surface.
    const rocky = generatedPlanets(system, model.star).find((p) => !p.giant) ?? generatedPlanets(system, model.star)[0]!
    const planetClaim = claimPlanet(system.id, rocky, true, newId)
    expect(bus.execute(planetClaim.command).targetId).toBe(planetClaim.id)
    const nodesNow = store.nodes.all()
    const claimed = systemModel(nodesNow, records(), system.id).bodies.get(planetClaim.id)!
    expect(claimed.semiMajorAxisKm).toBeCloseTo(rocky.orbit.semiMajorAxisKm, 0)
    expect(claimed.periodS).toBeCloseTo(rocky.orbit.periodS, 0)
    expect(nodesNow.find((x) => x.parentId === planetClaim.id)?.kind).toBe('world')
    expect(unclaimedPlanets(systemModel(nodesNow, records(), system.id), system, nodesNow).map((g) => g.seed)).not.toContain(rocky.seed)
  })
})

describe('calendars', () => {
  it('an Earth-like world gets the Earth calendar exactly', () => {
    const d = deriveCalendar(system(), 'earth')
    expect(d.calendar).toEqual(DEFAULT_CALENDAR)
    expect(d.monthDays).toBeCloseTo(29.53, 1)
    expect(d.yearDays).toBeCloseTo(365.26, 1)
  })

  it('follow the day, the year and the moon', () => {
    const s = system([orbit('earth', { semiMajorAxisKm: AU_KM * 1.5, rotationHours: 30, monthNames: null })])
    const d = deriveCalendar(s, 'earth')
    expect(d.dayHours).toBeCloseTo(30, 0)
    const days = d.calendar.months.reduce((n, m) => n + m.days, 0)
    expect(days).toBe(Math.round(d.yearDays))
    expect(d.calendar.months.length).toBe(Math.round(days / d.monthDays!))
  })

  it('is the Earth calendar until the world’s orbit is set', () => {
    expect(worldCalendar(nodes, system([]), 'w')).toBe(DEFAULT_CALENDAR)
    expect(worldCalendar(nodes, system([orbit('earth', { rotationHours: 30 })]), 'w').secondsPerDay).not.toBe(86400)
  })
})

describe('moons', () => {
  it('go round their phases once a synodic month', () => {
    const s = system()
    const moon = s.bodies.get('moon')!
    const events = skyEvents(s, 'earth', 0, 365.25 * DAY_S)
    const news = events.filter((e) => e.kind === 'new-moon')
    expect(news.length).toBeGreaterThanOrEqual(12)
    expect(news.length).toBeLessThanOrEqual(13)
    // Single months vary with the orbits' eccentricity; on average they're 29.53 days.
    expect((news.at(-1)!.at - news[0]!.at) / (news.length - 1) / DAY_S).toBeCloseTo(29.5, 0)
    expect(moonPhase(s, moon, news[0]!.at).illumination).toBeLessThan(0.001)
    const full = events.find((e) => e.kind === 'full-moon')!
    expect(moonPhase(s, moon, full.at).name).toBe('Full moon')
  })

  it('cause a few eclipses a year with a tilted orbit, and one every month without', () => {
    const tilted = skyEvents(system(), 'earth', 0, 10 * 365.25 * DAY_S).filter((e) => e.kind.endsWith('eclipse'))
    expect(tilted.length / 10).toBeGreaterThan(1)
    expect(tilted.length / 10).toBeLessThan(8)
    const flat = system([earthOrbit, orbit('moon', { ...MOON_ORBIT, inclinationDeg: 0 })])
    const every = skyEvents(flat, 'earth', 0, 365.25 * DAY_S)
    expect(every.filter((e) => e.kind === 'solar-eclipse').length).toBe(every.filter((e) => e.kind === 'new-moon').length)
  })
})

describe('climate', () => {
  it('Earth is the reference; farther out is colder, more tilt flattens the poles', () => {
    expect(worldClimate(system(), 'earth').offsetC).toBeCloseTo(0, 5)
    expect(worldClimate(system(), 'earth').gradient).toBeCloseTo(1, 5)
    const mars = worldClimate(system([orbit('earth', { semiMajorAxisKm: 1.52 * AU_KM })]), 'earth')
    expect(mars.offsetC).toBeLessThan(-40)
    expect(mars.inHabitableZone).toBe(false)
    expect(worldClimate(system([orbit('earth', { axialTiltDeg: 60 })]), 'earth').gradient).toBeLessThan(0.6)
    // A moon's world shares its planet's distance from the star.
    expect(worldClimate(system(), 'moon').distanceAu).toBeCloseTo(1, 5)
  })
})

describe('weathering', async () => {
  const { TerrainModel, generateBase } = await import('@universe/procgen')
  const { DEFAULT_WORLD_SETTINGS } = await import('@universe/core')
  const { exposureAt } = await import('./index')
  const settings = { ...DEFAULT_WORLD_SETTINGS, terrain: { ...DEFAULT_WORLD_SETTINGS.terrain } }
  const model = new TerrainModel(settings, generateBase(3, settings.terrain))
  it('freezes and thaws at mid latitudes, stays hot at the equator, and every value is 0–1', () => {
    const polar = exposureAt(model, undefined, 70, 10)
    const equator = exposureAt(model, undefined, 0, 10)
    expect(equator.heat).toBeGreaterThan(polar.heat)
    for (const v of [...Object.values(polar), ...Object.values(equator)]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
