import { DEFAULT_CALENDAR, type Calendar, type SpatialNode } from '@universe/core'
import { isTidallyLocked, moonsOf, planetOf, synodicS, worldOrbit, type SystemModel } from './orbits'

/**
 * Calendars from the sky (PLAN.md §4.3): a day is one turn relative to the
 * star, a year one orbit, and months follow the largest moon. Days are
 * rounded to the minute and years to whole days, as calendars do, so an
 * Earth-like world gets exactly the Earth calendar back.
 */

interface DerivedCalendar {
  calendar: Calendar
  /** Unrounded, for showing: days in a year, hours in a day, days from new moon to new moon. */
  yearDays: number
  dayHours: number
  monthDays: number | null
  /** The day is as long as the year: one side always faces the star. */
  tidallyLocked: boolean
}

/** Seconds from noon to noon: one turn relative to the star, not the stars. */
function solarDayS(rotationHours: number, yearS: number): number {
  const sidereal = rotationHours * 3600
  if (isTidallyLocked(sidereal, yearS)) return yearS
  return 1 / (1 / sidereal - 1 / yearS)
}

const EARTH_MONTHS = DEFAULT_CALENDAR.months.map((m) => m.name)

/** The calendar of a world on `bodyId` (a planet, or a moon, which then counts days and years as it goes round). */
export function deriveCalendar(system: SystemModel, bodyId: string): DerivedCalendar {
  const body = system.bodies.get(bodyId)!
  const planet = planetOf(system, bodyId)!
  const yearS = planet.periodS
  const dayS = Math.round(solarDayS(body.rotationHours, body.parentBodyId ? body.periodS : yearS) / 60) * 60
  const days = Math.max(1, Math.round(yearS / dayS))
  // A moon's world counts months by its planet's other moons, if any; a planet by its largest moon.
  const moon = moonsOf(system, bodyId).sort((a, b) => b.massEarth - a.massEarth)[0]
  const monthDays = moon ? synodicS(moon, yearS) / dayS : null
  const count = Math.min(24, Math.max(1, monthDays && monthDays < days ? Math.round(days / monthDays) : days >= 120 ? 12 : Math.round(days / 30) || 1))
  const names = body.monthNames?.length === count ? body.monthNames : count === 12 ? EARTH_MONTHS : Array.from({ length: count }, (_, k) => `Month ${k + 1}`)
  const months =
    count === 12 && days === 365
      ? DEFAULT_CALENDAR.months.map((m, k) => ({ name: names[k]!, days: m.days }))
      : spread(days, count).map((d, k) => ({ name: names[k]!, days: d }))
  return {
    calendar: { secondsPerDay: dayS, months },
    yearDays: yearS / dayS,
    dayHours: dayS / 3600,
    monthDays,
    tidallyLocked: isTidallyLocked(dayS, yearS)
  }
}

/** `total` days split into `count` months as evenly as possible, the longer ones spread through the year. */
function spread(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  const extra = total - base * count
  return Array.from({ length: count }, (_, k) => base + (Math.floor(((k + 1) * extra) / count) - Math.floor((k * extra) / count)))
}

/**
 * The calendar a world's timeline uses: derived from its body once that
 * body's orbit has been set, otherwise the Earth calendar.
 */
export function worldCalendar(nodes: SpatialNode[], system: SystemModel | undefined, worldId: string): Calendar {
  const body = worldOrbit(nodes, system, worldId)
  return body ? deriveCalendar(system!, body.bodyId).calendar : DEFAULT_CALENDAR
}
