import { TERRAIN_RES } from '@universe/core'
import { latLonToDir, type Vec3 } from './cubesphere'
import type { TerrainModel } from './terrain-model'

/** Fills an RGBA TERRAIN_RES² texture for one cube face (unlit; the 3D view lights it). */
export function renderFaceTexture(model: TerrainModel, face: number, out: Uint8Array): void {
  for (let c = 0; c < TERRAIN_RES * TERRAIN_RES; c++) model.color(face, c, out, c * 4)
}

/** Latitude/longitude of an equirectangular pixel's center. */
export function pixelToLatLon(x: number, y: number, width: number, height: number): { lat: number; lon: number } {
  return { lat: 90 - ((y + 0.5) / height) * 180, lon: ((x + 0.5) / width) * 360 - 180 }
}

/**
 * Renders rows [y0, y1) of an equirectangular map with hillshading into
 * `out` (RGBA, width × height). Rendering only the rows a brush touched keeps
 * sculpting on the map interactive.
 */
export function renderEquirect(model: TerrainModel, out: Uint8ClampedArray, width: number, height: number, y0 = 0, y1 = height): void {
  y0 = Math.max(0, y0)
  y1 = Math.min(height, y1)
  // Heights for the rows plus a one-pixel border, for the shading gradient.
  const top = Math.max(0, y0 - 1)
  const bottom = Math.min(height, y1 + 1)
  const heights = new Float32Array((bottom - top) * width)
  const cells = new Int32Array((bottom - top) * width * 2)
  const dir: Vec3 = [0, 0, 0]
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < width; x++) {
      const { lat, lon } = pixelToLatLon(x, y, width, height)
      latLonToDir(lat, lon, dir)
      const { face, cell } = model.cellAt(dir[0], dir[1], dir[2])
      const k = (y - top) * width + x
      heights[k] = model.height(face, cell)
      cells[k * 2] = face
      cells[k * 2 + 1] = cell
    }
  }

  const sea = model.settings.seaLevel
  const metersPerRow = (Math.PI * model.settings.radiusKm * 1000) / height
  const h = (x: number, y: number) => heights[(Math.max(top, Math.min(bottom - 1, y)) - top) * width + ((x + width) % width)]!
  for (let y = y0; y < y1; y++) {
    const lat = pixelToLatLon(0, y, width, height).lat
    const metersPerCol = Math.max(1, metersPerRow * 2 * Math.cos((lat * Math.PI) / 180))
    for (let x = 0; x < width; x++) {
      const k = (y - top) * width + x
      const o = (y * width + x) * 4
      model.color(cells[k * 2]!, cells[k * 2 + 1]!, out, o)
      // Light from the north-west: slopes rising to the east or south catch it.
      const gx = (h(x + 1, y) - h(x - 1, y)) / (2 * metersPerCol)
      const gy = (h(x, y + 1) - h(x, y - 1)) / (2 * metersPerRow)
      const land = heights[k]! >= sea
      const shade = Math.max(0.55, Math.min(1.35, 1 + (gx + gy) * (land ? 6 : 0.6)))
      out[o] = out[o]! * shade
      out[o + 1] = out[o + 1]! * shade
      out[o + 2] = out[o + 2]! * shade
    }
  }
}

/** Map rows a brush at `dir` with angular radius `radius` (radians) can touch. */
export function brushRows(dir: Vec3, radius: number, height: number): [number, number] {
  const lat = (Math.asin(dir[1]) * 180) / Math.PI
  const r = (radius * 180) / Math.PI
  const toRow = (l: number) => Math.round(((90 - l) / 180) * height)
  return [toRow(Math.min(90, lat + r)) - 2, toRow(Math.max(-90, lat - r)) + 2]
}
