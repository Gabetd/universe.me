import type { NodeKind, SpatialNode } from '@universe/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { hueOf } from '@universe/procgen'
import { kindLabel } from '../kinds'
import { selectNode, useTimelineOwner, useUi } from '../store'
import { playheadOf } from '../timeline/timelineStore'
import { useSystem } from '../world/useSky'
import type { GeneratedPlanet, SystemModel } from '@universe/sim'
import { drawOrbits, type CanvasTarget } from './orbitView'
import { label, starfield } from './canvasDraw'
import { CosmosView, isCosmos } from './CosmosView'
import { zoomInto, zoomOut, zooming } from './zoom'
import { claimPlanet, describePlanet, isGiant, useUnclaimedPlanets } from './ClaimPlanets'
import { SkyControls } from './SkyControls'
import { SPACE_BG } from '../theme'
import { usePlanetTextures, type PlanetTexture } from './planetSprite'

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
  return isCosmos(node.kind) ? <CosmosView key={node.id} node={node as SpatialNode & { kind: 'universe' }} /> : <OrbitViewport key={node.id} />
}

/** A star system or a planet with its moons: bodies where their orbits put them. */
function OrbitViewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodes = useUi((s) => s.nodes)
  const node = useUi(selectNode)

  const scene = useMemo(() => {
    if (!node) return undefined
    const children = nodes.filter((n) => n.parentId === node.id)
    // The world on each body in view (the body itself and what orbits it), drawn with its real surface.
    const worlds = new Map<string, SpatialNode>()
    for (const body of [node, ...children]) {
      const world = nodes.find((n) => n.parentId === body.id && n.kind === 'world')
      if (world) worlds.set(body.id, world)
    }
    return { node, children, world: worlds.get(node.id), worlds, label: kindLabel(node, nodes) }
  }, [node, nodes])
  const textures = usePlanetTextures(useMemo(() => [...(scene?.worlds.values() ?? [])], [scene]))
  const texturesRef = useRef(textures)
  useEffect(() => {
    texturesRef.current = textures
  }, [textures])

  const system = useSystem(node?.kind === 'star_system' || node?.kind === 'body' ? node.id : undefined)
  const owner = useTimelineOwner()
  // Names and colours of the bodies, worked out once rather than every frame.
  const bodies = useMemo(() => new Map(nodes.filter((n) => n.kind === 'body').map((n) => [n.id, { name: n.name, hue: hueOf(n.seed) }])), [nodes])
  // In a star system, the planets its seed generates that nobody has claimed yet.
  const unclaimed = useUnclaimedPlanets(node)
  const skyRef = useRef({ system, ownerId: owner?.id, bodies, unclaimed })
  useEffect(() => {
    skyRef.current = { system, ownerId: owner?.id, bodies, unclaimed }
  }, [system, owner?.id, bodies, unclaimed])
  const [picked, setPicked] = useState<{ planet: GeneratedPlanet; x: number; y: number; withWorld: boolean } | null>(null)

  const hover = useRef<string | null>(null)
  const targets = useRef<Target[]>([])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !scene) return
    const ctx = canvas.getContext('2d')!
    let frame = 0
    const start = performance.now()

    const render = () => {
      const dpr = window.devicePixelRatio || 1
      const { clientWidth: w, clientHeight: h } = canvas
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const s = skyRef.current
      const sky = s.system && { system: s.system, t: s.ownerId ? playheadOf(s.ownerId) : 0, bodies: s.bodies, unclaimed: s.unclaimed }
      targets.current = drawScene(ctx, w, h, scene, texturesRef.current, sky, hover.current, (performance.now() - start) / 1000)
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [scene])

  const hitTest = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    return targets.current.find((t) => Math.hypot(t.x - x, t.y - y) <= Math.max(t.r, 10))
  }
  const generated = (id: string) => unclaimed.find((g) => g.orbit.bodyId === id)

  // A few pushes of the wheel change level: out to the parent, or in to what's under the cursor.
  const wheelAccum = useRef(0)
  const onWheel = (e: React.WheelEvent) => {
    if (zooming()) return
    wheelAccum.current += e.deltaY
    if (Math.abs(wheelAccum.current) < 240) return
    const out = wheelAccum.current > 0
    wheelAccum.current = 0
    if (out) return zoomOut(canvasRef.current)
    const t = hitTest(e)
    if (t && !generated(t.id)) zoomInto(canvasRef.current, t.id, t.x, t.y)
  }

  if (!scene) return null
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
          setPicked(planet ? { planet, x: t.x, y: t.y, withWorld: !isGiant(planet) } : null)
          if (t && !planet) zoomInto(canvasRef.current, t.id, t.x, t.y)
        }}
        onWheel={onWheel}
      />
      <div className="viewport-overlay top">
        <div className="viewport-title">{scene.node.name}</div>
        <div className="muted small">{scene.label} view</div>
      </div>
      {picked && (
        <div className="cosmos-card" style={{ left: picked.x + 14, top: picked.y + 10 }} role="dialog" aria-label={picked.planet.name}>
          <b>{picked.planet.name}</b>
          <span className="muted small">{describePlanet(picked.planet)} · not claimed yet</span>
          <label className="checkbox">
            <input type="checkbox" checked={picked.withWorld} onChange={(e) => setPicked({ ...picked, withWorld: e.target.checked })} />
            With a world surface
          </label>
          <button className="primary" onClick={() => (setPicked(null), void claimPlanet(node!.id, picked.planet, picked.withWorld, picked))}>
            Claim and go there
          </button>
        </div>
      )}
      {system && owner && <SkyControls ownerId={owner.id} system={system} centerId={scene.node.kind === 'body' ? scene.node.id : null} />}
      <div className="viewport-overlay bottom muted small">
        Click to zoom in{unclaimed.length ? ' or claim a faint planet' : ''} · Scroll down or Esc to zoom out
      </div>
    </div>
  )
}

type Target = CanvasTarget

interface Scene {
  node: SpatialNode
  children: SpatialNode[]
  world: SpatialNode | undefined
  /** Body id → the world on it. */
  worlds: Map<string, SpatialNode>
}

/** What the star-system and planet views need: the simulated system at the playhead. */
interface Sky {
  system: SystemModel
  /** Timeline time. */
  t: number
  bodies: Map<string, { name: string; hue: number }>
  unclaimed: GeneratedPlanet[]
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scene: Scene,
  textures: Map<string, PlanetTexture>,
  sky: Sky | undefined,
  hoverId: string | null,
  t: number
): Target[] {
  const { node, children } = scene
  ctx.fillStyle = SPACE_BG
  ctx.fillRect(0, 0, w, h)
  starfield(ctx, w, h, node.seed, 380)

  const cx = w / 2
  const targets: Target[] = []

  switch (node.kind) {
    case 'star_system':
    case 'body': {
      if (!sky) break
      const isSystem = node.kind === 'star_system'
      targets.push(
        ...drawOrbits(ctx, w, h, {
          system: sky.system,
          centerId: isSystem ? null : node.id,
          t: sky.t,
          spin: t,
          bodies: sky.bodies,
          worlds: scene.worlds,
          textures,
          // The planet in the middle opens its world.
          centerTargetId: scene.world?.id,
          unclaimed: sky.unclaimed,
          hoverId
        })
      )
      const middle = !isSystem && scene.world && targets.find((x) => x.id === scene.world!.id)
      if (middle) label(ctx, `World: ${scene.world!.name}`, middle.x, middle.y + middle.r + 14, middle.id === hoverId)
      break
    }
  }

  if (children.length === 0 && !sky?.unclaimed.length) {
    ctx.fillStyle = 'rgba(200,210,240,0.55)'
    ctx.font = '14px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`Nothing here yet. Use “Add inside” in the inspector to create a ${childHint(node.kind)}.`, cx, h - 70)
  }
  return targets
}

function childHint(kind: NodeKind): string {
  return { universe: 'galaxy cluster', galaxy_cluster: 'galaxy', galaxy: 'star system', star_system: 'planet', body: 'moon or world', world: '' }[kind]
}







