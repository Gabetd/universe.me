import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Project } from '@universe/db'
import type { AppState } from '../shared/api'

const MAX_RECENT = 10

/** Owns the currently open project (one per app instance for now) and the recent-files list. */
export class Session {
  private project: Project | null = null
  private focusId: string | undefined

  constructor(private readonly userDataDir: string) {}

  get isOpen(): boolean {
    return this.project !== null
  }

  state(): AppState {
    const p = this.project
    if (!p) return { project: null, nodes: [], canUndo: false, canRedo: false }
    const info = p.info()
    return {
      project: { path: info.path, name: info.name, rootId: info.rootId },
      nodes: p.store.nodes.all(),
      canUndo: p.bus.canUndo,
      canRedo: p.bus.canRedo,
      focusId: this.focusId
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
    this.focusId = undefined
  }

  execute(command: unknown): AppState {
    this.focusId = this.require().bus.execute(command, 'user').targetId
    return this.state()
  }

  undo(): AppState {
    this.focusId = this.require().bus.undo()?.targetId
    return this.state()
  }

  redo(): AppState {
    this.focusId = this.require().bus.redo()?.targetId
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
