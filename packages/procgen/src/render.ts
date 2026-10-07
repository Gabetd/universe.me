import { TERRAIN_RES } from '@universe/core'
import { dirToLatLon, latLonToDir, type Vec3 } from './cubesphere'
import { clamp } from './math'
import type { TerrainModel } from './terrain-model'

/** Fills an RGBA TERRAIN_RES² texture for one cube face (unlit; the 3D view lights it). */
export function renderFaceTexture(model: TerrainModel, face: number, out: Uint8Array): void {
  for (let c = 0; c < TERRAIN_RES * TERRAIN_RES; c++) model.color(face, c, out, c * 4)
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
function pixelCells(model: TerrainModel, width: number, height: number): Int32Array {
  const key = `${width}x${height}`
  let lut = pixelCellCache.get(key)
  if (lut) return lut
  lut = new Int32Array(width * height)
  const dir: Vec3 = [0, 0, 0]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { lat, lon } = pixelToLatLon(x, y, width, height)
      latLonToDir(lat, lon, dir)
      const { face, cell } = model.cellAt(dir[0], dir[1], dir[2])
      lut[y * width + x] = face * CELLS + cell
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
  const lut = pixelCells(model, width, height)
  // Heights for the rows plus a one-pixel border, for the shading gradient.
  const top = Math.max(0, y0 - 1)
  const bottom = Math.min(height, y1 + 1)
  const heights = new Float32Array((bottom - top) * width)
  for (let k = 0, p = top * width; k < heights.length; k++, p++) {
    const fc = lut[p]!
    heights[k] = model.height((fc / CELLS) | 0, fc % CELLS)
  }

  const sea = model.settings.seaLevel
  const metersPerRow = (Math.PI * model.settings.radiusKm * 1000) / height
  const h = (x: number, y: number) => heights[(clamp(y, top, bottom - 1) - top) * width + ((x + width) % width)]!
  for (let y = y0; y < y1; y++) {
    const lat = pixelToLatLon(0, y, width, height).lat
    const metersPerCol = Math.max(1, metersPerRow * 2 * Math.cos((lat * Math.PI) / 180))
    for (let x = 0; x < width; x++) {
      const k = (y - top) * width + x
      const o = (y * width + x) * 4
      const fc = lut[y * width + x]!
      model.color((fc / CELLS) | 0, fc % CELLS, out, o)
      // Light from the north-west: slopes rising to the east or south catch it.
      const gx = (h(x + 1, y) - h(x - 1, y)) / (2 * metersPerCol)
      const gy = (h(x, y + 1) - h(x, y - 1)) / (2 * metersPerRow)
      const land = heights[k]! >= sea
      const shade = clamp(1 + (gx + gy) * (land ? 6 : 0.6), 0.55, 1.35)
      out[o] = out[o]! * shade
      out[o + 1] = out[o + 1]! * shade
      out[o + 2] = out[o + 2]! * shade
    }
  }
}

/** Map rows a brush at `dir` with angular radius `radius` (radians) can touch. */
export function brushRows(dir: Vec3, radius: number, height: number): [number, number] {
  const { lat } = dirToLatLon(...dir)
  const r = (radius * 180) / Math.PI
  const toRow = (l: number) => Math.round(latLonToPixel(l, 0, 1, height)[1])
  return [toRow(Math.min(90, lat + r)) - 2, toRow(Math.max(-90, lat - r)) + 2]
}
