import { DEVICE_ID, MAX_MERGE_ROWS, SyncPage, personOf } from '@universe/core'
import { z } from 'zod'
import type { AppState, Collaboration, DeviceStatus, Person, SharedDevice, TailnetPeer } from '../shared/api'
import { MAX_PEOPLE, PresenceWire, Presences, Where } from './presence'
import type { SyncRoutes } from './phone-app'
import type { Session } from './session'

/**
 * Sync over the tailnet (PLAN.md §6.7): with the user's other devices, and
 * with other people's a universe is shared with. Each Universe answers what
 * it has open and the changes of the universe it has open (on the same
 * tailnet server as the phone app: the owner's devices, and other people's
 * only for a universe they're members of), and asks the others the same.
 * When two have the same universe open (the same sync id), each takes the
 * rows the other got since it last asked; a visit to another person's device
 * also gives it the rows got here since the last it was given (machine
 * sharing lets the person a machine is shared with reach it, but not the
 * machine them, so a visitor brings its own changes), while the user's own
 * devices, which reach each other, only take. Merged, the later write of a
 * row wins, and a row both ways is only merged once. Hellos carry who's in
 * the universe and where.
 *
 * The user's own devices and members' are visited every few seconds (more
 * often while someone else is in), other people's, which may have a universe
 * to share, at most every 10 s and less often while they have nothing. After
 * a change here, the user's own devices with it open are nudged to ask, and
 * other people's are given it at once.
 */

const EVERY_MS = 10_000
/** How often while someone else is in the universe here: changes and where they are show within moments. */
const LIVE_MS = 3_000
/** How long, at most, before another person's device that had nothing to share is asked again: each time it has nothing, the wait doubles from EVERY_MS. */
const MAX_PROBE_MS = 80_000
/** A round can come a moment before a device is due (timers aren't exact to the millisecond): it's asked then all the same. */
const SLACK_MS = 500
/** How long a device that turned down the newer hello (an older version) is greeted the older way before the newer one is tried again: it may have been updated. */
const OLDER_MS = 10 * 60_000
/** How long after a change the other devices are nudged (a burst of changes is one nudge). */
const NUDGE_MS = 800
/** How long after rows are pushed here the window is shown them (a burst of pages is one new state). */
const SHOW_MS = 150
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

/** Rows a visitor gives, checked as they're merged. */
const Push = z.object({ syncId: SyncId, rows: z.array(z.unknown()).max(MAX_MERGE_ROWS) })

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
  /** Who's in or other people's devices changed (told only when they did). */
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

/** The Universe on a device and the universe it has open, the same as here: changes made here can be given to it without a new hello. */
interface Link {
  device: string
  syncId: string
}

/** What sync keeps of a device on the tailnet while it's online. */
interface Contact {
  /** As last found (once a visit got that far): what the window is shown. */
  found?: Found
  /** As of the last exchange, while it has this universe open too. */
  link?: Link
  /** When it last turned down the newer hello (an older version): it's greeted the older way for a while. */
  older?: number
  /** For another person's device that's no member's: when it's asked again, and how many times in a row it had nothing to share. */
  probe?: { next: number; misses: number }
}

/** What the devices with this universe open are to hear of next: rows got here (`from` one device alone, which isn't given them back), where the user is, or both. */
interface News {
  rows: boolean
  where: boolean
  from?: string
}

const NO_NEWS: News = { rows: false, where: false }

export class DeviceSync implements SyncRoutes {
  /** The user's own devices online, and other people's, by host. */
  private readonly contacts = new Map<string, Contact>()
  private readonly presences = new Presences()
  private where: Where | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private nudging: ReturnType<typeof setTimeout> | undefined
  private news = NO_NEWS
  /** Rows pushed here, on their way to the window. */
  private showing: ReturnType<typeof setTimeout> | undefined
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
    this.news = NO_NEWS
    this.contacts.clear()
    this.presences.clear()
    this.o.changed()
    this.tell()
  }

  /** The user's own devices. */
  status(): DeviceStatus[] {
    return this.allFound().filter((d) => !d.owner)
  }

  /** What a device has open, as last asked, and what to call it (another person's by its owner too). */
  openOn(host: string): { device: string; project: { syncId: string; name: string } } | undefined {
    const found = this.contacts.get(host)?.found
    return found?.project && { device: found.owner ? `${found.owner.name}’s ${found.name}` : found.name, project: found.project }
  }

  collaboration(): Collaboration {
    const tailnet = this.o.tailnet()
    const me = tailnet?.me ?? null
    const open = this.o.session.syncInfo()
    return {
      on: this.o.on() && !!me,
      me,
      here: open ? this.presences.in(open.syncId, me?.login) : [],
      shared: this.allFound().filter((d): d is SharedDevice => !!d.owner && !!d.project),
      people: peopleOf(tailnet?.others ?? [])
    }
  }

  /** Where the user is now (the window says): the others with this universe open hear of it soon. */
  setWhere(where: unknown): void {
    const parsed = Where.nullable().parse(where)
    if (JSON.stringify(parsed) === JSON.stringify(this.where)) return
    this.where = parsed
    this.announce('where')
  }

  // Answering the other devices (phone-app.ts asks only about a visitor `mayVisit` lets in).

  /** Whether sync is on here, to answer. */
  on(): boolean {
    return this.o.on()
  }

  /**
   * Whether someone may sync the universe open here (as a visitor here, or
   * a device's owner when visiting it): always from one of the owner's own
   * devices, otherwise while they're a member of it.
   */
  mayVisit(visitor: Pick<SyncVisitor, 'login' | 'owner'>): boolean {
    return visitor.owner || this.o.session.isMember(visitor.login)
  }

  /**
   * What's open here, to a visitor who may have it (without one, nothing);
   * if they have it open too (`body`, from newer versions), who's in it here
   * and where, them aside, and they're counted in.
   */
  hello(visitor?: SyncVisitor, body?: unknown): Hello {
    const open = this.o.session.syncInfo()
    const device = this.o.session.device
    if (!open || !visitor) return { device, project: null }
    const visit = Visit.safeParse(body)
    if (!visit.success || visit.data.syncId !== open.syncId) return { device, project: open }
    this.presences.hear(open.syncId, [{ ...personOf(visitor.login, visit.data.name), where: visit.data.where ?? null, age: 0 }], this.myLogin())
    this.tell()
    return { device, project: open, people: this.peopleIn(open.syncId, visitor.login) }
  }

  changes(body: unknown, visitor: SyncVisitor): SyncAnswer {
    const ask = z.object({ syncId: z.string(), since: z.number().int().min(0) }).safeParse(body)
    if (!ask.success || !visitor.device) return { status: 400, body: { error: 'Ask with a sync id and where from' } }
    if (this.o.session.syncInfo()?.syncId !== ask.data.syncId) return notOpen
    return { status: 200, body: this.o.session.changesSince(ask.data.since, visitor.device, PAGE) }
  }

  /**
   * Rows a visitor brings (a device that can reach this one, but not this
   * one it), merged as pulled ones are: the window is shown them once a
   * burst of pages is in, and the other devices with this universe open then
   * hear of them (but the one that brought them).
   */
  push(body: unknown, visitor: SyncVisitor): SyncAnswer {
    const given = Push.safeParse(body)
    if (!given.success) return { status: 400, body: { error: 'Give a sync id and rows' } }
    const { session } = this.o
    if (session.syncInfo()?.syncId !== given.data.syncId) return notOpen
    if (session.merge(given.data.rows)) {
      this.showSoon()
      this.announce('rows', visitor.device)
    }
    return { status: 200, body: {} }
  }

  /** A visitor says it has changes: the device it names is asked at once, if it's the visitor's own (one of the owner's, or one of that person's). */
  nudged(body: unknown, visitor: SyncVisitor): void {
    const host = z.object({ host: z.string() }).safeParse(body)
    const tailnet = this.o.tailnet()
    if (!host.success || !tailnet || !this.o.on()) return
    const theirs = visitor.owner ? tailnet.peers : tailnet.others.filter((p) => p.login === visitor.login)
    const peer = theirs.find((p) => p.host === host.data.host)
    if (peer) void this.visit(peer, visitor.owner).then(() => this.o.changed())
  }

  // Asking them.

  /** Something changed here: the devices with this universe open hear of it soon. (Who it's shared with is the window's to read, in the universe itself.) */
  localChange(): void {
    this.announce('rows')
  }

  /**
   * Every device online now, at once: the user's own (what they're doing is
   * told once they've all answered), members' of the universe open here, and
   * other people's that are due (who may share a universe with this one).
   */
  async round(): Promise<void> {
    if (!this.o.on()) return
    const tailnet = this.o.tailnet()
    const [peers, others] = [tailnet?.peers ?? [], tailnet?.others ?? []]
    forgetGone(this.contacts, [...peers, ...others])
    const now = Date.now()
    const own = Promise.all(peers.map((p) => this.visit(p, true))).then(() => this.o.changed())
    const theirs = others.flatMap((p) => (this.mayVisit({ owner: false, login: p.login ?? '' }) ? [this.visit(p, false)] : this.due(p.host, now) ? [this.probe(p, now)] : []))
    await Promise.all([own, ...theirs])
    this.tell()
  }

  /** Tailscale was looked at again (the user opened their devices: Connect AI, or the start screen): other people's are asked at once, however long they've had nothing to share. */
  lookAgain(): Promise<void> {
    for (const contact of this.contacts.values()) contact.probe = undefined
    return this.round()
  }

  /** A round now, and the next one in a few seconds (sooner while someone else is in). */
  private tick(): void {
    this.timer = setTimeout(() => this.tick(), this.someoneIn() ? LIVE_MS : EVERY_MS)
    this.timer.unref()
    void this.round()
  }

  private someoneIn(): boolean {
    const open = this.o.session.syncInfo()
    return !!open && this.presences.in(open.syncId, this.myLogin()).length > 0
  }

  /** Whether another person's device that's no member's is to be asked again. */
  private due(host: string, now: number): boolean {
    const probe = this.contacts.get(host)?.probe
    return !probe || probe.next <= now + SLACK_MS
  }

  /** Asks another person's device that's no member's what it has open; each time it has nothing to share (it doesn't answer, has nothing open for this user, or isn't a Universe), it's asked again later. */
  private async probe(peer: TailnetPeer, now: number): Promise<void> {
    await this.visit(peer, false)
    const contact = this.contact(peer.host)
    const state = contact.found?.state
    const misses = state === 'unreachable' || state === 'nothing' ? (contact.probe?.misses ?? 0) + 1 : 0
    contact.probe = { next: now + Math.min(EVERY_MS * 2 ** misses, MAX_PROBE_MS), misses }
  }

  /**
   * Soon (a burst is one), the devices with this universe open hear what's
   * new here: rows (`from` a device that brought them, which isn't given
   * them back, if they all came from it), or where the user is.
   */
  private announce(what: 'rows' | 'where', from?: string): void {
    if (!this.o.on()) return
    const news = this.news
    this.news = what === 'where' ? { ...news, where: true } : { ...news, rows: true, from: !news.rows || news.from === from ? from : undefined }
    clearTimeout(this.nudging)
    this.nudging = setTimeout(() => this.spread(), NUDGE_MS)
  }

  /**
   * Tells the devices with this universe open what's new here: the user's
   * own are nudged to ask for new rows; other people's (which can't be sure
   * to reach this one) are given them as they were last found, without a new
   * hello, or, to hear where the user is, visited.
   */
  private spread(): void {
    const { rows, where, from } = this.news
    this.news = NO_NEWS
    const others = this.o.tailnet()?.others ?? []
    for (const [host, { found, link }] of this.contacts) {
      if (found?.state !== 'same' || !link) continue
      const fresh = rows && link.device !== from
      const peer = where && found.owner && others.find((p) => p.host === host)
      if (!found.owner) {
        if (fresh) this.nudge(host)
      } else if (peer) void this.visit(peer, false)
      // Should it fail, the next visit gives them.
      else if (fresh) void this.alone(host, () => this.give(host, link)).catch(() => {})
    }
  }

  private visit(peer: TailnetPeer, mine: boolean): Promise<void> {
    return this.alone(peer.host, () => this.exchange(peer, mine))
  }

  /** Works with a device while nothing else does: while it's being visited, that visit is the answer. */
  private alone(host: string, work: () => Promise<void>): Promise<void> {
    const running = this.visiting.get(host)
    if (running) return running
    const done = work().finally(() => this.visiting.delete(host))
    this.visiting.set(host, done)
    return done
  }

  /**
   * What a device has open; if it's the universe open here, and its owner is
   * the user or one of the universe's members, who's in it there, everything
   * it got since it was last asked, and (another person's) everything this
   * one got since it last gave it some.
   */
  private async exchange(peer: TailnetPeer, mine: boolean): Promise<void> {
    const contact = this.contact(peer.host)
    const lastSync = contact.found?.lastSync
    const owner = mine ? undefined : person(peer)
    const set = (status: Omit<DeviceStatus, 'host' | 'name'>, link?: Link) => {
      contact.found = { host: peer.host, name: peer.name, ...status, ...(owner && { owner }) }
      contact.link = link
    }
    const trusted = this.mayVisit({ owner: mine, login: peer.login ?? '' })
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
    if (hello.people) this.presences.hear(project.syncId, hello.people, this.myLogin())
    const link = { device: hello.device, syncId: project.syncId }
    try {
      // Both at once: neither sends the other's own rows, and a row both have is only merged where it's newer.
      await Promise.all([this.take(peer.host, link, hello.project.upTo), mine ? undefined : this.give(peer.host, link)])
      set({ state: 'same', project, lastSync: Date.now() }, link)
    } catch (err) {
      set({ state: 'same', project, ...(lastSync && { lastSync }), error: (err as Error).message }, link)
    }
  }

  /** Every page of rows `host` got since it was last asked (none if it's got nothing since: `upTo`), merged here; the window is told once. */
  private async take(host: string, { device, syncId }: Link, upTo = Infinity): Promise<void> {
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
      if (merged) this.o.merged(session.state())
    }
  }

  /**
   * Every page of rows this copy got since it last gave `host` some (but
   * those `host` wrote: it has them), given to it; nothing is asked when
   * nothing came since. A version from before pushing doesn't take them: it
   * asks for them instead.
   */
  private async give(host: string, { device, syncId }: Link): Promise<void> {
    const { session } = this.o
    for (let since = session.sent(device); this.gotSince(syncId, since); ) {
      const page = session.changesSince(since, device, PAGE)
      if (page.rows.length) {
        try {
          await this.ask(host, '/sync/push', { syncId, rows: page.rows })
        } catch (err) {
          if (isOlderVersion(err)) return
          throw err
        }
      }
      // Another universe opened while it was given: its marks aren't this one's.
      if (session.syncInfo()?.syncId !== syncId) return
      if (page.upTo !== since) session.setSent(device, (since = page.upTo))
      if (!page.more) return
    }
  }

  /** Whether the universe `syncId` is open here, and got rows after `since`. */
  private gotSince(syncId: string, since: number): boolean {
    const open = this.o.session.syncInfo()
    return open?.syncId === syncId && open.upTo > since
  }

  /** Shows the window the rows pushed here, a moment after the last page of a burst. */
  private showSoon(): void {
    clearTimeout(this.showing)
    this.showing = setTimeout(() => this.o.merged(this.o.session.state()), SHOW_MS)
    this.showing.unref()
  }

  /** Makes a copy here of the universe a device has open (the user's own, or one another person shares with them), in a new file at `path`, and opens it. */
  async copyFrom(host: string, path: string): Promise<AppState> {
    const hello = await this.hi(host, false)
    if (!hello.project) throw new Error('That device has no universe open now')
    this.o.session.createCopy(path, hello.project.name, hello.project.syncId)
    await this.take(host, { device: hello.device, syncId: hello.project.syncId })
    // The device it came from learns at once that this one has it too.
    this.nudge(host)
    void this.round()
    return this.o.session.state()
  }

  /** Says hello to a device: with who's here and where, to one that may hear it; to an older version (as it said last time), as it was asked before. */
  private async hi(host: string, visit: boolean): Promise<Hello> {
    const contact = this.contact(host)
    if (contact.older === undefined || Date.now() - contact.older >= OLDER_MS) {
      try {
        const hello = Hello.parse(await this.ask(host, '/sync/hello', visit ? this.ownVisit() : {}))
        contact.older = undefined
        return hello
      } catch (err) {
        if (!isOlderVersion(err)) throw err
        contact.older = Date.now()
      }
    }
    return Hello.parse(await this.ask(host, '/sync/hello'))
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

  /** Who's signed in to Tailscale here, by their login. */
  private myLogin(): string | undefined {
    return this.o.tailnet()?.me?.login
  }

  /** Tells a device there's something new here. */
  private nudge(host: string): void {
    void this.ask(host, '/sync/nudge', { host: this.o.tailnet()?.host }).catch(() => {})
  }

  private ask(host: string, path: string, body?: object): Promise<unknown> {
    return this.o.ask(host, path, this.o.session.device, body)
  }

  /** What's kept of a device, started if there's nothing yet. */
  private contact(host: string): Contact {
    let contact = this.contacts.get(host)
    if (!contact) this.contacts.set(host, (contact = {}))
    return contact
  }

  /** Every device as last found. */
  private allFound(): Found[] {
    return [...this.contacts.values()].flatMap((c) => (c.found ? [c.found] : []))
  }

  /** Tells the window what changed in who's in or other people's devices, if anything did (when they last synced alone isn't news: it goes with the next). */
  private tell(): void {
    const collaboration = this.collaboration()
    const json = JSON.stringify(collaboration, (key, value: unknown) => (key === 'lastSync' ? undefined : value))
    if (json === this.told) return
    this.told = json
    this.o.collaboration(collaboration)
  }
}

const notOpen: SyncAnswer = { status: 409, body: { error: 'That universe isn’t open here' } }

/** Whether a device said it doesn't know what it was asked: an older version (or no Universe at all). */
const isOlderVersion = (err: unknown) => err instanceof AskError && err.status === 404

/** A device's owner, by their login. */
const person = (peer: TailnetPeer): Person | undefined => (peer.login ? personOf(peer.login, peer.ownerName) : undefined)

/** The owners of these devices, each once. */
function peopleOf(devices: readonly TailnetPeer[]): Person[] {
  const people = new Map<string, Person>()
  for (const d of devices) {
    const owner = person(d)
    if (owner) people.set(owner.login, owner)
  }
  return [...people.values()]
}

/** Devices no longer online aren't kept. */
function forgetGone(kept: Map<string, unknown>, online: readonly TailnetPeer[]): void {
  for (const host of kept.keys()) if (!online.some((p) => p.host === host)) kept.delete(host)
}
