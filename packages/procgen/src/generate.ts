import { CUBE_FACES, TERRAIN_RES, type TerrainParams } from '@universe/core'
import { createNoise3D, type NoiseFunction3D } from 'simplex-noise'
import { cellDirections } from './cubesphere'
import { rng, subSeed } from './random'

/** The generated (unedited) terrain for a world: meters of height and 0–1 moisture per cell. */
export interface BaseTerrain {
  height: Float32Array[]
  moisture: Float32Array[]
}

function fbm(noise: NoiseFunction3D, x: number, y: number, z: number, octaves: number, gain = 0.5): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq, z * freq)
    norm += amp
    amp *= gain
    freq *= 2.03
  }
  return sum / norm
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Generates continents, ocean basins and mountain ranges from a seed.
 * Pure and deterministic; heavy (~6M noise samples), so callers in the UI run it in a worker.
 */
export function generateBase(seed: number, params: TerrainParams): BaseTerrain {
  const continents = createNoise3D(rng(subSeed(seed, 1)))
  const warp = createNoise3D(rng(subSeed(seed, 2)))
  const detail = createNoise3D(rng(subSeed(seed, 3)))
  const ridges = createNoise3D(rng(subSeed(seed, 4)))
  const wetness = createNoise3D(rng(subSeed(seed, 5)))
  const f = params.continentScale
  const dirs = cellDirections()
  const cells = TERRAIN_RES * TERRAIN_RES

  const height: Float32Array[] = []
  const moisture: Float32Array[] = []
  for (let face = 0; face < CUBE_FACES; face++) {
    const d = dirs[face]!
    const h = new Float32Array(cells)
    const m = new Float32Array(cells)
    for (let c = 0; c < cells; c++) {
      const x = d[c * 3]!
      const y = d[c * 3 + 1]!
      const z = d[c * 3 + 2]!
      // Domain warp bends coastlines so continents aren't blobby.
      const wx = warp(x * f * 1.7, y * f * 1.7, z * f * 1.7) * 0.35
      const wz = warp(z * f * 1.7 + 9, x * f * 1.7, y * f * 1.7) * 0.35
      const land = fbm(continents, x * f + wx, y * f, z * f + wz, 5) + 0.03
      const rough = fbm(detail, x * f * 7, y * f * 7, z * f * 7, 4) * params.roughness
      const shape = land + rough * 0.18
      // Ridged noise, sharpened so ranges are narrow chains rather than plateaus.
      const ridge = Math.pow(1 - Math.abs(ridges(x * f * 2.6, y * f * 2.6, z * f * 2.6)), 4)
      const ranges = smoothstep(-0.35, 0.3, fbm(ridges, x * f * 0.9 + 5, y * f * 0.9, z * f * 0.9, 2))
      const mountains = ridge * ranges * smoothstep(0.02, 0.3, shape) * params.mountainHeight * (0.5 + 0.5 * params.roughness)
      // Land rises gently from the coast; ocean floors drop steeply to abyssal depths.
      h[c] = (shape > 0 ? shape * 2200 + rough * 500 : shape * 5000) + mountains
      m[c] = 0.5 + 0.5 * fbm(wetness, x * 2.2, y * 2.2, z * 2.2, 3)
    }
    height.push(h)
    moisture.push(m)
  }
  return { height, moisture }
}
