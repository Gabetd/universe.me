import { conditionCurves, effectHits, findBlueprint, stateAt, timelineOf, type Blueprint, type ConditionCurve, type Exposure, type Region, type Structure, type StructureState, type StructureWorld, type TimelineData, type WorldInfo } from '@universe/core'
import { skyKey, type TerrainModel } from '@universe/procgen'
import { exposureAt, type WorldClimate } from '@universe/sim'
import { useLoadedTerrain } from './loadedTerrain'
import { useWorldClimate } from './useSky'
import { useMemo } from 'react'
import { useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'

/** A structure as drawn at the playhead. */
export interface PlacedStructure {
  structure: Structure
  state: StructureState
  /** Its blueprint as of the playhead (a `modify` effect can swap it). */
  blueprint: Blueprint
  selected: boolean
  /** How hard the selected event's effects hit it (0–1), if they do: drawn as a preview ring. */
  hit?: number
}

interface Inputs {
  timeline: TimelineData
  regions: Region[]
  info: WorldInfo | undefined
  model: TerrainModel | undefined
  terrainVersion: number | undefined
  climateKey: string
}

/**
 * One condition engine per world, shared by every view and panel that asks
 * (the editor, the structure list and inspector, the timeline's weathering
 * track, effect previews): rebuilt only when its inputs change.
 */
const engines = new Map<string, { inputs: Inputs; world: StructureWorld; curves: Map<string, ConditionCurve> }>()

function engineFor(worldId: string, inputs: Inputs, climate: WorldClimate | undefined) {
  const cached = engines.get(worldId)
  if (cached && (Object.keys(inputs) as (keyof Inputs)[]).every((k) => cached.inputs[k] === inputs[k])) return cached
  const { timeline, info, model } = inputs
  // The blueprint library belongs to the project, not the world.
  const data = { ...timelineOf(timeline, worldId), blueprints: timeline.blueprints }
  // The weather where each structure stands, once the world's terrain is loaded; temperate until then.
  const exposures = new Map<string, Exposure>()
  const exposure = model
    ? (s: Structure) => {
        const key = `${s.lat}:${s.lon}`
        let e = exposures.get(key)
        if (!e) exposures.set(key, (e = exposureAt(model, climate, s.lat, s.lon)))
        return e
      }
    : undefined
  const world: StructureWorld = {
    data,
    regions: inputs.regions.filter((r) => r.worldId === worldId),
    radiusKm: info?.settings.radiusKm ?? 6371,
    erosionSpeed: info?.settings.erosionSpeed ?? 1,
    blueprint: (id: string) => findBlueprint(timeline.blueprints, id),
    exposure
  }
  const engine = { inputs, world, curves: conditionCurves(world) }
  engines.set(worldId, engine)
  return engine
}

/** Condition curves for every structure on a world, and what they were worked out from. */
export function useConditionCurves(worldId: string): { world: StructureWorld; curves: Map<string, ConditionCurve> } {
  const timeline = useUi((s) => s.timeline)
  const regions = useUi((s) => s.regions)
  const info = useUi((s) => s.worlds.find((w) => w.id === worldId))
  const terrain = useLoadedTerrain((s) => s.models[worldId])
  const climate = useWorldClimate(worldId)
  // The climate's numbers, not its identity: renaming a node rebuilds the system but changes no weather.
  const climateKey = skyKey(climate) + (climate ? `:${climate.seasonalSwingC}` : '')
  const { world, curves } = engineFor(worldId, { timeline, regions, info, model: terrain?.model, terrainVersion: terrain?.version, climateKey }, climate)
  return { world, curves }
}

/** Everything the condition engine needs about one world. */
export const useStructureWorld = (worldId: string): StructureWorld => useConditionCurves(worldId).world

/** Structures standing at the playhead, with what the selected event would do to them. */
export function useStructuresAt(worldId: string): PlacedStructure[] {
  const { world, curves } = useConditionCurves(worldId)
  const playhead = usePlayhead(worldId)
  const selectedId = useUi((s) => s.selectedStructureId)
  const selection = useUi((s) => s.timelineSelection)
  // What the selected event would do doesn't change with the playhead, so it isn't redone as it plays.
  const hits = useMemo(() => {
    const out = new Map<string, number>()
    if (selection?.kind !== 'event') return out
    for (const effect of world.data.effects.filter((e) => selection.ids.includes(e.eventId))) {
      for (const h of effectHits(effect, world)) out.set(h.structureId, Math.max(out.get(h.structureId) ?? 0, h.strength))
    }
    return out
  }, [world, selection])
  return useMemo(() => {
    return world.data.structures.flatMap((structure) => {
      const state = stateAt(curves.get(structure.id)!, playhead)
      const selected = structure.id === selectedId
      // Gone structures are still drawn (as a ghost) when selected, so they can be found and edited.
      if (!state.exists && !selected && !hits.has(structure.id)) return []
      const blueprint = world.blueprint(state.blueprintId) ?? world.blueprint(structure.blueprintId)
      return blueprint ? [{ structure, state, blueprint, selected, hit: hits.get(structure.id) }] : []
    })
  }, [world, curves, playhead, selectedId, hits])
}
