import { parentPort } from 'node:worker_threads'
import type { TerrainParams } from '@universe/core'
import { generateBase } from '@universe/procgen'

/** Generates worlds' base terrain off the main process's thread, for the API (the renderer has its own worker). */
parentPort!.on('message', ({ id, seed, params }: { id: number; seed: number; params: TerrainParams }) => {
  try {
    parentPort!.postMessage({ id, base: generateBase(seed, params) })
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message })
  }
})
