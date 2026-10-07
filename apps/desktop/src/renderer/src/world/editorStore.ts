import type { LatLon } from '@universe/core'
import { BIOME, type BrushTool } from '@universe/procgen'
import { create } from 'zustand'

export type EditorTool = 'navigate' | BrushTool | 'region'
type EditorView = 'globe' | 'map'

interface EditorState {
  view: EditorView
  tool: EditorTool
  radiusKm: number
  strength: number
  biome: number
  /** Visual height multiplier for the globe; doesn't change the data. */
  exaggeration: number
  /** Points of the region being drawn, before it is saved. */
  draft: LatLon[]
  set(patch: Partial<Omit<EditorState, 'set'>>): void
}

export const useEditor = create<EditorState>((set) => ({
  view: 'globe',
  tool: 'navigate',
  radiusKm: 350,
  strength: 0.5,
  biome: BIOME.temperateForest,
  exaggeration: 25,
  draft: [],
  set: (patch) => set(patch)
}))

export const isBrushTool = (tool: EditorTool): tool is BrushTool => tool !== 'navigate' && tool !== 'region'
