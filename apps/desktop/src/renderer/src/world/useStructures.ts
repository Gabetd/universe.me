import { conditionCurves, effectHits, findBlueprint, stateAt, timelineOf, type Blueprint, type ConditionCurve, type Structure, type StructureState, type StructureWorld } from '@universe/core'
import { useMemo } from 'react'
import { useUi, useWorld } from '../store'
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

/** Everything the condition engine needs about one world, rebuilt only when its data changes. */
export function useStructureWorld(worldId: string): StructureWorld {
  const timeline = useUi((s) => s.timeline)
  const { info, regions } = useWorld(worldId)
  const radiusKm = info?.settings.radiusKm ?? 6371
  const erosionSpeed = info?.settings.erosionSpeed ?? 1
  return useMemo(() => {
    const own = timelineOf(timeline, worldId)
    // The blueprint library belongs to the project, not the world.
    const data = { ...own, blueprints: timeline.blueprints }
    return { data, regions, radiusKm, erosionSpeed, blueprint: (id: string) => findBlueprint(timeline.blueprints, id) }
  }, [timeline, worldId, regions, radiusKm, erosionSpeed])
}

/** Condition curves for every structure on a world. */
export function useConditionCurves(worldId: string): { world: StructureWorld; curves: Map<string, ConditionCurve> } {
  const world = useStructureWorld(worldId)
  const curves = useMemo(() => conditionCurves(world), [world])
  return { world, curves }
}

/** Structures standing at the playhead, with what the selected event would do to them. */
export function useStructuresAt(worldId: string): PlacedStructure[] {
  const { world, curves } = useConditionCurves(worldId)
  const playhead = usePlayhead(worldId)
  const selectedId = useUi((s) => s.selectedStructureId)
  const selection = useUi((s) => s.timelineSelection)
  return useMemo(() => {
    const hits = new Map<string, number>()
    if (selection?.kind === 'event') {
      for (const effect of world.data.effects.filter((e) => selection.ids.includes(e.eventId))) {
        for (const h of effectHits(effect, world)) hits.set(h.structureId, Math.max(hits.get(h.structureId) ?? 0, h.strength))
      }
    }
    return world.data.structures.flatMap((structure) => {
      const state = stateAt(curves.get(structure.id)!, playhead)
      const selected = structure.id === selectedId
      // Gone structures are still drawn (as a ghost) when selected, so they can be found and edited.
      if (!state.exists && !selected && !hits.has(structure.id)) return []
      const blueprint = world.blueprint(state.blueprintId) ?? world.blueprint(structure.blueprintId)
      return blueprint ? [{ structure, state, blueprint, selected, hit: hits.get(structure.id) }] : []
    })
  }, [world, curves, playhead, selectedId, selection])
}
