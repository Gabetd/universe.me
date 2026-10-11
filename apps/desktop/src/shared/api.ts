import type { Channel, ChannelVersion, UpdateStatus } from './update'
import type { Region, SpatialNode, Target, TerrainLayers, TimelineData, WorldInfo } from '@universe/core'
import type { ContributionKind, Nameable, PluginManifest } from '@universe/plugins/manifest'

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

/** A plugin as the plugin manager shows it (PLAN.md §9, M16). */
export interface PluginInfo {
  /** Its id from plugin.json; its folder's name if that can't be read. */
  id: string
  /** Its folder. */
  path: string
  /** A folder of the user's the app only points to (removing forgets it), or one in the app's own plugins folder (removing puts it in the bin). */
  linked: boolean
  enabled: boolean
  manifest?: PluginManifest
  /** Why it can't be used, if it can't. */
  error?: string
  /** What it logged in its last run. */
  log: string[]
}

/** Running one of a plugin's contributions: on a world (or the universe), with its options. */
export interface PluginRunRequest {
  pluginId: string
  kind: ContributionKind
  id: string
  worldId?: string
  options: Record<string, unknown>
  /** For a name generator: what's being named, and how many names to make. */
  naming?: { for: Nameable; count: number }
}

/** How a run went: what it changed (one undoable step), saved or named, and its log. */
export interface PluginRunResult {
  summary: string
  /** Changes made to the universe (undone together). */
  changes: number
  /** Where an exporter's files were saved; empty if the user cancelled. */
  saved?: string[]
  names?: string[]
  log: string[]
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

/**
 * Several people in one universe (PLAN.md §6.7, "With other people"): what
 * the window builds the sharing panel and who's-in marks on.
 *
 * - `collaboration()` reads it all, and `onCollaboration` hears each change
 *   (who's in or where, the members, other people's devices), as `onApi`
 *   hears sync's devices. It needs sync on (`ApiStatus.phone.sync.on`);
 *   `on` says whether it is, and Tailscale signed in.
 * - **Inviting** someone is a command, undoable like any:
 *   `execute({ type: 'member.create', payload: { ownerId: state.project.rootId, login, name?, invitedBy: me } })`,
 *   `login` being their tailnet login (one of `people`, or typed). Passing
 *   `invitedBy` lists you too if you aren't yet, which their devices need to
 *   answer yours. They then see the universe in `shared` on their computer
 *   once it can reach one of yours with it open (Tailscale machine sharing
 *   lets the person a machine is shared with reach it), and copy it with
 *   `copyFromDevice(host)`, as for their own devices.
 * - **Removing** someone: `execute({ type: 'member.delete', payload: { id } })`
 *   with their member's id (renaming: `member.update`). Members are records of
 *   the universe (`state.timeline.members` too), synced with it; API clients
 *   can't change them.
 * - **Where you are**: `setWhere({ nodeId, view, label })` whenever the
 *   selection or the view changes (null with nothing open), as others will
 *   read it ("Terra, the map").
 */
export interface Collaboration {
  /** Whether sync is on and Tailscale says who's signed in: all of this needs both. */
  on: boolean
  /** Who's signed in to Tailscale here. */
  me: Person | null
  /** Who the open universe is shared with (none with nothing open); `you` marks your own entry. */
  members: MemberInfo[]
  /** Who's in the open universe now (heard from in the last half minute), but you, and where. */
  here: PersonIn[]
  /** Other people's devices with a universe shared with you open; `copyFromDevice(host)` copies one here. */
  shared: SharedDevice[]
  /** Other people on your tailnet, or with devices shared into it, whom you could invite. */
  people: Person[]
}

/** Someone, by their tailnet login and what they're called. */
export interface Person {
  login: string
  name: string
}

/** A member of the open universe (its `member` record). */
export interface MemberInfo extends Person {
  id: string
  /** Who invited them, by login. */
  invitedBy: string | null
  /** Whether it's you. */
  you: boolean
}

/** Where someone is in a universe, as the window tells it: what's selected, the view, and both in words. */
export interface Where {
  /** The node (a world, a star system…) they're on, if any. */
  nodeId: string | null
  /** The view, as the window names it ("map", "globe", "timeline", "canvas"…). */
  view: string
  /** Both in words, as others see it: "Terra, the map". */
  label: string
}

/** Someone in a universe now, and where (null until their window says). */
export interface PersonIn extends Person {
  where: Where | null
}

/** Another person's device with a universe shared with you open. */
export interface SharedDevice {
  host: string
  name: string
  owner: Person
  project: { syncId: string; name: string }
  /** You have it open too: the two keep each other up to date. */
  same: boolean
  lastSync?: number
  error?: string
}

/** A device on the user's tailnet (or shared into it): its tailnet name, its own name, and whose it is. */
export interface TailnetPeer {
  host: string
  name: string
  /** Its owner's tailnet login, and what they're called. */
  login?: string
  ownerName?: string
}

/**
 * Tailscale on this computer, as phone access and sync need it: not there,
 * there but not running or signed in, or ready (with where Funnel forwards,
 * if anywhere, who's signed in, the user's other devices online, and other
 * people's this computer can reach).
 */
export type TailscaleState =
  | { kind: 'missing' }
  | { kind: 'stopped'; detail: string }
  | { kind: 'ready'; host: string; login?: string; name?: string; funnelPort: number | null; appPort: number | null; peers: TailnetPeer[]; others: TailnetPeer[] }

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
export type MenuAction = 'undo' | 'redo' | 'shortcuts' | 'versions' | 'dictionary' | 'plugins'

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
  /** Saves a part of the window (a canvas, in CSS px) as a PNG where the user says; the path, or null if cancelled. */
  exportImage(rect: { x: number; y: number; width: number; height: number }, name: string): Promise<Result<string | null>>
  apiStatus(): Promise<ApiStatus>
  setApi(patch: ApiSettingsPatch): Promise<ApiStatus>
  /** A new token: clients with the old one stop working. */
  newApiToken(): Promise<ApiStatus>
  /** Turns down a client signing in (its page then says so). */
  denySignIn(id: string): Promise<ApiStatus>
  /** Disconnects a client that signed in: its tokens stop working at once. */
  removeConnection(id: string): Promise<ApiStatus>
  /** Makes a copy here of the universe another device has open (one of the user's own, or another person's shared with them: `Collaboration.shared`), saved where the user picks, and opens it; null if they cancel. */
  copyFromDevice(host: string): Promise<Result<AppState | null>>
  /** Several people in one universe: see `Collaboration`. */
  collaboration(): Promise<Collaboration>
  /** Where the user is in the open universe, for the others in it to see; null with nothing to say. */
  setWhere(where: Where | null): Promise<void>
  onCollaboration(listener: (collaboration: Collaboration) => void): () => void
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
  /** The plugins installed (PLAN.md §9, M16). */
  plugins(): Promise<PluginInfo[]>
  /** Points the app to a plugin folder the user picks; null if they cancel. */
  addPlugin(): Promise<Result<PluginInfo[] | null>>
  /** A new plugin made from the template (a working example) in the app's plugins folder, opened in the file manager. */
  newPlugin(): Promise<Result<PluginInfo[]>>
  removePlugin(id: string): Promise<Result<PluginInfo[]>>
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo[]>
  /** Opens a plugin's folder in the file manager. */
  showPlugin(id: string): Promise<void>
  runPlugin(request: PluginRunRequest): Promise<Result<PluginRunResult>>
  /** Pastes the clipboard into the focused field (pages may write to the clipboard, but not read it). */
  paste(): Promise<void>
  onUpdate(listener: (status: UpdateStatus) => void): () => void
}

/** The methods the main process answers; the others listen to what it sends. */
export type InvokeMethod = Exclude<keyof UniverseApi, 'remote' | 'onState' | 'onMenu' | 'onUpdate' | 'onApi' | 'onAiChange' | 'onCollaboration'>

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
  exportImage: 'window:export-image',
  apiStatus: 'api:status',
  setApi: 'api:set',
  newApiToken: 'api:new-token',
  denySignIn: 'api:deny-sign-in',
  removeConnection: 'api:remove-connection',
  copyFromDevice: 'sync:copy',
  collaboration: 'collab:get',
  setWhere: 'collab:where',
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
  paste: 'edit:paste',
  plugins: 'plugin:list',
  addPlugin: 'plugin:add',
  newPlugin: 'plugin:new',
  removePlugin: 'plugin:remove',
  setPluginEnabled: 'plugin:enable',
  showPlugin: 'plugin:show',
  runPlugin: 'plugin:run'
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

/** Channels the main process sends on, behind `onState`, `onMenu`, `onUpdate`, `onApi`, `onAiChange` and `onCollaboration`. */
export const EVENTS = {
  state: 'state:changed',
  menu: 'menu:action',
  update: 'update:changed',
  api: 'api:changed',
  aiChange: 'ai:changed',
  collaboration: 'collab:changed'
} as const
