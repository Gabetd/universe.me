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

const TAU = Math.PI * 2

function elongationAt(system: SystemModel, moon: BodyOrbit, t: number): number {
  const planet = positionFromStar(system, moon.parentBodyId!, t)
  const m = orbitPosition(moon, t)
  const sun = Math.atan2(-planet[1], -planet[0])
  const e = Math.atan2(m[1], m[0]) - sun
  return ((e % TAU) + TAU) % TAU
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

/**
 * New and full moons of every moon of a planet between t0 and t1, and the
 * eclipses among them. Stops after `limit` events (zoomed far out there
 * would be millions).
 */
export function skyEvents(system: SystemModel, planetId: string, t0: number, t1: number, limit = 4000): SkyEvent[] {
  const planet = system.bodies.get(planetId)
  const sunPlanet = planetOf(system, planetId)
  if (!planet || !sunPlanet) return []
  const out: SkyEvent[] = []
  for (const moon of moonsOf(system, planetId)) {
    const synodic = synodicS(moon, sunPlanet.periodS)
    if (!Number.isFinite(synodic) || (t1 - t0) / synodic > limit) continue
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
    while (t < t1 && out.length < limit) {
      const tn = Math.min(t1, t + step)
      const en = unwrap(tn, e)
      const k = Math.floor(e / Math.PI)
      const kn = Math.floor(en / Math.PI)
      if (kn !== k) {
        const target = Math.max(k, kn) * Math.PI
        // Bisect for the moment the elongation reaches the target.
        let lo = t
        let hi = tn
        let elo = e
        for (let i = 0; i < 40 && hi - lo > 30; i++) {
          const mid = (lo + hi) / 2
          const em = unwrap(mid, elo)
          if (em < target === elo < target) [lo, elo] = [mid, em]
          else hi = mid
        }
        const at = (lo + hi) / 2
        const full = Math.round(target / Math.PI) % 2 !== 0
        out.push({ at, kind: full ? 'full-moon' : 'new-moon', moonId: moon.bodyId })
        const eclipse = eclipseAt(system, planet, moon, at, full)
        if (eclipse) out.push({ at, kind: full ? 'lunar-eclipse' : 'solar-eclipse', moonId: moon.bodyId, extent: eclipse })
      }
      t = tn
      e = en
    }
  }
  return out.sort((a, b) => a.at - b.at)
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
