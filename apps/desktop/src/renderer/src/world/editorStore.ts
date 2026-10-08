import type { LatLon } from '@universe/core'
import { BIOME, type BrushTool } from '@universe/procgen'
import { create } from 'zustand'

/**
 * `locate` picks a point for an event's location (`locateEventId`), `place`
 * puts down a structure (`placeBlueprintId`), `move` picks a new spot for one
 * (`moveStructureId`), `travel` sends a character there (`travelCharacterId`).
 */
export type EditorTool = 'navigate' | BrushTool | 'region' | 'locate' | 'place' | 'move' | 'travel'
export type SurfaceView = 'globe' | 'map'
/** The canvas shows the world's events as cards rather than its surface; the ground is the surface up close. */
type EditorView = SurfaceView | 'canvas' | 'ground'

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
  placeBlueprintId: string
  moveStructureId: string | null
  /** The character the `travel` tool sends somewhere. */
  travelCharacterId: string | null
  /** Where the ground view is (its middle), once opened. */
  ground: LatLon | null
  /** Where the globe last looked, and from how far (planet radii from the centre). */
  lookingAt: LatLon | null
  lookDistance: number
  /** Goes down to the ground at `at`. */
  enterGround(at: LatLon): void
  /** Back up to the globe or map, looking at where the ground view was. */
  leaveGround(at: LatLon): void
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
  placeBlueprintId: 'builtin:castle',
  moveStructureId: null,
  travelCharacterId: null,
  ground: null,
  lookingAt: null,
  lookDistance: 2.4,
  enterGround: (at) => set({ view: 'ground', ground: at }),
  leaveGround: (at) => set((s) => ({ view: s.surfaceView, lookingAt: at, lookDistance: 1.25, ground: at })),
  set: (patch) => set(patch)
}))

export const isBrushTool = (tool: EditorTool): tool is BrushTool => !['navigate', 'region', 'locate', 'place', 'move', 'travel'].includes(tool)
