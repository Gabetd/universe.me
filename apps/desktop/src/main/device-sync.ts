import { DEVICE_ID, SyncPage } from '@universe/core'
import { net } from 'electron'
import { z } from 'zod'
import type { AppState, DeviceStatus, TailnetPeer } from '../shared/api'
import type { Session } from './session'
import { tailnetBase } from './tailnet'

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
/** Rows asked for at once, at most (a page also stops at about 2 MB: see StampedStore). */
const PAGE = 100

const Hello = z.object({
  device: z.string().regex(DEVICE_ID),
  project: z.object({ syncId: z.string().min(1).max(100), name: z.string().max(200), upTo: z.number().int().min(0) }).nullable()
})
type Hello = z.infer<typeof Hello>

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

/** An answer to another device: its status and body. */
export interface SyncAnswer {
  status: number
  body: object
}

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
    const open = this.o.session.syncInfo()
    return { device: this.o.session.device, project: open ?? null }
  }

  changes(body: unknown, device: string | undefined): SyncAnswer {
    const ask = z.object({ syncId: z.string(), since: z.number().int().min(0) }).safeParse(body)
    if (!ask.success || !device) return { status: 400, body: { error: 'Ask with a sync id and where from' } }
    if (this.o.session.syncInfo()?.syncId !== ask.data.syncId) return { status: 409, body: { error: 'That universe isn’t open here' } }
    return { status: 200, body: this.o.session.changesSince(ask.data.since, device, PAGE) }
  }

  /** Another device says it has changes: asked at once (if it's one of the user's). */
  nudged(body: unknown): void {
    const host = z.object({ host: z.string() }).safeParse(body)
    const peer = host.success ? this.o.tailnet()?.peers.find((p) => p.host === host.data.host) : undefined
    if (peer && this.o.on()) void this.visit(peer).then(() => this.o.changed())
  }

  // Asking them.

  /** Something changed here: the devices with the same universe open are nudged to ask for it. */
  localChange(): void {
    if (!this.o.on()) return
    clearTimeout(this.nudging)
    this.nudging = setTimeout(() => {
      for (const d of this.status()) if (d.state === 'same') this.nudge(d.host)
    }, NUDGE_MS)
  }

  /** Every device online now, at once; what they're doing is told once they've all answered. */
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
    const set = (status: Omit<DeviceStatus, 'host' | 'name'>) => void this.devices.set(peer.host, { host: peer.host, name: peer.name, ...status })
    let hello: Hello
    try {
      hello = await this.hi(peer.host)
    } catch (err) {
      return set({ state: 'unreachable', error: (err as Error).message })
    }
    const here = this.o.session.syncInfo()
    if (!hello.project) return set({ state: 'nothing' })
    const project = { syncId: hello.project.syncId, name: hello.project.name }
    if (project.syncId !== here?.syncId) return set({ state: 'other', project })
    try {
      await this.take(peer.host, hello.device, project.syncId, hello.project.upTo)
      set({ state: 'same', project, lastSync: Date.now() })
    } catch (err) {
      set({ state: 'same', project, ...(before?.lastSync && { lastSync: before.lastSync }), error: (err as Error).message })
    }
  }

  /** Every page of rows `host` got since it was last asked (none if it's got nothing since: `upTo`), merged here; the window is told once. */
  private async take(host: string, device: string, syncId: string, upTo = Infinity): Promise<void> {
    const { session } = this.o
    let merged = false
    try {
      for (let since = session.seen(device); since < upTo; ) {
        const page = SyncPage.parse(await call(host, '/sync/changes', session.device, { syncId, since }))
        // The universe here changed while asking (another was opened): the rows aren't its.
        if (session.syncInfo()?.syncId !== syncId) return
        merged = session.merge(page.rows) || merged
        if (page.upTo !== since) session.setSeen(device, (since = page.upTo))
        if (!page.more) return
      }
    } finally {
      if (merged) this.o.merged(session.state())
    }
  }

  /** Makes a copy here of the universe a device has open, in a new file at `path`, and opens it. */
  async copyFrom(host: string, path: string): Promise<AppState> {
    const hello = await this.hi(host)
    if (!hello.project) throw new Error('That device has no universe open now')
    this.o.session.createCopy(path, hello.project.name, hello.project.syncId)
    await this.take(host, hello.device, hello.project.syncId)
    // The device it came from learns at once that this one has it too.
    this.nudge(host)
    void this.round()
    return this.o.session.state()
  }

  private async hi(host: string): Promise<Hello> {
    return Hello.parse(await call(host, '/sync/hello', this.o.session.device))
  }

  /** Tells a device there's something new here. */
  private nudge(host: string): void {
    void call(host, '/sync/nudge', this.o.session.device, { host: this.o.tailnet()?.host }).catch(() => {})
  }
}

/** Asks a device's Universe, through Electron's network stack (where keepOffline lets only this through). */
async function call(host: string, path: string, device: string, body?: object): Promise<unknown> {
  const res = await net.fetch(`${tailnetBase(host)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Universe-Sync': '1', 'X-Universe-Device': device, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(json.error ?? `It answered ${res.status}`)
  return json
}
