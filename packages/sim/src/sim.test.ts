import { AU_KM, DEFAULT_CALENDAR, orbitId, type Orbit, type SpatialNode } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { DAY_S, EARTH_ORBIT, MOON_ORBIT, deriveCalendar, luminosityOf, moonPhase, orbitPosition, skyEvents, starInfo, systemModel, worldCalendar, worldClimate } from './index'

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
