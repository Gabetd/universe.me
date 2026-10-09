import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { writePrivate } from '@universe/api'
import { Command as CommandSchema, CommandError, DEVICE_ID, EMPTY_TIMELINE, type Command, type CommandSource, type ExecuteResult, type SyncPage, type SyncRow, type Target } from '@universe/core'
import { Project } from '@universe/db'
import type { AppState, ProposalSummary, WorldTerrain } from '../shared/api'

const MAX_RECENT = 10
/** Suggestions waiting at most: a client stuck in a loop can't fill memory with them. */
const MAX_PROPOSALS = 200
/** And at most this many characters of them, all together (a suggestion can carry a model, or a thousand commands). */
const MAX_PROPOSAL_CHARS = 50 * 1024 * 1024

/** Owns the currently open project (one per app instance for now) and the recent-files list. */
export class Session {
  private project: Project | null = null
  private focus: Target | undefined
  /** AI changes held for the user to accept (review mode). Kept for this session only. */
  private proposals: (ProposalSummary & { command: Command; size: number })[] = []

  /** This install, in the stamps of what it writes (PLAN.md §6.7): made once, kept in its own file. */
  readonly device: string

  /** Told of every change made here (a command, undo or redo; not rows merged from another device). */
  onChange: (() => void) | undefined

  constructor(private readonly userDataDir: string) {
    this.device = loadDevice(join(userDataDir, 'device.json'))
  }

  get isOpen(): boolean {
    return this.project !== null
  }

  /** Where the open project is, if one is. */
  get path(): string | undefined {
    return this.project?.path
  }

  state(): AppState {
    const p = this.project
    if (!p) return { project: null, nodes: [], worlds: [], regions: [], timeline: EMPTY_TIMELINE, canUndo: false, canRedo: false, aiChanges: 0, proposals: [] }
    const { path, name, rootId } = p.info()
    const proposals = this.proposals.map(({ id, summary, at }) => ({ id, summary, at }))
    return { project: { path, name, rootId }, ...p.snapshot(), canUndo: p.bus.canUndo, canRedo: p.bus.canRedo, aiChanges: p.bus.latestFrom('ai'), proposals, focus: this.focus }
  }

  create(path: string): AppState {
    const name = basename(path, extname(path))
    this.replace(Project.create(path, name, this.projectOptions))
    return this.state()
  }

  open(path: string): AppState {
    this.replace(Project.open(path, this.projectOptions))
    return this.state()
  }

  /** A new, empty file for a universe coming from another device (with its sync id), opened: its rows arrive with `merge`. */
  createCopy(path: string, name: string, syncId: string): void {
    this.replace(Project.create(path, name, { ...this.projectOptions, copyOf: syncId }))
  }

  /** The open universe as sync sees it (PLAN.md §6.7): its id, name and when it last got a row, if one is open (a copy has its id before its rows arrive). */
  syncInfo(): { syncId: string; name: string; upTo: number } | undefined {
    const p = this.project
    return p ? { syncId: p.syncId(), name: p.info().name, upTo: p.changedUpTo } : undefined
  }

  /** What another device asks for: the rows the open universe got after `since`, but that device's own. */
  changesSince(since: number, from: string, limit: number): SyncPage {
    return this.require().changesSince(since, { from, limit })
  }

  /** Rows from another device, merged into the open universe; whether any came. */
  merge(rows: SyncRow[]): boolean {
    if (!rows.length) return false
    this.require().merge(rows)
    return true
  }

  /** Where the open universe last asked a device for its changes from (0: never). */
  seen(device: string): number {
    return Number(this.require().getMeta(`syncSeen:${device}`) ?? 0)
  }

  setSeen(device: string, upTo: number): void {
    this.require().setMeta(`syncSeen:${device}`, String(upTo))
  }

  async saveCopy(path: string): Promise<void> {
    await this.require().saveCopy(path)
    this.remember(path)
  }

  close(): void {
    this.project?.close()
    this.project = null
    this.focus = undefined
    this.proposals = []
  }

  /** Applies a command. An AI client's doesn't move the selection: the user may be in the middle of something. */
  execute(command: unknown, source: CommandSource = 'user'): AppState {
    const result = this.require().bus.execute(command, source)
    return source === 'user' ? this.applied(result) : this.state()
  }

  /** Every one of the latest changes an AI client made, one after another, taken back. */
  undoAi(): AppState {
    const { bus } = this.require()
    for (let n = bus.latestFrom('ai'); n > 0; n--) bus.undo()
    this.focus = undefined
    return this.state()
  }

  /** Holds an AI client's change for the user to accept or reject; returns its id. It must be a valid command, and only so many wait at once. */
  propose(command: Command, summary: string): string {
    this.require()
    const parsed = CommandSchema.safeParse(command)
    if (!parsed.success) throw new CommandError(`That isn’t a valid change: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
    if (this.proposals.length >= MAX_PROPOSALS) throw new CommandError(`${MAX_PROPOSALS} suggestions are already waiting for the user`)
    const size = JSON.stringify(command).length
    if (this.proposals.reduce((n, p) => n + p.size, size) > MAX_PROPOSAL_CHARS) throw new CommandError('The suggestions waiting for the user are already as big as they can be')
    const id = randomUUID()
    this.proposals.push({ id, summary, at: new Date().toISOString(), command, size })
    return id
  }

  /** Applies a proposed change, as the AI's (so it undoes with the rest of them). */
  accept(id: string): AppState {
    const proposal = this.take(id)
    try {
      return this.execute(proposal.command, 'ai')
    } catch (err) {
      throw new Error(`“${proposal.summary}” can’t be applied any more: ${(err as Error).message}`)
    }
  }

  reject(id: string): AppState {
    this.take(id)
    return this.state()
  }

  private take(id: string) {
    const proposal = this.proposals.find((p) => p.id === id)
    if (!proposal) throw new Error('That suggestion is gone')
    this.proposals = this.proposals.filter((p) => p !== proposal)
    return proposal
  }

  undo(): AppState {
    return this.applied(this.require().bus.undo())
  }

  redo(): AppState {
    return this.applied(this.require().bus.redo())
  }

  /** Edit layers of a world. */
  terrain(worldId: string): WorldTerrain {
    return this.require().terrain(worldId)
  }

  /** Keeps a file in the project with `asset.add`, undoable like any command. */
  addAsset(name: string, mime: string, bytes: Buffer): { assetId: string; state: AppState } {
    const assetId = randomUUID()
    return { assetId, state: this.execute({ type: 'asset.add', payload: { id: assetId, name, mime, data: bytes.toString('base64') } }) }
  }

  /** A file kept in the project, such as an imported model. */
  asset(id: string): { mime: string; data: Uint8Array } {
    const asset = this.require().store.assets.get(id)
    if (!asset) throw new Error('That file is missing from the project')
    return { mime: asset.mime, data: asset.data }
  }

  private applied(result: ExecuteResult | undefined): AppState {
    this.focus = result?.target
    return this.state()
  }

  recent(): string[] {
    try {
      const list = JSON.parse(readFileSync(this.recentFile, 'utf8')) as unknown
      return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && existsSync(p)) : []
    } catch {
      return []
    }
  }

  private replace(project: Project): void {
    this.close()
    this.project = project
    this.remember(project.path)
  }

  private remember(path: string): void {
    const list = [path, ...this.recent().filter((p) => p !== path)].slice(0, MAX_RECENT)
    mkdirSync(dirname(this.recentFile), { recursive: true })
    writeFileSync(this.recentFile, JSON.stringify(list, null, 2))
  }

  private get projectOptions() {
    return { device: this.device, onChange: () => this.onChange?.() }
  }

  private get recentFile(): string {
    return join(this.userDataDir, 'recent-projects.json')
  }

  private require(): Project {
    if (!this.project) throw new Error('No project is open')
    return this.project
  }
}

/** This install's device id: read from its file, or made (and kept) the first time. */
function loadDevice(file: string): string {
  try {
    const { id } = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown }
    if (typeof id === 'string' && DEVICE_ID.test(id)) return id
  } catch {
    // First run, or an unreadable file: a new id.
  }
  const id = randomBytes(9).toString('base64url')
  writePrivate(file, JSON.stringify({ id }))
  return id
}
