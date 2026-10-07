import type { Command, SpatialNode } from '@universe/core'
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
  /** Runs a command; resolves false (and shows the error) if it was rejected. */
  execute(command: Command): Promise<boolean>
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
    const { selectedId, selectedRegionId } = get()
    const isNode = (id: string | null | undefined) => !!id && state.nodes.some((n) => n.id === id)
    const focusRegion = state.regions.find((r) => r.id === state.focusId)
    // A command that touched a region selects it on its world; otherwise keep the selection if it still exists.
    const nextNode = focusRegion ? focusRegion.worldId : isNode(state.focusId) ? state.focusId! : isNode(selectedId) ? selectedId : (state.project?.rootId ?? null)
    const keepRegion = selectedRegionId && state.regions.some((r) => r.id === selectedRegionId && r.worldId === nextNode)
    set({ ...state, ready: true, selectedId: nextNode, selectedRegionId: focusRegion ? focusRegion.id : keepRegion ? selectedRegionId : null })
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
    return state !== undefined
  }
}))

export const selectNode = (s: UiState): SpatialNode | undefined => s.nodes.find((n) => n.id === s.selectedId)

async function historyStep(call: Promise<Result<AppState>>): Promise<void> {
  const state = await useUi.getState().run(call)
  if (state) useUi.getState().apply(state)
}

export const undo = () => historyStep(window.universe.undo())
export const redo = () => historyStep(window.universe.redo())
