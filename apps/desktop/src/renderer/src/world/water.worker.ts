/// <reference lib="webworker" />
import { erosionField, hydrology, type Lake, type River } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

export interface WaterRequest {
  /** Metres above sea level, per face: generated and sculpted, not worn. */
  heights: Float32Array[]
  moisture: Float32Array[]
  /** 1 for each sculpted cell, per face: those don't erode. */
  sculpted: Uint8Array[]
  seed: number
  radiusKm: number
}

/** A world's rivers and lakes, and how deep its land wears down in the long run. */
export interface Water {
  rivers: River[]
  lakes: Lake[]
  /** Each cell's lake surface (planet-wide), NaN where there's none. */
  lakeLevel: Float32Array
  /** How deep each cell wears down by in the long run, per face. */
  erosion: Float32Array[]
}

// Every cell of the planet, twice over (where water goes, then what it wears away): half a second or so, here rather than in the window.
answerCalls<WaterRequest, Water>(({ heights, moisture, sculpted, seed, radiusKm }) => {
  const water = hydrology({ heights, moisture, seed, radiusKm })
  const erosion = erosionField({ heights, water, radiusKm, edited: (f, c) => sculpted[f]![c] === 1 })
  return { reply: { rivers: water.rivers, lakes: water.lakes, lakeLevel: water.lakeLevel, erosion }, transfer: [water.lakeLevel.buffer, ...erosion.map((e) => e.buffer)] }
})
