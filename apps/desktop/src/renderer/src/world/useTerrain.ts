import type { Command, TerrainParams, WorldInfo } from '@universe/core'
import { TerrainModel, type BaseTerrain, type Vec3 } from '@universe/procgen'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useUi } from '../store'
import type { GenerateRequest } from './terrain.worker'
import TerrainWorker from './terrain.worker?worker'

/** Which cube faces changed since the last render: views refresh only those. */
export interface TerrainChange {
  version: number
  faces: number[] | 'all'
  /** Set when the change is one brush dab, so views can refresh just around it. */
  dab?: { dir: Vec3; radius: number }
}

let worker: Worker | undefined
let nextRequest = 0
const pending = new Map<number, (base: BaseTerrain) => void>()
/** Recently generated terrains, so switching between worlds doesn't regenerate. */
const baseCache = new Map<string, Promise<BaseTerrain>>()
const CACHE_SIZE = 4

function generateBase(seed: number, params: TerrainParams): Promise<BaseTerrain> {
  const key = `${seed}:${params.continentScale}:${params.roughness}:${params.mountainHeight}`
  const cached = baseCache.get(key)
  if (cached) return cached
  if (!worker) {
    worker = new TerrainWorker()
    worker.onmessage = (e: MessageEvent<{ id: number; base: BaseTerrain }>) => {
      pending.get(e.data.id)?.(e.data.base)
      pending.delete(e.data.id)
    }
  }
  const id = ++nextRequest
  const promise = new Promise<BaseTerrain>((resolve) => pending.set(id, resolve))
  worker.postMessage({ id, seed, params } satisfies GenerateRequest)
  baseCache.set(key, promise)
  if (baseCache.size > CACHE_SIZE) baseCache.delete(baseCache.keys().next().value!)
  return promise
}

async function fetchLayers(worldId: string) {
  const result = await window.universe.getTerrain(worldId)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/**
 * Loads a world's terrain (generated base in a worker + edit layers from the
 * project, fetched in parallel) and keeps it in sync: regenerates when the seed
 * or terrain params change, reloads layers when an undo/redo changes them.
 */
export function useTerrain(worldId: string, seed: number, info: WorldInfo | undefined) {
  const [model, setModel] = useState<TerrainModel>()
  const [change, setChange] = useState<TerrainChange>({ version: 0, faces: 'all' })
  const [error, setError] = useState<string>()
  /** Terrain revision the in-memory model matches. */
  const revision = useRef(-1)
  const modelRef = useRef<TerrainModel>(undefined)
  const bump = useCallback(
    (faces: TerrainChange['faces'], dab?: TerrainChange['dab']) => setChange((c) => ({ version: c.version + 1, faces, dab })),
    []
  )

  const settings = info?.settings
  const params = settings?.terrain
  // Only the terrain params trigger regeneration; sea level and radius just recolor.
  const paramsKey = params && `${params.continentScale}:${params.roughness}:${params.mountainHeight}`

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
    if (!m || m.isStroking || terrainRevision === undefined || terrainRevision === revision.current) return
    void reload()
  }, [terrainRevision, reload])

  /** Saves a finished brush stroke. The model already has it, so no reload unless saving fails. */
  const commit = useCallback(
    async (command: Extract<Command, { type: 'terrain.patch' }>) => {
      revision.current = (terrainRevision ?? 0) + 1
      if (!(await useUi.getState().execute(command))) await reload()
    },
    [terrainRevision, reload]
  )

  return { model, change, error, bump, commit }
}
