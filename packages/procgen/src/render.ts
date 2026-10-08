import { CUBE_FACES, TERRAIN_RES } from '@universe/core'
import { DEG, RAD, clamp } from './math'
import { dirToFace, dirToLatLon, nearestCell, type FacePoint, type Vec3 } from './cubesphere'
import type { TerrainModel } from './terrain-model'

/** Fills an RGBA TERRAIN_RES² texture for one cube face (unlit; the 3D view lights it): a copy of model.faceColors. */
export function renderFaceTexture(model: TerrainModel, face: number, out: Uint8Array): void {
  out.set(model.faceColors(face))
}

/** Latitude/longitude of an equirectangular pixel's center. */
export function pixelToLatLon(x: number, y: number, width: number, height: number): { lat: number; lon: number } {
  return { lat: 90 - ((y + 0.5) / height) * 180, lon: ((x + 0.5) / width) * 360 - 180 }
}

/** Inverse of pixelToLatLon: continuous pixel coordinates (cell centers land on .5). */
export function latLonToPixel(lat: number, lon: number, width: number, height: number): [number, number] {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height]
}

const CELLS = TERRAIN_RES * TERRAIN_RES
const pixelCellCache = new Map<string, Int32Array>()

/** For each map pixel, the cube cell under it (face * CELLS + cell). Depends only on the map size, so it is computed once. */
function pixelCells(width: number, height: number): Int32Array {
  const key = `${width}x${height}`
  let lut = pixelCellCache.get(key)
  if (lut) return lut
  lut = new Int32Array(width * height)
  // Each pixel's direction as latLonToDir has it, with the sines and cosines of each row and column worked out once.
  const sinLon = new Float64Array(width)
  const cosLon = new Float64Array(width)
  for (let x = 0; x < width; x++) {
    const lo = pixelToLatLon(x, 0, width, height).lon / DEG
    sinLon[x] = Math.sin(lo)
    cosLon[x] = Math.cos(lo)
  }
  const at: FacePoint = { face: 0, s: 0, t: 0 }
  for (let y = 0, p = 0; y < height; y++) {
    const la = pixelToLatLon(0, y, width, height).lat / DEG
    const cosLat = Math.cos(la)
    const sinLat = Math.sin(la)
    for (let x = 0; x < width; x++, p++) {
      dirToFace(cosLat * sinLon[x]!, sinLat, cosLat * cosLon[x]!, at)
      lut[p] = at.face * CELLS + nearestCell(at.s, at.t)
    }
  }
  pixelCellCache.set(key, lut)
  return lut
}

/**
 * Renders rows [y0, y1) of an equirectangular map with hillshading into
 * `out` (RGBA, width × height). Rendering only the rows a brush touched keeps
 * sculpting on the map interactive.
 */
export function renderEquirect(model: TerrainModel, out: Uint8ClampedArray, width: number, height: number, y0 = 0, y1 = height): void {
  y0 = Math.max(0, y0)
  y1 = Math.min(height, y1)
  const lut = pixelCells(width, height)
  // A map with as many pixels as a face has cells takes whole faces of colours (cheap per cell, and kept for next time);
  // a smaller one, like a planet's sprite, has just the cells it shows coloured.
  const shown = (y1 - y0) * width < CELLS ? cellsByFace(lut.subarray(y0 * width, y1 * width)) : undefined
  const colors = Array.from({ length: CUBE_FACES }, (_, f) => model.roundedFaceColors(f, shown?.[f]))
  // Heights for the rows plus a one-pixel border, for the shading gradient.
  const top = Math.max(0, y0 - 1)
  const bottom = Math.min(height, y1 + 1)
  const heights = new Float32Array((bottom - top) * width)
  const { base, heightEdits } = model
  for (let k = 0, p = top * width; k < heights.length; k++, p++) {
    const fc = lut[p]!
    const face = (fc / CELLS) | 0
    const cell = fc - face * CELLS
    heights[k] = base.height[face]![cell]! + heightEdits[face]![cell]!
  }

  const sea = model.settings.seaLevel
  const metersPerRow = (Math.PI * model.settings.radiusKm * 1000) / height
  const dy = 2 * metersPerRow
  for (let y = y0; y < y1; y++) {
    const lat = pixelToLatLon(0, y, width, height).lat
    const dx = 2 * Math.max(1, metersPerRow * 2 * Math.cos(lat * RAD))
    // This row and the ones above and below in `heights` (the edge rows repeat); columns wrap round.
    const row = (y - top) * width
    const above = (Math.max(y - 1, top) - top) * width
    const below = (Math.min(y + 1, bottom - 1) - top) * width
    for (let x = 0, p = y * width; x < width; x++, p++) {
      const o = p * 4
      const fc = lut[p]!
      const face = (fc / CELLS) | 0
      const from = colors[face]!
      const c = (fc - face * CELLS) * 4
      // Light from the north-west: slopes rising to the east or south catch it.
      const gx = (heights[row + (x + 1 < width ? x + 1 : 0)]! - heights[row + (x > 0 ? x - 1 : width - 1)]!) / dx
      const gy = (heights[below + x]! - heights[above + x]!) / dy
      const land = heights[row + x]! >= sea
      const shade = clamp(1 + (gx + gy) * (land ? 6 : 0.6), 0.55, 1.35)
      out[o] = from[c]! * shade
      out[o + 1] = from[c + 1]! * shade
      out[o + 2] = from[c + 2]! * shade
      out[o + 3] = 255
    }
  }
}

/** Cells (face * CELLS + cell each) sorted out by face, as each face's own cell numbers. */
function cellsByFace(cells: Int32Array): Int32Array[] {
  const counts = new Int32Array(CUBE_FACES)
  for (const fc of cells) counts[(fc / CELLS) | 0]!++
  const byFace = Array.from(counts, (n) => new Int32Array(n))
  counts.fill(0)
  for (const fc of cells) {
    const face = (fc / CELLS) | 0
    byFace[face]![counts[face]!++] = fc - face * CELLS
  }
  return byFace
}

/** Map rows a brush at `dir` with angular radius `radius` (radians) can touch. */
export function brushRows(dir: Vec3, radius: number, height: number): [number, number] {
  const { lat } = dirToLatLon(...dir)
  const r = radius * DEG
  const toRow = (l: number) => Math.round(latLonToPixel(l, 0, 1, height)[1])
  return [toRow(Math.min(90, lat + r)) - 2, toRow(Math.max(-90, lat - r)) + 2]
}
