import { EMPTY_TIMELINE, timelineOwner, type Command, type SpatialNode } from '@universe/core'
import { useMemo } from 'react'
import { create } from 'zustand'
import type { AppState, Result } from '../../shared/api'

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
  /** Selected timeline records: several events (for grouping), or one era, group, link… */
  timelineSelection: TimelineSelection | null
  selectTimeline(selection: TimelineSelection | null): void
}

export interface TimelineSelection {
  kind: 'event' | 'era' | 'group' | 'link'
  ids: string[]
}

export const useUi = create<UiState>((set, get) => ({
  ready: false,
  project: null,
  nodes: [],
  canUndo: false,
  canRedo: false,
  worlds: [],
  regions: [],
  timeline: EMPTY_TIMELINE,
  selectedId: null,
  timelineSelection: null,
  selectedRegionId: null,
  selectedStructureId: null,
  error: null,

  apply(state) {
    set({ ...state, ready: true, ...nextSelection(state, get()) })
  },

  select: (id) => set({ selectedId: id, selectedRegionId: null, selectedStructureId: null, timelineSelection: null }),
  selectTimeline: (timelineSelection) => set(timelineSelection ? { timelineSelection, selectedRegionId: null, selectedStructureId: null } : { timelineSelection }),
  // A region, a structure and timeline records are never selected together: whichever was picked last is what the inspector shows.
  selectRegion: (id) => set(id ? { selectedRegionId: id, selectedStructureId: null, timelineSelection: null } : { selectedRegionId: null }),
  selectStructure: (id) => set(id ? { selectedStructureId: id, selectedRegionId: null, timelineSelection: null } : { selectedStructureId: null }),
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

  async execute(command) {
    const state = await get().run(window.universe.execute(command))
    if (state) get().apply(state)
    return state
  }
}))

type Selection = Pick<UiState, 'selectedId' | 'selectedRegionId' | 'selectedStructureId' | 'timelineSelection'>

/**
 * Selects what the last command targeted (a region or structure selects its
 * world too, a timeline record selects itself); otherwise keeps the selection
 * while it exists.
 */
function nextSelection(state: AppState, current: Selection): Selection {
  const { focus } = state
  const timelineSelection = keptTimelineSelection(state, current.timelineSelection)
  const none = { selectedRegionId: null, selectedStructureId: null, timelineSelection: null }
  if (focus?.kind === 'region') {
    const region = state.regions.find((r) => r.id === focus.id)
    if (region) return { ...none, selectedId: region.worldId, selectedRegionId: region.id }
  }
  if (focus?.kind === 'structure' && current.selectedStructureId !== focus.id) {
    const structure = state.timeline.structures.find((s) => s.id === focus.id)
    if (structure) return { ...none, selectedId: structure.ownerId, selectedStructureId: structure.id }
  }
  // Lanes and changes are edited in place, so only records with an inspector panel get selected.
  if (focus && (focus.kind === 'event' || focus.kind === 'era' || focus.kind === 'group' || focus.kind === 'link')) {
    const kind = focus.kind
    if (state.timeline[`${kind}s`].some((r) => r.id === focus.id)) {
      const ids = current.timelineSelection?.kind === kind && current.timelineSelection.ids.includes(focus.id) ? timelineSelection!.ids : [focus.id]
      return { ...keptNodeSelection(state, current), selectedRegionId: null, selectedStructureId: null, timelineSelection: { kind, ids } }
    }
  }
  const exists = (id: string | null | undefined): id is string => !!id && state.nodes.some((n) => n.id === id)
  if (focus?.kind === 'node' && exists(focus.id) && focus.id !== current.selectedId) {
    return { ...none, selectedId: focus.id }
  }
  return { ...keptNodeSelection(state, current), timelineSelection }
}

function keptNodeSelection(state: AppState, current: Selection): Pick<Selection, 'selectedId' | 'selectedRegionId' | 'selectedStructureId'> {
  const selectedId = state.nodes.some((n) => n.id === current.selectedId) ? current.selectedId : (state.project?.rootId ?? null)
  const keepRegion = state.regions.some((r) => r.id === current.selectedRegionId && r.worldId === selectedId)
  const keepStructure = state.timeline.structures.some((x) => x.id === current.selectedStructureId && x.ownerId === selectedId)
  return { selectedId, selectedRegionId: keepRegion ? current.selectedRegionId : null, selectedStructureId: keepStructure ? current.selectedStructureId : null }
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

async function historyStep(call: Promise<Result<AppState>>): Promise<void> {
  const state = await useUi.getState().run(call)
  if (state) useUi.getState().apply(state)
}

export const undo = () => historyStep(window.universe.undo())
export const redo = () => historyStep(window.universe.redo())
