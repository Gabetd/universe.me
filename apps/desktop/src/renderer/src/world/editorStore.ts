import type { LatLon } from '@universe/core'
import { BIOME, type BrushTool } from '@universe/procgen'
import { create } from 'zustand'

/** `locate` picks a point for an event's location (`locateEventId`). */
export type EditorTool = 'navigate' | BrushTool | 'region' | 'locate'
export type SurfaceView = 'globe' | 'map'
/** The canvas shows the world's events as cards rather than its surface. */
type EditorView = SurfaceView | 'canvas'

interface EditorState {
  view: EditorView
  /** The surface view to return to from the canvas. */
  surfaceView: SurfaceView
  /** Bumped to fly the views to the selected event's place again, even if it was already selected. */
  focusSeq: number
  tool: EditorTool
  radiusKm: number
  strength: number
  biome: number
  /** Visual height multiplier for the globe; doesn't change the data. */
  exaggeration: number
  /** Points of the region being drawn, before it is saved. */
  draft: LatLon[]
  /** The event the `locate` tool adds a location to. */
  locateEventId: string | null
  set(patch: Partial<Omit<EditorState, 'set'>>): void
}

export const useEditor = create<EditorState>((set) => ({
  view: 'globe',
  surfaceView: 'globe',
  focusSeq: 0,
  tool: 'navigate',
  radiusKm: 350,
  strength: 0.5,
  biome: BIOME.temperateForest,
  exaggeration: 25,
  draft: [],
  locateEventId: null,
  set: (patch) => set(patch)
}))

export const isBrushTool = (tool: EditorTool): tool is BrushTool => tool !== 'navigate' && tool !== 'region' && tool !== 'locate'
