import { z } from 'zod'

/**
 * Time on a world's timeline (PLAN.md §4.3): seconds from the world's epoch
 * (year 0), negative for the past before it. Stored as a float64: whole
 * seconds are exact within ±285 million years, and deep-time events (billions
 * of years) keep far more precision than their dates could ever have.
 */
export const Time = z.number().finite()
export type Time = number

/** How precisely a date is known; controls how it's written ("1204", "c. 1200", "13th century"). */
export const Precision = z.enum(['exact', 'day', 'year', 'century', 'approx'])
export type Precision = z.infer<typeof Precision>
export const PRECISIONS = Precision.options

export interface Calendar {
  secondsPerDay: number
  months: { name: string; days: number }[]
}

/**
 * Earth-like calendar without leap days, used until M4 derives calendars from
 * a world's rotation and orbit. Year 0 exists (astronomical numbering).
 */
export const DEFAULT_CALENDAR: Calendar = {
  secondsPerDay: 86400,
  months: [
    ['Jan', 31], ['Feb', 28], ['Mar', 31], ['Apr', 30], ['May', 31], ['Jun', 30],
    ['Jul', 31], ['Aug', 31], ['Sep', 30], ['Oct', 31], ['Nov', 30], ['Dec', 31]
  ].map(([name, days]) => ({ name: name as string, days: days as number }))
}

export const daysPerYear = (cal: Calendar) => cal.months.reduce((n, m) => n + m.days, 0)
export const secondsPerYear = (cal: Calendar) => daysPerYear(cal) * cal.secondsPerDay

export interface DateParts {
  year: number
  /** 0-based. */
  month: number
  /** 1-based. */
  day: number
  hour: number
  minute: number
  second: number
}

export function toParts(t: Time, cal: Calendar = DEFAULT_CALENDAR): DateParts {
  const yearLen = secondsPerYear(cal)
  const year = Math.floor(t / yearLen)
  let rest = t - year * yearLen
  let dayOfYear = Math.floor(rest / cal.secondsPerDay)
  rest -= dayOfYear * cal.secondsPerDay
  let month = 0
  while (month < cal.months.length - 1 && dayOfYear >= cal.months[month]!.days) dayOfYear -= cal.months[month++]!.days
  const hour = Math.floor(rest / 3600)
  const minute = Math.floor((rest - hour * 3600) / 60)
  const second = Math.floor(rest - hour * 3600 - minute * 60)
  return { year, month, day: dayOfYear + 1, hour, minute, second }
}

export function fromParts(p: Partial<DateParts> & { year: number }, cal: Calendar = DEFAULT_CALENDAR): Time {
  let days = 0
  for (let m = 0; m < (p.month ?? 0); m++) days += cal.months[m]!.days
  days += (p.day ?? 1) - 1
  return p.year * secondsPerYear(cal) + days * cal.secondsPerDay + (p.hour ?? 0) * 3600 + (p.minute ?? 0) * 60 + (p.second ?? 0)
}

/** "1204", "−3,000", "4.5 billion": years written for people, with a real minus sign. */
export function formatYear(year: number): string {
  const sign = year < 0 ? '−' : ''
  const a = Math.abs(year)
  if (a >= 1e9) return `${sign}${round3(a / 1e9)} billion`
  if (a >= 1e6) return `${sign}${round3(a / 1e6)} million`
  if (a >= 1e4) return sign + Math.round(a).toLocaleString('en-US')
  return sign + String(Math.round(a))
}

const round3 = (v: number) => String(Number(v.toPrecision(3)))
const pad = (n: number) => String(n).padStart(2, '0')

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

export function formatTime(t: Time, precision: Precision = 'exact', cal: Calendar = DEFAULT_CALENDAR): string {
  const p = toParts(t, cal)
  const month = cal.months[p.month]!.name
  switch (precision) {
    case 'exact':
      return `${p.day} ${month} ${formatYear(p.year)}, ${pad(p.hour)}:${pad(p.minute)}`
    case 'day':
      return `${p.day} ${month} ${formatYear(p.year)}`
    case 'year':
      return formatYear(p.year)
    case 'century': {
      // Year 0–99 is the 1st century; −1 to −100 is the 1st century before year 0.
      const c = p.year >= 0 ? Math.floor(p.year / 100) + 1 : Math.floor((-p.year - 1) / 100) + 1
      return `${ordinal(c)} century${p.year < 0 ? ' before 0' : ''}`
    }
    case 'approx':
      return `c. ${formatYear(Number(p.year.toPrecision(Math.abs(p.year) >= 100 ? 2 : 1)))}`
  }
}

/** A short human duration: "3 days", "1.5 years", "2.3 million years". */
export function formatDuration(seconds: number, cal: Calendar = DEFAULT_CALENDAR): string {
  const s = Math.abs(seconds)
  const year = secondsPerYear(cal)
  const units: [number, string][] = [
    [year, 'year'],
    [cal.secondsPerDay, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second']
  ]
  for (const [size, name] of units) {
    if (s >= size || size === 1) {
      const v = s / size
      const text = size === year && v >= 1e4 ? formatYear(v) : round3(v)
      return `${text} ${name}${text === '1' ? '' : 's'}`
    }
  }
  return '0 seconds'
}

const SCALE_WORDS: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }

/**
 * Reads a date the way people type one, including everything formatTime
 * writes: "1204", "-3000", "1204-03-15", "1204-03-15 14:30", "15 Mar 1204",
 * "15 Mar 1204, 14:30", "Mar 1204", "c. 1200" or "~1200" (approximate),
 * "12th century", "4.5 billion", "-2.5k". Returns undefined if it isn't a date.
 */
export function parseTime(input: string, cal: Calendar = DEFAULT_CALENDAR): { t: Time; precision: Precision } | undefined {
  let text = input.trim().toLowerCase().replace(/−/g, '-').replace(/,/g, '')
  let approx = false
  const approxMatch = /^(c\.?|ca\.?|circa|~)\s*/.exec(text)
  if (approxMatch) {
    approx = true
    text = text.slice(approxMatch[0].length)
  }

  const century = /^(-?)(\d+)(st|nd|rd|th) century( before 0)?$/.exec(text)
  if (century) {
    const n = Number(century[2])
    const before = century[1] === '-' || !!century[4]
    // A century starts at its earliest year: the 13th at 1200, the 1st before 0 at −100.
    if (n >= 1) return { t: fromParts({ year: before ? -n * 100 : (n - 1) * 100 }, cal), precision: 'century' }
  }

  const date = /^(-?\d+)-(\d{1,2})(?:-(\d{1,2}))?(?:[ t](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (date) {
    const [, y, mo, d, h, mi, s] = date
    const month = Number(mo) - 1
    const day = d ? Number(d) : 1
    if (month < 0 || month >= cal.months.length || day < 1 || day > cal.months[month]!.days) return undefined
    const t = fromParts({ year: Number(y), month, day, hour: Number(h ?? 0), minute: Number(mi ?? 0), second: Number(s ?? 0) }, cal)
    return { t, precision: approx ? 'approx' : h ? 'exact' : 'day' }
  }

  const named = /^(?:(\d{1,2}) )?([a-z]+)\.? (-?\d+)(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (named) {
    const [, d, name, y, h, mi, s] = named
    const month = cal.months.findIndex((m) => name!.startsWith(m.name.toLowerCase().slice(0, 3)))
    const day = d ? Number(d) : 1
    if (month !== -1 && day >= 1 && day <= cal.months[month]!.days) {
      const t = fromParts({ year: Number(y), month, day, hour: Number(h ?? 0), minute: Number(mi ?? 0), second: Number(s ?? 0) }, cal)
      return { t, precision: approx ? 'approx' : h ? 'exact' : 'day' }
    }
  }

  const year = /^(-?\d+(?:\.\d+)?(?:e\d+)?)\s*(k|thousand|m|million|b|billion)?(?:\s*years?)?(\s+ago)?$/.exec(text)
  if (year) {
    let value = Number(year[1]) * (year[2] ? SCALE_WORDS[year[2]]! : 1)
    if (year[3]) value = -value
    if (!Number.isFinite(value)) return undefined
    const whole = Number.isInteger(value)
    return { t: fromParts({ year: Math.round(value) }, cal), precision: approx || !whole || Math.abs(value) >= 1e5 ? 'approx' : 'year' }
  }
  return undefined
}

export interface Tick {
  t: Time
  label: string
  /** Major ticks get a label and a full-height grid line. */
  major: boolean
}

/** Tick steps from seconds to billions of years; years go 1-2-5 up the decades. */
function tickSteps(cal: Calendar): { size: number; unit: 'second' | 'day' | 'month' | 'year' }[] {
  const day = cal.secondsPerDay
  const steps: { size: number; unit: 'second' | 'day' | 'month' | 'year' }[] = [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600].map(
    (size) => ({ size, unit: 'second' as const })
  )
  steps.push({ size: day, unit: 'day' }, { size: 7 * day, unit: 'day' })
  steps.push({ size: 1, unit: 'month' }, { size: 3, unit: 'month' })
  for (let e = 0; e <= 10; e++) for (const m of [1, 2, 5]) steps.push({ size: m * 10 ** e, unit: 'year' })
  return steps
}

/**
 * Ticks for a ruler showing [t0, t1] across `widthPx`, spaced at least
 * `minSpacingPx` apart, on calendar boundaries (midnights, month starts, round years).
 */
export function timeTicks(t0: Time, t1: Time, widthPx: number, cal: Calendar = DEFAULT_CALENDAR, minSpacingPx = 90): Tick[] {
  const span = t1 - t0
  if (!(span > 0) || widthPx <= 0) return []
  const secondsPerPx = span / widthPx
  const year = secondsPerYear(cal)
  const monthAvg = year / cal.months.length
  const sizeOf = (s: { size: number; unit: string }) => (s.unit === 'year' ? s.size * year : s.unit === 'month' ? s.size * monthAvg : s.size)
  const step = tickSteps(cal).find((s) => sizeOf(s) / secondsPerPx >= minSpacingPx) ?? { size: 1e10, unit: 'year' as const }
  const ticks: Tick[] = []
  const push = (t: Time, label: string) => ticks.push({ t, label, major: true })

  if (step.unit === 'year') {
    const first = Math.ceil(Math.floor(t0 / year) / step.size) * step.size
    for (let y = first; y * year <= t1 && ticks.length < 500; y += step.size) push(y * year, formatYear(y))
  } else if (step.unit === 'month') {
    const p = toParts(t0, cal)
    let y = p.year
    let m = Math.ceil(p.month / step.size) * step.size
    for (;;) {
      if (m >= cal.months.length) {
        y++
        m = 0
      }
      const t = fromParts({ year: y, month: m }, cal)
      if (t > t1 || ticks.length >= 500) break
      if (t >= t0) push(t, m === 0 ? formatYear(y) : `${cal.months[m]!.name} ${formatYear(y)}`)
      m += step.size
    }
  } else {
    // Seconds and days are uniform, so step from a multiple of the step size.
    const size = step.size
    for (let t = Math.ceil(t0 / size) * size; t <= t1 && ticks.length < 500; t += size) {
      const p = toParts(t, cal)
      const label =
        size >= cal.secondsPerDay || (p.hour === 0 && p.minute === 0)
          ? `${p.day} ${cal.months[p.month]!.name} ${formatYear(p.year)}`
          : `${pad(p.hour)}:${pad(p.minute)}${size < 60 ? `:${pad(p.second)}` : ''}`
      push(t, label)
    }
  }
  return ticks
}
