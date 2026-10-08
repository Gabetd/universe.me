import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiServer, OAuth, apiContext, clearDiscovery, fileStore, worldBible, writeDiscovery, writePrivate, type ApiContext, type ApiHost } from '@universe/api'
import type { TerrainParams } from '@universe/core'
import type { BaseTerrain } from '@universe/procgen'
import { app } from 'electron'
import createTerrainWorker from './terrain.worker?nodeWorker'
import type { AiChange, ApiSettingsPatch, ApiStatus, AppState, PhoneStatus, TailscaleState } from '../shared/api'
import type { Session } from './session'
import { setFunnel, tailscaleState } from './tailscale'

/** Where the API listens unless that's taken (then the next few ports are tried). */
const DEFAULT_PORT = 47615

interface ApiSettings {
  enabled: boolean
  review: boolean
  /** Phone access (PLAN.md §6.4), off until the user turns it on. */
  phone: boolean
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
 * writes where it listens for `--mcp` servers to find. With phone access on,
 * it also answers the public address Tailscale Funnel forwards here, to
 * clients signed in with OAuth.
 */
export class ApiController {
  private settings: ApiSettings
  private server: ApiServer | undefined
  private port: number | null = null
  private error: string | undefined
  private tailscale: TailscaleState = { kind: 'missing' }
  private phoneError: string | undefined
  private syncing = Promise.resolve()
  private readonly oauth: OAuth
  readonly ctx: ApiContext

  constructor(
    private readonly userData: string,
    private readonly session: Session,
    private readonly events: ApiEvents,
    private readonly version: string
  ) {
    this.settings = this.load()
    this.ctx = apiContext(this.host())
    // Sign-ins and connections show in Connect AI as they come and go.
    this.oauth = new OAuth(fileStore(join(userData, 'api-oauth.json')), () => this.events.status(this.status()))
  }

  /** The project is about to be opened: `--mcp` servers should wait for it rather than open the file too. */
  opening(path: string): void {
    this.announce(path)
  }

  async start(): Promise<void> {
    await this.stop()
    this.error = undefined
    if (this.settings.enabled) {
      const server = new ApiServer(this.ctx, { token: this.settings.token, version: this.version, oauth: this.oauth, publicHost: () => this.publicHost() })
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
    // Funnel follows the port, which can change from one start to the next.
    if (this.settings.phone) void this.syncPhone()
  }

  async stop(): Promise<void> {
    await this.server?.close()
    this.server = undefined
    this.port = null
  }

  /** At quit: no `--mcp` server is pointed here any more (at once: the process may end before anything async finishes), and nothing is left listening. */
  close(): void {
    clearDiscovery()
    void this.stop()
  }

  async set(patch: ApiSettingsPatch): Promise<ApiStatus> {
    const restart = patch.enabled !== undefined && patch.enabled !== this.settings.enabled
    const phone = patch.phone !== undefined && patch.phone !== this.settings.phone
    this.settings = { ...this.settings, ...patch }
    this.save()
    if (restart) await this.start()
    else if (phone) await this.syncPhone()
    else this.announce()
    return this.status()
  }

  denySignIn(id: string): ApiStatus {
    this.oauth.deny(id)
    return this.status()
  }

  removeConnection(id: string): ApiStatus {
    this.oauth.revoke(id)
    return this.status()
  }

  /**
   * Looks at Tailscale again and, with phone access on, points Funnel at the
   * API's port (or, with it off, turns off a Funnel that points here).
   */
  syncPhone(): Promise<void> {
    // One at a time: each runs Tailscale's command, and the last one's answer is what shows.
    this.syncing = this.syncing.then(() => this.lookAtTailscale())
    return this.syncing
  }

  private async lookAtTailscale(): Promise<void> {
    this.phoneError = undefined
    this.tailscale = await tailscaleState()
    const ts = this.tailscale
    if (ts.kind === 'ready' && this.port !== null) {
      const wanted = this.settings.phone ? this.port : null
      const ours = ts.funnelPort === this.port
      if ((wanted !== null && !ours) || (wanted === null && ours)) {
        try {
          await setFunnel(wanted)
          this.tailscale = await tailscaleState()
        } catch (err) {
          this.phoneError = (err as Error).message
        }
      }
    }
    this.events.status(this.status())
  }

  /** The public host while phone access is on and Funnel forwards it here; requests for any other host are turned away. */
  private publicHost(): string | undefined {
    const ts = this.tailscale
    return this.settings.phone && ts.kind === 'ready' && ts.funnelPort !== null && ts.funnelPort === this.port ? ts.host : undefined
  }

  async newToken(): Promise<ApiStatus> {
    this.settings = { ...this.settings, token: newToken() }
    this.save()
    await this.start()
    return this.status()
  }

  /** The project opened or closed: `--mcp` servers should know which file the app has, and nothing from the last one is kept. */
  projectChanged(): void {
    this.ctx.models.reset()
    this.announce()
  }

  /** A change made in the app, for the change feed. */
  changedHere(summary: string): void {
    this.server?.changed({ summary, source: 'user', at: new Date().toISOString() })
  }

  /** A world's bible as Markdown. */
  bible(worldId: string): Promise<string> {
    return worldBible(this.ctx, worldId)
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
      connect: port === null ? null : { http: `claude mcp add --transport http universe http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`, stdio: stdioCommand(this.session.path) },
      phone: this.phoneStatus()
    }
  }

  private phoneStatus(): PhoneStatus {
    const host = this.publicHost()
    return {
      on: this.settings.phone,
      tailscale: this.tailscale,
      url: host ? `https://${host}/mcp` : null,
      ...(this.phoneError && { error: this.phoneError }),
      signIns: this.oauth.pendingSignIns(),
      connections: this.oauth.connections()
    }
  }

  private announce(opening?: string): void {
    try {
      writeDiscovery({ pid: process.pid, port: this.port, token: this.settings.token, project: this.session.path ?? null, ...(opening && { opening }), version: this.version })
    } catch (err) {
      // The API still works over HTTP; only `--mcp` servers won't find it.
      this.error = `Couldn’t say where the API is for stdio servers: ${(err as Error).message}`
    }
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
    return join(this.userData, 'api-settings.json')
  }

  private load(): ApiSettings {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ApiSettings>
      if (typeof saved.token === 'string' && saved.token.length >= 32) return { enabled: saved.enabled !== false, review: saved.review === true, phone: saved.phone === true, token: saved.token }
    } catch {
      // First run, or an unreadable file: start over.
    }
    const fresh = { enabled: true, review: false, phone: false, token: newToken() }
    this.save(fresh)
    return fresh
  }

  /** The token is a secret, so the file is the user's alone. */
  private save(settings = this.settings): void {
    writePrivate(this.file, JSON.stringify(settings, null, 2))
  }
}

const newToken = () => randomBytes(24).toString('base64url')

/** A word for the user's shell, taken literally: single quotes on macOS and Linux (no $, ` or \\ is read), double quotes on Windows. */
const shellWord = (word: string) => (process.platform === 'win32' ? `"${word.replace(/"/g, '""')}"` : `'${word.replace(/'/g, `'\\''`)}'`)

/** The command that adds the stdio server to Claude Code: this app's executable with --mcp, and the open project. */
function stdioCommand(project: string | undefined): string {
  // An AppImage runs from a new mount each time: the AppImage file itself is what stays put.
  const exe = process.env.APPIMAGE ?? process.execPath
  const args = app.isPackaged ? [] : [app.getAppPath()]
  return `claude mcp add universe -- ${[exe, ...args].map(shellWord).join(' ')} --mcp --project ${project ? shellWord(project) : '<path to your .universe file>'}`
}

/** Worlds' base terrain from a worker thread, so a query about structures doesn't hold up the window. */
let worker: ReturnType<typeof createTerrainWorker> | undefined
const pending = new Map<number, { resolve(base: BaseTerrain): void; reject(err: Error): void }>()
let nextId = 0

function baseTerrain(seed: number, params: TerrainParams): Promise<BaseTerrain> {
  if (!worker) {
    const w = createTerrainWorker({})
    worker = w
    w.unref()
    w.on('message', ({ id, base, error }: { id: number; base?: BaseTerrain; error?: string }) => {
      const call = pending.get(id)
      pending.delete(id)
      if (error) call?.reject(new Error(error))
      else call?.resolve(base!)
    })
    // A worker that fails or stops takes its unanswered calls with it; the next call starts a new one.
    const fail = (err: Error) => {
      for (const call of pending.values()) call.reject(err)
      pending.clear()
      if (worker === w) worker = undefined
    }
    w.on('error', fail)
    w.on('exit', () => fail(new Error('The terrain worker stopped')))
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, seed, params })
  })
}
