import variant from '@jitl/quickjs-wasmfile-release-sync'
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from 'quickjs-emscripten-core'
import type { ContributionKind } from './manifest'
import { PRELUDE } from './prelude'

/**
 * Runs a plugin's code (PLAN.md §9, M16) in QuickJS, a JavaScript engine of
 * its own compiled to WebAssembly: the code can reach nothing of the app or
 * the computer (no network, no files, no Node, no DOM) but what the host
 * hands it, which is the `universe` object (see prelude.ts): the API's
 * operations, a file the user picks, a PNG encoder and a log. It runs with a
 * memory limit and a deadline.
 */

/** What the plugin can ask of the app, all through `universe`. */
export interface PluginHost {
  /** One of the API's operations (by its MCP name), with its input; what it answers. */
  call(operation: string, input: unknown): Promise<unknown>
  /** A file the user picks (text), or null if they don't. */
  pickFile(options: { title?: string; extensions?: string[] }): Promise<{ name: string; text: string } | null>
  /** RGBA pixels (base64) as a PNG (base64). */
  png(width: number, height: number, rgba: string): Promise<string>
  log(line: string): void
}

export interface PluginLimits {
  /** Bytes of memory the code can use. */
  memory: number
  /** How long a run can take, waiting on the app included (ms). */
  timeMs: number
  /** How many calls into the app a run can make. */
  calls: number
  /** How many changes to the universe a run can make (the host counts them). */
  changes: number
}

export const DEFAULT_LIMITS: PluginLimits = { memory: 256 * 1024 * 1024, timeMs: 120_000, calls: 20_000, changes: 10_000 }

export interface PluginRun {
  /** The plugin's modules by path in its folder (`main.js`, `lib/names.js`…). */
  files: Record<string, string>
  main: string
  kind: ContributionKind
  /** The contribution's id: its function's name in what the code exports for `kind`. */
  id: string
  /** What it's given: the world or universe it runs on, its options. */
  input: Record<string, unknown>
  host: PluginHost
  limits?: Partial<PluginLimits>
}

/** A file an exporter makes: text, or bytes as base64. */
export type ExportedFile = { name: string; text: string } | { name: string; base64: string }

/** What a run gives back: an exporter's files, a name generator's names, a generator's summary (or nothing). */
export type PluginOutput = { kind: 'exporters'; files: ExportedFile[] } | { kind: 'names'; names: string[] } | { kind: 'generators'; summary?: string }

/** A plugin's own mistake (a throw, a bad answer, a limit reached), as it should be shown to the user. */
export class PluginError extends Error {
  override name = 'PluginError'
}

let engine: Promise<QuickJSWASMModule> | undefined
/** A compiled WebAssembly.Module (typed loosely: this package's code needs no DOM types). */
type WasmModule = NonNullable<Parameters<typeof newVariant>[1]['wasmModule']>
let wasmModule: WasmModule | undefined
/** QuickJS, loaded once (from `useWasm`'s module if given: where the app is bundled, its file isn't where the package would look). */
const quickjs = () => (engine ??= newQuickJSWASMModuleFromVariant(wasmModule ? newVariant(variant, { wasmModule }) : variant))

/** QuickJS's WebAssembly, compiled once by the host (and shared by its workers), if not from its package's own file: before the first run. */
export function useWasm(module: WasmModule): void {
  wasmModule ??= module
}

export async function runPlugin(run: PluginRun): Promise<PluginOutput> {
  const limits = { ...DEFAULT_LIMITS, ...run.limits }
  const runtime = (await quickjs()).newRuntime()
  const deadline = Date.now() + limits.timeMs
  runtime.setMemoryLimit(limits.memory)
  runtime.setMaxStackSize(1024 * 1024)
  runtime.setInterruptHandler(() => Date.now() > deadline)
  // Its own modules, by path in its folder; nothing else can be imported.
  // (A path it can't have is passed on as why, for the loader to say: QuickJS doesn't keep the normalizer's errors.)
  runtime.setModuleLoader(
    (name) => {
      if (name.startsWith(REFUSED)) throw new Error(name.slice(REFUSED.length))
      const code = run.files[name]
      if (code === undefined) throw new Error(`There is no ${name} in the plugin`)
      return code
    },
    (base, name) => {
      try {
        return resolvePath(base, name)
      } catch (err) {
        return REFUSED + (err as Error).message
      }
    }
  )
  const vm = runtime.newContext()
  // Answers from the app that come after the run has ended (it failed, or ran out of time) go nowhere.
  const open = { now: true }
  try {
    return await Promise.race([execute(vm, runtime, run, limits, open), timeout(limits.timeMs)])
  } finally {
    open.now = false
    vm.dispose()
    runtime.dispose()
  }
}

/** Fails once a run's time is up, even while it waits on the app. */
const timeout = (ms: number) =>
  new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new PluginError(`It took longer than ${Math.round(ms / 1000)} s and was stopped`)), ms)
    timer.unref?.()
  })

async function execute(vm: QuickJSContext, runtime: QuickJSRuntime, run: PluginRun, limits: PluginLimits, open: { now: boolean }): Promise<PluginOutput> {
  let calls = 0
  /** A host function that answers later: a promise in the plugin, settled when the app answers. */
  const later = (name: string, answer: (...args: unknown[]) => Promise<unknown>) =>
    vm.newFunction(name, (...handles) => {
      const args = handles.map((h) => vm.dump(h))
      const deferred = vm.newPromise()
      const settle = (ok: boolean, value: unknown) => {
        if (!open.now || !deferred.alive) return
        const handle = ok ? vm.newString(JSON.stringify(value ?? null)) : vm.newError(errorText(value))
        if (ok) deferred.resolve(handle)
        else deferred.reject(handle)
        handle.dispose()
        deferred.dispose()
        runtime.executePendingJobs()
      }
      // Settled after this returns, always: the plugin gets its promise first.
      const answered = ++calls > limits.calls ? Promise.reject(new Error(`It asked the app for more than ${limits.calls} things in one run`)) : answer(...args)
      answered.then(
        (v) => settle(true, v),
        (err) => settle(false, err)
      )
      return deferred.handle
    })

  const host = vm.newObject()
  const fns = {
    call: later('call', (op, json) => run.host.call(String(op), JSON.parse(String(json)))),
    pickFile: later('pickFile', (json) => run.host.pickFile(JSON.parse(String(json)))),
    png: later('png', (w, h, rgba) => run.host.png(Number(w), Number(h), String(rgba))),
    log: vm.newFunction('log', (line) => void run.host.log(String(vm.dump(line)).slice(0, 2000))),
    toBase64: vm.newFunction('toBase64', (buffer) => {
      const bytes = vm.getArrayBuffer(buffer)
      try {
        return vm.newString(Buffer.from(bytes.value).toString('base64'))
      } finally {
        bytes.dispose()
      }
    }),
    fromBase64: vm.newFunction('fromBase64', (text) => {
      const bytes = Buffer.from(vm.getString(text), 'base64')
      return vm.newArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    })
  }
  for (const [name, fn] of Object.entries(fns)) {
    vm.setProp(host, name, fn)
    fn.dispose()
  }
  vm.setProp(vm.global, '__host', host)
  host.dispose()
  vm.unwrapResult(vm.evalCode(PRELUDE, 'universe.js')).dispose()

  // The plugin's code, as a module: what it exports, once it has run (it may await at its top level).
  const code = run.files[run.main]
  if (code === undefined) throw new PluginError(`Its code, ${run.main}, isn’t in its folder`)
  const exports = await settled(vm, runtime, vm.evalCode(code, run.main, { type: 'module' }))
  const invoke = vm.getProp(vm.global, '__invoke')
  const args = [exports, vm.newString(run.kind), vm.newString(run.id), vm.newString(JSON.stringify(run.input))]
  const result = vm.callFunction(invoke, vm.undefined, args)
  invoke.dispose()
  args.forEach((a) => a.dispose())
  const out = await settled(vm, runtime, result)
  const json = vm.getString(out)
  out.dispose()
  return parseOutput(run.kind, json)
}

/** A result's value once it (a promise, perhaps) settles, driving the plugin's jobs meanwhile; its error as a PluginError. */
async function settled(vm: QuickJSContext, runtime: QuickJSRuntime, result: ReturnType<QuickJSContext['evalCode']>): Promise<QuickJSHandle> {
  if (result.error) throw thrown(vm, result.error)
  const promise = vm.resolvePromise(result.value)
  result.value.dispose()
  runtime.executePendingJobs()
  const done = await promise
  if (done.error) throw thrown(vm, done.error)
  return done.value
}

function thrown(vm: QuickJSContext, error: QuickJSHandle): PluginError {
  const e = vm.dump(error) as { name?: string; message?: string; stack?: string } | string
  error.dispose()
  if (typeof e !== 'object' || !e) return new PluginError(String(e))
  if (e.message === 'interrupted') return new PluginError('It ran too long and was stopped')
  if (e.message === 'out of memory') return new PluginError('It used more memory than a plugin may and was stopped')
  const where = e.stack?.split('\n').find((l) => l.trim().startsWith('at '))?.trim()
  return new PluginError(`${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message ?? 'It failed'}${where ? ` (${where})` : ''}`)
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

const REFUSED = 'refused-import:'

/** A module path from an import in `base` (both relative to the plugin's folder); never outside it. */
export function resolvePath(base: string, name: string): string {
  if (!name.startsWith('./') && !name.startsWith('../')) throw new Error(`A plugin can import only its own files (./…), not ${name}`)
  const parts = base.split('/').slice(0, -1)
  for (const part of name.split('/')) {
    if (part === '..') {
      if (!parts.length) throw new Error(`${name} is outside the plugin`)
      parts.pop()
    } else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

const MAX_NAMES = 1000
const MAX_FILES = 10_000

/** What the plugin answered, checked: it's the code's own JSON, so nothing in it is trusted. */
function parseOutput(kind: ContributionKind, json: string): PluginOutput {
  const value: unknown = JSON.parse(json)
  if (kind === 'names') {
    if (!Array.isArray(value)) throw new PluginError('A name generator gives back a list of names')
    return { kind, names: value.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim().slice(0, 200)).slice(0, MAX_NAMES) }
  }
  if (kind === 'exporters') {
    if (!Array.isArray(value)) throw new PluginError('An exporter gives back a list of files ({ name, text } or { name, bytes })')
    const files = value.slice(0, MAX_FILES).map((f: unknown, i): ExportedFile => {
      const file = f as { name?: unknown; text?: unknown; base64?: unknown }
      if (typeof file?.name !== 'string' || !file.name) throw new PluginError(`File ${i + 1} has no name`)
      if (typeof file.text === 'string') return { name: file.name, text: file.text }
      if (typeof file.base64 === 'string') return { name: file.name, base64: file.base64 }
      throw new PluginError(`${file.name} has neither text nor bytes`)
    })
    return { kind, files }
  }
  return { kind, ...(typeof value === 'string' && value && { summary: value.slice(0, 500) }) }
}
