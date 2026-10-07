/// <reference lib="webworker" />
import type { TerrainParams } from '@universe/core'
import { generateBase } from '@universe/procgen'

export interface GenerateRequest {
  id: number
  seed: number
  params: TerrainParams
}

// Generation takes ~0.5–1 s, so it runs here to keep the editor responsive.
self.onmessage = (e: MessageEvent<GenerateRequest>) => {
  const { id, seed, params } = e.data
  const base = generateBase(seed, params)
  const buffers = [...base.height, ...base.moisture].map((a) => a.buffer)
  ;(self as unknown as Worker).postMessage({ id, base }, buffers)
}
