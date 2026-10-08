import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { CUBE_FACES, EMPTY_TIMELINE, type ExecuteResult, type Target, type TerrainLayerName } from '@universe/core'
import { Project } from '@universe/db'
import type { AppState, WorldTerrain } from '../shared/api'

const MAX_RECENT = 10

/** Owns the currently open project (one per app instance for now) and the recent-files list. */
export class Session {
  private project: Project | null = null
  private focus: Target | undefined

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
    if (!p) return { project: null, nodes: [], worlds: [], regions: [], timeline: EMPTY_TIMELINE, canUndo: false, canRedo: false }
    const { path, name, rootId } = p.info()
    return { project: { path, name, rootId }, ...p.snapshot(), canUndo: p.bus.canUndo, canRedo: p.bus.canRedo, focus: this.focus }
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

  saveCopy(path: string): void {
    this.require().saveCopy(path)
    this.remember(path)
  }

  close(): void {
    this.project?.close()
    this.project = null
    this.focus = undefined
  }

  execute(command: unknown): AppState {
    return this.applied(this.require().bus.execute(command, 'user'))
  }

  undo(): AppState {
    return this.applied(this.require().bus.undo())
  }

  redo(): AppState {
    return this.applied(this.require().bus.redo())
  }

  /** Edit layers of a world. Unedited faces are left out, so loading a fresh world copies almost nothing. */
  terrain(worldId: string): WorldTerrain {
    const { worlds } = this.require().store
    const layer = (name: TerrainLayerName) => Array.from({ length: CUBE_FACES }, (_, face) => worlds.getLayer(worldId, name, face))
    return { revision: worlds.terrainRevision(worldId), height: layer('height'), biome: layer('biome') }
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
