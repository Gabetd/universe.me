/// <reference lib="webworker" />
import { worldWater, type WaterInput, type WorldWater } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

/** A world's rivers and lakes, and how deep its land wears down in the long run. */
export type Water = WorldWater & { erosion: Float32Array[] }

// Every cell of the planet, twice over (where water goes, then what it wears away): half a second or so, here rather than in the window.
answerCalls<WaterInput, Water>((input) => {
  const water = worldWater(input, { erosion: true }) as Water
  return { reply: water, transfer: [water.lakeLevel.buffer, water.lakeOf.buffer, ...water.erosion.map((e) => e.buffer)] }
})
