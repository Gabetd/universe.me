import { ALLOWED_CHILDREN, WORLD_RANGES, type Command, type NodeKind } from '@universe/core'
import { clamp, subSeed, type Procedural } from '@universe/procgen'
import { orbitFields, type GeneratedPlanet } from './orbits'

/**
 * Claiming what the seeds generate (PLAN.md §5.2): one batch that stores a
 * generated thing as a node with its seed and place, so it stays what it
 * was, and lands on it.
 */
export interface Claim {
  /** The node made: where to go once it's run. */
  id: string
  command: Command & { type: 'batch' }
}

/** A cluster of a universe, a galaxy of a cluster or a star of a galaxy; a star keeps its mass (and so its colour). */
export function claimGenerated(parent: { id: string; kind: NodeKind }, thing: Procedural & { massSun?: number }, newId: () => string): Claim {
  const id = newId()
  const commands: Command[] = [
    { type: 'node.create', payload: { id, parentId: parent.id, kind: ALLOWED_CHILDREN[parent.kind][0]!, name: thing.name, seed: thing.seed, position: { x: thing.x, y: thing.y, z: 0 } } }
  ]
  if (thing.massSun !== undefined) commands.push({ type: 'star.set', payload: { systemId: id, star: { massSun: Number(thing.massSun.toFixed(3)), luminositySun: null } } })
  return { id, command: { type: 'batch', payload: { commands, focusId: id } } }
}

/** A planet of a star system, with its orbit, and a world surface its size if `withWorld`. */
export function claimPlanet(systemId: string, planet: GeneratedPlanet, withWorld: boolean, newId: () => string): Claim {
  const id = newId()
  const commands: Command[] = [
    { type: 'node.create', payload: { id, parentId: systemId, kind: 'body', name: planet.name, seed: planet.seed } },
    { type: 'orbit.set', payload: { bodyId: id, orbit: orbitFields(planet.orbit) } }
  ]
  if (withWorld) {
    const worldId = newId()
    const { min, max } = WORLD_RANGES.radiusKm
    commands.push(
      { type: 'node.create', payload: { id: worldId, parentId: id, kind: 'world', name: `${planet.name} Surface`, seed: subSeed(planet.seed, 1) } },
      { type: 'world.update', payload: { id: worldId, patch: { radiusKm: clamp(Math.round(planet.orbit.radiusKm), min, max) } } }
    )
  }
  return { id, command: { type: 'batch', payload: { commands, focusId: id } } }
}
