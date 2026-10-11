import { parentPort } from 'node:worker_threads'
import type { TerrainParams } from '@universe/core'
import { generateBase, worldWater, type WaterInput } from '@universe/procgen'

/** What the API asks of the worker: a world's base terrain, or its rivers and lakes. */
export type TerrainJob = { job: 'base'; seed: number; params: TerrainParams } | ({ job: 'water' } & WaterInput)

/** Works out worlds' base terrain and their rivers and lakes off the main process's thread, for the API (the renderer has its own workers). */
parentPort!.on('message', ({ id, ...job }: { id: number } & TerrainJob) => {
  try {
    if (job.job === 'base') {
      const base = generateBase(job.seed, job.params)
      // Handed over rather than copied: a few MB.
      parentPort!.postMessage({ id, result: base }, [...base.height, ...base.moisture].map((a) => a.buffer as ArrayBuffer))
    } else {
      const water = worldWater(job)
      parentPort!.postMessage({ id, result: water }, [water.lakeLevel.buffer as ArrayBuffer, water.lakeOf.buffer as ArrayBuffer])
    }
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message })
  }
})
