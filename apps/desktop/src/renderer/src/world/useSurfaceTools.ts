import type { Command } from '@universe/core'
import { angleBetween, dirToLatLon, type TerrainModel, type Vec3 } from '@universe/procgen'
import { useCallback, useEffect, useRef } from 'react'
import { isEditingText } from '../input'
import { useUi } from '../store'
import { isBrushTool, useEditor } from './editorStore'

type Commit = (command: Extract<Command, { type: 'terrain.patch' }>) => Promise<void>

/**
 * Pointer handling shared by the globe and the map: brush strokes and region
 * drawing. Views translate pointer positions to unit directions and call these.
 */
export function useSurfaceTools(worldId: string, model: TerrainModel | undefined, onEdited: (faces: number[], dab: { dir: Vec3; radius: number }) => void, commit: Commit) {
  const lastDab = useRef<Vec3 | undefined>(undefined)

  const finishStroke = useCallback(() => {
    lastDab.current = undefined
    const payload = model?.endStroke(worldId)
    if (payload) void commit({ type: 'terrain.patch', payload })
  }, [model, worldId, commit])

  // A stroke ends wherever the pointer is released, even off the planet.
  useEffect(() => {
    window.addEventListener('pointerup', finishStroke)
    return () => window.removeEventListener('pointerup', finishStroke)
  }, [finishStroke])

  const dab = useCallback(
    (dir: Vec3) => {
      if (!model) return
      lastDab.current = dir
      const faces = model.dab(dir)
      if (faces.length) onEdited(faces, { dir, radius: model.angularRadius(useEditor.getState().radiusKm) })
    },
    [model, onEdited]
  )

  /** Returns true if the press was used by a tool (so the view shouldn't rotate or pan). */
  const pointerDown = useCallback(
    (dir: Vec3): boolean => {
      const { tool, radiusKm, strength, biome, draft, locateEventId, set } = useEditor.getState()
      if (tool === 'region') {
        set({ draft: [...draft, roundLatLon(dir)] })
        return true
      }
      if (tool === 'locate') {
        set({ tool: 'navigate', locateEventId: null })
        const event = useUi.getState().timeline.events.find((e) => e.id === locateEventId)
        if (event) {
          const point = { kind: 'point' as const, ...roundLatLon(dir) }
          void useUi.getState().execute({ type: 'event.update', payload: { id: event.id, patch: { locations: [...event.locations, point] } } })
        }
        return true
      }
      if (!model || !isBrushTool(tool)) return false
      model.beginStroke({ tool, radiusKm, strength, biome }, dir)
      dab(dir)
      return true
    },
    [model, dab]
  )

  const pointerMove = useCallback(
    (dir: Vec3) => {
      if (!model?.isStroking || !lastDab.current) return
      // Space dabs a quarter of the brush radius apart, so strokes are even at any pointer speed.
      const spacing = model.angularRadius(useEditor.getState().radiusKm) * 0.25
      if (angleBetween(dir, lastDab.current) >= spacing) dab(dir)
    },
    [model, dab]
  )

  const finishRegion = useCallback(async () => {
    const { draft, set } = useEditor.getState()
    if (draft.length < 3) return
    set({ draft: [] })
    await useUi.getState().execute({ type: 'region.create', payload: { worldId, points: draft } })
  }, [worldId])

  // Region drawing keys: Enter saves, Backspace removes the last point, Escape cancels.
  // Capture phase plus preventDefault, so the workspace's own Backspace/Escape shortcuts skip these presses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { tool, draft, set } = useEditor.getState()
      if (tool === 'locate' && e.key === 'Escape') {
        set({ tool: 'navigate', locateEventId: null })
        e.preventDefault()
        return
      }
      if (tool !== 'region' || isEditingText() || draft.length === 0) return
      if (e.key === 'Enter') void finishRegion()
      else if (e.key === 'Backspace') set({ draft: draft.slice(0, -1) })
      else if (e.key === 'Escape') set({ draft: [] })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [finishRegion])

  return { pointerDown, pointerMove, finishRegion }
}

/** Region points are stored to ~100 m precision; more is noise in the project file. */
function roundLatLon(dir: Vec3) {
  const { lat, lon } = dirToLatLon(...dir)
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 }
}
