import { AU_KM, type SpatialNode } from '@universe/core'
import { claimPlanet, unclaimedPlanets, type GeneratedPlanet } from '@universe/sim'
import { useMemo, type ReactNode } from 'react'
import { useUi } from '../store'
import { useSystem } from '../world/useSky'
import { claimInto } from './zoom'

/**
 * Claiming what the seeds generate (PLAN.md §5.2): the card for something
 * on the map, and the planets of a star system, each kept with its seed and
 * orbit, a rocky one with a world surface its size unless asked not to.
 */

export const newId = () => crypto.randomUUID()

/** "Rocky planet · 0.62 Earth masses · 0.48 AU". */
export function describePlanet(planet: GeneratedPlanet): string {
  const { orbit } = planet
  return `${planet.giant ? 'Giant planet' : 'Rocky planet'} · ${orbit.massEarth.toFixed(planet.giant ? 0 : 2)} Earth masses · ${(orbit.semiMajorAxisKm / AU_KM).toFixed(2)} AU`
}

/** Claims `planet` into the system and goes there, zooming at `at` on `canvas` (the view's middle by default). */
export const claimPlanetInto = (systemId: string, planet: GeneratedPlanet, withWorld: boolean, canvas?: HTMLCanvasElement | null, at?: { x: number; y: number }) =>
  claimInto(claimPlanet(systemId, planet, withWorld, newId), canvas, at)

/** The planets nobody has claimed in a star system, from its seed. */
export function useUnclaimedPlanets(node: SpatialNode | undefined): GeneratedPlanet[] {
  const nodes = useUi((s) => s.nodes)
  const system = useSystem(node?.kind === 'star_system' ? node.id : undefined)
  return useMemo(() => (node && system ? unclaimedPlanets(system, node, nodes) : []), [node, system, nodes])
}

/** A card next to something on a map, (x, y) px from the view's corner: what it is, and a button to claim it if it's only generated. */
export function ClaimCard({ x, y, name, description, onClaim, children }: { x: number; y: number; name: string; description: string; onClaim?: () => void; children?: ReactNode }) {
  return (
    <div className="cosmos-card" style={{ left: x + 14, top: y + 10 }} role="dialog" aria-label={name}>
      <b>{name}</b>
      <span className="muted small">{description}</span>
      {children}
      {onClaim && (
        <button className="primary" onClick={onClaim}>
          Claim and go there
        </button>
      )}
    </div>
  )
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
            <button onClick={() => void claimPlanetInto(node.id, p, !p.giant)} title={p.giant ? 'Claim the planet' : 'Claim the planet, with a world surface'}>
              Claim {p.name}
            </button>
            <span className="muted small">{describePlanet(p)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
