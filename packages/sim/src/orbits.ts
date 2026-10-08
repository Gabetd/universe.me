import { AU_KM, orbitId, starId, type Orbit, type OrbitFields, type SpatialNode, type Star } from '@universe/core'
import { rng, subSeed } from '@universe/procgen'
import { GM_EARTH, GM_SUN, starInfo, type StarInfo } from './star'

/**
 * Orbits (PLAN.md §7): Keplerian two-body motion of each body around its
 * parent, the star or a planet. Bodies without a stored orbit get defaults
 * from their seed: a planet with a world starts out Earth-like, a moon
 * Moon-like, the rest spread out the way planets usually are.
 */

export interface BodyOrbit extends OrbitFields {
  bodyId: string
  /** The body it goes round; null for the star. */
  parentBodyId: string | null
  /** Gravitational parameter of what it orbits, km³/s². */
  centralGM: number
  /** Orbital period in seconds. */
  periodS: number
  /** No orbit stored: these are the defaults. */
  isDefault: boolean
}

export const DAY_S = 86_400
const RAD = Math.PI / 180

export const EARTH_ORBIT: OrbitFields = {
  semiMajorAxisKm: AU_KM,
  eccentricity: 0.0167,
  inclinationDeg: 0,
  phaseDeg: 0,
  rotationHours: 23.9345,
  axialTiltDeg: 23.44,
  massEarth: 1,
  radiusKm: 6371,
  monthNames: null
}

export const MOON_ORBIT: OrbitFields = {
  semiMajorAxisKm: 384_400,
  eccentricity: 0.0549,
  inclinationDeg: 5.145,
  phaseDeg: 0,
  rotationHours: 655.7,
  axialTiltDeg: 6.68,
  massEarth: 0.0123,
  radiusKm: 1737,
  monthNames: null
}

/** Everything about one star system the simulation needs. */
export interface SystemModel {
  systemId: string
  star: StarInfo
  /** Every body in the system, planets and moons. */
  bodies: Map<string, BodyOrbit>
}

interface Records {
  stars: Star[]
  orbits: Orbit[]
}

const childBodies = (nodes: SpatialNode[], parentId: string) => nodes.filter((n) => n.parentId === parentId && n.kind === 'body')
const hasWorld = (nodes: SpatialNode[], bodyId: string) => nodes.some((n) => n.parentId === bodyId && n.kind === 'world')

/** The star system a node is in (itself, or an ancestor), if any. */
export function systemIdOf(nodes: SpatialNode[], nodeId: string): string | undefined {
  let node = nodes.find((n) => n.id === nodeId)
  while (node && node.kind !== 'star_system') node = nodes.find((n) => n.id === node!.parentId)
  return node?.id
}

/** Defaults for a body without a stored orbit. */
function defaultOrbit(body: SpatialNode, index: number, isMoon: boolean, withWorld: boolean): OrbitFields {
  const r = rng(subSeed(body.seed, 0x0b17))
  const phaseDeg = r() * 360
  if (isMoon) return { ...MOON_ORBIT, semiMajorAxisKm: MOON_ORBIT.semiMajorAxisKm * 1.6 ** index, phaseDeg }
  if (withWorld) return { ...EARTH_ORBIT, semiMajorAxisKm: AU_KM * (1 + 0.12 * index), phaseDeg }
  // Roughly where planets sit (0.4, 0.7, 1.0, 1.6, 2.8, 5.2… AU): small rocky ones inside, giants outside.
  const au = index === 0 ? 0.4 : 0.4 + 0.3 * 2 ** (index - 1)
  const giant = au > 2.5
  const massEarth = giant ? 15 + r() * 300 : 0.06 + r() * 1.8
  return {
    semiMajorAxisKm: au * AU_KM,
    eccentricity: r() * 0.09,
    inclinationDeg: r() * 3,
    phaseDeg,
    rotationHours: giant ? 9 + r() * 8 : 15 + r() * 40,
    axialTiltDeg: r() * 30,
    massEarth,
    radiusKm: giant ? 6371 * massEarth ** 0.5 * 1.9 : 6371 * massEarth ** 0.28,
    monthNames: null
  }
}

/** Builds the system model: the star and every body's orbit, stored or default. */
export function systemModel(nodes: SpatialNode[], records: Records, systemId: string): SystemModel {
  const star = starInfo(records.stars.find((s) => s.id === starId(systemId) && !s.deletedAt))
  const bodies = new Map<string, BodyOrbit>()
  const visit = (parentId: string, parentBody: BodyOrbit | null) => {
    childBodies(nodes, parentId).forEach((body, index) => {
      const stored = records.orbits.find((o) => o.id === orbitId(body.id) && !o.deletedAt)
      const fields = stored ?? defaultOrbit(body, index, !!parentBody, hasWorld(nodes, body.id))
      // Two bodies go round their common centre: the period depends on both masses.
      const centralGM = parentBody ? GM_EARTH * (parentBody.massEarth + fields.massEarth) : GM_SUN * star.massSun + GM_EARTH * fields.massEarth
      const orbit: BodyOrbit = {
        ...pickFields(fields),
        bodyId: body.id,
        parentBodyId: parentBody?.bodyId ?? null,
        centralGM,
        periodS: 2 * Math.PI * Math.sqrt(fields.semiMajorAxisKm ** 3 / centralGM),
        isDefault: !stored
      }
      bodies.set(body.id, orbit)
      visit(body.id, orbit)
    })
  }
  visit(systemId, null)
  return { systemId, star, bodies }
}

function pickFields(o: OrbitFields): OrbitFields {
  const { semiMajorAxisKm, eccentricity, inclinationDeg, phaseDeg, rotationHours, axialTiltDeg, massEarth, radiusKm, monthNames } = o
  return { semiMajorAxisKm, eccentricity, inclinationDeg, phaseDeg, rotationHours, axialTiltDeg, massEarth, radiusKm, monthNames }
}

/** Solves Kepler's equation M = E − e·sin E for the eccentric anomaly. */
export function eccentricAnomaly(meanAnomaly: number, e: number): number {
  let E = e < 0.8 ? meanAnomaly : Math.PI
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E))
    E -= d
    if (Math.abs(d) < 1e-12) break
  }
  return E
}

export type Vec3 = [number, number, number]

/** Where a body is at `t` (seconds), in km from what it orbits: x, y in the orbital reference plane, z out of it. */
export function orbitPosition(o: BodyOrbit, t: number): Vec3 {
  const M = o.phaseDeg * RAD + (2 * Math.PI * t) / o.periodS
  const E = eccentricAnomaly(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), o.eccentricity)
  const a = o.semiMajorAxisKm
  const x = a * (Math.cos(E) - o.eccentricity)
  const y = a * Math.sqrt(1 - o.eccentricity ** 2) * Math.sin(E)
  const inc = o.inclinationDeg * RAD
  return [x, y * Math.cos(inc), y * Math.sin(inc)]
}

/** Where a body is relative to the star at `t`: its own orbit plus its parents'. */
export function positionFromStar(system: SystemModel, bodyId: string, t: number): Vec3 {
  const out: Vec3 = [0, 0, 0]
  let o = system.bodies.get(bodyId)
  while (o) {
    const p = orbitPosition(o, t)
    out[0] += p[0]
    out[1] += p[1]
    out[2] += p[2]
    o = o.parentBodyId ? system.bodies.get(o.parentBodyId) : undefined
  }
  return out
}

/** The planet a body is, or orbits: the one going round the star. */
export function planetOf(system: SystemModel, bodyId: string): BodyOrbit | undefined {
  let o = system.bodies.get(bodyId)
  while (o?.parentBodyId) o = system.bodies.get(o.parentBodyId)
  return o
}

/** The moons of a body, nearest first. */
export const moonsOf = (system: SystemModel, bodyId: string) =>
  [...system.bodies.values()].filter((o) => o.parentBodyId === bodyId).sort((a, b) => a.semiMajorAxisKm - b.semiMajorAxisKm)

/** Points around a body's orbit, for drawing it. */
export function orbitPath(o: BodyOrbit, points = 96): Vec3[] {
  return Array.from({ length: points + 1 }, (_, k) => orbitPosition({ ...o, phaseDeg: 0 }, (o.periodS * k) / points))
}
