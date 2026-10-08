/// <reference lib="webworker" />
import type { TerrainParams } from '@universe/core'
import { generateBase, type BaseTerrain } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

export interface GenerateRequest {
  seed: number
  params: TerrainParams
}

// Generation takes ~0.5–1 s, so it runs here to keep the editor responsive.
answerCalls<GenerateRequest, BaseTerrain>(({ seed, params }) => {
  const base = generateBase(seed, params)
  return { reply: base, transfer: [...base.height, ...base.moisture].map((a) => a.buffer) }
})
