import { DEFAULT_CALENDAR, type Calendar, type SpatialNode } from '@universe/core'
import { systemIdOf, systemModel, worldCalendar, worldClimate, type SystemModel, type WorldClimate } from '@universe/sim'
import { useMemo } from 'react'
import { useUi } from '../store'

/** The star system a node is in, as the simulation sees it (stored orbits, or defaults). */
export function useSystem(nodeId: string | undefined): SystemModel | undefined {
  const nodes = useUi((s) => s.nodes)
  const stars = useUi((s) => s.timeline.stars)
  const orbits = useUi((s) => s.timeline.orbits)
  return useMemo(() => {
    const systemId = nodeId && systemIdOf(nodes, nodeId)
    return systemId ? systemModel(nodes, { stars, orbits }, systemId) : undefined
  }, [nodes, stars, orbits, nodeId])
}

/** The body a world is on. */
export const bodyOfWorld = (nodes: SpatialNode[], worldId: string) => nodes.find((n) => n.id === worldId)?.parentId ?? undefined

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
  return useMemo(() => climateOfWorld(nodes, system, worldId), [nodes, system, worldId])
}

/** A world's climate in its system, once its body's orbit has been set. */
export function climateOfWorld(nodes: SpatialNode[], system: SystemModel | undefined, worldId: string): WorldClimate | undefined {
  const bodyId = bodyOfWorld(nodes, worldId)
  const body = bodyId ? system?.bodies.get(bodyId) : undefined
  return body && !body.isDefault ? worldClimate(system!, body.bodyId) : undefined
}

/** Climates for several worlds at once, outside a world's own view (the orbit views' planet textures). */
export function useWorldClimates(worldIds: string[]): Map<string, WorldClimate | undefined> {
  const nodes = useUi((s) => s.nodes)
  const stars = useUi((s) => s.timeline.stars)
  const orbits = useUi((s) => s.timeline.orbits)
  const key = worldIds.join()
  return useMemo(
    () =>
      new Map(
        worldIds.map((id) => {
          const systemId = systemIdOf(nodes, id)
          return [id, systemId ? climateOfWorld(nodes, systemModel(nodes, { stars, orbits }, systemId), id) : undefined]
        })
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `worldIds`
    [nodes, stars, orbits, key]
  )
}
