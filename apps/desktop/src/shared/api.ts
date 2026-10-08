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
  /** How many of the latest changes, one after another, an AI client made: what "Undo AI changes" takes back. */
  aiChanges: number
  /** Changes an AI client proposed while review mode is on, oldest first. */
  proposals: ProposalSummary[]
  /** Node or region the last command created or touched, so the UI can select it. */
  focus?: Target
}

/** A change waiting for the user to accept it. */
export interface ProposalSummary {
  id: string
  /** What it does, in the client's words. */
  summary: string
  at: string
}

/** The local API (PLAN.md §6): whether it's on, where, and how to connect a client. */
export interface ApiStatus {
  /** Let AI clients connect (on by default). */
  enabled: boolean
  /** Hold AI changes for the user to accept. */
  review: boolean
  /** Where it listens, once it does. */
  port: number | null
  /** Why it isn't listening, if it should be. */
  error?: string
  token: string
  /** How to add it to Claude Code: over HTTP to the app, and over stdio (which also works while the app is closed). */
  connect: { http: string; stdio: string } | null
}

/** A change an AI client made, for the app to show. */
export interface AiChange {
  summary: string
}

/** A world's edit layers as loaded by the renderer, with the revision they match. */
export interface WorldTerrain extends TerrainLayers {
  revision: number
}

/** A model file the main process read and added to the project. */
export interface ImportedModel {
  assetId: string
  /** The file's name, extension included. */
  name: string
  state: AppState
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export type MenuAction = 'undo' | 'redo'

export interface UniverseApi {
  getState(): Promise<AppState>
  recentProjects(): Promise<string[]>
  /** Each returns `null` in `value` if the user cancelled the file dialog. */
  newProject(): Promise<Result<AppState | null>>
  openProject(path?: string): Promise<Result<AppState | null>>
  execute(command: unknown): Promise<Result<AppState>>
  getTerrain(worldId: string): Promise<Result<WorldTerrain>>
  /** Asks for a .glb/.gltf file and adds it to the project with `asset.add` (undoable). Null if cancelled. */
  importModel(): Promise<Result<ImportedModel | null>>
  getAsset(id: string): Promise<Result<{ mime: string; data: Uint8Array }>>
  undo(): Promise<Result<AppState>>
  redo(): Promise<Result<AppState>>
  /** Takes back every one of the latest changes an AI client made, one after another. */
  undoAi(): Promise<Result<AppState>>
  acceptProposal(id: string): Promise<Result<AppState>>
  rejectProposal(id: string): Promise<Result<AppState>>
  /** Asks where to save a world's bible (Markdown) and writes it there; the path, or null if cancelled. */
  exportBible(worldId: string): Promise<Result<string | null>>
  apiStatus(): Promise<ApiStatus>
  setApi(patch: { enabled?: boolean; review?: boolean }): Promise<ApiStatus>
  /** A new token: clients with the old one stop working. */
  newApiToken(): Promise<ApiStatus>
  onApi(listener: (status: ApiStatus) => void): () => void
  onAiChange(listener: (change: AiChange) => void): () => void
  onState(listener: (state: AppState) => void): () => void
  onMenu(listener: (action: MenuAction) => void): () => void
  updateStatus(): Promise<UpdateStatus>
  /** Downloads and installs the offered update, then restarts the app into it. */
  installUpdate(): Promise<void>
  dismissUpdate(): Promise<void>
  onUpdate(listener: (status: UpdateStatus) => void): () => void
}

/** The methods the main process answers; the others listen to what it sends. */
export type InvokeMethod = Exclude<keyof UniverseApi, 'onState' | 'onMenu' | 'onUpdate' | 'onApi' | 'onAiChange'>

/** The channel behind each method the main process answers. The preload makes those methods from this table. */
export const INVOKE: Record<InvokeMethod, string> = {
  getState: 'state:get',
  recentProjects: 'project:recent',
  newProject: 'project:new',
  openProject: 'project:open',
  execute: 'cmd:execute',
  undo: 'cmd:undo',
  redo: 'cmd:redo',
  undoAi: 'cmd:undo-ai',
  acceptProposal: 'proposal:accept',
  rejectProposal: 'proposal:reject',
  exportBible: 'world:export-bible',
  apiStatus: 'api:status',
  setApi: 'api:set',
  newApiToken: 'api:new-token',
  getTerrain: 'world:terrain',
  importModel: 'asset:import-model',
  getAsset: 'asset:get',
  updateStatus: 'update:status',
  installUpdate: 'update:install',
  dismissUpdate: 'update:dismiss'
}

/** Channels the main process sends on, behind `onState`, `onMenu` and `onUpdate`. */
export const EVENTS = {
  state: 'state:changed',
  menu: 'menu:action',
  update: 'update:changed',
  api: 'api:changed',
  aiChange: 'ai:changed'
} as const
