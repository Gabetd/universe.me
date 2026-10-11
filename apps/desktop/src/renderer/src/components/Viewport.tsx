import { bodyLabel, type SpatialNode } from '@universe/core'
import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { hueOf } from '@universe/procgen'
import { kindLabel } from '../kinds'
import { selectNode, useTimelineOwner, useUi } from '../store'
import { playheadOf } from '../timeline/timelineStore'
import { useSystem } from '../world/useSky'
import type { GeneratedPlanet } from '@universe/sim'
import { drawOrbits, orbitAt, targetSummary, type OrbitTarget } from './orbitView'
import { label, targetAt, useCanvasLoop } from './canvasDraw'
import { spaceBackdrop } from './spaceArt'
import { CosmosView, isCosmos } from './CosmosView'
import { EdgePush, zoomOut, zoomTo } from './zoom'
import { ClaimCard, claimPlanetInto, describePlanet, useUnclaimedPlanets } from './ClaimPlanets'
import { SkyControls } from './SkyControls'
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
  const worldIds = useMemo(() => new Set([...worlds.values()].map((w) => w.id)), [worlds])
  const textures = usePlanetTextures(useMemo(() => [...worlds.values()], [worlds]))

  const system = useSystem(node.kind === 'star_system' || node.kind === 'body' ? node.id : undefined)
  const owner = useTimelineOwner()
  // Names and colours of the bodies, worked out once rather than every frame.
  const bodies = useMemo(() => new Map(nodes.filter((n) => n.kind === 'body').map((n) => [n.id, { name: n.name, hue: hueOf(n.seed) }])), [nodes])
  // In a star system, the planets its seed generates that nobody has claimed yet.
  const unclaimed = useUnclaimedPlanets(node)
  const [picked, setPicked] = useState<{ planet: GeneratedPlanet; x: number; y: number; withWorld: boolean } | null>(null)

  // What's pointed at, and its card, which follows it round each frame.
  const hover = useRef<string | null>(null)
  const card = useRef<HoverCardHandle>(null)
  const targets = useRef<OrbitTarget[]>([])

  useCanvasLoop(canvasRef, (ctx, w, h) => {
    spaceBackdrop(ctx, w, h, node.seed, { stars: 380, nebula: isSystem ? 0.45 : 0.3 })
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
    const shown = hover.current && targets.current.find((x) => x.id === hover.current)
    if (shown) card.current?.place(shown)
    if (children.length === 0 && !unclaimed.length) {
      ctx.fillStyle = 'rgba(200,210,240,0.55)'
      ctx.font = '14px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`Nothing here yet. Use “Add inside” in the inspector to create a ${isSystem ? 'planet' : 'moon or world'}.`, w / 2, h - 70)
    }
  })

  /** What's under the pointer: a body, or else the line of its orbit. */
  const hitTest = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const [x, y] = [e.clientX - rect.left, e.clientY - rect.top]
    return targetAt(targets.current, x, y) ?? orbitAt(targets.current, x, y)
  }
  const point = (t: OrbitTarget | null) => {
    if ((t?.id ?? null) === hover.current) return
    hover.current = t?.id ?? null
    card.current?.show(t && system ? { target: t, summary: targetSummary(system, t, owner ? playheadOf(owner.id) : 0) } : null)
  }
  const generated = (id: string) => unclaimed.find((g) => g.orbit.bodyId === id)

  // A few pushes of the wheel change level: out to the parent, or in to what's under the cursor (or else nearest it).
  const edge = useRef(new EdgePush())
  const onWheel = (e: React.WheelEvent) => {
    // About one push a notch, so a trackpad's many small scrolls take as long as a wheel's few.
    if (!edge.current.push(Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100))) return
    if (e.deltaY > 0) return zoomOut(canvasRef.current)
    const rect = canvasRef.current!.getBoundingClientRect()
    const [x, y] = [e.clientX - rect.left, e.clientY - rect.top]
    // Nearest somewhere to land if nothing's under the cursor: a world, or a planet that would have one.
    const landable = (id: string) => worldIds.has(id) || worlds.has(id) || generated(id)?.giant === false
    const t = hitTest(e) ?? targetAt(targets.current.filter((x) => landable(x.id)), x, y, Infinity) ?? targetAt(targets.current, x, y, Infinity)
    if (!t) return
    // A planet nobody has claimed yet is claimed on the way in (with a world surface, unless it's a giant), as a click and Claim would.
    const planet = generated(t.id)
    if (planet) return void claimPlanetInto(node.id, planet, !planet.giant, canvasRef.current, t)
    zoomTo(t.id, canvasRef.current, t)
  }

  return (
    <div className="viewport">
      <canvas
        ref={canvasRef}
        className="viewport-canvas"
        data-testid="viewport"
        onMouseMove={(e) => {
          point(hitTest(e) ?? null)
          canvasRef.current!.style.cursor = hover.current ? 'pointer' : 'default'
        }}
        onMouseLeave={() => point(null)}
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
      <HoverCard ref={card} hiddenFor={picked?.planet.orbit.bodyId} />
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

/** Where a body's card goes: beside it, clear of it however big it's drawn. */
const beside = (t: OrbitTarget) => [t.x + t.r, t.y] as const

interface HoverCardHandle {
  show(card: { target: OrbitTarget; summary: string } | null): void
  /** Keeps it beside its body as the body moves. */
  place(target: OrbitTarget): void
}

/**
 * The card of the body pointed at (or whose orbit is): its level, its name and
 * how it goes round. On its own, so pointing at things re-renders only it;
 * not shown for the planet whose claim card is open (`hiddenFor`).
 */
function HoverCard({ ref, hiddenFor }: { ref: Ref<HoverCardHandle>; hiddenFor?: string }) {
  const [card, setCard] = useState<{ target: OrbitTarget; summary: string } | null>(null)
  const el = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({
    show: setCard,
    place: (t) => {
      const style = el.current?.style
      const [x, y] = beside(t)
      const [left, top] = [`${x}px`, `${y}px`]
      if (style && (style.left !== left || style.top !== top)) Object.assign(style, { left, top })
    }
  }))
  if (!card || card.target.id === hiddenFor) return null
  const { target, summary } = card
  const [x, y] = beside(target)
  return <ClaimCard ref={el} x={x} y={y} level={bodyLabel(!!target.orbit.parentBodyId)} name={target.name} description={summary} />
}
