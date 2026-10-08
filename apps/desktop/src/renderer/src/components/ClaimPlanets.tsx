import { AU_KM, type Command, type SpatialNode } from '@universe/core'
import { subSeed } from '@universe/procgen'
import { orbitFields, unclaimedPlanets, type GeneratedPlanet } from '@universe/sim'
import { useMemo } from 'react'
import { useUi } from '../store'
import { useSystem } from '../world/useSky'
import { claimInto, viewCanvas } from './zoom'

/**
 * Claiming the planets a star system's seed generates (PLAN.md §5.2): the
 * planet keeps its seed and orbit, and a rocky one gets a world surface its
 * size unless asked not to.
 */

export const isGiant = (p: GeneratedPlanet) => p.orbit.massEarth > 10

/** "Rocky planet · 0.62 Earth masses · 0.48 AU". */
export function describePlanet(planet: GeneratedPlanet): string {
  const { orbit } = planet
  const kind = isGiant(planet) ? 'Giant planet' : 'Rocky planet'
  return `${kind} · ${orbit.massEarth.toFixed(orbit.massEarth < 10 ? 2 : 0)} Earth masses · ${(orbit.semiMajorAxisKm / AU_KM).toFixed(2)} AU`
}

/** Claims `planet` into the system and goes there, zooming from (x, y) on the view (its middle by default). */
export async function claimPlanet(systemId: string, planet: GeneratedPlanet, withWorld: boolean, at?: { x: number; y: number }) {
  const id = crypto.randomUUID()
  const commands: Command[] = [
    { type: 'node.create', payload: { id, parentId: systemId, kind: 'body', name: planet.name, seed: planet.seed } },
    { type: 'orbit.set', payload: { bodyId: id, orbit: orbitFields(planet.orbit) } }
  ]
  if (withWorld) {
    const worldId = crypto.randomUUID()
    commands.push(
      { type: 'node.create', payload: { id: worldId, parentId: id, kind: 'world', name: `${planet.name} Surface`, seed: subSeed(planet.seed, 1) } },
      { type: 'world.update', payload: { id: worldId, patch: { radiusKm: Math.min(200_000, Math.round(planet.orbit.radiusKm)) } } }
    )
  }
  const canvas = viewCanvas()
  await claimInto(canvas, commands, id, at?.x ?? (canvas?.clientWidth ?? 0) / 2, at?.y ?? (canvas?.clientHeight ?? 0) / 2)
}

/** The planets nobody has claimed in a star system, from its seed. */
export function useUnclaimedPlanets(node: SpatialNode | undefined): GeneratedPlanet[] {
  const nodes = useUi((s) => s.nodes)
  const system = useSystem(node?.kind === 'star_system' ? node.id : undefined)
  return useMemo(() => (node && system ? unclaimedPlanets(system, node, nodes) : []), [node, system, nodes])
}

/** In the inspector of a star system: its generated planets, each a click from being claimed. */
export function PlanetsToClaim({ node }: { node: SpatialNode }) {
  const planets = useUnclaimedPlanets(node)
  if (!planets.length) return null
  return (
    <div className="field">
      <span>Or claim a planet its seed made</span>
      <ul className="claim-list">
        {planets.map((p) => (
          <li key={p.seed}>
            <button onClick={() => void claimPlanet(node.id, p, !isGiant(p))} title={isGiant(p) ? 'Claim the planet' : 'Claim the planet, with a world surface'}>
              Claim {p.name}
            </button>
            <span className="muted small">{describePlanet(p)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
