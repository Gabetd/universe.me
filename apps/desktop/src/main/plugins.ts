import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { operationNamed, runOperation, type ApiContext, type ApiHost } from '@universe/api'
import { defaultOptions, readManifest, type ContributionKind, type PluginManifest, type PluginOption } from '@universe/plugins/manifest'
import type { PluginOutput, PluginRun } from '@universe/plugins'
import type { AppState, PluginInfo, PluginRunRequest, PluginRunResult } from '../shared/api'
import { encodePng } from './png'
import type { FromWorker, ToWorker } from './plugin.worker'
import createPluginWorker from './plugin.worker?nodeWorker'
import quickjsWasm from '@jitl/quickjs-wasmfile-release-sync/wasm?asset'
import type { Session } from './session'
import templateMain from '../../plugin-template/main.js?raw'
import templateManifest from '../../plugin-template/plugin.json?raw'
import templateReadme from '../../plugin-template/README.md?raw'

/**
 * Plugins (PLAN.md §9, M16): folders in the app's own plugins folder, and
 * folders of the user's the app points to. Each run happens in a worker of
 * its own, the plugin's code sandboxed there (packages/plugins); what it asks
 * of the app comes here: the API's operations (a generator's writes go
 * through the bus as the plugin's, made one undoable step when it's done, or
 * taken back if it fails), a file the user picks, a PNG. An exporter's files
 * are written only where the user says.
 */

/** What the plugin manager needs of the app. */
export interface PluginApp {
  session: Session
  /** The API's operations with these writes (ApiController.pluginContext). */
  context(write: ApiHost['write']): ApiContext
  /** The project changed: the window (and phones) are shown it. */
  changed(state: AppState, summary: string): void
  dialogs: {
    /** A folder the user picks, or null. */
    folder(title: string, buttonLabel: string): Promise<string | null>
    /** A file the user picks to open, or null. */
    openFile(title: string, extensions: string[]): Promise<string | null>
    /** Where the user saves a file, or null. */
    saveFile(title: string, name: string): Promise<string | null>
  }
  /** Opens a folder in the file manager. */
  show(path: string): Promise<void>
  /** Puts a folder in the bin. */
  trash(path: string): Promise<void>
}

/** A run's limits: what a plugin may change, and how big a file it may read or make. */
const MAX_CHANGES = 10_000
const MAX_CODE_BYTES = 10 * 1024 * 1024
const MAX_CODE_FILES = 500
const MAX_PICKED_BYTES = 20 * 1024 * 1024
const MAX_LOG = 500
/** How long a run may take (the sandbox stops it first; this is for a worker that doesn't answer). */
const RUN_MS = 130_000

interface Settings {
  /** Folders of the user's the app points to. */
  folders: string[]
  /** Plugins turned off, by id. */
  disabled: string[]
}

interface Found {
  info: PluginInfo
  /** Its modules by path, read when it runs. */
  folder: string
}

export class Plugins {
  private settings: Settings
  private logs = new Map<string, string[]>()
  private running = false

  constructor(
    private readonly userData: string,
    private readonly app: PluginApp
  ) {
    this.settings = this.load()
  }

  /** The app's own plugins folder. */
  get folder(): string {
    return join(this.userData, 'plugins')
  }

  list(): PluginInfo[] {
    return this.found().map((f) => f.info)
  }

  async add(): Promise<PluginInfo[] | null> {
    const path = await this.app.dialogs.folder('Add a plugin: pick its folder (the one with plugin.json in it)', 'Add plugin')
    if (!path) return null
    if (!existsSync(join(path, 'plugin.json'))) throw new Error('That folder has no plugin.json: pick the folder a plugin is in')
    if (!this.settings.folders.includes(path) && !this.isOwn(path)) this.save({ ...this.settings, folders: [...this.settings.folders, path] })
    return this.list()
  }

  /** A new plugin from the template, in the app's plugins folder (named so it's unique), opened in the file manager. */
  async create(): Promise<PluginInfo[]> {
    mkdirSync(this.folder, { recursive: true })
    const taken = new Set(this.list().map((p) => p.id))
    let n = 1
    while (taken.has(`my-plugin-${n}`) || existsSync(join(this.folder, `my-plugin-${n}`))) n++
    const id = `my-plugin-${n}`
    const dir = join(this.folder, id)
    mkdirSync(dir)
    const manifest = JSON.parse(templateManifest) as PluginManifest
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...manifest, id, name: `My plugin ${n}` }, null, 2) + '\n')
    writeFileSync(join(dir, 'main.js'), templateMain)
    writeFileSync(join(dir, 'README.md'), templateReadme)
    await this.app.show(dir)
    return this.list()
  }

  async remove(id: string): Promise<PluginInfo[]> {
    const found = this.find(id)
    if (found.info.linked) this.save({ ...this.settings, folders: this.settings.folders.filter((f) => f !== found.folder) })
    else await this.app.trash(found.folder)
    return this.list()
  }

  setEnabled(id: string, enabled: boolean): PluginInfo[] {
    const disabled = this.settings.disabled.filter((d) => d !== id)
    this.save({ ...this.settings, disabled: enabled ? disabled : [...disabled, id] })
    return this.list()
  }

  show(id: string): Promise<void> {
    return this.app.show(this.find(id).folder)
  }

  /** Runs one contribution of a plugin: its changes made one undoable step, its files saved where the user says, or its names given back. */
  async run(request: PluginRunRequest): Promise<PluginRunResult> {
    if (this.running) throw new Error('A plugin is running already: wait for it to finish')
    const { info, folder } = this.find(request.pluginId)
    if (info.error || !info.manifest) throw new Error(`${info.id} can’t run: ${info.error ?? 'it has no plugin.json'}`)
    if (!info.enabled) throw new Error(`${info.manifest.name} is turned off`)
    const contribution = info.manifest[request.kind].find((c) => c.id === request.id)
    if (!contribution) throw new Error(`${info.manifest.name} has no ${request.kind} ${request.id}`)
    const state = this.app.session.state()
    if (!state.project) throw new Error('Open a universe first')
    if ('on' in contribution && contribution.on === 'world' && !state.nodes.some((n) => n.id === request.worldId && n.kind === 'world')) throw new Error(`${contribution.title} runs on a world: pick one first`)

    const log: string[] = []
    this.logs.set(info.id, log)
    const input = {
      universeId: state.project.rootId,
      ...(request.worldId && { worldId: request.worldId }),
      options: optionsFor(contribution.options, request.options),
      seed: Math.floor(Math.random() * 2 ** 31),
      ...(request.naming && { for: request.naming.for, count: Math.max(1, Math.min(100, Math.floor(request.naming.count))) })
    }
    this.running = true
    let changes = 0
    const summaries: string[] = []
    const ctx = this.app.context((command, summary) => {
      if (request.kind !== 'generators') throw new Error('Only a generator can change the universe')
      if (++changes > MAX_CHANGES) throw new Error(`A plugin can make at most ${MAX_CHANGES} changes in one run`)
      this.app.session.execute(command, 'plugin')
      summaries.push(summary)
      return { status: 'applied' }
    })
    try {
      const output = await this.work({ files: readCode(folder), main: info.manifest.main, kind: request.kind, id: request.id, input }, request.kind, ctx, log)
      const summary = (output.kind === 'generators' && output.summary) || summaryOf(summaries, contribution.title)
      if (changes) this.app.changed(this.app.session.groupLatest(changes), `${info.manifest.name}: ${summary}`)
      return { summary, changes, log, ...(output.kind === 'exporters' && { saved: await this.saveFiles(output.files, contribution.title) }), ...(output.kind === 'names' && { names: output.names }) }
    } catch (err) {
      // Nothing of a failed run is left behind.
      if (changes) this.app.changed(this.app.session.undoLatest(changes), `${info.manifest.name} failed; its changes were taken back`)
      throw new Error(`${info.manifest.name}: ${(err as Error).message}`)
    } finally {
      this.running = false
    }
  }

  /** The run in a worker of its own, answering what the plugin asks. */
  private work(run: Omit<PluginRun, 'host'>, kind: ContributionKind, ctx: ApiContext, log: string[]): Promise<PluginOutput> {
    const worker = createPluginWorker({})
    const send = (message: ToWorker) => worker.postMessage(message)
    return new Promise<PluginOutput>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('It stopped answering')), RUN_MS)
      const finish = () => {
        clearTimeout(timer)
        void worker.terminate()
      }
      worker.on('message', (message: FromWorker) => {
        if (message.type === 'log') {
          if (log.length < MAX_LOG) log.push(message.line)
        } else if (message.type === 'done') {
          finish()
          resolve(message.output)
        } else if (message.type === 'failed') {
          finish()
          reject(new Error(message.error))
        } else
          this.answer(message, kind, ctx).then(
            (value) => send({ type: 'answer', ask: message.ask, ok: true, value }),
            (err: Error) => send({ type: 'answer', ask: message.ask, ok: false, error: err.message })
          )
      })
      worker.on('error', (err) => {
        finish()
        reject(err)
      })
      worker.on('exit', () => reject(new Error('It stopped')))
      send({ type: 'run', run, wasm: wasm() })
    })
  }

  /** What a plugin asked of the app. */
  private async answer({ what, args }: Extract<FromWorker, { type: 'ask' }>, kind: ContributionKind, ctx: ApiContext): Promise<unknown> {
    if (what === 'call') {
      const [name, input] = args as [string, unknown]
      const op = operationNamed(name)
      if (!op) throw new Error(`There is no operation ${name}`)
      if (op.write && kind !== 'generators') throw new Error(`${name} changes the universe, and only a generator can`)
      return runOperation(ctx, name, input)
    }
    if (what === 'png') {
      const [width, height, rgba] = args as [number, number, string]
      return encodePng(width, height, Buffer.from(rgba, 'base64')).toString('base64')
    }
    const [options] = args as [{ title?: string; extensions?: string[] }]
    const extensions = (options?.extensions ?? []).filter((e) => typeof e === 'string' && /^\w{1,10}$/.test(e))
    const path = await this.app.dialogs.openFile(String(options?.title ?? 'A plugin asks for a file'), extensions)
    if (!path) return null
    if (statSync(path).size > MAX_PICKED_BYTES) throw new Error('That file is too big for a plugin to read (20 MB at most)')
    return { name: basename(path), text: readFileSync(path, 'utf8') }
  }

  /** An exporter's files, written where the user says: one file where they save it, several in a folder they pick. */
  private async saveFiles(files: Extract<PluginOutput, { kind: 'exporters' }>['files'], title: string): Promise<string[]> {
    if (!files.length) return []
    const bytes = (f: (typeof files)[number]) => ('text' in f ? Buffer.from(f.text) : Buffer.from(f.base64, 'base64'))
    if (files.length === 1) {
      const path = await this.app.dialogs.saveFile(title, basename(safePath(files[0]!.name)))
      if (!path) return []
      await writeFile(path, bytes(files[0]!))
      return [path]
    }
    const dir = await this.app.dialogs.folder(`${title}: pick a folder for its ${files.length} files`, 'Save here')
    if (!dir) return []
    const saved: string[] = []
    for (const f of files) {
      const path = join(dir, safePath(f.name))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes(f))
      saved.push(path)
    }
    return saved
  }

  private found(): Found[] {
    const own = existsSync(this.folder)
      ? readdirSync(this.folder, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => ({ folder: join(this.folder, d.name), linked: false }))
      : []
    const seen = new Set<string>()
    return [...own, ...this.settings.folders.map((folder) => ({ folder, linked: true }))].map(({ folder, linked }) => {
      const info = this.read(folder, linked)
      if (seen.has(info.id)) return { folder, info: { ...info, error: `Another plugin has the id ${info.id}` } }
      seen.add(info.id)
      return { folder, info }
    })
  }

  private read(folder: string, linked: boolean): PluginInfo {
    const base = { path: folder, linked, log: [] as string[] }
    let text: string
    try {
      text = readFileSync(join(folder, 'plugin.json'), 'utf8')
    } catch {
      return { ...base, id: basename(folder), enabled: false, error: existsSync(folder) ? 'Its folder has no plugin.json' : 'Its folder isn’t there any more' }
    }
    const read = readManifest(text)
    if ('error' in read) return { ...base, id: basename(folder), enabled: false, error: read.error }
    const { manifest } = read
    const error = existsSync(join(folder, manifest.main)) ? undefined : `Its code, ${manifest.main}, isn’t in its folder`
    return { ...base, id: manifest.id, manifest, enabled: !this.settings.disabled.includes(manifest.id), log: this.logs.get(manifest.id) ?? [], ...(error && { error }) }
  }

  private find(id: string): Found {
    const found = this.found().find((f) => f.info.id === id)
    if (!found) throw new Error(`There is no plugin ${id}`)
    return found
  }

  private isOwn(path: string): boolean {
    const rel = relative(this.folder, resolve(path))
    return !!rel && !rel.startsWith('..')
  }

  private get file(): string {
    return join(this.userData, 'plugins.json')
  }

  private load(): Settings {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      return { folders: strings(saved.folders), disabled: strings(saved.disabled) }
    } catch {
      return { folders: [], disabled: [] }
    }
  }

  private save(settings: Settings): void {
    this.settings = settings
    writeFileSync(this.file, JSON.stringify(settings, null, 2))
  }
}

/** QuickJS's WebAssembly, read once here (where the app's packaged files can be read) for each run's worker. */
let wasmBytes: ArrayBuffer | undefined
const wasm = () => (wasmBytes ??= new Uint8Array(readFileSync(quickjsWasm)).buffer)

/** A run's options: each one the contribution asks for, the user's value if it fits, else its default. */
function optionsFor(options: readonly PluginOption[], given: Record<string, unknown>): Record<string, unknown> {
  const out = defaultOptions(options)
  for (const o of options) {
    const v = given[o.id]
    if (o.type === 'number' && typeof v === 'number' && Number.isFinite(v)) out[o.id] = Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v))
    else if (o.type === 'text' && typeof v === 'string') out[o.id] = v.slice(0, 10_000)
    else if (o.type === 'flag' && typeof v === 'boolean') out[o.id] = v
    else if (o.type === 'choice' && typeof v === 'string' && o.choices.includes(v)) out[o.id] = v
  }
  return out
}

/** What a generator did, in words, if it didn't say: its changes' own summaries, the first few. */
function summaryOf(summaries: string[], title: string): string {
  if (!summaries.length) return `${title}: nothing changed`
  const shown = summaries.slice(0, 3).join('; ')
  return summaries.length > 3 ? `${shown} and ${summaries.length - 3} more` : shown
}

/** A file name from a plugin, as a path inside the folder it's saved in: never above it, nor absolute. */
export function safePath(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    // Characters no file system takes (and control characters) become dashes.
    .map((p) => [...p].map((ch) => (ch < ' ' || '<>:"|?*'.includes(ch) ? '-' : ch)).join('').trim())
    .filter((p) => p && p !== '.' && p !== '..')
  if (!parts.length) throw new Error(`“${name}” isn’t a file name`)
  return parts.join(sep)
}

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
