import { parentPort } from 'node:worker_threads'
import { planMerge, type MergeInput } from '@universe/core'
import { PageReader } from '@universe/db'

/** What sync asks of the worker: a page of what the project file got since a point, or what rows from another device come to. */
export type SyncJob = { job: 'page'; path: string; since: number; from: string; limit: number } | { job: 'plan'; inputs: MergeInput[] } | { job: 'close' }

/**
 * Sync's heavy work off the main process's thread (PLAN.md §6.7, M21): the
 * pages other devices ask for, read through a connection of its own to the
 * open project (terrain inflated and turned to text here), and working out
 * what rows from them come to (fields, notes line by line, terrain cell by
 * cell, each checked), which the main thread then writes.
 */
let reader: PageReader | undefined

parentPort!.on('message', ({ id, ...job }: { id: number } & SyncJob) => {
  try {
    if (job.job === 'close') {
      reader?.close()
      reader = undefined
      return parentPort!.postMessage({ id, result: null })
    }
    if (job.job === 'plan') return parentPort!.postMessage({ id, result: planMerge(job.inputs) })
    if (reader?.path !== job.path) {
      reader?.close()
      reader = new PageReader(job.path)
    }
    parentPort!.postMessage({ id, result: reader.changesSince(job.since, { from: job.from, limit: job.limit }) })
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message })
  }
})
