import { z } from 'zod'
import { RecordMeta } from './schema'
import { EARTH_RADIUS_KM } from './world'

/**
 * Stars and orbits (PLAN.md §4.1, §7). Both are optional records: a star
 * system without a `star` record has a Sun-like star, and a body without an
 * `orbit` record gets plausible seeded defaults (packages/sim). Editing either
 * in the inspector stores one, and from then on the body's calendar and
 * climate follow it.
 */

/** The star of a star system (`ownerId` is the system). */
export const Star = z.object({
  ...RecordMeta,
  /** Solar masses. */
  massSun: z.number().min(0.08).max(150),
  /** Solar luminosities; null: worked out from the mass (main sequence). */
  luminositySun: z.number().positive().max(1e7).nullable()
})
export type Star = z.infer<typeof Star>

/** A body's orbit around its parent (the star, or the planet for a moon), and its spin. `ownerId` is the body. */
export const Orbit = z.object({
  ...RecordMeta,
  semiMajorAxisKm: z.number().positive(),
  eccentricity: z.number().min(0).max(0.95),
  inclinationDeg: z.number().min(0).max(180),
  /** Where along its orbit the body is at year 0, in degrees (mean anomaly). */
  phaseDeg: z.number(),
  /** One turn relative to the stars, in hours. */
  rotationHours: z.number().positive(),
  axialTiltDeg: z.number().min(0).max(180),
  /** Earth masses. */
  massEarth: z.number().positive(),
  /** Used when the body has no world (whose own radius wins). */
  radiusKm: z.number().positive(),
  /** Month names for the calendar of a world on this body; null for generated ones. */
  monthNames: z.array(z.string().min(1).max(40)).nullable(),
  /** Whether its mass follows its size (by `massOfRadius`), as it does unless it's been unlinked (false): then `massEarth` is its own. */
  massFollowsSize: z.boolean().optional()
})
export type Orbit = z.infer<typeof Orbit>

/** The slopes of radius against mass for rocky planets and Neptune-like ones (Chen & Kipping 2017), and where the one ends and the other begins: 2 Earth masses, about 1.2 Earth radii. */
const ROCKY = 0.279
const NEPTUNIAN = 0.589
const ROCKY_MASS = 2
const ROCKY_RADIUS = ROCKY_MASS ** ROCKY

/** A planet's mass (Earth masses) for its radius, as planets go: rocky up to about 1.2 Earth radii, then Neptune-like and on to the giants. */
export function massOfRadius(radiusKm: number): number {
  const r = radiusKm / EARTH_RADIUS_KM
  return r <= ROCKY_RADIUS ? r ** (1 / ROCKY) : ROCKY_MASS * (r / ROCKY_RADIUS) ** (1 / NEPTUNIAN)
}

/** A planet's radius (km) for its mass: the inverse of `massOfRadius`. */
export function radiusOfMass(massEarth: number): number {
  return EARTH_RADIUS_KM * (massEarth <= ROCKY_MASS ? massEarth ** ROCKY : ROCKY_RADIUS * (massEarth / ROCKY_MASS) ** NEPTUNIAN)
}

export const AU_KM = 149_597_870.7
