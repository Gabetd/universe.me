import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { operationNamed, writePrivate, type ApiContext, type ApiHost } from '@universe/api'
import { optionsFor, readManifest, type ContributionKind, type PluginManifest } from '@universe/plugins/manifest'
import { DEFAULT_LIMITS, type PluginOutput } from '@universe/plugins'
import type { AppState, PluginInfo, PluginRunRequest, PluginRunResult } from '../shared/api'
import type { FromWorker, ToWorker, WorkerRun } from './plugin.worker'
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

/** How big a file a plugin may read. */
const MAX_PICKED_BYTES = 20 * 1024 * 1024
const MAX_LOG = 500
/** How many of an exporter's files are written at once. */
const SAVING_AT_ONCE = 16
/** How long a run may take: the sandbox stops it first; this is for a worker that doesn't answer. */
const RUN_MS = DEFAULT_LIMITS.timeMs + 10_000

interface Settings {
  /** Folders of the user's the app points to. */
  folders: string[]
  /** Plugins turned off, by id. */
  disabled: string[]
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
    const seen = new Set<string>()
    return this.folders().map(({ folder, linked }) => {
      const info = this.read(folder, linked)
      if (seen.has(info.id)) return { ...info, error: `Another plugin has the id ${info.id}` }
      seen.add(info.id)
      return info
    })
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
    const plugin = this.find(id)
    if (plugin.linked) this.save({ ...this.settings, folders: this.settings.folders.filter((f) => f !== plugin.path) })
    else await this.app.trash(plugin.path)
    return this.list()
  }

  setEnabled(id: string, enabled: boolean): PluginInfo[] {
    const disabled = this.settings.disabled.filter((d) => d !== id)
    this.save({ ...this.settings, disabled: enabled ? disabled : [...disabled, id] })
    return this.list()
  }

  show(id: string): Promise<void> {
    return this.app.show(this.find(id).path)
  }

  /** Runs one contribution of a plugin: its changes made one undoable step, its files saved where the user says, or its names given back. */
  async run(request: PluginRunRequest): Promise<PluginRunResult> {
    if (this.running) throw new Error('A plugin is running already: wait for it to finish')
    const info = this.find(request.pluginId)
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
      if (++changes > DEFAULT_LIMITS.changes) throw new Error(`A plugin can make at most ${DEFAULT_LIMITS.changes} changes in one run`)
      this.app.session.apply(command, 'plugin')
      summaries.push(summary)
      return { status: 'applied' }
    })
    try {
      const output = await this.work({ folder: info.path, main: info.manifest.main, kind: request.kind, id: request.id, input }, ctx, log)
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
  private async work(run: WorkerRun, ctx: ApiContext, log: string[]): Promise<PluginOutput> {
    const wasm = await quickjsModule()
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
          this.answer(message, run.kind, ctx).then(
            (value) => send({ type: 'answer', ask: message.ask, ok: true, value }),
            (err: Error) => send({ type: 'answer', ask: message.ask, ok: false, error: err.message })
          )
      })
      worker.on('error', (err) => {
        finish()
        reject(err)
      })
      worker.on('exit', () => reject(new Error('It stopped')))
      send({ type: 'run', run, wasm })
    })
  }

  /** What a plugin asked of the app. */
  private async answer({ what, args }: Extract<FromWorker, { type: 'ask' }>, kind: ContributionKind, ctx: ApiContext): Promise<unknown> {
    if (what === 'call') {
      const [name, input] = args as [string, unknown]
      const op = operationNamed(name)
      if (!op) throw new Error(`There is no operation ${name}`)
      if (op.write && kind !== 'generators') throw new Error(`${name} changes the universe, and only a generator can`)
      return op.run(ctx, op.input.parse(input))
    }
    const [options] = args as [{ title?: string; extensions?: string[] }]
    const extensions = (options?.extensions ?? []).filter((e) => typeof e === 'string' && /^\w{1,10}$/.test(e))
    const path = await this.app.dialogs.openFile(String(options?.title ?? 'A plugin asks for a file'), extensions)
    if (!path) return null
    if ((await stat(path)).size > MAX_PICKED_BYTES) throw new Error('That file is too big for a plugin to read (20 MB at most)')
    return { name: basename(path), text: await readFile(path, 'utf8') }
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
    const paths = files.map((f) => join(dir, safePath(f.name)))
    await Promise.all([...new Set(paths.map((p) => dirname(p)))].map((d) => mkdir(d, { recursive: true })))
    // A few at a time: a wiki can be thousands of pages.
    for (let i = 0; i < files.length; i += SAVING_AT_ONCE) await Promise.all(files.slice(i, i + SAVING_AT_ONCE).map((f, k) => writeFile(paths[i + k]!, bytes(f))))
    return paths
  }

  /** Every plugin folder: the app's own plugins folder's, then the user's it points to. */
  private folders(): { folder: string; linked: boolean }[] {
    const own = existsSync(this.folder)
      ? readdirSync(this.folder, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => ({ folder: join(this.folder, d.name), linked: false }))
      : []
    return [...own, ...this.settings.folders.map((folder) => ({ folder, linked: true }))]
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

  private find(id: string): PluginInfo {
    const found = this.list().find((p) => p.id === id)
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

  /** Kept the user's alone: it says which folders' code runs. */
  private save(settings: Settings): void {
    this.settings = settings
    writePrivate(this.file, JSON.stringify(settings, null, 2))
  }
}

/** QuickJS's WebAssembly, read (here, where the app's packaged files can be read) and compiled once, and shared with each run's worker. */
let compiled: Promise<WebAssembly.Module> | undefined
const quickjsModule = () => (compiled ??= readFile(quickjsWasm).then((bytes) => WebAssembly.compile(bytes)))

/** What a generator did, in words, if it didn't say: its changes' own summaries, the first few. */
function summaryOf(summaries: string[], title: string): string {
  if (!summaries.length) return `${title}: nothing changed`
  const shown = summaries.slice(0, 3).join('; ')
  return summaries.length > 3 ? `${shown} and ${summaries.length - 3} more` : shown
}

/** A file name from a plugin, as a path inside the folder it's saved in: never above it, nor absolute. */
function safePath(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    // Characters no file system takes (and control characters) become dashes.
    .map((p) => [...p].map((ch) => (ch < ' ' || '<>:"|?*'.includes(ch) ? '-' : ch)).join('').trim())
    .filter((p) => p && p !== '.' && p !== '..')
  if (!parts.length) throw new Error(`“${name}” isn’t a file name`)
  return parts.join(sep)
}
