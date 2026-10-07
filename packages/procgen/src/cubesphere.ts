import { CUBE_FACES, TERRAIN_RES, type LatLon } from '@universe/core'
import { clamp } from './math'

/**
 * Cube-sphere grid math. Each face has TERRAIN_RES² cells; cell (i, j) is at
 * index j * TERRAIN_RES + i. Face coordinates s, t run from -1 to 1 and are
 * tangent-warped so cells are close to equal area.
 */
export type Vec3 = [number, number, number]

const WARP = Math.PI / 4

/** Direction (unit vector) for face coordinates s, t in [-1, 1]. */
export function faceToDir(face: number, s: number, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const u = Math.tan(s * WARP)
  const v = Math.tan(t * WARP)
  let x: number, y: number, z: number
  switch (face) {
    case 0: [x, y, z] = [1, v, -u]; break
    case 1: [x, y, z] = [-1, v, u]; break
    case 2: [x, y, z] = [u, 1, -v]; break
    case 3: [x, y, z] = [u, -1, v]; break
    case 4: [x, y, z] = [u, v, 1]; break
    default: [x, y, z] = [-u, v, -1]
  }
  const len = Math.hypot(x, y, z)
  out[0] = x / len
  out[1] = y / len
  out[2] = z / len
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
/** Unit direction of every cell center, xyz-interleaved, one array per face. Computed once. */
export function cellDirections(): Float32Array[] {
  if (dirCache) return dirCache
  const out: Vec3 = [0, 0, 0]
  dirCache = Array.from({ length: CUBE_FACES }, (_, face) => {
    const dirs = new Float32Array(TERRAIN_RES * TERRAIN_RES * 3)
    for (let j = 0; j < TERRAIN_RES; j++) {
      for (let i = 0; i < TERRAIN_RES; i++) {
        faceToDir(face, cellCenter(i), cellCenter(j), out)
        dirs.set(out, (j * TERRAIN_RES + i) * 3)
      }
    }
    return dirs
  })
  return dirCache
}

const DEG = 180 / Math.PI

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
