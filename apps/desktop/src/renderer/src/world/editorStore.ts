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
/** The canvas shows the world's events as cards and `species` its food web, rather than its surface; the ground is the surface up close. */
type EditorView = SurfaceView | 'canvas' | 'ground' | 'species'

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
  /** How far from the middle of the ground view its camera starts, in metres. */
  groundDistance: number
  /** Goes down to the ground at `at`, the camera `distance` metres away (a person needs it closer than a city). */
  enterGround(at: LatLon, distance?: number): void
  /** Back up to the globe or map, looking at where the ground view was. */
  leaveGround(at: LatLon): void
  /** Picks a tool from the inspector: shows the surface (from the canvas) and keeps the ground view if it's open. */
  startTool(patch: Partial<Omit<EditorState, 'set'>> & { tool: EditorTool }): void
  set(patch: Partial<Omit<EditorState, 'set'>>): void
}

const DEFAULT_GROUND_DISTANCE = 600

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
  groundDistance: DEFAULT_GROUND_DISTANCE,
  enterGround: (at, distance = DEFAULT_GROUND_DISTANCE) => set({ view: 'ground', ground: at, groundDistance: distance }),
  leaveGround: (at) => set((s) => ({ view: s.surfaceView, lookingAt: at, lookDistance: 1.25, ground: at })),
  startTool: (patch) => set((s) => ({ ...patch, view: s.view === 'canvas' || s.view === 'species' ? s.surfaceView : s.view })),
  set: (patch) => set(patch)
}))

export const isBrushTool = (tool: EditorTool): tool is BrushTool => !['navigate', 'region', 'locate', 'place', 'move', 'travel'].includes(tool)
