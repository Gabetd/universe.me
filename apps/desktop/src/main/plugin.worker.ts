import { parentPort } from 'node:worker_threads'
import { runPlugin, useWasm, type PluginHost, type PluginRun } from '@universe/plugins'

/**
 * Runs one plugin (PLAN.md §9, M16) off the main process's thread, in its
 * QuickJS sandbox: what it asks of the app goes to the main process and
 * comes back answered (main/plugins.ts). One worker per run, ended after it.
 */

/** What the main process sends: the run, then each answer to what the plugin asked. */
export type ToWorker = { type: 'run'; run: Omit<PluginRun, 'host'>; wasm: ArrayBuffer } | { type: 'answer'; ask: number; ok: true; value: unknown } | { type: 'answer'; ask: number; ok: false; error: string }
/** What the worker sends: a question for the app, a log line, and how the run ended. */
export type FromWorker =
  | { type: 'ask'; ask: number; what: Exclude<keyof PluginHost, 'log'>; args: unknown[] }
  | { type: 'log'; line: string }
  | { type: 'done'; output: Awaited<ReturnType<typeof runPlugin>> }
  | { type: 'failed'; error: string }

const port = parentPort!
const waiting = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>()
let asks = 0
const send = (message: FromWorker) => port.postMessage(message)

const ask =
  (what: Exclude<keyof PluginHost, 'log'>) =>
  (...args: unknown[]) =>
    new Promise<never>((resolve, reject) => {
      const id = ++asks
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject })
      send({ type: 'ask', ask: id, what, args })
    })

const host: PluginHost = { call: ask('call'), pickFile: ask('pickFile'), png: ask('png'), log: (line) => send({ type: 'log', line }) }

port.on('message', (message: ToWorker) => {
  if (message.type === 'answer') {
    const call = waiting.get(message.ask)
    waiting.delete(message.ask)
    if (message.ok) call?.resolve(message.value)
    else call?.reject(new Error(message.error))
    return
  }
  useWasm(message.wasm)
  runPlugin({ ...message.run, host }).then(
    (output) => send({ type: 'done', output }),
    (err: Error) => send({ type: 'failed', error: err.message })
  )
})
