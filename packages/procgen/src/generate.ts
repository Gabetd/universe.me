import { CUBE_FACES, TERRAIN_RES, type TerrainParams } from '@universe/core'
import { cellDirections, latLonToDir } from './cubesphere'
import { rng, subSeed } from './random'
import { DEG, kthSmallest, smoothstep } from './math'
import { fbm, seededNoise } from './noise'

/** The generated (unedited) terrain for a world: meters of height and 0–1 moisture per cell. */
export interface BaseTerrain {
  height: Float32Array[]
  moisture: Float32Array[]
}

/** The options that change the generated shape; the rest (climate, colors) only recolor it. */
export const SHAPE_KEYS = ['landform', 'water', 'continentScale', 'islands', 'roughness', 'mountains', 'mountainHeight'] as const

/** Identifies a generated shape, e.g. for caching. Same seed and key, same terrain. */
export const shapeKey = (seed: number, p: TerrainParams) => `${seed}:${SHAPE_KEYS.map((k) => p[k]).join(':')}`

/**
 * Generates continents, ocean basins, islands and mountain ranges from a seed.
 * Pure and deterministic; heavy (~7M noise samples), so callers in the UI run
 * it in a worker. The sea level is placed so exactly `water` of the surface is
 * under it.
 */
export function generateBase(seed: number, params: TerrainParams): BaseTerrain {
  const continents = seededNoise(seed, 1)
  const warp = seededNoise(seed, 2)
  const detail = seededNoise(seed, 3)
  const ridges = seededNoise(seed, 4)
  const wetness = seededNoise(seed, 5)
  const islandNoise = seededNoise(seed, 6)
  const centerRng = rng(subSeed(seed, 7))
  const archipelago = params.landform === 'archipelago'
  const f = params.continentScale * (archipelago ? 2.2 : params.landform === 'supercontinent' ? 0.75 : 1)
  // A supercontinent gathers the land around one point of the globe.
  const center = latLonToDir(Math.asin(centerRng() * 1.6 - 0.8) * DEG, centerRng() * 360 - 180)
  const islandAmount = params.islands * (archipelago ? 1.4 : 1)
  // Islands are a few hundred km across whatever the land type, so they read as islands rather than speckle.
  const fi = params.continentScale * 3.2
  // More mountain coverage lowers the threshold where ranges start.
  const rangeShift = (0.5 - params.mountains) * 0.9
  const dirs = cellDirections()
  const cells = TERRAIN_RES * TERRAIN_RES

  // Pass 1: the land shape (positive = land at the natural sea level) and per-cell details.
  const shapes: Float32Array[] = []
  const roughs: Float32Array[] = []
  const ridgeTerms: Float32Array[] = []
  const moisture: Float32Array[] = []
  for (let face = 0; face < CUBE_FACES; face++) {
    const d = dirs[face]!
    const sh = new Float32Array(cells)
    const ro = new Float32Array(cells)
    const ri = new Float32Array(cells)
    const m = new Float32Array(cells)
    for (let c = 0; c < cells; c++) {
      const x = d[c * 3]!
      const y = d[c * 3 + 1]!
      const z = d[c * 3 + 2]!
      // Domain warp bends coastlines so continents aren't blobby.
      const wx = warp(x * f * 1.7, y * f * 1.7, z * f * 1.7) * 0.35
      const wz = warp(z * f * 1.7 + 9, x * f * 1.7, y * f * 1.7) * 0.35
      let land = fbm(continents, x * f + wx, y * f, z * f + wz, 5) * (archipelago ? 0.7 : 1)
      if (params.landform === 'supercontinent') land += 0.45 * (x * center[0] + y * center[1] + z * center[2])
      // Islands: small, sharp bumps that mostly matter out at sea.
      const isle = smoothstep(0.2, 0.6, fbm(islandNoise, x * fi, y * fi, z * fi, 3))
      land += islandAmount * isle * (land < 0 ? 0.45 : 0.15)
      const rough = fbm(detail, x * f * 7, y * f * 7, z * f * 7, 4) * params.roughness
      sh[c] = land + rough * 0.18
      ro[c] = rough
      // Ridged noise, sharpened so ranges are narrow chains rather than plateaus.
      const ridge = Math.pow(1 - Math.abs(ridges(x * f * 2.6, y * f * 2.6, z * f * 2.6)), 4)
      ri[c] = ridge * smoothstep(-0.35 + rangeShift, 0.3 + rangeShift, fbm(ridges, x * f * 0.9 + 5, y * f * 0.9, z * f * 0.9, 2))
      m[c] = 0.5 + 0.5 * fbm(wetness, x * 2.2, y * 2.2, z * 2.2, 3)
    }
    shapes.push(sh)
    roughs.push(ro)
    ridgeTerms.push(ri)
    moisture.push(m)
  }

  // Pass 2: the sea level that puts exactly `water` of the cells under it.
  const all = new Float32Array(cells * CUBE_FACES)
  shapes.forEach((sh, i) => all.set(sh, i * cells))
  const sea = kthSmallest(all, Math.min(all.length - 1, Math.floor(params.water * all.length)))

  // Pass 3: heights. Land rises gently from the coast; ocean floors drop steeply to abyssal depths.
  const height = shapes.map((sh, face) => {
    const h = new Float32Array(cells)
    const ro = roughs[face]!
    const ri = ridgeTerms[face]!
    for (let c = 0; c < cells; c++) {
      const shape = sh[c]! - sea
      const mountains = ri[c]! * smoothstep(0.02, 0.3, shape) * params.mountainHeight * (0.5 + 0.5 * params.roughness)
      // Roughness fades out at the coast, so the shoreline stays exactly where `water` put it.
      h[c] = (shape > 0 ? shape * 2200 + ro[c]! * 500 * smoothstep(0, 0.08, shape) : shape * 5000) + mountains
    }
    return h
  })
  return { height, moisture }
}
