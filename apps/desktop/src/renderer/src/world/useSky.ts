import { DEFAULT_CALENDAR, type Calendar, type Orbit, type SpatialNode, type Star, type WorldInfo } from '@universe/core'
import { systemIdOf, systemModel, worldCalendar, worldClimateOf, type SystemModel, type WorldClimate } from '@universe/sim'
import { useMemo } from 'react'
import { useUi } from '../store'

/**
 * Star systems as the simulation sees them, built once per change of the
 * project's nodes, stars, orbits or world sizes and shared by every view and
 * panel (many timeline rows ask for their world's calendar at once).
 */
let cache: { nodes: SpatialNode[]; stars: Star[]; orbits: Orbit[]; worlds: WorldInfo[]; systems: Map<string, SystemModel> } | undefined

function systemFor(nodes: SpatialNode[], stars: Star[], orbits: Orbit[], worlds: WorldInfo[], systemId: string): SystemModel {
  if (!cache || cache.nodes !== nodes || cache.stars !== stars || cache.orbits !== orbits || cache.worlds !== worlds) cache = { nodes, stars, orbits, worlds, systems: new Map() }
  let system = cache.systems.get(systemId)
  if (!system) cache.systems.set(systemId, (system = systemModel(nodes, { stars, orbits }, systemId, new Map(worlds.map((w) => [w.id, w.settings.radiusKm])))))
  return system
}

/** Everything the system cache depends on, from the store. */
function useSkyInputs() {
  const nodes = useUi((s) => s.nodes)
  const stars = useUi((s) => s.timeline.stars)
  const orbits = useUi((s) => s.timeline.orbits)
  const worlds = useUi((s) => s.worlds)
  return { nodes, stars, orbits, worlds }
}

/** The star system a node is in (stored orbits, or defaults). */
export function useSystem(nodeId: string | undefined): SystemModel | undefined {
  const { nodes, stars, orbits, worlds } = useSkyInputs()
  return useMemo(() => {
    const systemId = nodeId && systemIdOf(nodes, nodeId)
    return systemId ? systemFor(nodes, stars, orbits, worlds, systemId) : undefined
  }, [nodes, stars, orbits, worlds, nodeId])
}

/**
 * The calendar dates on a timeline are written in: a world's own, from its
 * body's orbit once that's been set; the Earth calendar otherwise.
 */
export function useCalendar(ownerId: string | undefined): Calendar {
  const nodes = useUi((s) => s.nodes)
  const system = useSystem(ownerId)
  return useMemo(() => {
    const owner = nodes.find((n) => n.id === ownerId)
    return owner?.kind === 'world' ? worldCalendar(nodes, system, owner.id) : DEFAULT_CALENDAR
  }, [nodes, system, ownerId])
}

/** A world's climate from its star and orbit, once its body's orbit has been set (until then the world keeps its Earth-like climate). */
export function useWorldClimate(worldId: string): WorldClimate | undefined {
  const nodes = useUi((s) => s.nodes)
  const system = useSystem(worldId)
  return useMemo(() => worldClimateOf(nodes, system, worldId), [nodes, system, worldId])
}

/** Climates for several worlds at once, outside a world's own view (the orbit views' planet textures). */
export function useWorldClimates(worldIds: string[]): Map<string, WorldClimate | undefined> {
  const { nodes, stars, orbits, worlds } = useSkyInputs()
  const key = worldIds.join()
  return useMemo(
    () =>
      new Map(
        worldIds.map((id) => {
          const systemId = systemIdOf(nodes, id)
          return [id, systemId ? worldClimateOf(nodes, systemFor(nodes, stars, orbits, worlds, systemId), id) : undefined]
        })
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `worldIds`
    [nodes, stars, orbits, worlds, key]
  )
}
