import { TERRAIN_RES } from '@universe/core'
import { erosionField } from './erosion'
import { hydrology, type Hydrology } from './hydrology'

const CELLS = TERRAIN_RES * TERRAIN_RES

/** What a world's water is worked out from: its terrain as generated and sculpted (not worn), its sea and its rain. */
export interface WaterInput {
  /** Generated heights, per face. */
  base: ArrayLike<number>[]
  /** The user's height edits, per face: where they're not 0, the land is sculpted and doesn't erode. */
  edits: ArrayLike<number>[]
  seaLevel: number
  moisture: ArrayLike<number>[]
  /** The world's seed, for the names. */
  seed: number
  radiusKm: number
}

/** A world's rivers and lakes, and (if asked for) how deep its land wears down in the long run, per face. */
export interface WorldWater extends Pick<Hydrology, 'rivers' | 'lakes' | 'lakeLevel' | 'lakeOf'> {
  erosion?: Float32Array[]
}

/**
 * A world's water (PLAN.md §9, M15), the same wherever it's worked out (the
 * app's worker, the API's): every cell of the planet, so off the UI thread.
 */
export function worldWater({ base, edits, seaLevel, moisture, seed, radiusKm }: WaterInput, { erosion = false } = {}): WorldWater {
  const heights = base.map((b, f) => {
    const e = edits[f]!
    const out = new Float32Array(CELLS)
    for (let c = 0; c < CELLS; c++) out[c] = b[c]! + e[c]! - seaLevel
    return out
  })
  const { rivers, lakes, lakeLevel, lakeOf, ...water } = hydrology({ heights, moisture, seed, radiusKm })
  return { rivers, lakes, lakeLevel, lakeOf, ...(erosion && { erosion: erosionField({ heights, water: { lakeLevel, ...water }, sculpted: edits, radiusKm }) }) }
}
