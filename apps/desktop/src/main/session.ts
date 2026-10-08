import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { EMPTY_TIMELINE, type Command, type CommandSource, type ExecuteResult, type Target } from '@universe/core'
import { Project } from '@universe/db'
import type { AppState, ProposalSummary, WorldTerrain } from '../shared/api'

const MAX_RECENT = 10

/** Owns the currently open project (one per app instance for now) and the recent-files list. */
export class Session {
  private project: Project | null = null
  private focus: Target | undefined
  /** AI changes held for the user to accept (review mode). Kept for this session only. */
  private proposals: (ProposalSummary & { command: Command })[] = []

  constructor(private readonly userDataDir: string) {}

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
    this.replace(Project.create(path, name))
    return this.state()
  }

  open(path: string): AppState {
    this.replace(Project.open(path))
    return this.state()
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

  /** Holds an AI client's change for the user to accept or reject; returns its id. */
  propose(command: Command, summary: string): string {
    this.require()
    const id = randomUUID()
    this.proposals.push({ id, summary, at: new Date().toISOString(), command })
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

  private get recentFile(): string {
    return join(this.userDataDir, 'recent-projects.json')
  }

  private require(): Project {
    if (!this.project) throw new Error('No project is open')
    return this.project
  }
}
