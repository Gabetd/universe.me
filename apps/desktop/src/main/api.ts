import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiServer, apiContext, clearDiscovery, exportWorldBible, writeDiscovery, type ApiContext, type ApiHost } from '@universe/api'
import type { TerrainParams } from '@universe/core'
import type { BaseTerrain } from '@universe/procgen'
import { app } from 'electron'
import createTerrainWorker from './terrain.worker?nodeWorker'
import type { AiChange, ApiStatus, AppState } from '../shared/api'
import type { Session } from './session'

/** Where the API listens unless that's taken (then the next few ports are tried). */
const DEFAULT_PORT = 47615

interface ApiSettings {
  enabled: boolean
  review: boolean
  token: string
}

/** What the controller tells the window. */
export interface ApiEvents {
  state(state: AppState): void
  aiChange(change: AiChange): void
  status(status: ApiStatus): void
}

/**
 * The local API in the app (PLAN.md §6): serves the open project to AI
 * clients over REST and MCP while "Let AI connect" is on, applies their
 * writes as the AI's (or holds them for review), tells the window, and
 * writes where it listens for `--mcp` servers to find.
 */
export class ApiController {
  private settings: ApiSettings
  private server: ApiServer | undefined
  private port: number | null = null
  private error: string | undefined
  readonly ctx: ApiContext

  constructor(
    private readonly userData: string,
    private readonly session: Session,
    private readonly events: ApiEvents,
    private readonly version: string
  ) {
    this.settings = this.load()
    this.ctx = apiContext(this.host())
  }

  async start(): Promise<void> {
    await this.stop()
    this.error = undefined
    if (this.settings.enabled) {
      const server = new ApiServer(this.ctx, { token: this.settings.token, version: this.version })
      const wanted = process.env.UNIVERSE_API_PORT === undefined ? DEFAULT_PORT : Number(process.env.UNIVERSE_API_PORT)
      for (let port = wanted; port < wanted + (wanted ? 10 : 1); port++) {
        try {
          this.port = await server.listen(port)
          this.server = server
          break
        } catch (err) {
          this.error = `Couldn’t listen on port ${port}: ${(err as Error).message}`
        }
      }
      if (this.server) this.error = undefined
    }
    this.announce()
  }

  async stop(): Promise<void> {
    await this.server?.close()
    this.server = undefined
    this.port = null
  }

  /** At quit: nothing is left listening, and no `--mcp` server is pointed here. */
  async close(): Promise<void> {
    await this.stop()
    clearDiscovery()
  }

  async set(patch: Partial<Pick<ApiSettings, 'enabled' | 'review'>>): Promise<ApiStatus> {
    const restart = patch.enabled !== undefined && patch.enabled !== this.settings.enabled
    this.settings = { ...this.settings, ...patch }
    this.save()
    if (restart) await this.start()
    else this.announce()
    return this.status()
  }

  async newToken(): Promise<ApiStatus> {
    this.settings = { ...this.settings, token: newToken() }
    this.save()
    await this.start()
    return this.status()
  }

  /** The project opened or closed: `--mcp` servers should know which file the app has. */
  projectChanged(): void {
    this.announce()
  }

  /** A change made in the app, for the change feed. */
  changedHere(summary: string): void {
    this.server?.changed({ summary, source: 'user', at: new Date().toISOString() })
  }

  /** A world's bible as Markdown. */
  async bible(worldId: string): Promise<string> {
    return (await exportWorldBible(this.ctx, worldId, 'markdown')) as string
  }

  status(): ApiStatus {
    const { enabled, review, token } = this.settings
    const port = this.port
    return {
      enabled,
      review,
      port,
      ...(this.error && { error: this.error }),
      token,
      connect: port === null ? null : { http: `claude mcp add --transport http universe http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`, stdio: stdioCommand(this.session.path) }
    }
  }

  private announce(): void {
    writeDiscovery({ pid: process.pid, port: this.port, token: this.settings.token, project: this.session.path ?? null, version: this.version })
    this.events.status(this.status())
  }

  private host(): ApiHost {
    return {
      project: () => {
        const state = this.session.state()
        return state.project ? { name: state.project.name, rootId: state.project.rootId, data: state } : undefined
      },
      terrainLayers: (worldId) => this.session.terrain(worldId),
      write: (command, summary) => {
        if (this.settings.review) {
          const proposalId = this.session.propose(command, summary)
          // The window shows it with the other suggestions.
          this.events.state(this.session.state())
          return { status: 'proposed', proposalId }
        }
        this.events.state(this.session.execute(command, 'ai'))
        this.events.aiChange({ summary })
        this.server?.changed({ summary, source: 'ai', at: new Date().toISOString() })
        return { status: 'applied' }
      },
      baseTerrain
    }
  }

  private get file(): string {
    return join(this.userData, 'api.json')
  }

  private load(): ApiSettings {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ApiSettings>
      if (typeof saved.token === 'string' && saved.token.length >= 32) return { enabled: saved.enabled !== false, review: saved.review === true, token: saved.token }
    } catch {
      // First run, or an unreadable file: start over.
    }
    const fresh = { enabled: true, review: false, token: newToken() }
    this.settings = fresh
    this.save()
    return fresh
  }

  /** The token is a secret, so the file is the user's alone. */
  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2), { mode: 0o600 })
  }
}

const newToken = () => randomBytes(24).toString('base64url')

/** The command that adds the stdio server to Claude Code: this app's executable with --mcp, and the open project. */
function stdioCommand(project: string | undefined): string {
  // An AppImage runs from a new mount each time: the AppImage file itself is what stays put.
  const exe = process.env.APPIMAGE ?? process.execPath
  const args = app.isPackaged ? [] : [app.getAppPath()]
  return `claude mcp add universe -- ${[exe, ...args].map((a) => `"${a}"`).join(' ')} --mcp --project "${project ?? '<path to your .universe file>'}"`
}

/** Worlds' base terrain from a worker thread, so a query about structures doesn't hold up the window. */
let worker: ReturnType<typeof createTerrainWorker> | undefined
const pending = new Map<number, { resolve(base: BaseTerrain): void; reject(err: Error): void }>()
let nextId = 0

function baseTerrain(seed: number, params: TerrainParams): Promise<BaseTerrain> {
  if (!worker) {
    worker = createTerrainWorker({})
    worker.unref()
    worker.on('message', ({ id, base, error }: { id: number; base?: BaseTerrain; error?: string }) => {
      const call = pending.get(id)
      pending.delete(id)
      if (error) call?.reject(new Error(error))
      else call?.resolve(base!)
    })
    worker.on('error', (err) => {
      for (const call of pending.values()) call.reject(err)
      pending.clear()
      worker = undefined
    })
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, seed, params })
  })
}
