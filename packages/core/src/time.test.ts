import { describe, expect, it } from 'vitest'
import { DEFAULT_CALENDAR, formatDuration, formatTime, fromParts, parseTime, secondsPerYear, timeTicks, toParts } from './time'

const YEAR = secondsPerYear(DEFAULT_CALENDAR)

describe('calendar math', () => {
  it('round-trips dates, including before year 0', () => {
    for (const parts of [
      { year: 1204, month: 2, day: 15, hour: 14, minute: 30, second: 5 },
      { year: -3000, month: 11, day: 31, hour: 23, minute: 59, second: 59 },
      { year: 0, month: 0, day: 1, hour: 0, minute: 0, second: 0 }
    ]) {
      expect(toParts(fromParts(parts))).toEqual(parts)
    }
  })

  it('formats by precision', () => {
    const t = fromParts({ year: 1204, month: 2, day: 15, hour: 9, minute: 5 })
    expect(formatTime(t, 'exact')).toBe('15 Mar 1204, 09:05')
    expect(formatTime(t, 'day')).toBe('15 Mar 1204')
    expect(formatTime(t, 'year')).toBe('1204')
    expect(formatTime(t, 'century')).toBe('13th century')
    expect(formatTime(t, 'approx')).toBe('c. 1200')
    expect(formatTime(fromParts({ year: -50 }), 'century')).toBe('1st century before 0')
    expect(formatTime(-4.5e9 * YEAR, 'year')).toBe('−4.5 billion')
  })

  it('formats durations', () => {
    expect(formatDuration(3 * 86400)).toBe('3 days')
    expect(formatDuration(YEAR)).toBe('1 year')
    expect(formatDuration(2.3e6 * YEAR)).toBe('2.3 million years')
  })
})

describe('parseTime', () => {
  it.each([
    ['1204', { year: 1204 }, 'year'],
    ['-3000', { year: -3000 }, 'year'],
    ['−3,000', { year: -3000 }, 'year'],
    ['1204-03-15', { year: 1204, month: 2, day: 15 }, 'day'],
    ['1204-03-15 14:30', { year: 1204, month: 2, day: 15, hour: 14, minute: 30 }, 'exact'],
    ['c. 1200', { year: 1200 }, 'approx'],
    ['~1200', { year: 1200 }, 'approx'],
    ['13th century', { year: 1200 }, 'century'],
    ['1st century before 0', { year: -100 }, 'century'],
    ['4.5 billion years ago', { year: -4.5e9 }, 'approx'],
    ['-2.5k', { year: -2500 }, 'year']
  ])('reads %s', (input, parts, precision) => {
    expect(parseTime(input)).toEqual({ t: fromParts(parts), precision })
  })

  it('rejects things that are not dates', () => {
    for (const input of ['', 'soon', '1204-13-01', '1204-02-30']) expect(parseTime(input)).toBeUndefined()
  })

  it('round-trips what it formats', () => {
    expect(parseTime(formatTime(fromParts({ year: 1204 }), 'year'))!.t).toBe(fromParts({ year: 1204 }))
    expect(parseTime(formatTime(fromParts({ year: 1200 }), 'century'))!.t).toBe(fromParts({ year: 1200 }))
    expect(parseTime(formatTime(fromParts({ year: -4.5e9 }), 'year'))!.t).toBe(fromParts({ year: -4.5e9 }))
    expect(parseTime(formatTime(fromParts({ year: 1200 }), 'approx'))!.t).toBe(fromParts({ year: 1200 }))
  })
})

describe('timeTicks', () => {
  it('picks round years for a century-wide view', () => {
    const ticks = timeTicks(1200 * YEAR, 1300 * YEAR, 1000)
    expect(ticks.map((t) => t.label)).toEqual(['1200', '1210', '1220', '1230', '1240', '1250', '1260', '1270', '1280', '1290', '1300'])
  })

  it('uses months, days and hours when zoomed in', () => {
    expect(timeTicks(fromParts({ year: 1204 }), fromParts({ year: 1205 }), 1200)[1]!.label).toBe('Feb 1204')
    expect(timeTicks(0, 86400, 1000)[1]!.label).toBe('03:00')
  })

  it('reaches billions of years', () => {
    const ticks = timeTicks(-5e9 * YEAR, 0, 800)
    expect(ticks[0]!.label).toBe('−5 billion')
    expect(ticks.length).toBeGreaterThan(3)
  })
})
