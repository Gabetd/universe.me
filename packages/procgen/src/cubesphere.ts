import { TERRAIN_RES, type LatLon } from '@universe/core'
import { DEG, clamp } from './math'

/**
 * Cube-sphere grid math. Each face has TERRAIN_RES² cells; cell (i, j) is at
 * index j * TERRAIN_RES + i. Face coordinates s, t run from -1 to 1 and are
 * tangent-warped so cells are close to equal area.
 */
export type Vec3 = [number, number, number]

const WARP = Math.PI / 4

/**
 * How each face's warped coordinates u = tan(s·π/4), v = tan(t·π/4) make a
 * point on the cube: which axis is ±1 (`c`, sign `cs`) and which axes u and
 * v go on, with their signs. Face 0 is (1, v, −u), 1 (−1, v, u), 2 (u, 1, −v),
 * 3 (u, −1, v), 4 (u, v, 1) and 5 (−u, v, −1).
 */
const FACES = [
  { c: 0, cs: 1, u: 2, us: -1, v: 1, vs: 1 },
  { c: 0, cs: -1, u: 2, us: 1, v: 1, vs: 1 },
  { c: 1, cs: 1, u: 0, us: 1, v: 2, vs: -1 },
  { c: 1, cs: -1, u: 0, us: 1, v: 2, vs: 1 },
  { c: 2, cs: 1, u: 0, us: 1, v: 1, vs: 1 },
  { c: 2, cs: -1, u: 0, us: -1, v: 1, vs: 1 }
] as const

/** Direction (unit vector) for face coordinates s, t in [-1, 1]. */
export function faceToDir(face: number, s: number, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const f = FACES[face] ?? FACES[5]
  out[f.c] = f.cs
  out[f.u] = f.us * Math.tan(s * WARP)
  out[f.v] = f.vs * Math.tan(t * WARP)
  const len = Math.hypot(out[0], out[1], out[2])
  out[0] /= len
  out[1] /= len
  out[2] /= len
  return out
}

export interface FacePoint {
  face: number
  /** Face coordinates in [-1, 1]. */
  s: number
  t: number
}

/** Inverse of faceToDir. `dir` need not be normalized. */
export function dirToFace(x: number, y: number, z: number): FacePoint {
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const az = Math.abs(z)
  let face: number, u: number, v: number
  if (ax >= ay && ax >= az) {
    face = x > 0 ? 0 : 1
    u = x > 0 ? -z / ax : z / ax
    v = y / ax
  } else if (ay >= az) {
    face = y > 0 ? 2 : 3
    u = x / ay
    v = y > 0 ? -z / ay : z / ay
  } else {
    face = z > 0 ? 4 : 5
    u = z > 0 ? x / az : -x / az
    v = y / az
  }
  return { face, s: Math.atan(u) / WARP, t: Math.atan(v) / WARP }
}

/** Grid coordinate (cell units, may be fractional) for a face coordinate. */
export const toGrid = (s: number): number => ((s + 1) / 2) * TERRAIN_RES - 0.5
/** Face coordinate of a cell center. */
export const cellCenter = (i: number): number => ((i + 0.5) / TERRAIN_RES) * 2 - 1

let dirCache: Float32Array[] | undefined
/**
 * Unit direction of every cell center, xyz-interleaved, one array per face.
 * Computed once; the same float32 values faceToDir gives for cell centers.
 */
export function cellDirections(): Float32Array[] {
  if (dirCache) return dirCache
  // A cell's u depends on its column alone and v on its row.
  const tan = Float64Array.from({ length: TERRAIN_RES }, (_, i) => Math.tan(cellCenter(i) * WARP))
  dirCache = FACES.map(({ c, cs, u: uAxis, us, v: vAxis, vs }) => {
    const dirs = new Float32Array(TERRAIN_RES * TERRAIN_RES * 3)
    for (let j = 0, o = 0; j < TERRAIN_RES; j++) {
      const v = tan[j]!
      for (let i = 0; i < TERRAIN_RES; i++, o += 3) {
        const u = tan[i]!
        // One coordinate is ±1 on every face, so this is the cube point's length.
        const len = Math.sqrt(1 + u * u + v * v)
        dirs[o + c] = cs / len
        dirs[o + uAxis] = (us * u) / len
        dirs[o + vAxis] = (vs * v) / len
      }
    }
    return dirs
  })
  return dirCache
}

/** +Y is north; longitude 0 faces +Z and 90°E faces +X. */
export function dirToLatLon(x: number, y: number, z: number): LatLon {
  return { lat: Math.asin(clamp(y, -1, 1)) * DEG, lon: Math.atan2(x, z) * DEG }
}

export function latLonToDir(lat: number, lon: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const la = lat / DEG
  const lo = lon / DEG
  out[0] = Math.cos(la) * Math.sin(lo)
  out[1] = Math.sin(la)
  out[2] = Math.cos(la) * Math.cos(lo)
  return out
}

/** Angle in radians between two unit vectors. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1))
}
