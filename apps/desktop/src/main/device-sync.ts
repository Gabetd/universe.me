import { MAX_MERGE_ROWS, SyncRow } from '@universe/core'
import { z } from 'zod'
import type { AppState, DeviceStatus, TailnetPeer } from '../shared/api'
import type { Session } from './session'
import { APP_HTTPS_PORT } from './tailscale'

/**
 * Sync with the user's other devices (PLAN.md §6.7), directly over their
 * tailnet: each Universe answers what it has open and the changes of the
 * universe it has open (on the same tailnet server as the phone app, so only
 * the tailnet owner's devices reach it), and asks the others the same. When
 * two have the same universe open (the same sync id), each takes the rows
 * the other got since it last asked, and merges them: the later write of a
 * row wins. They ask every few seconds, and at once when nudged after a
 * change.
 */

const EVERY_MS = 10_000
/** How long after a change the other devices are nudged (a burst of changes is one nudge). */
const NUDGE_MS = 800
const TIMEOUT_MS = 10_000
/** Rows asked for at once: a page of terrain faces is a few MB. */
const PAGE = 100

const Hello = z.object({ device: z.string().min(1).max(64), project: z.object({ syncId: z.string().min(1).max(100), name: z.string().max(200) }).nullable() })
type Hello = z.infer<typeof Hello>
const Page = z.object({ rows: z.array(SyncRow).max(MAX_MERGE_ROWS), upTo: z.number().int().min(0), more: z.boolean() })

export interface DeviceSyncOptions {
  session: Session
  /** Whether sync is on here. */
  on(): boolean
  /** This computer's tailnet name, and the user's other devices online now. */
  tailnet(): { host: string; peers: TailnetPeer[] } | undefined
  /** Rows came in: the window (and phones) show the new state. */
  merged(state: AppState): void
  /** What the devices are doing changed. */
  changed(): void
}

/** The page of rows another device asks for, or why there's none. */
export type ChangesAnswer = { ok: true; rows: SyncRow[]; upTo: number; more: boolean } | { ok: false; status: number; error: string }

export class DeviceSync {
  private readonly devices = new Map<string, DeviceStatus>()
  private timer: ReturnType<typeof setInterval> | undefined
  private nudging: ReturnType<typeof setTimeout> | undefined
  /** One visit to a device at a time (a nudge while one runs waits for it). */
  private readonly visiting = new Map<string, Promise<void>>()

  constructor(private readonly o: DeviceSyncOptions) {}

  /** Asks the other devices now and every few seconds, while sync is on. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.round(), EVERY_MS)
    this.timer.unref()
    void this.round()
  }

  stop(): void {
    clearInterval(this.timer)
    clearTimeout(this.nudging)
    this.timer = undefined
    this.devices.clear()
    this.o.changed()
  }

  status(): DeviceStatus[] {
    return [...this.devices.values()]
  }

  // Answering the other devices.

  hello(): Hello {
    return { device: this.o.session.device, project: this.o.session.syncInfo() ?? null }
  }

  changes(body: unknown, device: string | undefined): ChangesAnswer {
    const ask = z.object({ syncId: z.string(), since: z.number().int().min(0) }).safeParse(body)
    if (!ask.success || !device) return { ok: false, status: 400, error: 'Ask with a sync id and where from' }
    const open = this.o.session.syncInfo()
    if (open?.syncId !== ask.data.syncId) return { ok: false, status: 409, error: 'That universe isn’t open here' }
    return { ok: true, ...this.o.session.changesSince(ask.data.since, device, PAGE) }
  }

  /** Another device says it has changes: asked at once (if it's one of the user's). */
  nudged(body: unknown): void {
    const host = z.object({ host: z.string() }).safeParse(body)
    const peer = host.success ? this.o.tailnet()?.peers.find((p) => p.host === host.data.host) : undefined
    if (peer && this.o.on()) void this.visit(peer)
  }

  // Asking them.

  /** Something changed here: the devices with the same universe open are nudged to ask for it. */
  localChange(): void {
    if (!this.o.on()) return
    clearTimeout(this.nudging)
    this.nudging = setTimeout(() => {
      const me = this.o.tailnet()
      const same = this.status().filter((d) => d.state === 'same')
      for (const d of same) void call(d.host, '/sync/nudge', this.o.session.device, { host: me?.host }).catch(() => {})
    }, NUDGE_MS)
  }

  /** Every device online now, at once. */
  async round(): Promise<void> {
    if (!this.o.on()) return
    const peers = this.o.tailnet()?.peers ?? []
    for (const host of this.devices.keys()) if (!peers.some((p) => p.host === host)) this.devices.delete(host)
    await Promise.all(peers.map((p) => this.visit(p)))
    this.o.changed()
  }

  private visit(peer: TailnetPeer): Promise<void> {
    const running = this.visiting.get(peer.host)
    if (running) return running
    const visit = this.pull(peer).finally(() => this.visiting.delete(peer.host))
    this.visiting.set(peer.host, visit)
    return visit
  }

  /** What a device has open; if it's the universe open here, everything it got since it was last asked. */
  private async pull(peer: TailnetPeer): Promise<void> {
    const before = this.devices.get(peer.host)
    const set = (status: Omit<DeviceStatus, 'host' | 'name'>) => {
      this.devices.set(peer.host, { host: peer.host, name: peer.name, ...status })
      this.o.changed()
    }
    let hello: Hello
    try {
      hello = Hello.parse(await call(peer.host, '/sync/hello', this.o.session.device))
    } catch (err) {
      return set({ state: 'unreachable', error: (err as Error).message })
    }
    const here = this.o.session.syncInfo()
    if (!hello.project) return set({ state: 'nothing', device: hello.device })
    if (hello.project.syncId !== here?.syncId) return set({ state: 'other', device: hello.device, project: hello.project })
    try {
      await this.take(peer.host, hello.device, hello.project.syncId)
      set({ state: 'same', device: hello.device, project: hello.project, lastSync: Date.now() })
    } catch (err) {
      set({ state: 'same', device: hello.device, project: hello.project, ...(before?.lastSync && { lastSync: before.lastSync }), error: (err as Error).message })
    }
  }

  /** Every page of rows `host` got since it was last asked, merged here. */
  private async take(host: string, device: string, syncId: string): Promise<void> {
    const { session } = this.o
    for (;;) {
      const since = session.seen(device)
      const page = Page.parse(await call(host, '/sync/changes', session.device, { syncId, since }))
      // The universe here changed while asking (another was opened): the rows aren't its.
      if (session.syncInfo()?.syncId !== syncId) return
      const state = session.merge(page.rows)
      session.setSeen(device, page.upTo)
      if (state) this.o.merged(state)
      if (!page.more) return
    }
  }

  /** Makes a copy here of the universe a device has open, in a new file at `path`, and opens it. */
  async copyFrom(host: string, path: string): Promise<AppState> {
    const hello = Hello.parse(await call(host, '/sync/hello', this.o.session.device))
    if (!hello.project) throw new Error('That device has no universe open now')
    this.o.session.createCopy(path, hello.project.name, hello.project.syncId)
    await this.take(host, hello.device, hello.project.syncId)
    const state = this.o.session.state()
    this.o.merged(state)
    // The device it came from learns at once that this one has it too.
    void call(host, '/sync/nudge', this.o.session.device, { host: this.o.tailnet()?.host }).catch(() => {})
    void this.round()
    return state
  }
}

/** Where a device's Universe answers: its tailnet name's HTTPS (or, for tests, UNIVERSE_TAILNET_URLS's address for it). */
function baseOf(host: string): string {
  const overrides = process.env.UNIVERSE_TAILNET_URLS ? (JSON.parse(process.env.UNIVERSE_TAILNET_URLS) as Record<string, string>) : {}
  return overrides[host] ?? `https://${host}:${APP_HTTPS_PORT}`
}

async function call(host: string, path: string, device: string, body?: object): Promise<unknown> {
  const res = await fetch(`${baseOf(host)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Universe-Sync': '1', 'X-Universe-Device': device, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(json.error ?? `It answered ${res.status}`)
  return json
}
