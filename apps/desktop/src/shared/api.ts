import type { SpatialNode } from '@universe/core'

/** Shared between the main process, the preload bridge and the renderer. Types only. */

export interface BuildInfo {
  version: string
  commit: string
  builtAt: string
}

export interface ProjectSummary {
  path: string
  name: string
  rootId: string
}

export interface AppState {
  project: ProjectSummary | null
  nodes: SpatialNode[]
  canUndo: boolean
  canRedo: boolean
  /** Node the last command created or touched, so the UI can select it. */
  focusId?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export type MenuAction = 'undo' | 'redo'

export interface UniverseApi {
  getState(): Promise<AppState>
  recentProjects(): Promise<string[]>
  /** Each returns `null` in `value` if the user cancelled the file dialog. */
  newProject(): Promise<Result<AppState | null>>
  openProject(path?: string): Promise<Result<AppState | null>>
  saveCopy(): Promise<Result<string | null>>
  closeProject(): Promise<AppState>
  execute(command: unknown): Promise<Result<AppState>>
  undo(): Promise<Result<AppState>>
  redo(): Promise<Result<AppState>>
  onState(listener: (state: AppState) => void): () => void
  onMenu(listener: (action: MenuAction) => void): () => void
}

export const IPC = {
  getState: 'state:get',
  recent: 'project:recent',
  newProject: 'project:new',
  openProject: 'project:open',
  saveCopy: 'project:save-copy',
  closeProject: 'project:close',
  execute: 'cmd:execute',
  undo: 'cmd:undo',
  redo: 'cmd:redo',
  stateChanged: 'state:changed',
  menu: 'menu:action'
} as const
