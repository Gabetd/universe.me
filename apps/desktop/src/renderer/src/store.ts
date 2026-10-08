import { EMPTY_TIMELINE, timelineOwner, type Command, type SpatialNode, type TimelineData, type TimelineEvent } from '@universe/core'
import { useMemo } from 'react'
import { create } from 'zustand'
import type { AppState, Result } from '../../shared/api'
import { reconcile } from './reconcile'

interface UiState extends AppState {
  ready: boolean
  selectedId: string | null
  error: string | null
  apply(state: AppState): void
  select(id: string | null): void
  dismissError(): void
  /** Runs a bridge call and surfaces its error, if any, in the error banner. */
  run<T>(call: Promise<Result<T>>): Promise<T | undefined>
  /** Runs a command; resolves to the new state, or undefined (and shows the error) if it was rejected. */
  execute(command: Command): Promise<AppState | undefined>
  selectedRegionId: string | null
  selectRegion(id: string | null): void
  /** A structure on the selected world. Like a region, it's shown in the inspector above the world. */
  selectedStructureId: string | null
  selectStructure(id: string | null): void
  /** A character on the selected world, shown in the inspector like a structure. */
  selectedCharacterId: string | null
  selectCharacter(id: string | null): void
  /** Selected timeline records: several events (for grouping), or one era, group, link… */
  timelineSelection: TimelineSelection | null
  selectTimeline(selection: TimelineSelection | null): void
}

/** Timeline records with an inspector panel of their own: what a timeline selection can be. */
const PANEL_KINDS = ['event', 'era', 'group', 'link', 'theme', 'themeSpan'] as const

export interface TimelineSelection {
  kind: (typeof PANEL_KINDS)[number]
  ids: string[]
}

const hasPanel = (kind: string): kind is TimelineSelection['kind'] => (PANEL_KINDS as readonly string[]).includes(kind)

export const useUi = create<UiState>((set, get) => ({
  ready: false,
  project: null,
  nodes: [],
  canUndo: false,
  canRedo: false,
  aiChanges: 0,
  proposals: [],
  worlds: [],
  regions: [],
  timeline: EMPTY_TIMELINE,
  selectedId: null,
  timelineSelection: null,
  selectedRegionId: null,
  selectedStructureId: null,
  selectedCharacterId: null,
  error: null,

  apply(reply) {
    const state = reconcile(get(), reply)
    set({ ...state, ready: true, ...nextSelection(state, get()) })
  },

  select: (id) => set({ selectedId: id, ...NOTHING_ON_WORLD }),
  selectTimeline: (timelineSelection) => set(timelineSelection ? { ...NOTHING_ON_WORLD, timelineSelection } : { timelineSelection }),
  // A region, a structure, a character and timeline records are never selected together: whichever was picked last is what the inspector shows.
  selectRegion: (id) => set(id ? { ...NOTHING_ON_WORLD, selectedRegionId: id } : { selectedRegionId: null }),
  selectStructure: (id) => set(id ? { ...NOTHING_ON_WORLD, selectedStructureId: id } : { selectedStructureId: null }),
  selectCharacter: (id) => set(id ? { ...NOTHING_ON_WORLD, selectedCharacterId: id } : { selectedCharacterId: null }),
  dismissError: () => set({ error: null }),

  async run(call) {
    const result = await call
    if (!result.ok) {
      set({ error: result.error })
      return undefined
    }
    set({ error: null })
    return result.value
  },

  execute: (command) => applyReply(window.universe.execute(command))
}))

/** Runs a bridge call that replies with the project's new state, and shows that state (or the error). */
export async function applyReply(call: Promise<Result<AppState>>): Promise<AppState | undefined> {
  const { run, apply } = useUi.getState()
  const state = await run(call)
  if (state) apply(state)
  return state
}

/** Nothing selected on the world surface or its timeline. */
const NOTHING_ON_WORLD = { selectedRegionId: null, selectedStructureId: null, selectedCharacterId: null, timelineSelection: null }

type Selection = Pick<UiState, 'selectedId' | 'selectedRegionId' | 'selectedStructureId' | 'selectedCharacterId' | 'timelineSelection'>

/**
 * Selects what the last command targeted (a region or structure selects its
 * world too, a timeline record selects itself); otherwise keeps the selection
 * while it exists.
 */
function nextSelection(state: AppState, current: Selection): Selection {
  const { focus } = state
  const timelineSelection = keptTimelineSelection(state, current.timelineSelection)
  const none = NOTHING_ON_WORLD
  if (focus?.kind === 'region') {
    const region = state.regions.find((r) => r.id === focus.id)
    if (region) return { ...none, selectedId: region.worldId, selectedRegionId: region.id }
  }
  if (focus?.kind === 'structure' && current.selectedStructureId !== focus.id) {
    const structure = state.timeline.structures.find((s) => s.id === focus.id)
    if (structure) return { ...none, selectedId: structure.ownerId, selectedStructureId: structure.id }
  }
  if (focus?.kind === 'character' && current.selectedCharacterId !== focus.id) {
    const character = state.timeline.characters.find((c) => c.id === focus.id)
    if (character) return { ...none, selectedId: character.ownerId, selectedCharacterId: character.id }
  }
  // Lanes and changes are edited in place, so only records with an inspector panel get selected.
  if (focus && hasPanel(focus.kind)) {
    const kind = focus.kind
    if (state.timeline[`${kind}s`].some((r) => r.id === focus.id)) {
      const ids = current.timelineSelection?.kind === kind && current.timelineSelection.ids.includes(focus.id) ? timelineSelection!.ids : [focus.id]
      return { ...keptNodeSelection(state, current), selectedRegionId: null, selectedStructureId: null, selectedCharacterId: null, timelineSelection: { kind, ids } }
    }
  }
  const exists = (id: string | null | undefined): id is string => !!id && state.nodes.some((n) => n.id === id)
  if (focus?.kind === 'node' && exists(focus.id) && focus.id !== current.selectedId) {
    return { ...none, selectedId: focus.id }
  }
  return { ...keptNodeSelection(state, current), timelineSelection }
}

function keptNodeSelection(state: AppState, current: Selection): Pick<Selection, 'selectedId' | 'selectedRegionId' | 'selectedStructureId' | 'selectedCharacterId'> {
  const selectedId = state.nodes.some((n) => n.id === current.selectedId) ? current.selectedId : (state.project?.rootId ?? null)
  const keepRegion = state.regions.some((r) => r.id === current.selectedRegionId && r.worldId === selectedId)
  const keepStructure = state.timeline.structures.some((x) => x.id === current.selectedStructureId && x.ownerId === selectedId)
  const keepCharacter = state.timeline.characters.some((x) => x.id === current.selectedCharacterId && x.ownerId === selectedId)
  return {
    selectedId,
    selectedRegionId: keepRegion ? current.selectedRegionId : null,
    selectedStructureId: keepStructure ? current.selectedStructureId : null,
    selectedCharacterId: keepCharacter ? current.selectedCharacterId : null
  }
}

/** The timeline selection minus records that no longer exist. */
function keptTimelineSelection(state: AppState, selection: TimelineSelection | null): TimelineSelection | null {
  if (!selection) return null
  const live = new Set(state.timeline[`${selection.kind}s`].map((r) => r.id))
  const ids = selection.ids.filter((id) => live.has(id))
  return ids.length ? { ...selection, ids } : null
}

export const selectNode = (s: UiState): SpatialNode | undefined => s.nodes.find((n) => n.id === s.selectedId)

/** The node whose timeline the timeline panel shows for the current selection. */
export const useTimelineOwner = () => {
  const nodes = useUi((s) => s.nodes)
  const selectedId = useUi((s) => s.selectedId)
  return useMemo(() => timelineOwner(nodes, selectedId), [nodes, selectedId])
}

/** A world's settings and its regions. */
export function useWorld(worldId: string) {
  const info = useUi((s) => s.worlds.find((w) => w.id === worldId))
  const allRegions = useUi((s) => s.regions)
  const regions = useMemo(() => allRegions.filter((r) => r.worldId === worldId), [allRegions, worldId])
  return { info, regions }
}

export const undo = () => applyReply(window.universe.undo())
export const redo = () => applyReply(window.universe.redo())

/** One command for several: the command itself when there's one, a batch (one undo step) when there are more, nothing when there are none. */
export function asCommand(commands: Command[]): Command | undefined {
  return commands.length > 1 ? { type: 'batch', payload: { commands } } : commands[0]
}

type KindOf<T, Verb extends string> = T extends `${infer K}.${Verb}` ? K : never
type UpdateCommand = Extract<Command, { payload: { id: string; patch: unknown } }>
type DeleteCommand = Extract<Command, { type: `${string}.delete`; payload: { id: string } }>
/** Kinds of record with an `<kind>.update` command taking an id and a patch. */
export type UpdateKind = KindOf<UpdateCommand['type'], 'update'>
export type PatchOf<K extends UpdateKind> = Extract<UpdateCommand, { type: `${K}.update` }>['payload']['patch']
/** Kinds of record with an `<kind>.delete` command taking an id. */
export type DeleteKind = KindOf<DeleteCommand['type'], 'delete'>

/** Saves patches to one record: `updater('event', id)({ title })`. */
export function updater<K extends UpdateKind>(kind: K, id: string): (patch: PatchOf<K>) => void {
  return (patch) => void useUi.getState().execute({ type: `${kind}.update`, payload: { id, patch } } as Command)
}

/** Deletes records of one kind in one undo step; undefined when there are none. */
export const deleteCommand = (kind: DeleteKind, ids: string[]): Command | undefined => asCommand(ids.map((id) => ({ type: `${kind}.delete`, payload: { id } }) as Command))

/** One owner's timeline records of a kind (`'events'`, `'lanes'`…): re-rendered and filtered again only when that kind changes. */
export function useOwnRecords<K extends keyof TimelineData>(key: K, ownerId: string): TimelineData[K] {
  const list = useUi((s) => s.timeline[key]) as { ownerId: string }[]
  return useMemo(() => list.filter((r) => r.ownerId === ownerId), [list, ownerId]) as TimelineData[K]
}

const indexes = new WeakMap<object, Map<string, unknown>>()

/** A list's records by id, built once per list (the store keeps a list while none of its records change). */
function byId<T extends { id: string }>(list: T[]): Map<string, T> {
  let index = indexes.get(list) as Map<string, T> | undefined
  if (!index) {
    index = new Map(list.map((r) => [r.id, r]))
    indexes.set(list, index)
  }
  return index
}

/** Every timeline event by id. */
export const useEventsById = (): Map<string, TimelineEvent> => byId(useUi((s) => s.timeline.events))
