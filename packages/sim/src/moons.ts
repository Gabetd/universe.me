import { TAU, wrapTau } from '@universe/procgen'
import { SUN_RADIUS_KM } from './star'
import { moonsOf, orbitPosition, planetOf, positionFromStar, synodicS, type BodyOrbit, type SystemModel } from './orbits'

/**
 * Moon phases and eclipses (PLAN.md §7): phases from the angle between the
 * star and the moon as seen from the planet; eclipses when a new or full
 * moon happens close enough to the plane of the planet's orbit for the
 * shadows to fall.
 */

const PHASE_NAMES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'] as const
type PhaseName = (typeof PHASE_NAMES)[number]

export interface MoonPhase {
  /** Angle from the star to the moon seen from the planet, 0–2π: 0 new, π full. */
  elongation: number
  /** Lit fraction of the disc, 0–1. */
  illumination: number
  name: PhaseName
}

function elongationAt(system: SystemModel, moon: BodyOrbit, t: number): number {
  const planet = positionFromStar(system, moon.parentBodyId!, t)
  const m = orbitPosition(moon, t)
  const sun = Math.atan2(-planet[1], -planet[0])
  return wrapTau(Math.atan2(m[1], m[0]) - sun)
}

export function moonPhase(system: SystemModel, moon: BodyOrbit, t: number): MoonPhase {
  const elongation = elongationAt(system, moon, t)
  return { elongation, illumination: (1 - Math.cos(elongation)) / 2, name: PHASE_NAMES[Math.round(elongation / (TAU / 8)) % 8]! }
}

type SkyEventKind = 'new-moon' | 'full-moon' | 'solar-eclipse' | 'lunar-eclipse'

export interface SkyEvent {
  at: number
  kind: SkyEventKind
  moonId: string
  /** Eclipses: how much of it. */
  extent?: 'total' | 'annular' | 'partial'
}

/** Phases a moon's elongation might fall short of its average count by, as eccentric orbits speed up and slow down. */
const PHASE_SLACK = 8

/**
 * New and full moons of every moon of a planet between t0 and t1, and the
 * eclipses among them. If there would be `limit` or more, returns none
 * (zoomed far out there would be millions); a moon with more than `limit`
 * months in the span is left out.
 */
export function skyEvents(system: SystemModel, planetId: string, t0: number, t1: number, limit = 4000): SkyEvent[] {
  const planet = system.bodies.get(planetId)
  const sunPlanet = planetOf(system, planetId)
  if (!planet || !sunPlanet) return []
  const moons = moonsOf(system, planetId)
    .map((moon) => ({ moon, synodic: synodicS(moon, sunPlanet.periodS) }))
    .filter(({ synodic }) => Number.isFinite(synodic) && (t1 - t0) / synodic <= limit)
  // A moon is new and full about twice a synodic month: when even the fewest phases there could be reach the limit, don't work them out.
  const fewest = moons.reduce((n, { synodic }) => n + Math.max(0, Math.floor((2 * (t1 - t0)) / synodic) - PHASE_SLACK), 0)
  if (fewest >= limit) return []
  const out: SkyEvent[] = []
  for (const { moon, synodic } of moons) {
    const step = synodic / 16
    // The unwrapped elongation keeps growing; each multiple of π is a new or full moon.
    const unwrap = (t: number, prev: number) => {
      let e = elongationAt(system, moon, t)
      while (e < prev - Math.PI) e += TAU
      while (e > prev + Math.PI) e -= TAU
      return e
    }
    let t = t0
    let e = elongationAt(system, moon, t)
    while (t < t1) {
      const tn = Math.min(t1, t + step)
      const en = unwrap(tn, e)
      const k = Math.floor(e / Math.PI)
      const kn = Math.floor(en / Math.PI)
      if (kn !== k) {
        const target = Math.max(k, kn) * Math.PI
        const at = crossing((x) => unwrap(x, e) - target, t, e - target, tn, en - target)
        const full = Math.round(target / Math.PI) % 2 !== 0
        out.push({ at, kind: full ? 'full-moon' : 'new-moon', moonId: moon.bodyId })
        const eclipse = eclipseAt(system, planet, moon, at, full)
        if (eclipse) out.push({ at, kind: full ? 'lunar-eclipse' : 'solar-eclipse', moonId: moon.bodyId, extent: eclipse })
        if (out.length >= limit) return []
      }
      t = tn
      e = en
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * When `f` crosses zero between `lo` and `hi`, where it has the values `flo`
 * and `fhi` of opposite signs, to within a second: secant steps, which get
 * there in a few tries on a smooth curve, falling back to halving the
 * interval when a step would leave it.
 */
function crossing(f: (t: number) => number, lo: number, flo: number, hi: number, fhi: number): number {
  let [a, fa, b, fb] = [lo, flo, hi, fhi]
  for (let i = 0; i < 40; i++) {
    let x = b - (fb * (b - a)) / (fb - fa)
    if (!(x > lo && x < hi)) x = (lo + hi) / 2
    const fx = f(x)
    if (fx < 0 === flo < 0) [lo, flo] = [x, fx]
    else hi = x
    if (Math.abs(x - b) < 1 || hi - lo < 1) return x
    ;[a, fa, b, fb] = [b, fb, x, fx]
  }
  return (lo + hi) / 2
}

/** Whether the new (or full) moon at `t` eclipses the star (or is eclipsed), and how much. */
function eclipseAt(system: SystemModel, planet: BodyOrbit, moon: BodyOrbit, t: number, full: boolean): SkyEvent['extent'] | undefined {
  const sunDist = Math.hypot(...positionFromStar(system, planet.bodyId, t))
  const m = orbitPosition(moon, t)
  const moonDist = Math.hypot(...m)
  const rSun = SUN_RADIUS_KM * system.star.radiusSun
  const rPlanet = planet.radiusKm
  const rMoon = moon.radiusKm
  // How far the moon passes from the line through the star and the planet.
  const offset = Math.abs(m[2])
  if (!full) {
    const sunAngular = rSun / sunDist
    const penumbra = rPlanet + rMoon + moonDist * sunAngular
    if (offset > penumbra) return undefined
    const umbra = rPlanet + rMoon - moonDist * sunAngular
    if (offset > umbra) return 'partial'
    return rMoon / (moonDist - rPlanet) >= sunAngular ? 'total' : 'annular'
  }
  const umbra = rPlanet - (moonDist * (rSun - rPlanet)) / sunDist
  if (offset > umbra + rMoon) return undefined
  return offset < umbra - rMoon ? 'total' : 'partial'
}
