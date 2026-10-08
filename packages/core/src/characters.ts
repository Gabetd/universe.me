import { z } from 'zod'
import { greatCircleKm, slerpLatLon } from './geo'
import { Id, RecordMeta } from './schema'
import { DEFAULT_CALENDAR, Time, secondsPerYear, type Calendar } from './time'
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

/** Age in whole years of the world's calendar at `t` (or at death, if `t` is later). */
export function ageAt(c: Pick<Character, 'born' | 'died'>, t: Time, cal: Calendar = DEFAULT_CALENDAR): number {
  const until = c.died === null ? t : Math.min(t, c.died)
  return Math.max(0, Math.floor((until - c.born) / secondsPerYear(cal)))
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
