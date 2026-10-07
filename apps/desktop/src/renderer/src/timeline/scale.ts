import { DEFAULT_CALENDAR, secondsPerYear } from '@universe/core'

/** A visible time range [t0, t1] on the timeline. */
export interface TimeRange {
  t0: number
  t1: number
}

const YEAR = secondsPerYear(DEFAULT_CALENDAR)
/** Zoom limits: a minute across the screen, up to 30 billion years. */
const MIN_SPAN = 60
const MAX_SPAN = 3e10 * YEAR

/** Maps between time and x pixels for a range drawn across `width` pixels. */
export class TimeScale {
  constructor(
    readonly range: TimeRange,
    readonly width: number
  ) {}

  get secondsPerPx(): number {
    return (this.range.t1 - this.range.t0) / Math.max(1, this.width)
  }

  x(t: number): number {
    return (t - this.range.t0) / this.secondsPerPx
  }

  t(x: number): number {
    return this.range.t0 + x * this.secondsPerPx
  }
}

/** Zooms by `factor` (< 1 zooms in) keeping time `at` under the same pixel. */
export function zoomRange(range: TimeRange, at: number, factor: number): TimeRange {
  const span = range.t1 - range.t0
  const next = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span * factor))
  const k = next / span
  return { t0: at - (at - range.t0) * k, t1: at + (range.t1 - at) * k }
}

export const panRange = (range: TimeRange, dt: number): TimeRange => ({ t0: range.t0 + dt, t1: range.t1 + dt })

/** A range showing [start, end] with some margin; a single moment gets a century around it. */
export function fitRange(start: number, end: number): TimeRange {
  const span = Math.max(end - start, 100 * YEAR)
  const mid = (start + end) / 2
  return { t0: mid - span * 0.6, t1: mid + span * 0.6 }
}

const SNAP_UNITS = [1, 60, 3600, 86400, YEAR, 10 * YEAR, 100 * YEAR, 1000 * YEAR, 1e4 * YEAR, 1e5 * YEAR, 1e6 * YEAR, 1e7 * YEAR, 1e8 * YEAR, 1e9 * YEAR]

/** Rounds a dragged time to a calendar unit worth a few pixels at this zoom, so drags land on round dates. */
export function snap(t: number, secondsPerPx: number): number {
  const unit = [...SNAP_UNITS].reverse().find((u) => u <= secondsPerPx * 6) ?? 1
  return Math.round(t / unit) * unit
}
