import { z } from 'zod'
import { Id, Notes, RecordMeta } from './schema'
import { Time } from './time'
import { LatLon } from './world'

/**
 * Scars on the land (PLAN.md §9, M25): what's been done to a world's ground
 * and how long it lasts. A blast leaves a crater; war pocks and churns the
 * land and kills its woods; fire burns them to black stumps; drought parches
 * it; radiation and poison leave it sickly and dead. A scar is at a point,
 * reaching `radiusKm` around it, or over a region; it comes at `start`, lasts
 * to `end` (or for good) and then heals over `recoverYears` (0: never). Made
 * by an event, it says so (`eventId`), and it damages the structures it
 * reaches as the event happens.
 */

export const SCAR_KINDS = ['crater', 'war', 'burned', 'drought', 'irradiated', 'poisoned'] as const
export const ScarKind = z.enum(SCAR_KINDS)
export type ScarKind = z.infer<typeof ScarKind>

/** How each kind of scar looks and lasts, and what it does to the land, its plants and what's built on it. */
export interface ScarLook {
  label: string
  icon: string
  /** What it's drawn in on the maps (its ring), and what the ground it covers turns toward (RGB 0–255). */
  color: string
  ground: readonly [number, number, number]
  /** How far the ground turns toward that, at its heart, 0–1. */
  tint: number
  /** The share of trees, bushes and grass it kills, 0–1, and the share of the dead trees left standing as bare trunks. */
  kills: number
  snags: number
  /** Condition points it takes from what's built at its heart as it comes (100 destroys). */
  damage: number
  /** A new one's size and how long it takes to heal, unless told otherwise. */
  radiusKm: number
  recoverYears: number
  /** Whether it lasts a while (war, drought) or comes in a moment (a blast). */
  lasting: boolean
}

export const SCAR_LOOKS: Record<ScarKind, ScarLook> = {
  crater: { label: 'Crater', icon: '💥', color: '#c46a2c', ground: [104, 96, 88], tint: 0.85, kills: 1, snags: 0.15, damage: 100, radiusKm: 0.5, recoverYears: 0, lasting: false },
  war: { label: 'War-torn', icon: '⚔️', color: '#a33b32', ground: [92, 78, 62], tint: 0.7, kills: 0.75, snags: 0.7, damage: 45, radiusKm: 4, recoverYears: 40, lasting: true },
  burned: { label: 'Burned', icon: '🔥', color: '#5a4a40', ground: [40, 36, 33], tint: 0.85, kills: 0.95, snags: 0.75, damage: 55, radiusKm: 3, recoverYears: 25, lasting: false },
  drought: { label: 'Drought', icon: '☀️', color: '#c9a043', ground: [196, 172, 118], tint: 0.6, kills: 0.4, snags: 0.35, damage: 0, radiusKm: 30, recoverYears: 3, lasting: true },
  irradiated: { label: 'Irradiated', icon: '☢️', color: '#9db53a', ground: [150, 160, 66], tint: 0.6, kills: 0.8, snags: 0.85, damage: 0, radiusKm: 6, recoverYears: 300, lasting: true },
  poisoned: { label: 'Poisoned', icon: '☠️', color: '#7d4f86', ground: [96, 72, 90], tint: 0.65, kills: 0.9, snags: 0.5, damage: 0, radiusKm: 2, recoverYears: 80, lasting: true }
}

export const Scar = z.object({
  ...RecordMeta,
  name: z.string().max(200),
  kind: ScarKind,
  /** Its middle (a region's scar too: where it's listed and labelled). */
  ...LatLon.shape,
  radiusKm: z.number().positive().max(20_000),
  /** Over a region of its world instead of a circle. */
  regionId: Id.nullable(),
  /** The event that made it, if one did. */
  eventId: Id.nullable(),
  start: Time,
  /** When it stops getting worse (null: it never does, and never heals). */
  end: Time.nullable(),
  /** Years it takes to heal after its end (0: never). */
  recoverYears: z.number().min(0).max(10_000_000),
  /** How bad it is, 0–1 (a crater's depth, the share of plants killed, the colour). */
  strength: z.number().min(0).max(1),
  notes: Notes
})
export type Scar = z.infer<typeof Scar>

const ease = (w: number) => w * w * (3 - 2 * w)

/**
 * How much of a scar there is at `t`, 0–1 (times its strength): none before
 * it comes, all of it until its end, then less and less as it heals over its
 * recovery (`secondsPerYear` long years), eased.
 */
export function scarWeight(scar: Pick<Scar, 'start' | 'end' | 'recoverYears' | 'strength'>, t: Time, secondsPerYear: number): number {
  if (t < scar.start) return 0
  if (scar.end === null || t <= scar.end || scar.recoverYears <= 0) return scar.strength
  const healed = (t - scar.end) / (scar.recoverYears * secondsPerYear)
  return healed >= 1 ? 0 : scar.strength * ease(1 - healed)
}

/** How much of a scar reaches a point `x` of its radius from its middle, 0–1: all of it over its heart (seven tenths of the way out), none past its edge. */
export function scarReach(x: number): number {
  if (x >= 1) return 0
  if (x <= 0.7) return 1
  return ease((1 - x) / 0.3)
}

/** A scar's weight rounded to sixteenths: the land is drawn again only as often as that changes, not every frame of a playing timeline. */
export const scarStep = (w: number) => Math.round(w * 16) / 16

/** What a scar is called where it has no name: its kind. */
export const scarName = (scar: Pick<Scar, 'name' | 'kind'>) => scar.name || SCAR_LOOKS[scar.kind].label
