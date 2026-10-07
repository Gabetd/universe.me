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
  execute(command: Command): Promise<void>
}

export const useUi = create<UiState>((set, get) => ({
  ready: false,
  project: null,
  nodes: [],
  canUndo: false,
  canRedo: false,
  selectedId: null,
  error: null,

  apply(state) {
    const { selectedId } = get()
    const exists = (id: string | null | undefined) => !!id && state.nodes.some((n) => n.id === id)
    const next = exists(state.focusId) ? state.focusId! : exists(selectedId) ? selectedId : (state.project?.rootId ?? null)
    set({ ...state, ready: true, selectedId: next })
  },

  select: (id) => set({ selectedId: id }),
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
  }
}))

export const selectNode = (s: UiState): SpatialNode | undefined => s.nodes.find((n) => n.id === s.selectedId)

export async function undo(): Promise<void> {
  const state = await useUi.getState().run(window.universe.undo())
  if (state) useUi.getState().apply(state)
}

export async function redo(): Promise<void> {
  const state = await useUi.getState().run(window.universe.redo())
  if (state) useUi.getState().apply(state)
}
