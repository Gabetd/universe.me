import { CUBE_FACES, SCAR_LOOKS, TERRAIN_RES, polygonTester, scarReach, type LatLon, type ScarKind } from '@universe/core'
import { cellDirections, dirToLatLon, latLonToDir } from './cubesphere'
import { RAD, clamp01, smoothstep, wrapLon } from './math'

/**
 * What scars (core scars.ts) do to the land itself, as the views draw it:
 * a crater's bowl and its raised rim, the ground pocked by shells where war
 * was, and the colour the ground turns, the plants that die and the dead
 * trees left standing. Plain data in, so the same scar shapes the land alike
 * in the UI thread and in the workers that build the ground.
 */

/** A scar as the land is shaped by it at the moment shown. */
export interface LandScar {
  id: string
  kind: ScarKind
  lat: number
  lon: number
  radiusKm: number
  /** How much of it there is now, 0–1 (see `scarWeight`). */
  weight: number
  /** Over a region: its outline (`radiusKm` then reaches its farthest corner). */
  polygon?: LatLon[]
}

/** What the scars do at a point. */
export interface ScarTouch {
  /** Metres the ground is raised (a rim) or lowered (a bowl, a shell hole). */
  dh: number
  /** The colour the ground turns toward (RGB 0–255), and how far, 0–1. */
  rgb: [number, number, number]
  tint: number
  /** The share of the plants that die, and of dead trees left standing. */
  kills: number
  snags: number
}

/** A crater's depth as a share of its radius, and the deepest one, in metres. */
const CRATER_DEPTH = 0.22
const CRATER_DEEPEST_M = 1500
/** Its rim's height as a share of its depth, and its width as a share of its radius. */
const RIM = 0.16
const RIM_WIDTH = 0.2
/** Thrown-out earth reaches this many radii out, paler than the bowl. */
const EJECTA = 1.8
/** War's shell holes: one may lie in each square this many metres across, from 3 to 9 m across. */
const SHELL_CELL_M = 22

const hash = (a: number, b: number, c: number) => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const idSalt = (id: string) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return h
}

interface Prepared extends LandScar {
  salt: number
  metresPerDeg: number
  /** How far it reaches each way, in degrees: points beyond aren't looked at. */
  dLat: number
  dLon: number
  inside?: (p: LatLon) => boolean
}

/** Shapes the land by the scars at the moment shown. Asked about one point at a time, the answer kept until the next. */
export class ScarShaper {
  private scars: Prepared[]
  readonly touch: ScarTouch = { dh: 0, rgb: [0, 0, 0], tint: 0, kills: 0, snags: 0 }
  private last = { lat: NaN, lon: NaN }

  constructor(scars: readonly LandScar[], radiusKm: number) {
    const metresPerDeg = radiusKm * 1000 * RAD
    this.scars = scars
      .filter((s) => s.weight > 0)
      .map((s) => {
        // Craters throw earth out past their rims.
        const reachM = s.radiusKm * 1000 * (s.kind === 'crater' ? EJECTA : 1.15)
        const dLat = reachM / metresPerDeg
        return { ...s, salt: idSalt(s.id), metresPerDeg, dLat, dLon: dLat / Math.max(0.02, Math.cos(s.lat * RAD)), inside: s.polygon && polygonTester(s.polygon) }
      })
  }

  get any(): boolean {
    return this.scars.length > 0
  }

  /** Each scar's middle as a direction from the planet's centre, and the cosine of the angle it reaches out to: a point whose direction is farther off is untouched. */
  get reaches(): { dir: [number, number, number]; cos: number }[] {
    return this.scars.map((s) => ({ dir: latLonToDir(s.lat, s.lon), cos: Math.cos((Math.max(s.dLat, 1e-6) * Math.PI) / 180) }))
  }

  /**
   * What the scars do at a point (into `touch`). `ragged` (−1 to 1, varying
   * over a few hundred metres) frays their edges and patches their colour.
   */
  touchAt(lat: number, lon: number, ragged: number): ScarTouch {
    const t = this.touch
    if (lat === this.last.lat && lon === this.last.lon) return t
    const last = this.last
    last.lat = lat
    last.lon = lon
    t.dh = 0
    t.tint = 0
    t.kills = 0
    t.snags = 0
    for (const s of this.scars) {
      const dy = lat - s.lat
      const dx = wrapLon(lon - s.lon)
      if (Math.abs(dy) > s.dLat || Math.abs(dx) > s.dLon) continue
      const look = SCAR_LOOKS[s.kind]
      // How far out it is, in radii (over a region: inside or not), its edge frayed.
      const yM = dy * s.metresPerDeg
      const xM = dx * s.metresPerDeg * Math.cos(lat * RAD)
      const radiusM = s.radiusKm * 1000
      const x = s.inside ? (s.inside({ lat, lon }) ? 0.5 : 1) : Math.hypot(xM, yM) / radiusM
      const frayed = s.kind === 'crater' ? x : x * (1 + 0.14 * ragged)
      let reach = scarReach(frayed)
      if (s.kind === 'crater') {
        const depth = Math.min(radiusM * CRATER_DEPTH, CRATER_DEEPEST_M) * s.weight
        t.dh += (x < 1 ? -depth * (1 - x * x) : 0) + depth * RIM * Math.exp(-(((x - 1) / RIM_WIDTH) ** 2))
        // The bowl ashen, the earth thrown out around it paler and thinning out.
        reach = x < 1 ? 1 : smoothstep(EJECTA, 1, x) * 0.55
      }
      if (reach <= 0) continue
      // Patchy, not one flat colour: some ground hit harder than the rest.
      const k = clamp01(reach * s.weight * look.tint * (0.8 + 0.3 * ragged))
      this.mix(look.ground, k)
      const dies = reach * s.weight * look.kills
      t.snags = t.kills + dies > 0 ? (t.snags * t.kills + look.snags * dies) / (t.kills + dies) : 0
      t.kills = 1 - (1 - t.kills) * (1 - dies)
    }
    return t
  }

  /** Mixes another scar's colour in: what's there is kept in proportion to how much of it there is. */
  private mix(rgb: readonly number[], k: number): void {
    const t = this.touch
    if (k <= 0) return
    const share = k / (t.tint + k)
    for (let c = 0; c < 3; c++) t.rgb[c] = t.tint > 0 ? t.rgb[c]! + (rgb[c]! - t.rgb[c]!) * share : rgb[c]!
    t.tint = 1 - (1 - t.tint) * (1 - k)
  }

  /** Metres the ground is pocked down (and up, at their lips) by shell holes where war was: too small to see but up close. */
  pocks(lat: number, lon: number, ragged: number): number {
    let dh = 0
    for (const s of this.scars) {
      if (s.kind !== 'war') continue
      const dy = lat - s.lat
      const dx = wrapLon(lon - s.lon)
      if (Math.abs(dy) > s.dLat || Math.abs(dx) > s.dLon) continue
      const yM = dy * s.metresPerDeg
      const xM = dx * s.metresPerDeg * Math.cos(lat * RAD)
      const x = s.inside ? (s.inside({ lat, lon }) ? 0.5 : 1) : (Math.hypot(xM, yM) / (s.radiusKm * 1000)) * (1 + 0.14 * ragged)
      const reach = scarReach(x)
      if (reach > 0) dh += this.shellHoles(s, xM, yM, reach * s.weight)
    }
    return dh
  }

  /** Shell holes where war was: bowls of a few metres in some squares of SHELL_CELL_M, more where it was worst. */
  private shellHoles(s: Prepared, xM: number, yM: number, density: number): number {
    const ci = Math.floor(xM / SHELL_CELL_M)
    const cj = Math.floor(yM / SHELL_CELL_M)
    let dh = 0
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (hash(i, j, s.salt) > density * 0.55) continue
        const r = 1.5 + 3 * hash(i, j, s.salt + 1)
        const hx = (i + 0.2 + 0.6 * hash(i, j, s.salt + 2)) * SHELL_CELL_M
        const hy = (j + 0.2 + 0.6 * hash(i, j, s.salt + 3)) * SHELL_CELL_M
        const d = Math.hypot(xM - hx, yM - hy) / r
        if (d < 1) dh -= r * 0.45 * (1 - d * d)
        else if (d < 1.6) dh += r * 0.08 * (1 - (d - 1) / 0.6)
      }
    }
    return dh
  }
}

/** What the scars do to each cell of the globe: metres added (craters' bowls and rims) and the colour it turns toward (RGB 0–255 and how far, four values a cell), per face. */
export interface ScarField {
  height: Float32Array[]
  tint: Float32Array[]
}

/**
 * The scars on the globe's cells, worked out at each cell's middle as the
 * ground works them out (no fraying: a cell is kilometres across); undefined
 * where there are none. Only cells within reach of a scar are looked at.
 */
export function scarField(scars: readonly LandScar[], radiusKm: number): ScarField | undefined {
  const shaper = new ScarShaper(scars, radiusKm)
  if (!shaper.any) return undefined
  const reaches = shaper.reaches
  const cells = TERRAIN_RES * TERRAIN_RES
  const dirs = cellDirections()
  const height = Array.from({ length: CUBE_FACES }, () => new Float32Array(cells))
  const tint = Array.from({ length: CUBE_FACES }, () => new Float32Array(cells * 4))
  for (let f = 0; f < CUBE_FACES; f++) {
    const d = dirs[f]!
    for (let c = 0; c < cells; c++) {
      const [x, y, z] = [d[c * 3]!, d[c * 3 + 1]!, d[c * 3 + 2]!]
      if (!reaches.some(({ dir, cos }) => dir[0] * x + dir[1] * y + dir[2] * z >= cos)) continue
      const { lat, lon } = dirToLatLon(x, y, z)
      const t = shaper.touchAt(lat, lon, 0)
      height[f]![c] = t.dh
      tint[f]!.set([t.rgb[0], t.rgb[1], t.rgb[2], t.tint], c * 4)
    }
  }
  return { height, tint }
}
