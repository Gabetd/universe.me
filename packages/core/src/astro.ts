import { z } from 'zod'
import { RecordMeta } from './schema'

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
  monthNames: z.array(z.string().min(1).max(40)).nullable()
})
export type Orbit = z.infer<typeof Orbit>

export const AU_KM = 149_597_870.7
