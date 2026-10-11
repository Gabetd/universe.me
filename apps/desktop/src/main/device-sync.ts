import { DEVICE_ID, MAX_MERGE_ROWS, SyncPage, SyncRow, personOf } from '@universe/core'
import { z } from 'zod'
import type { AppState, Collaboration, DeviceStatus, Person, SharedDevice, TailnetPeer } from '../shared/api'
import { MAX_PEOPLE, PresenceWire, Presences, Where } from './presence'
import type { Session } from './session'

/**
 * Sync over the tailnet (PLAN.md §6.7): with the user's other devices, and
 * with other people's a universe is shared with. Each Universe answers what
 * it has open and the changes of the universe it has open (on the same
 * tailnet server as the phone app: the owner's devices, and other people's
 * only for a universe they're members of), and asks the others the same.
 * When two have the same universe open (the same sync id), each takes the
 * rows the other got since it last asked, and gives the rows it got since it
 * last gave (machine sharing lets the person a machine is shared with reach
 * it, but not the machine them, so a visitor brings its own changes); merged,
 * the later write of a row wins, and a row both ways is only merged once.
 * Hellos carry who's in the universe and where. They ask every few seconds
 * (more often while someone else is in), and at once when nudged after a
 * change.
 */

const EVERY_MS = 10_000
/** How often while someone else is in the universe here: changes and where they are show within moments. */
const LIVE_MS = 3_000
/** How long after a change the other devices are nudged (a burst of changes is one nudge). */
const NUDGE_MS = 800
/** Rows asked for or given at once, at most (a page also stops at about 2 MB: see StampedStore). */
const PAGE = 100

const SyncId = z.string().min(1).max(100)

const Hello = z.object({
  device: z.string().regex(DEVICE_ID),
  project: z.object({ syncId: SyncId, name: z.string().max(200), upTo: z.number().int().min(0) }).nullable(),
  /** Who's in that universe there, but the one asking (from newer versions only). */
  people: z.array(PresenceWire).max(MAX_PEOPLE).optional()
})
type Hello = z.infer<typeof Hello>

/** What a visitor's hello says (newer versions): the universe it has open, and where its person is in it. */
const Visit = z.object({ syncId: SyncId, name: z.string().min(1).max(200), where: Where.nullable() }).partial()

const Push = z.object({ syncId: SyncId, rows: z.array(SyncRow).max(MAX_MERGE_ROWS) })

/** Who's asking, as the tailnet server vouches for them. */
export interface SyncVisitor {
  /** Their tailnet login (as members keep it), which `tailscale serve` adds and a device can't. */
  login: string
  /** Whether it's this computer's owner: one of their own devices. */
  owner: boolean
  /** Which install asks (its own word). */
  device: string | undefined
}

/** This computer on the tailnet: its name, who's signed in, the user's other devices online and other people's. */
export interface Tailnet {
  host: string
  me?: Person
  peers: TailnetPeer[]
  others: TailnetPeer[]
}

/** Asks a device's Universe a sync question (`body` makes it a POST), resolving to its JSON answer; an `AskError` if it says no. */
export type Ask = (host: string, path: string, device: string, body?: object) => Promise<unknown>

/** A device's answer that wasn't yes, with its HTTP status. */
export class AskError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export interface DeviceSyncOptions {
  session: Session
  /** Whether sync is on here. */
  on(): boolean
  tailnet(): Tailnet | undefined
  /** Rows came in: the window (and phones) show the new state. */
  merged(state: AppState): void
  /** What the user's own devices are doing changed. */
  changed(): void
  /** Who's in, the members or other people's devices changed (told only when they did). */
  collaboration(collaboration: Collaboration): void
  ask: Ask
}

/** An answer to another device: its status and body. */
export interface SyncAnswer {
  status: number
  body: object
}

/** A device as sync last found it, with whose it is for another person's. */
type Found = DeviceStatus & { owner?: Person }

export class DeviceSync {
  /** The user's own devices, and other people's, as last found. */
  private readonly devices = new Map<string, Found>()
  private readonly theirs = new Map<string, Found>()
  private readonly presences = new Presences()
  private where: Where | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private nudging: ReturnType<typeof setTimeout> | undefined
  /** One visit to a device at a time (a nudge while one runs waits for it). */
  private readonly visiting = new Map<string, Promise<void>>()
  /** The last collaboration told, as JSON: it's told again only once it's different. */
  private told = ''

  constructor(private readonly o: DeviceSyncOptions) {}

  /** Asks the other devices now and every few seconds, while sync is on. */
  start(): void {
    if (!this.timer) this.tick()
  }

  stop(): void {
    clearTimeout(this.timer)
    clearTimeout(this.nudging)
    this.timer = undefined
    this.devices.clear()
    this.theirs.clear()
    this.presences.clear()
    this.o.changed()
    this.tell()
  }

  /** The user's own devices. */
  status(): DeviceStatus[] {
    return [...this.devices.values()]
  }

  /** What a device has open, as last asked, and what to call it (another person's by its owner too). */
  openOn(host: string): { device: string; project: { syncId: string; name: string } } | undefined {
    const found = this.devices.get(host) ?? this.theirs.get(host)
    return found?.project && { device: found.owner ? `${found.owner.name}’s ${found.name}` : found.name, project: found.project }
  }

  collaboration(): Collaboration {
    const tailnet = this.o.tailnet()
    const me = tailnet?.me ?? null
    const open = this.o.session.syncInfo()
    const members = this.o.session.members().map(({ id, login, name, invitedBy }) => ({ id, login, name, invitedBy, you: login === me?.login }))
    return {
      on: this.o.on() && !!me,
      me,
      members,
      here: open ? this.presences.in(open.syncId, me?.login) : [],
      shared: [...this.theirs.values()].flatMap((d) => (d.project && d.owner ? [sharedDevice(d, d.owner, d.project)] : [])),
      people: peopleOf(tailnet?.others ?? [])
    }
  }

  /** Where the user is now (the window says): the others with this universe open hear of it soon. */
  setWhere(where: unknown): void {
    const parsed = Where.nullable().parse(where)
    if (JSON.stringify(parsed) === JSON.stringify(this.where)) return
    this.where = parsed
    this.announce()
  }

  // Answering the other devices.

  /** Whether a visitor may sync the universe open here: always on one of the owner's own devices, otherwise while they're a member of it. */
  mayVisit(visitor: SyncVisitor): boolean {
    return visitor.owner || this.o.session.isMember(visitor.login)
  }

  /**
   * What's open here, to someone who may have it (nothing to anyone else);
   * if they have it open too (`body`, from newer versions), who's in it here
   * and where, them aside, and they're counted in.
   */
  hello(visitor: SyncVisitor, body?: unknown): Hello {
    const open = this.o.session.syncInfo()
    const device = this.o.session.device
    if (!open || !this.mayVisit(visitor)) return { device, project: null }
    const visit = Visit.safeParse(body)
    if (!visit.success || visit.data.syncId !== open.syncId) return { device, project: open }
    this.presences.hear(open.syncId, [{ ...personOf(visitor.login, visit.data.name), where: visit.data.where ?? null, age: 0 }], this.o.tailnet()?.me?.login)
    this.tell()
    return { device, project: open, people: this.peopleIn(open.syncId, visitor.login) }
  }

  changes(body: unknown, visitor: SyncVisitor): SyncAnswer {
    const ask = z.object({ syncId: z.string(), since: z.number().int().min(0) }).safeParse(body)
    if (!this.mayVisit(visitor)) return notShared
    if (!ask.success || !visitor.device) return { status: 400, body: { error: 'Ask with a sync id and where from' } }
    if (this.o.session.syncInfo()?.syncId !== ask.data.syncId) return notOpen
    return { status: 200, body: this.o.session.changesSince(ask.data.since, visitor.device, PAGE) }
  }

  /** Rows a visitor brings (a device that can reach this one, but not this one it), merged as pulled ones are; the other devices with this universe open then hear of them. */
  push(body: unknown, visitor: SyncVisitor): SyncAnswer {
    const given = Push.safeParse(body)
    if (!this.mayVisit(visitor)) return notShared
    if (!given.success) return { status: 400, body: { error: 'Give a sync id and rows' } }
    const { session } = this.o
    if (session.syncInfo()?.syncId !== given.data.syncId) return notOpen
    if (session.merge(given.data.rows)) {
      this.o.merged(session.state())
      this.tell()
      this.announce()
    }
    return { status: 200, body: {} }
  }

  /** A visitor says it has changes: the device it names is asked at once, if it's the visitor's own (one of the owner's, or one of that person's). */
  nudged(body: unknown, visitor: SyncVisitor): void {
    const host = z.object({ host: z.string() }).safeParse(body)
    const tailnet = this.o.tailnet()
    if (!host.success || !tailnet || !this.o.on() || !this.mayVisit(visitor)) return
    const theirs = visitor.owner ? tailnet.peers : tailnet.others.filter((p) => p.login === visitor.login)
    const peer = theirs.find((p) => p.host === host.data.host)
    if (peer) void this.visit(peer, visitor.owner).then(() => this.o.changed())
  }

  // Asking them.

  /** Something changed here: the devices with this universe open hear of it soon. */
  localChange(): void {
    this.tell()
    this.announce()
  }

  /**
   * Every device online now, at once: the user's own (what they're doing is
   * told once they've all answered) and other people's (who may share a
   * universe with this one).
   */
  async round(): Promise<void> {
    if (!this.o.on()) return
    const tailnet = this.o.tailnet()
    const [peers, others] = [tailnet?.peers ?? [], tailnet?.others ?? []]
    forgetGone(this.devices, peers)
    forgetGone(this.theirs, others)
    const own = Promise.all(peers.map((p) => this.visit(p, true))).then(() => this.o.changed())
    await Promise.all([own, ...others.map((p) => this.visit(p, false))])
    this.tell()
  }

  /** A round now, and the next one in a few seconds (sooner while someone else is in). */
  private tick(): void {
    this.timer = setTimeout(() => this.tick(), this.someoneIn() ? LIVE_MS : EVERY_MS)
    this.timer.unref()
    void this.round()
  }

  private someoneIn(): boolean {
    const open = this.o.session.syncInfo()
    return !!open && this.presences.in(open.syncId, this.o.tailnet()?.me?.login).length > 0
  }

  /** Soon (a burst of changes is one), the devices with this universe open hear of what's new here: the user's own are nudged to ask, and other people's are visited (they can't be sure to reach this one). */
  private announce(): void {
    if (!this.o.on()) return
    clearTimeout(this.nudging)
    this.nudging = setTimeout(() => {
      for (const d of this.devices.values()) if (d.state === 'same') this.nudge(d.host)
      const others = this.o.tailnet()?.others ?? []
      for (const p of others) if (this.theirs.get(p.host)?.state === 'same') void this.visit(p, false)
    }, NUDGE_MS)
  }

  private visit(peer: TailnetPeer, mine: boolean): Promise<void> {
    const running = this.visiting.get(peer.host)
    if (running) return running
    const visit = this.exchange(peer, mine).finally(() => this.visiting.delete(peer.host))
    this.visiting.set(peer.host, visit)
    return visit
  }

  /**
   * What a device has open; if it's the universe open here, and its owner is
   * the user or one of the universe's members, who's in it there, everything
   * it got since it was last asked, and everything this one got since it
   * last gave it some.
   */
  private async exchange(peer: TailnetPeer, mine: boolean): Promise<void> {
    const found = mine ? this.devices : this.theirs
    const before = found.get(peer.host)
    const owner = mine ? undefined : person(peer)
    const set = (status: Omit<DeviceStatus, 'host' | 'name'>) => void found.set(peer.host, { host: peer.host, name: peer.name, ...status, ...(owner && { owner }) })
    const trusted = mine || (!!owner && this.o.session.isMember(owner.login))
    let hello: Hello
    try {
      hello = await this.hi(peer.host, trusted)
    } catch (err) {
      return set({ state: 'unreachable', error: (err as Error).message })
    }
    const here = this.o.session.syncInfo()
    if (!hello.project) return set({ state: 'nothing' })
    const project = { syncId: hello.project.syncId, name: hello.project.name }
    if (project.syncId !== here?.syncId) return set({ state: 'other', project })
    if (!trusted) return set({ state: 'other', project, error: `${owner?.name ?? peer.name} isn’t a member of this universe here` })
    if (hello.people) this.presences.hear(project.syncId, hello.people, this.o.tailnet()?.me?.login)
    try {
      // Both at once: neither sends the other's own rows, and a row both have is only merged where it's newer.
      await Promise.all([this.take(peer.host, hello.device, project.syncId, hello.project.upTo), this.give(peer.host, hello.device, project.syncId)])
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
        const page = SyncPage.parse(await this.ask(host, '/sync/changes', { syncId, since }))
        // The universe here changed while asking (another was opened): the rows aren't its.
        if (session.syncInfo()?.syncId !== syncId) return
        merged = session.merge(page.rows) || merged
        if (page.upTo !== since) session.setSeen(device, (since = page.upTo))
        if (!page.more) return
      }
    } finally {
      if (merged) {
        this.o.merged(session.state())
        this.tell()
      }
    }
  }

  /** Every page of rows this copy got since it last gave `host` some (but those `host` wrote: it has them), given to it. A version from before pushing doesn't take them: it asks for them instead. */
  private async give(host: string, device: string, syncId: string): Promise<void> {
    const { session } = this.o
    for (let since = session.sent(device); session.syncInfo()?.syncId === syncId; ) {
      const page = session.changesSince(since, device, PAGE)
      if (page.rows.length) {
        try {
          await this.ask(host, '/sync/push', { syncId, rows: page.rows })
        } catch (err) {
          if (err instanceof AskError && err.status === 404) return
          throw err
        }
      }
      // Another universe opened while it was given: its marks aren't this one's.
      if (session.syncInfo()?.syncId !== syncId) return
      if (page.upTo !== since) session.setSent(device, (since = page.upTo))
      if (!page.more) return
    }
  }

  /** Makes a copy here of the universe a device has open (the user's own, or one another person shares with them), in a new file at `path`, and opens it. */
  async copyFrom(host: string, path: string): Promise<AppState> {
    const hello = await this.hi(host, false)
    if (!hello.project) throw new Error('That device has no universe open now')
    this.o.session.createCopy(path, hello.project.name, hello.project.syncId)
    await this.take(host, hello.device, hello.project.syncId)
    // The device it came from learns at once that this one has it too.
    this.nudge(host)
    void this.round()
    return this.o.session.state()
  }

  /** Says hello to a device: with who's here and where, to one that may hear it; to an older version, as it was asked before. */
  private async hi(host: string, visit: boolean): Promise<Hello> {
    try {
      return Hello.parse(await this.ask(host, '/sync/hello', visit ? this.ownVisit() : {}))
    } catch (err) {
      if (err instanceof AskError && err.status === 404) return Hello.parse(await this.ask(host, '/sync/hello'))
      throw err
    }
  }

  /** What this device's hello says of the universe open here and where its person is in it. */
  private ownVisit(): z.infer<typeof Visit> {
    const open = this.o.session.syncInfo()
    const me = this.o.tailnet()?.me
    return open ? { syncId: open.syncId, ...(me && { name: me.name }), where: this.where } : {}
  }

  /** Who's in a universe here, for a visitor: this device's own person (with the universe open, they're in) and those heard from, but the visitor. */
  private peopleIn(syncId: string, visitor: string): PresenceWire[] {
    const me = this.o.tailnet()?.me
    const self = me && me.login !== visitor ? [{ ...me, where: this.where, age: 0 }] : []
    return [...self, ...this.presences.wire(syncId, visitor)].slice(0, MAX_PEOPLE)
  }

  /** Tells a device there's something new here. */
  private nudge(host: string): void {
    void this.ask(host, '/sync/nudge', { host: this.o.tailnet()?.host }).catch(() => {})
  }

  private ask(host: string, path: string, body?: object): Promise<unknown> {
    return this.o.ask(host, path, this.o.session.device, body)
  }

  /** Tells the window what changed in who's in, the members or other people's devices, if anything did. */
  private tell(): void {
    const collaboration = this.collaboration()
    const json = JSON.stringify(collaboration)
    if (json === this.told) return
    this.told = json
    this.o.collaboration(collaboration)
  }
}

const notShared: SyncAnswer = { status: 403, body: { error: 'That universe isn’t shared with you' } }
const notOpen: SyncAnswer = { status: 409, body: { error: 'That universe isn’t open here' } }

/** A device's owner, by their login. */
const person = (peer: TailnetPeer): Person | undefined => (peer.login ? personOf(peer.login, peer.ownerName) : undefined)

const sharedDevice = (d: Found, owner: Person, project: { syncId: string; name: string }): SharedDevice => ({
  host: d.host,
  name: d.name,
  owner,
  project,
  same: d.state === 'same',
  ...(d.lastSync && { lastSync: d.lastSync }),
  ...(d.error && { error: d.error })
})

/** The owners of these devices, each once. */
function peopleOf(devices: readonly TailnetPeer[]): Person[] {
  const people = new Map<string, Person>()
  for (const d of devices) {
    const owner = person(d)
    if (owner) people.set(owner.login, owner)
  }
  return [...people.values()]
}

/** Devices no longer online aren't listed. */
function forgetGone(found: Map<string, unknown>, online: readonly TailnetPeer[]): void {
  for (const host of found.keys()) if (!online.some((p) => p.host === host)) found.delete(host)
}
