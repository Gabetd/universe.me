import type { SpatialNode } from '@universe/core'
import { useMemo, useRef, useState } from 'react'
import { hueOf } from '@universe/procgen'
import { kindLabel } from '../kinds'
import { selectNode, useTimelineOwner, useUi } from '../store'
import { playheadOf } from '../timeline/timelineStore'
import { useSystem } from '../world/useSky'
import type { GeneratedPlanet } from '@universe/sim'
import { drawOrbits } from './orbitView'
import { label, starfield, targetAt, useCanvasLoop, type CanvasTarget } from './canvasDraw'
import { CosmosView, isCosmos } from './CosmosView'
import { EdgePush, zoomOut, zoomTo } from './zoom'
import { ClaimCard, claimPlanetInto, describePlanet, useUnclaimedPlanets } from './ClaimPlanets'
import { SkyControls } from './SkyControls'
import { SPACE_BG } from '../theme'
import { usePlanetTextures } from './planetSprite'

/**
 * The viewport for every level above a world surface (PLAN.md §5.2): the
 * universe, clusters and galaxies as maps to pan and zoom (CosmosView), and
 * star systems and planets simulated, their bodies where their orbits put
 * them at the timeline's playhead. Zooming in and out moves between levels;
 * world surfaces open the WorldEditor instead.
 */
export function Viewport() {
  const node = useUi(selectNode)
  if (!node) return null
  // A new view per node, so each level starts from its own camera.
  return isCosmos(node) ? <CosmosView key={node.id} node={node} /> : <OrbitViewport key={node.id} node={node} />
}

/** A star system or a planet with its moons: bodies where their orbits put them. */
function OrbitViewport({ node }: { node: SpatialNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodes = useUi((s) => s.nodes)
  const isSystem = node.kind === 'star_system'

  // The world on each body in view (the body itself and what orbits it), drawn with its real surface.
  const { children, worlds } = useMemo(() => {
    const children = nodes.filter((n) => n.parentId === node.id)
    const worlds = new Map<string, SpatialNode>()
    for (const body of [node, ...children]) {
      const world = nodes.find((n) => n.parentId === body.id && n.kind === 'world')
      if (world) worlds.set(body.id, world)
    }
    return { children, worlds }
  }, [node, nodes])
  const world = worlds.get(node.id)
  const textures = usePlanetTextures(useMemo(() => [...worlds.values()], [worlds]))

  const system = useSystem(node.kind === 'star_system' || node.kind === 'body' ? node.id : undefined)
  const owner = useTimelineOwner()
  // Names and colours of the bodies, worked out once rather than every frame.
  const bodies = useMemo(() => new Map(nodes.filter((n) => n.kind === 'body').map((n) => [n.id, { name: n.name, hue: hueOf(n.seed) }])), [nodes])
  // In a star system, the planets its seed generates that nobody has claimed yet.
  const unclaimed = useUnclaimedPlanets(node)
  const [picked, setPicked] = useState<{ planet: GeneratedPlanet; x: number; y: number; withWorld: boolean } | null>(null)

  const hover = useRef<string | null>(null)
  const targets = useRef<CanvasTarget[]>([])

  useCanvasLoop(canvasRef, (ctx, w, h) => {
    ctx.fillStyle = SPACE_BG
    ctx.fillRect(0, 0, w, h)
    starfield(ctx, w, h, node.seed, 380)
    targets.current = system
      ? drawOrbits(ctx, w, h, {
          system,
          centerId: isSystem ? null : node.id,
          t: owner ? playheadOf(owner.id) : 0,
          spin: performance.now() / 1000,
          bodies,
          worlds,
          textures,
          // The planet in the middle opens its world.
          centerTargetId: world?.id,
          unclaimed,
          hoverId: hover.current
        })
      : []
    const middle = !isSystem && world && targets.current.find((x) => x.id === world.id)
    if (middle) label(ctx, `World: ${world.name}`, middle.x, middle.y + middle.r + 14, middle.id === hover.current)
    if (children.length === 0 && !unclaimed.length) {
      ctx.fillStyle = 'rgba(200,210,240,0.55)'
      ctx.font = '14px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`Nothing here yet. Use “Add inside” in the inspector to create a ${isSystem ? 'planet' : 'moon or world'}.`, w / 2, h - 70)
    }
  })

  const hitTest = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return targetAt(targets.current, e.clientX - rect.left, e.clientY - rect.top)
  }
  const generated = (id: string) => unclaimed.find((g) => g.orbit.bodyId === id)

  // A few pushes of the wheel change level: out to the parent, or in to what's under the cursor.
  const edge = useRef(new EdgePush())
  const onWheel = (e: React.WheelEvent) => {
    // About one push a notch, so a trackpad's many small scrolls take as long as a wheel's few.
    if (!edge.current.push(Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100))) return
    if (e.deltaY > 0) return zoomOut(canvasRef.current)
    const t = hitTest(e)
    if (t && !generated(t.id)) zoomTo(t.id, canvasRef.current, t)
  }

  return (
    <div className="viewport">
      <canvas
        ref={canvasRef}
        className="viewport-canvas"
        data-testid="viewport"
        onMouseMove={(e) => {
          hover.current = hitTest(e)?.id ?? null
          canvasRef.current!.style.cursor = hover.current ? 'pointer' : 'default'
        }}
        onMouseLeave={() => (hover.current = null)}
        onClick={(e) => {
          const t = hitTest(e)
          const planet = t && generated(t.id)
          setPicked(planet ? { planet, x: t.x, y: t.y, withWorld: !planet.giant } : null)
          if (t && !planet) zoomTo(t.id, canvasRef.current, t)
        }}
        onWheel={onWheel}
      />
      <div className="viewport-overlay top">
        <div className="viewport-title">{node.name}</div>
        <div className="muted small">{kindLabel(node, nodes)} view</div>
      </div>
      {picked && (
        <ClaimCard
          x={picked.x}
          y={picked.y}
          name={picked.planet.name}
          description={`${describePlanet(picked.planet)} · not claimed yet`}
          onClaim={() => (setPicked(null), void claimPlanetInto(node.id, picked.planet, picked.withWorld, canvasRef.current, picked))}
        >
          <label className="checkbox">
            <input type="checkbox" checked={picked.withWorld} onChange={(e) => setPicked({ ...picked, withWorld: e.target.checked })} />
            With a world surface
          </label>
        </ClaimCard>
      )}
      {system && owner && <SkyControls ownerId={owner.id} system={system} centerId={isSystem ? null : node.id} />}
      <div className="viewport-overlay bottom muted small">
        Click to zoom in{unclaimed.length ? ' or claim a faint planet' : ''} · Scroll down or Esc to zoom out
      </div>
    </div>
  )
}
