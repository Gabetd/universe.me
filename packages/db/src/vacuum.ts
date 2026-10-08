import { renameSync, rmSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

/** Runs in the worker, on a read-only connection of its own, so the project's connection stays free for commands. */
const SCRIPT = `
const { workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(workerData.from, { readOnly: true })
try {
  db.exec('PRAGMA busy_timeout = 2000')
  db.prepare('VACUUM INTO ?').run(workerData.to)
} finally {
  db.close()
}
`

/**
 * Writes a compacted copy of the database at `from` to `to` in a worker
 * thread. The copy is a snapshot of what was committed when it started. It's
 * written beside `to` and moved there once complete, so a copy cut short
 * never looks finished.
 */
export async function vacuumInto(from: string, to: string): Promise<void> {
  const partial = `${to}.partial`
  rmSync(partial, { force: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(SCRIPT, { eval: true, workerData: { from, to: partial } })
      worker.once('error', reject)
      worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Saving the copy stopped (exit code ${code})`))))
    })
    renameSync(partial, to)
  } catch (err) {
    rmSync(partial, { force: true })
    throw err
  }
}
