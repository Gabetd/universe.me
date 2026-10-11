import type { Channel, ChannelVersion, UpdateStatus } from './update'
import type { Region, SpatialNode, Target, TerrainLayers, TimelineData, WorldInfo } from '@universe/core'

/** Shared between the main process, the preload bridge and the renderer. Types only. */

export interface BuildInfo {
  version: string
  commit: string
  builtAt: string
  /** The branch it was built from (shared/update.ts `CHANNELS`): main's builds are "Universe", the others' "Universe (dev)" and "Universe (staging)". */
  channel: Channel
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
  phone: PhoneStatus
}

/**
 * One of the user's other devices, as sync sees it (PLAN.md §6.7): not
 * answering (Universe isn't running there, or sync is off), with nothing
 * open, with another universe open, or with the same one (synced then).
 */
export interface DeviceStatus {
  host: string
  name: string
  state: 'unreachable' | 'nothing' | 'other' | 'same'
  project?: { syncId: string; name: string }
  lastSync?: number
  error?: string
}

/** One of the user's other devices on their tailnet. */
export interface TailnetPeer {
  host: string
  name: string
}

/** Tailscale on this computer, as phone access needs it: not there, there but not running or signed in, or ready (with where Funnel forwards, if anywhere). */
export type TailscaleState =
  | { kind: 'missing' }
  | { kind: 'stopped'; detail: string }
  | { kind: 'ready'; host: string; login?: string; funnelPort: number | null; appPort: number | null; peers: TailnetPeer[] }

/** Phone access (PLAN.md §6.4): Claude on a phone, through a claude.ai custom connector, Tailscale Funnel and OAuth. */
export interface PhoneStatus {
  on: boolean
  tailscale: TailscaleState
  /** The connector's address to add on claude.ai, while phone access works. */
  url: string | null
  /** What's in the way, if it should work. */
  error?: string
  /** Clients signing in now, each with the code to type on its sign-in page. */
  signIns: { id: string; client: string; code: string; to: string; expires: number }[]
  /** Clients that have signed in. */
  connections: { id: string; name: string; created: number; lastUsed: number }[]
  /** The phone app (PLAN.md §6.6): this app in the phone's browser, on the tailnet only. */
  app: { on: boolean; url: string | null; error?: string }
  /** Sync with the user's other devices (PLAN.md §6.7). */
  sync: { on: boolean; devices: DeviceStatus[]; error?: string }
}

/** What the user can change about the API. */
export interface ApiSettingsPatch {
  enabled?: boolean
  review?: boolean
  /** Phone access: Funnel to the API's port, and the public address accepted. */
  phone?: boolean
  /** The phone app: this app served on the tailnet, through `tailscale serve`. */
  phoneApp?: boolean
  /** Sync with the user's other devices, on the same tailnet address. */
  sync?: boolean
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

/** What a menu item asks of the window: undo or redo (whatever has focus takes it), or the shortcuts sheet. */
export type MenuAction = 'undo' | 'redo' | 'shortcuts' | 'versions' | 'dictionary'

export interface UniverseApi {
  /** The phone app's bridge (PLAN.md §6.6), rather than the window's: what's only for the computer isn't there. */
  readonly remote?: true
  getState(): Promise<AppState>
  recentProjects(): Promise<string[]>
  /** Each returns `null` in `value` if the user cancelled the file dialog. */
  newProject(): Promise<Result<AppState | null>>
  /** A copy of the sample universe, saved where the user picks, and opened on its world. */
  newSample(): Promise<Result<AppState | null>>
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
  setApi(patch: ApiSettingsPatch): Promise<ApiStatus>
  /** A new token: clients with the old one stop working. */
  newApiToken(): Promise<ApiStatus>
  /** Turns down a client signing in (its page then says so). */
  denySignIn(id: string): Promise<ApiStatus>
  /** Disconnects a client that signed in: its tokens stop working at once. */
  removeConnection(id: string): Promise<ApiStatus>
  /** Makes a copy here of the universe another device has open (saved where the user picks), and opens it; null if they cancel. */
  copyFromDevice(host: string): Promise<Result<AppState | null>>
  onApi(listener: (status: ApiStatus) => void): () => void
  onAiChange(listener: (change: AiChange) => void): () => void
  onState(listener: (state: AppState) => void): () => void
  onMenu(listener: (action: MenuAction) => void): () => void
  updateStatus(): Promise<UpdateStatus>
  /** Downloads and installs the offered update, then restarts the app into it. */
  installUpdate(): Promise<void>
  dismissUpdate(): Promise<void>
  /** Looks on GitHub for a newer build now (offering again one that was dismissed): null if the update banner shows it, otherwise why there's nothing to install. */
  checkForUpdates(): Promise<string | null>
  /** Change version: every channel's newest build (Live, Staging, Dev). */
  versions(): Promise<ChannelVersion[]>
  /** Installs another channel's app beside this one and opens it: null once it's opening, otherwise why it couldn't. */
  installVersion(channel: Channel): Promise<string | null>
  /** The spelling dictionary: which of these words are misspelled (what's underlined as it's typed). */
  spellCheck(words: string[]): Promise<string[]>
  /** Whether a word is misspelled, and its corrections, best first. */
  spellWord(word: string): Promise<{ misspelled: boolean; suggestions: string[] }>
  /** The words the user added to the dictionary. */
  dictionaryWords(): Promise<string[]>
  addWord(word: string): Promise<string[]>
  removeWord(word: string): Promise<string[]>
  /** The names in the open universe, which count as spelled right. */
  setSpellingNames(names: string[]): Promise<void>
  /** Pastes the clipboard into the focused field (pages may write to the clipboard, but not read it). */
  paste(): Promise<void>
  onUpdate(listener: (status: UpdateStatus) => void): () => void
}

/** The methods the main process answers; the others listen to what it sends. */
export type InvokeMethod = Exclude<keyof UniverseApi, 'remote' | 'onState' | 'onMenu' | 'onUpdate' | 'onApi' | 'onAiChange'>

/** The channel behind each method the main process answers. The preload makes those methods from this table. */
export const INVOKE: Record<InvokeMethod, string> = {
  getState: 'state:get',
  recentProjects: 'project:recent',
  newProject: 'project:new',
  newSample: 'project:sample',
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
  denySignIn: 'api:deny-sign-in',
  removeConnection: 'api:remove-connection',
  copyFromDevice: 'sync:copy',
  getTerrain: 'world:terrain',
  importModel: 'asset:import-model',
  getAsset: 'asset:get',
  updateStatus: 'update:status',
  installUpdate: 'update:install',
  dismissUpdate: 'update:dismiss',
  checkForUpdates: 'update:check',
  versions: 'update:versions',
  installVersion: 'update:install-version',
  spellCheck: 'spell:check',
  spellWord: 'spell:word',
  dictionaryWords: 'spell:words',
  addWord: 'spell:add',
  removeWord: 'spell:remove',
  setSpellingNames: 'spell:names',
  paste: 'edit:paste'
}

/**
 * What the phone app may ask (PLAN.md §6.6): working on the open project.
 * Not opening files or dialogs on the computer, the API's settings and token,
 * nor updates: those stay with whoever sits at the computer.
 */
export const REMOTE_METHODS = ['getState', 'execute', 'undo', 'redo', 'undoAi', 'acceptProposal', 'rejectProposal', 'getTerrain', 'getAsset'] as const satisfies readonly InvokeMethod[]
export type RemoteMethod = (typeof REMOTE_METHODS)[number]
export const isRemoteMethod = (name: string): name is RemoteMethod => (REMOTE_METHODS as readonly string[]).includes(name)

/** What the phone app hears as it happens: the project's state, and AI changes. */
export const REMOTE_EVENTS = ['state', 'aiChange'] as const
export type RemoteEvent = (typeof REMOTE_EVENTS)[number]

/** Channels the main process sends on, behind `onState`, `onMenu` and `onUpdate`. */
export const EVENTS = {
  state: 'state:changed',
  menu: 'menu:action',
  update: 'update:changed',
  api: 'api:changed',
  aiChange: 'ai:changed'
} as const
