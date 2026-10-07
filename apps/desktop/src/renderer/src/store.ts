import type { Command, SpatialNode } from '@universe/core'
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
}

export const useUi = create<UiState>((set, get) => ({
  ready: false,
  project: null,
  nodes: [],
  canUndo: false,
  canRedo: false,
  worlds: [],
  regions: [],
  selectedId: null,
  selectedRegionId: null,
  error: null,

  apply(state) {
    set({ ...state, ready: true, ...nextSelection(state, get()) })
  },

  select: (id) => set({ selectedId: id, selectedRegionId: null }),
  selectRegion: (id) => set({ selectedRegionId: id }),
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

type Selection = Pick<UiState, 'selectedId' | 'selectedRegionId'>

/** Selects what the last command targeted (a region selects its world too); otherwise keeps the selection while it exists. */
function nextSelection(state: AppState, current: Selection): Selection {
  const { focus } = state
  if (focus?.kind === 'region') {
    const region = state.regions.find((r) => r.id === focus.id)
    if (region) return { selectedId: region.worldId, selectedRegionId: region.id }
  }
  const exists = (id: string | null | undefined): id is string => !!id && state.nodes.some((n) => n.id === id)
  let selectedId = state.project?.rootId ?? null
  if (focus?.kind === 'node' && exists(focus.id)) selectedId = focus.id
  else if (exists(current.selectedId)) selectedId = current.selectedId
  const keepRegion = state.regions.some((r) => r.id === current.selectedRegionId && r.worldId === selectedId)
  return { selectedId, selectedRegionId: keepRegion ? current.selectedRegionId : null }
}

export const selectNode = (s: UiState): SpatialNode | undefined => s.nodes.find((n) => n.id === s.selectedId)

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
