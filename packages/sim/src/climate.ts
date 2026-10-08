import { AU_KM, type SpatialNode } from '@universe/core'
import { RAD, clamp } from '@universe/procgen'
import { EARTH_ORBIT, planetOf, worldOrbit, type SystemModel } from './orbits'

/**
 * A world's climate from its star and orbit (PLAN.md §7), as numbers the
 * biome rules use: how much warmer or colder than Earth it is on average,
 * how strongly temperature falls toward the poles (axial tilt spreads the
 * star's warmth out), and how big the seasons are. Earth gives 0, 1 and
 * Earth's seasons, so a world nobody has edited looks as it always did.
 */

export interface WorldClimate {
  /** Average surface temperature, °C. */
  meanTempC: number
  /** Degrees warmer than Earth. */
  offsetC: number
  /** Multiplies the equator-to-pole temperature drop (1 = Earth). */
  gradient: number
  /** Typical summer-to-winter swing at mid latitudes, °C. */
  seasonalSwingC: number
  /** Star-to-planet distance, AU. */
  distanceAu: number
  inHabitableZone: boolean
}

const EARTH_TILT = 23.44
/** Earth's greenhouse warming, K; every world gets the same until atmospheres exist. */
const GREENHOUSE_K = 33
const ALBEDO = 0.3

export function worldClimate(system: SystemModel, bodyId: string): WorldClimate {
  const body = system.bodies.get(bodyId)!
  const planet = planetOf(system, bodyId)!
  const distanceAu = planet.semiMajorAxisKm / AU_KM
  const L = system.star.luminositySun
  const meanTempC = surfaceTempC(L, distanceAu, planet.eccentricity)
  // Tilts beyond 90° spin backwards but warm the same as their mirror.
  const tilt = body.axialTiltDeg > 90 ? 180 - body.axialTiltDeg : body.axialTiltDeg
  const gradient = clamp(1 - (tilt - EARTH_TILT) / 70, 0.3, 1.35)
  const seasonalSwingC = 12 * (Math.sin(tilt * RAD) / Math.sin(EARTH_TILT * RAD)) + 40 * planet.eccentricity
  const [inner, outer] = system.star.habitableAu
  return { meanTempC, offsetC: meanTempC - EARTH_MEAN_C, gradient, seasonalSwingC, distanceAu, inHabitableZone: distanceAu >= inner && distanceAu <= outer }
}

/** Average surface temperature, °C, for a star's luminosity and a distance. */
function surfaceTempC(luminositySun: number, distanceAu: number, eccentricity: number): number {
  // Averaged over an eccentric orbit a planet gets a little more light: (1 − e²)^−½ in flux.
  const flux = luminositySun / distanceAu ** 2 / Math.sqrt(1 - eccentricity ** 2)
  return 278.6 * flux ** 0.25 * (1 - ALBEDO) ** 0.25 + GREENHOUSE_K - 273.15
}

const EARTH_MEAN_C = surfaceTempC(1, 1, EARTH_ORBIT.eccentricity)

/** A world's climate, once the orbit of the body it's on has been set; undefined keeps it Earth-like. */
export function worldClimateOf(nodes: SpatialNode[], system: SystemModel | undefined, worldId: string): WorldClimate | undefined {
  const body = worldOrbit(nodes, system, worldId)
  return body && worldClimate(system!, body.bodyId)
}
