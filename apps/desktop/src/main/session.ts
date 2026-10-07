import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { CUBE_FACES, DEFAULT_WORLD_SETTINGS, EMPTY_TIMELINE, RECORD_KINDS, type ExecuteResult, type Target, type TerrainLayerName, type TimelineData } from '@universe/core'
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

  state(): AppState {
    const p = this.project
    if (!p) return { project: null, nodes: [], worlds: [], regions: [], timeline: EMPTY_TIMELINE, canUndo: false, canRedo: false }
    const info = p.info()
    const nodes = p.store.nodes.all()
    const worldIds = new Set(nodes.filter((n) => n.kind === 'world').map((n) => n.id))
    const liveIds = new Set(nodes.map((n) => n.id))
    const timeline = Object.fromEntries(
      RECORD_KINDS.map((kind) => [`${kind}s`, p.store.records(kind).all().filter((r) => liveIds.has(r.ownerId))])
    ) as TimelineData
    return {
      project: { path: info.path, name: info.name, rootId: info.rootId },
      nodes,
      worlds: [...worldIds].map((id) => ({
        id,
        settings: p.store.worlds.getSettings(id) ?? DEFAULT_WORLD_SETTINGS,
        terrainRevision: p.store.worlds.terrainRevision(id)
      })),
      regions: p.store.regions.all().filter((r) => worldIds.has(r.worldId)),
      timeline,
      canUndo: p.bus.canUndo,
      canRedo: p.bus.canRedo,
      focus: this.focus
    }
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
