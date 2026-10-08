import type { Command, LatLon, Region, TerrainParams, WorldInfo } from '@universe/core'
import type { PlacedStructure } from './useStructures'
import type { EventPin } from './useWorldAtTime'
import { TerrainModel, shapeKey, type Vec3 } from '@universe/procgen'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useUi } from '../store'
import { fetchLayers, generateBase } from './terrainSource'

/** Which cube faces changed since the last render: views refresh only those. */
export interface TerrainChange {
  faces: number[] | 'all'
  /** Set when the change is one brush dab, so views can refresh just around it. */
  dab?: { dir: Vec3; radius: number }
}

/** What the globe and the map views get from the world editor. */
export interface SurfaceViewProps {
  model: TerrainModel
  change: TerrainChange
  /** Regions as of the playhead. */
  regions: Region[]
  pins: EventPin[]
  /** Regions where the selected event happens. */
  highlightRegionIds: Set<string>
  /** Where the selected event happened; the views turn to it whenever `key` changes. */
  focus?: LatLon & { key: string }
  onPinClick(eventId: string): void
  /** Structures at the playhead (and selected or previewed ones that aren't standing). */
  structures: PlacedStructure[]
  onStructureClick(structureId: string): void
  onPointerDown(dir: Vec3): boolean
  onPointerMove(dir: Vec3): void
  onDoubleClick(): void
}

/**
 * Loads a world's terrain (generated base in a worker + edit layers from the
 * project, fetched in parallel) and keeps it in sync: regenerates when the seed
 * or terrain params change, reloads layers when an undo/redo changes them.
 */
export function useTerrain(worldId: string, seed: number, info: WorldInfo | undefined) {
  const [model, setModel] = useState<TerrainModel>()
  const [change, setChange] = useState<TerrainChange>({ faces: 'all' })
  const [error, setError] = useState<string>()
  /** Terrain revision the in-memory model matches. */
  const revision = useRef(-1)
  /** Strokes being saved; their revision bumps are ours, not changes to reload. */
  const saving = useRef(0)
  /** The model for effects and callbacks: it's mutated in place (settings, layers), which React state must not be. */
  const modelRef = useRef<TerrainModel>(undefined)
  const bump = useCallback((faces: TerrainChange['faces'], dab?: TerrainChange['dab']) => setChange({ faces, dab }), [])

  const settings = info?.settings
  const params = settings?.terrain
  // Only shape options regenerate; climate, colors, sea level and radius just recolor.
  const paramsKey = params && shapeKey(seed, params)

  useEffect(() => {
    if (!params) return
    let cancelled = false
    Promise.all([generateBase(seed, params), fetchLayers(worldId)])
      .then(([base, layers]) => {
        if (cancelled) return
        const m = new TerrainModel(useUi.getState().worlds.find((w) => w.id === worldId)!.settings, base, layers)
        revision.current = layers.revision
        modelRef.current = m
        setError(undefined)
        setModel(m)
        bump('all')
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `params` is captured via paramsKey
  }, [worldId, seed, paramsKey, bump])

  useEffect(() => {
    const m = modelRef.current
    if (!m || !settings || m.settings === settings) return
    m.settings = settings
    bump('all')
  }, [settings, bump])

  const reload = useCallback(async () => {
    const m = modelRef.current
    if (!m) return
    const layers = await fetchLayers(worldId)
    m.setLayers(layers)
    revision.current = layers.revision
    bump('all')
  }, [worldId, bump])

  const terrainRevision = info?.terrainRevision
  useEffect(() => {
    const m = modelRef.current
    if (!m || m.isStroking || saving.current > 0 || terrainRevision === undefined || terrainRevision === revision.current) return
    void reload()
  }, [terrainRevision, reload])

  /** Saves a finished brush stroke. The model already has it, so it only reloads if saving fails. */
  const commit = useCallback(
    async (command: Extract<Command, { type: 'terrain.patch' }>) => {
      saving.current++
      try {
        const state = await useUi.getState().execute(command)
        const saved = state?.worlds.find((w) => w.id === worldId)
        if (saved) revision.current = saved.terrainRevision
        else await reload()
      } finally {
        saving.current--
      }
    },
    [worldId, reload]
  )

  return { model, change, error, bump, commit }
}
