import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiServer, OAuth, apiContext, clearDiscovery, fileStore, worldBible, writeDiscovery, writePrivate, type ApiContext, type ApiHost } from '@universe/api'
import type { TerrainParams } from '@universe/core'
import type { BaseTerrain } from '@universe/procgen'
import { app } from 'electron'
import createTerrainWorker from './terrain.worker?nodeWorker'
import type { AiChange, ApiSettingsPatch, ApiStatus, AppState, PhoneStatus, RemoteEvent, RemoteMethod, TailscaleState } from '../shared/api'
import { PhoneAppServer, type PhoneAppPlace } from './phone-app'
import { DeviceSync } from './device-sync'
import type { Session } from './session'
import { APP_HTTPS_PORT, offNow, setFunnel, setServe, tailscaleState } from './tailscale'

/** Where the API listens unless that's taken (then the next few ports are tried). */
const DEFAULT_PORT = 47615

interface ApiSettings {
  enabled: boolean
  review: boolean
  /** Phone access (PLAN.md §6.4), off until the user turns it on. */
  phone: boolean
  /** The phone app (PLAN.md §6.6), off until the user turns it on. */
  phoneApp: boolean
  /** Sync with the user's other devices (PLAN.md §6.7), off until the user turns it on. */
  sync: boolean
  token: string
}

/** What the phone app serves: the window's files, and the window's methods to answer. */
export interface PhoneBridge {
  files: string
  answer(method: RemoteMethod, args: unknown[]): Promise<unknown>
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
  private next: Promise<void> | undefined
  /** Where the app pointed Funnel, while it does. */
  private funnelTo: number | undefined
  private bridge: PhoneBridge | undefined
  private phoneApp: PhoneAppServer | undefined
  private phoneAppPort: number | undefined
  private phoneAppError: string | undefined
  /** Where the app pointed `tailscale serve`, while it does. */
  private serveTo: number | undefined
  readonly devices: DeviceSync
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
    this.devices = new DeviceSync({
      session,
      on: () => this.settings.sync && !!this.phoneAppPlace(),
      tailnet: () => (this.tailscale.kind === 'ready' ? { host: this.tailscale.host, peers: this.tailscale.peers } : undefined),
      merged: (state) => this.events.state(state),
      changed: () => this.events.status(this.status())
    })
  }

  /** Something changed here (the user, a phone or an AI client): the user's other devices with this universe open are nudged to ask for it. */
  changedHere(summary: string): void {
    this.server?.changed({ summary, source: 'user', at: new Date().toISOString() })
    this.devices.localChange()
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
    // Funnel follows the port, which can change from one start to the next (and goes when nothing listens).
    if (this.settings.phone || this.funnelTo !== undefined || this.settings.phoneApp || this.settings.sync) void this.syncPhone()
  }

  async stop(): Promise<void> {
    await this.server?.close()
    this.server = undefined
    this.port = null
  }

  /** At quit: no `--mcp` server is pointed here any more (at once: the process may end before anything async finishes), and nothing is left listening. */
  close(): void {
    clearDiscovery()
    // Nor anything left on the internet (or the tailnet): a Funnel or Serve to a port nothing listens on, which another program could take.
    offNow({ funnel: this.funnelTo !== undefined, serve: this.serveTo !== undefined })
    void this.stop()
    void this.phoneApp?.close()
  }

  async set(given: ApiSettingsPatch): Promise<ApiStatus> {
    // Only these, and only as true or false: nothing else in the settings (the token) is the window's to set.
    const patch: ApiSettingsPatch = {}
    for (const key of ['enabled', 'review', 'phone', 'phoneApp', 'sync'] as const) if (typeof given[key] === 'boolean') patch[key] = given[key]
    const restart = patch.enabled !== undefined && patch.enabled !== this.settings.enabled
    const phone = (['phone', 'phoneApp', 'sync'] as const).some((key) => patch[key] !== undefined && patch[key] !== this.settings[key])
    this.settings = { ...this.settings, ...patch }
    this.save()
    if (restart) await this.start()
    else if (phone) await this.syncPhone()
    else this.announce()
    return this.status()
  }

  /** What the phone app serves; until it's given, the phone app can't be turned on. */
  useBridge(bridge: PhoneBridge): void {
    this.bridge = bridge
    if (this.settings.phoneApp) void this.syncPhone()
  }

  /** Tells phone apps what the window heard. */
  toPhones(event: RemoteEvent, value: unknown): void {
    this.phoneApp?.push(event, value)
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
    // One at a time (each runs Tailscale's command), and one waiting is enough however many are asked for meanwhile.
    this.next ??= this.syncing
      .catch(() => {})
      .then(() => {
        this.next = undefined
        return this.lookAtTailscale()
      })
    this.syncing = this.next
    return this.next
  }

  private async lookAtTailscale(): Promise<void> {
    this.phoneError = undefined
    this.tailscale = await tailscaleState()
    const ts = this.tailscale
    if (ts.kind === 'ready') {
      const wanted = this.settings.phone && this.port !== null ? this.port : null
      // One pointing here, or where the app last pointed it (where nothing may listen now), is the app's to change.
      const ours = ts.funnelPort !== null && (ts.funnelPort === this.port || ts.funnelPort === this.funnelTo)
      if (wanted !== null ? ts.funnelPort !== wanted : ours) {
        try {
          await setFunnel(wanted)
          this.funnelTo = wanted ?? undefined
          this.tailscale = await tailscaleState()
        } catch (err) {
          this.phoneError = (err as Error).message
        }
      }
      await this.syncPhoneApp(ts)
    }
    this.events.status(this.status())
  }

  /**
   * With the phone app or sync on, the tailnet server running and `tailscale
   * serve` pointed at it (and sync asking the other devices); with both off,
   * neither (if the app pointed it here).
   */
  private async syncPhoneApp(ts: Extract<TailscaleState, { kind: 'ready' }>): Promise<void> {
    this.phoneAppError = undefined
    const on = this.settings.phoneApp || this.settings.sync
    if (this.settings.phoneApp && !this.bridge) this.phoneAppError = 'The phone app comes with a built copy of Universe (not `pnpm dev`)'
    if (on && !ts.login) this.phoneAppError = 'Tailscale didn’t say who’s signed in on this computer'
    if (on && ts.login && !this.phoneApp) {
      const server = new PhoneAppServer({
        oauth: this.oauth,
        appOn: () => this.settings.phoneApp && !!this.bridge,
        files: this.bridge?.files ?? '',
        place: () => this.phoneAppPlace(),
        answer: (method, args) => (this.bridge ? this.bridge.answer(method, args) : Promise.reject(new Error('No phone app here'))),
        sync: { on: () => this.settings.sync, hello: () => this.devices.hello(), changes: (body, device) => this.devices.changes(body, device), nudged: (body) => this.devices.nudged(body) },
        sessionsFile: join(this.userData, 'phone-sessions.json')
      })
      this.phoneAppPort = await server.listen()
      this.phoneApp = server
    }
    const wanted = on && this.phoneApp ? this.phoneAppPort! : null
    const ours = ts.appPort !== null && (ts.appPort === this.phoneAppPort || ts.appPort === this.serveTo)
    if (wanted !== null ? ts.appPort !== wanted : ours) {
      try {
        await setServe(wanted)
        this.serveTo = wanted ?? undefined
        this.tailscale = await tailscaleState()
      } catch (err) {
        this.phoneAppError = (err as Error).message
      }
    }
    if (wanted === null && this.phoneApp) {
      await this.phoneApp.close()
      this.phoneApp = undefined
      this.phoneAppPort = undefined
    }
    if (this.settings.sync && this.phoneAppPlace()) this.devices.start()
    else this.devices.stop()
  }

  /** A copy here of the universe another device has open, in a new file at `path`, opened. */
  copyFromDevice(host: string, path: string): Promise<AppState> {
    return this.devices.copyFrom(host, path)
  }

  /** Where the phone app answers: the tailnet name `tailscale serve` forwards here, while it's on. */
  private phoneAppPlace(): PhoneAppPlace | undefined {
    const ts = this.tailscale
    if (!(this.settings.phoneApp || this.settings.sync) || ts.kind !== 'ready' || !ts.login || ts.appPort === null || ts.appPort !== this.phoneAppPort) return undefined
    return { host: `${ts.host}:${APP_HTTPS_PORT}`, login: ts.login }
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
    // Which devices have this universe open is asked again at once.
    void this.devices.round()
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
      connections: this.oauth.connections(),
      app: { on: this.settings.phoneApp, url: this.settings.phoneApp && this.phoneAppPlace() ? `https://${this.phoneAppPlace()!.host}/` : null, ...(this.phoneAppError && { error: this.phoneAppError }) },
      sync: { on: this.settings.sync, devices: this.devices.status(), ...(this.settings.sync && this.phoneAppError && { error: this.phoneAppError }) }
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
      write: (command, summary, options) => {
        if (this.settings.review && !options?.advice) {
          const proposalId = this.session.propose(command, summary)
          // The window shows it with the other suggestions.
          this.events.state(this.session.state())
          return { status: 'proposed', proposalId }
        }
        this.events.state(this.session.execute(command, 'ai'))
        this.events.aiChange({ summary })
        this.server?.changed({ summary, source: 'ai', at: new Date().toISOString() })
        this.devices.localChange()
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
      if (typeof saved.token === 'string' && saved.token.length >= 32) return { enabled: saved.enabled !== false, review: saved.review === true, phone: saved.phone === true, phoneApp: saved.phoneApp === true, sync: saved.sync === true, token: saved.token }
    } catch {
      // First run, or an unreadable file: start over.
    }
    const fresh = { enabled: true, review: false, phone: false, phoneApp: false, sync: false, token: newToken() }
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
