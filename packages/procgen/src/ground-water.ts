import { TERRAIN_RES, type LatLon } from '@universe/core'
import { dirToFace, latLonToDir, toGrid, type FacePoint, type Vec3 } from './cubesphere'
import type { BaseSampler } from './ground'
import { mouthFlow, planetCell, type Lake, type River } from './hydrology'
import { RAD, clamp, smoothstep, wrapLon } from './math'

/**
 * Rivers and lakes on the ground up close (PLAN.md §5.2): the land is shaped
 * around them, so a river runs in a valley it has cut, over falls where the
 * land drops steeply, and a lake lies in a basin with a shore.
 *
 * A river's course is worked out from the globe's river (cell to cell),
 * curved and then cut into points some 60 m apart, each with the water's
 * surface there. In gentle land the surface follows the land's; in steep land
 * it steps down, a pool then a fall, so its rivers come down mountains in
 * waterfalls. Everything about a stretch depends only on that stretch, so a
 * course worked out for one view meets the one worked out for the next.
 */

/** How far apart a course's points are, at most, in metres. */
const COURSE_STEP_M = 60
/** Pieces a river is curved into between two of its globe cells, before they're cut to COURSE_STEP_M. */
const BENDS = 32
/** How far a fall drops, in metres: a river steps down by this much at a time where the land is steep. */
export const FALL_M = 14
/** How steep the land must be (rise over run) for a river to step down in falls rather than run down rapids. */
const STEEP = [0.004, 0.014] as const
/** How far out from its banks a river's levees reach, where the land around is lower than its water. */
const LEVEE_M = 120
/** How far a river's valley reaches to either side of its banks, and how steeply its sides rise (rise over run). */
const VALLEY_M = 500
const VALLEY_SLOPE = 0.28
/** How far around a lake its shore is raised to keep its water in, in metres. */
export const SHORE_M = 900
/** How far a river's water sheet reaches past its banks, in metres: under the land as it rises from the water, so the water's edge follows the land. */
export const RIVER_SHEET_PAST_M = 10

/** A river's width on the ground, in metres: a stream sixty or so, the greatest some three hundred. */
export const riverMetres = (r: River) => Math.min(320, 40 + 55 * Math.log2(1 + mouthFlow(r)))

/**
 * A path (of points in any number of dimensions) drawn as a curve through
 * each of its points (Catmull-Rom, `steps` pieces between each two), so a
 * river that steps from cell to cell bends instead, and still passes through
 * the cells where its tributaries join it.
 */
export function smoothPath<P extends number[]>(path: P[], steps = 4): P[] {
  if (path.length < 3) return path
  const out: P[] = []
  for (let k = 0; k < path.length - 1; k++) {
    const [p0, p1, p2, p3] = [path[Math.max(0, k - 1)]!, path[k]!, path[k + 1]!, path[Math.min(path.length - 1, k + 2)]!]
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      const [t2, t3] = [t * t, t * t * t]
      out.push(p1.map((v, d) => 0.5 * (2 * v + (-p0[d]! + p2[d]!) * t + (2 * p0[d]! - 5 * v + 4 * p2[d]! - p3[d]!) * t2 + (-p0[d]! + 3 * v - 3 * p2[d]! + p3[d]!) * t3)) as P)
    }
  }
  out.push(path.at(-1)!)
  return out
}

/** A river as the ground has it: points from upstream down, each `[lat, lon, level]` (its water's surface, metres above sea level). */
export interface WaterCourse {
  points: number[][]
  halfWidth: number
}

/** A lake as the ground has it: its surface, and its cells (planet-wide numbers). */
export interface LakeBasin {
  level: number
  cells: number[]
}

/** The rivers and lakes around a stretch of ground. */
export interface GroundWaters {
  courses: WaterCourse[]
  lakes: LakeBasin[]
}

const metresPerDeg = (radiusKm: number) => radiusKm * 1000 * RAD

/** How far below the land around it a river runs, at least: it has cut its way down. */
const ENTRENCHED_M = 3

/** The water's surface at a point of a river where the land under it is `land` high and falls `drop` metres per metre: following it, below it by what it has cut, or in steep land a step below that. */
function waterLevel(land: number, drop: number): number {
  const steep = smoothstep(STEEP[0], STEEP[1], drop)
  const cut = land - ENTRENCHED_M
  const stepped = Math.floor(cut / FALL_M) * FALL_M
  return Math.max(0.3, cut + (stepped - cut) * steep)
}

/**
 * The courses of the rivers that come within `reachM` of `center`, worked
 * out from the globe's terrain (`base`): each the stretch of its river there
 * (and two cells either side, so it bends as it does everywhere).
 */
export function riverCourses(rivers: readonly River[], base: BaseSampler, center: LatLon, reachM: number, radiusKm: number): WaterCourse[] {
  const m = metresPerDeg(radiusKm)
  const here = latLonToDir(center.lat, center.lon)
  const reach = Math.cos(reachM / (radiusKm * 1000))
  const dir: Vec3 = [0, 0, 0]
  const near = (p: LatLon) => {
    latLonToDir(p.lat, p.lon, dir)
    return dir[0] * here[0] + dir[1] * here[1] + dir[2] * here[2] > reach
  }
  const courses: WaterCourse[] = []
  for (const river of rivers) {
    const first = river.points.findIndex(near)
    if (first < 0) continue
    const last = river.points.findLastIndex(near)
    const from = Math.max(0, first - 2)
    // Longitudes unwrapped along the river, so one crossing the date line curves the short way.
    const stretch: number[][] = []
    for (const p of river.points.slice(from, last + 3)) {
      const prev = stretch.at(-1)
      stretch.push([p.lat, prev ? prev[1]! + wrapLon(p.lon - prev[1]!) : p.lon])
    }
    const curve = smoothPath(stretch, BENDS)
    // The land's height along the river, and how fast it falls there (over 400 m either way along it).
    const landAt = (lat: number, lon: number) => base.elevation(lat, wrapLon(lon))
    const points: number[][] = []
    const add = (lat: number, lon: number, level: number) => {
      const last = points.at(-1)
      if (!last || last[0] !== lat || last[1] !== wrapLon(lon) || last[2] !== level) points.push([lat, wrapLon(lon), level])
    }
    let before: { lat: number; lon: number; level: number } | undefined
    for (let k = 0; k < curve.length; k++) {
      const [lat, lon] = curve[k] as [number, number]
      const [nLat, nLon] = (curve[Math.min(curve.length - 1, k + 1)] ?? curve[k]) as [number, number]
      const [pLat, pLon] = (curve[Math.max(0, k - 1)] ?? curve[k]) as [number, number]
      const along = Math.hypot((nLat - pLat) * m, (nLon - pLon) * m * Math.cos(lat * RAD)) || 1
      const [uLat, uLon] = [(nLat - pLat) / along, (nLon - pLon) / along]
      const levelAt = (la: number, lo: number) => waterLevel(landAt(la, lo), (landAt(la - uLat * 400, lo - uLon * 400) - landAt(la + uLat * 400, lo + uLon * 400)) / 800)
      const level = levelAt(lat, lon)
      if (before) {
        // Cut into steps short enough to follow the land, and where the water steps down, a fall: the same point twice, above and below.
        const span = Math.hypot((lat - before.lat) * m, (lon - before.lon) * m * Math.cos(lat * RAD))
        // The curve can pass the same place twice (where the river's own points do): nothing to add.
        if (span < 0.01) continue
        const n = Math.max(1, Math.ceil(span / COURSE_STEP_M))
        let prev = before.level
        for (let i = 1; i <= n; i++) {
          const t = i / n
          const [la, lo] = [before.lat + (lat - before.lat) * t, before.lon + (lon - before.lon) * t]
          const lv = i === n ? level : levelAt(la, lo)
          if (prev - lv > FALL_M * 0.5) {
            // Where between the two it drops: halved down to a metre or so.
            let [a, b] = [(i - 1) / n, t]
            for (let s = 0; s < 6; s++) {
              const mid = (a + b) / 2
              if (prev - levelAt(before.lat + (lat - before.lat) * mid, before.lon + (lon - before.lon) * mid) > FALL_M * 0.5) b = mid
              else a = mid
            }
            const [fLat, fLon] = [before.lat + (lat - before.lat) * b, before.lon + (lon - before.lon) * b]
            add(fLat, fLon, prev)
            add(fLat, fLon, lv)
          }
          add(la, lo, lv)
          prev = lv
        }
      } else add(lat, lon, level)
      before = { lat, lon, level }
    }
    courses.push({ points, halfWidth: riverMetres(river) / 2 })
  }
  return courses
}

/** The lakes with a cell within `reachM` of `center`. */
export function lakeBasins(lakes: readonly Lake[], center: LatLon, reachM: number, radiusKm: number, place: (cell: number) => LatLon): LakeBasin[] {
  const here = latLonToDir(center.lat, center.lon)
  const reach = Math.cos((reachM + cellMetres(radiusKm)) / (radiusKm * 1000))
  return lakes.flatMap((lake) => {
    const near = lake.cells.some((g) => {
      const p = place(g)
      const d = latLonToDir(p.lat, p.lon)
      return d[0] * here[0] + d[1] * here[1] + d[2] * here[2] > reach
    })
    return near ? [{ level: lake.level, cells: lake.cells }] : []
  })
}

/** About how wide a globe cell is, in metres. */
const cellMetres = (radiusKm: number) => ((Math.PI / 2) * radiusKm * 1000) / TERRAIN_RES

/** A river's stretch from point a to point b, with what's needed to measure from it. */
interface Segment {
  lat0: number
  lon0: number
  lat1: number
  lon1: number
  level0: number
  level1: number
  halfWidth: number
}

/** What the water does to the land at a point (see `WaterShaper.shape`). */
export interface WaterTouch {
  /** The height there, with valleys cut, basins dug and shores raised. */
  y: number
  /** 0 to 1: under a river or a lake (1), or on its bank or shore. */
  wet: number
  /** Within this many metres of a river's bank or a lake's shore (Infinity when far from both). */
  shore: number
  /** The water's surface over it, where it's under a river or a lake (NaN elsewhere). */
  surface: number
}

/**
 * Shapes the land around rivers and lakes: finds the river nearest a point
 * (through a grid of 1 km buckets) and cuts its valley, and digs lake basins
 * with shores raised around them.
 */
export class WaterShaper {
  private buckets = new Map<string, Segment[]>()
  private lakeCells = new Map<number, number>()
  private bucketDeg: number
  private m: number
  private cellM: number
  private face: FacePoint = { face: 0, s: 0, t: 0 }
  private dir: Vec3 = [0, 0, 0]
  readonly touch: WaterTouch = { y: 0, wet: 0, shore: Infinity, surface: NaN }

  constructor(
    waters: GroundWaters,
    readonly radiusKm: number
  ) {
    this.m = metresPerDeg(radiusKm)
    this.bucketDeg = 1000 / this.m
    this.cellM = cellMetres(radiusKm)
    for (const course of waters.courses) {
      const reachDeg = (course.halfWidth + VALLEY_M) / this.m
      for (let k = 0; k < course.points.length - 1; k++) {
        const [lat0, lon0, level0] = course.points[k] as [number, number, number]
        const [lat1, lon1raw, level1] = course.points[k + 1] as [number, number, number]
        const lon1 = lon0 + wrapLon(lon1raw - lon0)
        const seg = { lat0, lon0, lat1, lon1, level0, level1, halfWidth: course.halfWidth }
        const cos = Math.max(0.02, Math.cos(lat0 * RAD))
        const [la0, la1] = [Math.min(lat0, lat1) - reachDeg, Math.max(lat0, lat1) + reachDeg]
        const [lo0, lo1] = [Math.min(lon0, lon1) - reachDeg / cos, Math.max(lon0, lon1) + reachDeg / cos]
        for (let i = Math.floor(la0 / this.bucketDeg); i <= Math.floor(la1 / this.bucketDeg); i++)
          for (let j = Math.floor(lo0 / this.bucketDeg); j <= Math.floor(lo1 / this.bucketDeg); j++) {
            const key = `${i}:${wrapBucket(j, this.bucketDeg)}`
            const list = this.buckets.get(key)
            if (list) list.push(seg)
            else this.buckets.set(key, [seg])
          }
      }
    }
    for (const lake of waters.lakes) for (const g of lake.cells) this.lakeCells.set(g, lake.level)
  }

  get empty(): boolean {
    return this.buckets.size === 0 && this.lakeCells.size === 0
  }

  /** The land at a point, `y` high before the water, shaped by the rivers and lakes near it; into `touch`. */
  shape(lat: number, lon: number, y: number): WaterTouch {
    const touch = this.touch
    touch.y = y
    touch.wet = 0
    touch.shore = Infinity
    touch.surface = NaN
    this.river(lat, lon, touch)
    if (this.lakeCells.size) this.lake(lat, lon, touch)
    return touch
  }

  private river(lat: number, lon: number, touch: WaterTouch): void {
    const list = this.buckets.get(`${Math.floor(lat / this.bucketDeg)}:${wrapBucket(Math.floor(lon / this.bucketDeg), this.bucketDeg)}`)
    if (!list) return
    const cos = Math.cos(lat * RAD)
    // The nearest stretch of river (past its banks), and its water's surface there.
    let best = Infinity
    let level = 0
    let half = 0
    for (const s of list) {
      const ax = wrapLon(s.lon0 - lon) * this.m * cos
      const az = (s.lat0 - lat) * this.m
      const bx = ax + (s.lon1 - s.lon0) * this.m * cos
      const bz = (s.lat1 - lat) * this.m
      const [dx, dz] = [bx - ax, bz - az]
      const len2 = dx * dx + dz * dz
      const t = len2 > 0 ? clamp(-(ax * dx + az * dz) / len2, 0, 1) : 0
      const d = Math.hypot(ax + dx * t, az + dz * t) - s.halfWidth
      if (d < best) {
        best = d
        level = s.level0 + (s.level1 - s.level0) * t
        half = s.halfWidth
      }
    }
    if (best >= VALLEY_M) return
    // Its bed, a little deeper in the middle of wider rivers, and its valley's sides rising from its banks.
    const bed = level - 1.2 - half * 0.015
    const out = Math.max(0, best)
    // The valley's sides steepen away from the river, so they meet whatever rises around it (mountains too) before the valley's edge.
    const valley = bed + 1.4 + out * VALLEY_SLOPE + out * out * 0.004
    let y = touch.y
    // Where the land around lies lower than the water, banks (levees) hold the river in.
    if (best < LEVEE_M) y += (Math.max(y, level + 0.5 + out * 0.05) - y) * smoothstep(LEVEE_M, LEVEE_M * 0.4, best)
    y = Math.min(y, valley)
    // Under the water and just past its banks the land is the bed and the bank, built up if it was lower.
    if (best < 12) y += (Math.min(bed + Math.max(0, best) * 0.15, valley) - y) * smoothstep(12, -2, best)
    touch.y = y
    touch.wet = Math.max(touch.wet, smoothstep(4, -2, best))
    touch.shore = Math.min(touch.shore, Math.max(0, best))
    if (best < RIVER_SHEET_PAST_M && y < level) touch.surface = level
  }

  private lake(lat: number, lon: number, touch: WaterTouch): void {
    latLonToDir(lat, lon, this.dir)
    const p = dirToFace(this.dir[0], this.dir[1], this.dir[2], this.face)
    const [gx, gy] = [toGrid(p.s), toGrid(p.t)]
    const [i0, j0] = [Math.floor(gx), Math.floor(gy)]
    const [fx, fy] = [gx - i0, gy - j0]
    // How much of a lake this is, from the four cells around it (1 in the middle of a lake cell, ½ on its edge), and the lake's surface.
    let inside = 0
    let level = NaN
    for (const [di, dj, w] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy]
    ] as const) {
      const [i, j] = [i0 + di, j0 + dj]
      if (i < 0 || j < 0 || i >= TERRAIN_RES || j >= TERRAIN_RES) continue
      const l = this.lakeCells.get(planetCell(p.face, j * TERRAIN_RES + i))
      if (l === undefined) continue
      inside += w
      level = Number.isNaN(level) ? l : Math.max(level, l)
    }
    if (Number.isNaN(level)) return
    // Metres in from the shore (out from it, below 0).
    const into = (inside - 0.5) * this.cellM
    if (into > 0) {
      touch.y = Math.min(touch.y, level - 1 - Math.min(40, into * 0.02))
      touch.wet = 1
      touch.shore = 0
      touch.surface = Number.isNaN(touch.surface) ? level : Math.max(touch.surface, level)
    } else if (-into < SHORE_M) {
      // Around it, the land rises from the water to keep it in, back to the land as it was.
      const shore = level + 0.6 - into * 0.012
      touch.y += (Math.max(touch.y, shore) - touch.y) * smoothstep(SHORE_M, SHORE_M * 0.6, -into)
      touch.shore = Math.min(touch.shore, -into)
    }
  }
}

/** A bucket's column, wrapped round the date line. */
function wrapBucket(j: number, deg: number): number {
  const n = Math.round(360 / deg)
  return ((j % n) + n) % n
}

/** How far a lake's water sheet reaches past its cells' edges where they meet land, in metres: well inside its raised shore. */
export const LAKE_SHEET_REACH = SHORE_M * 0.45

/** The extent of the river courses and lakes worth handing to a stretch of ground from lat0…lat1, lon0…lon1 (degrees). */
export function watersNear(waters: GroundWaters, bounds: { lat0: number; lat1: number; lon0: number; lon1: number }, radiusKm: number): GroundWaters {
  const pad = (VALLEY_M + 400) / metresPerDeg(radiusKm)
  const cos = Math.max(0.02, Math.cos(((bounds.lat0 + bounds.lat1) / 2) * RAD))
  const within = (lat: number, lon: number) =>
    lat >= bounds.lat0 - pad && lat <= bounds.lat1 + pad && Math.abs(wrapLon(lon - (bounds.lon0 + bounds.lon1) / 2)) <= (bounds.lon1 - bounds.lon0) / 2 + pad / cos
  const courses: WaterCourse[] = []
  for (const c of waters.courses) {
    const keep = c.points.map(([lat, lon]) => within(lat!, lon!))
    // Each run of points that passes near, with a point either side so every stretch near is whole.
    let run: number[][] = []
    c.points.forEach((point, k) => {
      if (keep[k] || keep[k - 1] || keep[k + 1]) run.push(point)
      else if (run.length) {
        if (run.length > 1) courses.push({ points: run, halfWidth: c.halfWidth })
        run = []
      }
    })
    if (run.length > 1) courses.push({ points: run, halfWidth: c.halfWidth })
  }
  return { courses, lakes: waters.lakes }
}
