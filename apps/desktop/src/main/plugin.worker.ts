import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { runPlugin, useWasm, type PluginHost, type PluginRun } from '@universe/plugins'
import { encodePng } from './png'

/**
 * Runs one plugin (PLAN.md §9, M16) off the main process's thread, in its
 * QuickJS sandbox: what it asks of the app goes to the main process and
 * comes back answered (main/plugins.ts). One worker per run, ended after it.
 */

/** What the main process sends: the run, then each answer to what the plugin asked. */
/** A run, with the plugin's folder (its code is read here, off the main thread). */
export type WorkerRun = Omit<PluginRun, 'host' | 'files'> & { folder: string }
export type ToWorker = { type: 'run'; run: WorkerRun; wasm: Parameters<typeof useWasm>[0] } | { type: 'answer'; ask: number; ok: true; value: unknown } | { type: 'answer'; ask: number; ok: false; error: string }
/** What the plugin asks of the app itself (a PNG is made here). */
type Ask = 'call' | 'pickFile'

/** What the worker sends: a question for the app, a log line, and how the run ended. */
export type FromWorker =
  | { type: 'ask'; ask: number; what: Ask; args: unknown[] }
  | { type: 'log'; line: string }
  | { type: 'done'; output: Awaited<ReturnType<typeof runPlugin>> }
  | { type: 'failed'; error: string }

const port = parentPort!
const waiting = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>()
let asks = 0
const send = (message: FromWorker) => port.postMessage(message)

const ask =
  (what: Ask) =>
  (...args: unknown[]) =>
    new Promise<never>((resolve, reject) => {
      const id = ++asks
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject })
      send({ type: 'ask', ask: id, what, args })
    })

const host: PluginHost = {
  call: ask('call'),
  pickFile: ask('pickFile'),
  // Encoded here, off the app's main thread.
  png: async (width, height, rgba) => encodePng(width, height, Buffer.from(rgba, 'base64')).toString('base64'),
  log: (line) => send({ type: 'log', line })
}

port.on('message', (message: ToWorker) => {
  if (message.type === 'answer') {
    const call = waiting.get(message.ask)
    waiting.delete(message.ask)
    if (message.ok) call?.resolve(message.value)
    else call?.reject(new Error(message.error))
    return
  }
  useWasm(message.wasm)
  const { folder, ...run } = message.run
  Promise.resolve()
    .then(() => runPlugin({ ...run, files: readCode(folder), host }))
    .then(
      (output) => send({ type: 'done', output }),
      (err: Error) => send({ type: 'failed', error: err.message })
    )
})

/** How big a plugin's code may be. */
const MAX_CODE_BYTES = 10 * 1024 * 1024
const MAX_CODE_FILES = 500

/** A plugin's code: its .js and .mjs files, by path in its folder. */
function readCode(folder: string): Record<string, string> {
  const files: Record<string, string> = {}
  let bytes = 0
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 8) walk(path, depth + 1)
      } else if (/\.m?js$/.test(entry.name)) {
        const text = readFileSync(path, 'utf8')
        bytes += text.length
        if (Object.keys(files).length >= MAX_CODE_FILES || bytes > MAX_CODE_BYTES) throw new Error('Its code is too big: 500 files and 10 MB at most')
        files[relative(folder, path).split(sep).join('/')] = text
      }
    }
  }
  walk(folder, 0)
  return files
}

