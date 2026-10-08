import { z } from 'zod'
import { greatCircleKm } from './geo'
import { Id, RecordMeta } from './schema'
import { DEFAULT_CALENDAR, Time, secondsPerYear } from './time'
import { HexColor, type LatLon } from './world'

/**
 * Characters on a world: a lifespan and a journey. Each stop is where they
 * arrive, and when; they spend `travel` seconds before that on the way from
 * the stop before, and stay put in between.
 */
export const CharacterStop = z.object({
  at: Time,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Seconds on the road before arriving (0: they're simply there from `at`). */
  travel: z.number().min(0),
  /** The event this stop takes them to, if any. */
  eventId: Id.nullable()
})
export type CharacterStop = z.infer<typeof CharacterStop>

export const Character = z.object({
  ...RecordMeta,
  name: z.string().min(1).max(200),
  born: Time,
  /** null: still alive at the end of the timeline. */
  died: Time.nullable(),
  color: HexColor,
  notes: z.string(),
  tags: z.array(z.string()),
  /** In time order; the first is where they're born (or first seen). */
  stops: z.array(CharacterStop)
})
export type Character = z.infer<typeof Character>

/** Where a character is at one moment. */
export interface CharacterPlace extends LatLon {
  /** On the road between two stops. */
  travelling: boolean
  /** The stop they're at, or heading to. */
  stop: number
}

/** How far a walker gets in a day, for default travel times. */
export const WALK_KM_PER_DAY = 30
const DAY = DEFAULT_CALENDAR.secondsPerDay

/** Seconds to walk between two points. */
export function walkingTime(a: LatLon, b: LatLon, radiusKm: number): number {
  return Math.round(greatCircleKm(a, b, radiusKm) / WALK_KM_PER_DAY) * DAY
}

export const isAlive = (c: Pick<Character, 'born' | 'died'>, t: Time) => t >= c.born && (c.died === null || t <= c.died)

/** Age in whole years at `t` (or at death, if `t` is later). */
export function ageAt(c: Pick<Character, 'born' | 'died'>, t: Time): number {
  const until = c.died === null ? t : Math.min(t, c.died)
  return Math.max(0, Math.floor((until - c.born) / secondsPerYear(DEFAULT_CALENDAR)))
}

/** Where the character is at `t`, or undefined while they aren't alive (or have nowhere to be). */
export function characterAt(c: Character, t: Time): CharacterPlace | undefined {
  if (!isAlive(c, t) || c.stops.length === 0) return undefined
  const stops = c.stops
  // Before the first stop they're at it already: it's their birthplace.
  let i = 0
  while (i + 1 < stops.length && stops[i + 1]!.at <= t) i++
  const next = stops[i + 1]
  if (next && t < next.at && t > next.at - next.travel) {
    const from = stops[i]!
    const leave = Math.max(from.at, next.at - next.travel)
    const f = (t - leave) / (next.at - leave)
    return { ...slerpLatLon(from, next, f), travelling: true, stop: i + 1 }
  }
  return { lat: stops[i]!.lat, lon: stops[i]!.lon, travelling: false, stop: i }
}

/** Keeps stops in time order (stable for equal times). */
export const sortStops = (stops: CharacterStop[]) => [...stops].sort((a, b) => a.at - b.at)

const RAD = Math.PI / 180

/** The point a fraction `f` of the way along the great circle from `a` to `b`. */
export function slerpLatLon(a: LatLon, b: LatLon, f: number): LatLon {
  const v = (p: LatLon) => [Math.cos(p.lat * RAD) * Math.cos(p.lon * RAD), Math.cos(p.lat * RAD) * Math.sin(p.lon * RAD), Math.sin(p.lat * RAD)]
  const [p, q] = [v(a), v(b)]
  const dot = Math.min(1, Math.max(-1, p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!))
  const angle = Math.acos(dot)
  if (angle < 1e-9) return { lat: a.lat, lon: a.lon }
  const s = Math.sin(angle)
  const wa = Math.sin((1 - f) * angle) / s
  const wb = Math.sin(f * angle) / s
  const [x, y, z] = [0, 1, 2].map((k) => p[k]! * wa + q[k]! * wb) as [number, number, number]
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD }
}
