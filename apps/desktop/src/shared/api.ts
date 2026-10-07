import type { UpdateStatus } from './update'
import type { Region, SpatialNode, Target, TerrainLayers, TimelineData, WorldInfo } from '@universe/core'

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
  /** Every live world's settings and terrain revision. */
  worlds: WorldInfo[]
  /** Every live region on a live world. */
  regions: Region[]
  /** Every live timeline record whose owner is live. */
  timeline: TimelineData
  canUndo: boolean
  canRedo: boolean
  /** Node or region the last command created or touched, so the UI can select it. */
  focus?: Target
}

/** A world's edit layers as loaded by the renderer, with the revision they match. */
export interface WorldTerrain extends TerrainLayers {
  revision: number
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
  getTerrain(worldId: string): Promise<Result<WorldTerrain>>
  undo(): Promise<Result<AppState>>
  redo(): Promise<Result<AppState>>
  onState(listener: (state: AppState) => void): () => void
  onMenu(listener: (action: MenuAction) => void): () => void
  updateStatus(): Promise<UpdateStatus>
  /** Downloads and installs the offered update, then restarts the app into it. */
  installUpdate(): Promise<void>
  dismissUpdate(): Promise<void>
  onUpdate(listener: (status: UpdateStatus) => void): () => void
}

export const IPC = {
  getState: 'state:get',
  recent: 'project:recent',
  newProject: 'project:new',
  openProject: 'project:open',
  saveCopy: 'project:save-copy',
  closeProject: 'project:close',
  execute: 'cmd:execute',
  terrain: 'world:terrain',
  undo: 'cmd:undo',
  redo: 'cmd:redo',
  stateChanged: 'state:changed',
  menu: 'menu:action',
  updateStatus: 'update:status',
  updateChanged: 'update:changed',
  installUpdate: 'update:install',
  dismissUpdate: 'update:dismiss'
} as const
