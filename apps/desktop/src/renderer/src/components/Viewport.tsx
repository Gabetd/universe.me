import type { NodeKind, SpatialNode } from '@universe/core'
import { useEffect, useMemo, useRef } from 'react'
import { hueOf, rng } from '@universe/procgen'
import { kindLabel } from '../kinds'
import { selectNode, useTimelineOwner, useUi } from '../store'
import { playheadOf } from '../timeline/timelineStore'
import { useSystem } from '../world/useSky'
import type { SystemModel } from '@universe/sim'
import { drawOrbits } from './orbitView'
import { SkyControls } from './SkyControls'
import { SPACE_BG } from '../theme'
import { usePlanetTextures, type PlanetTexture } from './planetSprite'

/**
 * The viewport for every level above a world surface: a 2D canvas of the
 * selected level and its children. Star systems and planets are simulated
 * (orbits at the timeline's playhead); galaxies and above are sketched from
 * seeds until M5. Click a child to zoom in; scroll down or press Escape to
 * zoom out. World surfaces open the WorldEditor instead.
 */
export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodes = useUi((s) => s.nodes)
  const node = useUi(selectNode)
  const select = useUi((s) => s.select)

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
  const worlds = useUi((s) => s.worlds)
  const skyRef = useRef({ system, ownerId: owner?.id, nodes, radiusKm: new Map<string, number>() })
  useEffect(() => {
    skyRef.current = { system, ownerId: owner?.id, nodes, radiusKm: new Map(worlds.map((w) => [w.id, w.settings.radiusKm])) }
  }, [system, owner?.id, nodes, worlds])

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
      const sky = s.system && { system: s.system, t: s.ownerId ? playheadOf(s.ownerId) : 0, nodes: s.nodes, radiusKm: s.radiusKm }
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

  const wheelAccum = useRef(0)
  const onWheel = (e: React.WheelEvent) => {
    wheelAccum.current += e.deltaY
    if (Math.abs(wheelAccum.current) < 120) return
    const zoomOut = wheelAccum.current > 0
    wheelAccum.current = 0
    if (zoomOut && scene?.node.parentId) select(scene.node.parentId)
    else if (!zoomOut) {
      const t = hitTest(e)
      if (t) select(t.id)
    }
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
          if (t) select(t.id)
        }}
        onWheel={onWheel}
      />
      <div className="viewport-overlay top">
        <div className="viewport-title">{scene.node.name}</div>
        <div className="muted small">{scene.label} view</div>
      </div>
      {system && owner && <SkyControls ownerId={owner.id} system={system} centerId={scene.node.kind === 'body' ? scene.node.id : null} />}
      <div className="viewport-overlay bottom muted small">
        Click to zoom in · Scroll down or Esc to zoom out
      </div>
    </div>
  )
}

interface Target {
  id: string
  x: number
  y: number
  r: number
}

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
  nodes: SpatialNode[]
  /** World id → its radius. */
  radiusKm: Map<string, number>
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
  starfield(ctx, w, h, node.seed, node.kind)

  const cx = w / 2
  const cy = h / 2 + 10
  const size = Math.min(w, h)
  const targets: Target[] = []

  switch (node.kind) {
    case 'universe':
    case 'galaxy_cluster': {
      const isUniverse = node.kind === 'universe'
      children.forEach((child, i) => {
        const r = rng(child.seed)
        const angle = (i / Math.max(children.length, 1)) * Math.PI * 2 + r() * 0.8
        const dist = size * (0.12 + r() * 0.26)
        const x = cx + Math.cos(angle) * dist * (w / size)
        const y = cy + Math.sin(angle) * dist * 0.75
        const radius = size * (isUniverse ? 0.07 : 0.045) * (0.8 + r() * 0.5)
        if (isUniverse) clusterBlob(ctx, x, y, radius, child.seed)
        else galaxySprite(ctx, x, y, radius, child.seed, t)
        targets.push({ id: child.id, x, y, r: radius })
        label(ctx, child.name, x, y + radius + 16, child.id === hoverId)
      })
      break
    }
    case 'galaxy': {
      const radius = size * 0.4
      spiralGalaxy(ctx, cx, cy, radius, node.seed, t)
      children.forEach((child) => {
        const r = rng(child.seed)
        const arm = Math.floor(r() * 2)
        const along = 0.25 + r() * 0.7
        const theta = along * 3.2 + arm * Math.PI + t * 0.02
        const x = cx + Math.cos(theta) * along * radius
        const y = cy + Math.sin(theta) * along * radius * 0.55
        glowDot(ctx, x, y, 5, `hsl(${hueOf(child.seed)} 90% 80%)`)
        targets.push({ id: child.id, x, y, r: 8 })
        label(ctx, child.name, x, y + 18, child.id === hoverId)
      })
      break
    }
    case 'star_system':
    case 'body': {
      if (!sky) break
      const isSystem = node.kind === 'star_system'
      const bodyNodes = new Map(sky.nodes.map((n) => [n.id, n]))
      const worldOf = (bodyId: string) => sky.nodes.find((n) => n.parentId === bodyId && n.kind === 'world')
      targets.push(
        ...drawOrbits(ctx, w, h, {
          system: sky.system,
          centerId: isSystem ? null : node.id,
          t: sky.t,
          spin: t,
          names: new Map(sky.nodes.map((n) => [n.id, n.name])),
          radiusOf: (o) => {
            const world = worldOf(o.bodyId)
            return (world && sky.radiusKm.get(world.id)) ?? o.radiusKm
          },
          textureOf: (bodyId) => {
            const world = worldOf(bodyId)
            return world && textures.get(world.id)
          },
          hasWorld: (bodyId) => !!worldOf(bodyId),
          hueOf: (bodyId) => hueOf(bodyNodes.get(bodyId)?.seed ?? 0),
          hoverId
        })
      )
      if (!isSystem && scene.world) {
        // The planet in the middle opens its world.
        const middle = targets.find((x) => x.id === node.id)
        if (middle) {
          middle.id = scene.world.id
          label(ctx, `World: ${scene.world.name}`, middle.x, middle.y + middle.r + 14, scene.world.id === hoverId)
        }
      }
      break
    }
  }

  if (children.length === 0) {
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

function starfield(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, kind: NodeKind) {
  const r = rng(seed ^ 0x51ed27)
  const count = kind === 'universe' ? 260 : 380
  for (let i = 0; i < count; i++) {
    const x = r() * w
    const y = r() * h
    const s = r() * r() * 1.6 + 0.2
    ctx.fillStyle = `rgba(220,230,255,${0.15 + r() * 0.55})`
    ctx.fillRect(x, y, s, s)
  }
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, highlight: boolean) {
  ctx.font = `${highlight ? 600 : 500} 12px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillStyle = highlight ? '#ffffff' : 'rgba(210,220,245,0.8)'
  ctx.fillText(text, x, y)
}

function glowDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3)
  g.addColorStop(0, color)
  g.addColorStop(0.3, color.replace('80%)', '60% / 0.5)'))
  g.addColorStop(1, 'transparent')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r * 3, 0, Math.PI * 2)
  ctx.fill()
}

function clusterBlob(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, seed: number) {
  const r = rng(seed)
  const hue = hueOf(seed)
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2
    const d = Math.sqrt(r()) * radius
    const px = x + Math.cos(a) * d
    const py = y + Math.sin(a) * d * 0.7
    const s = 2 + r() * 6
    const g = ctx.createRadialGradient(px, py, 0, px, py, s * 2)
    g.addColorStop(0, `hsl(${hue + r() * 40} 80% 80% / 0.9)`)
    g.addColorStop(1, 'transparent')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(px, py, s * 2, 0, Math.PI * 2)
    ctx.fill()
  }
}

function galaxySprite(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, seed: number, t: number) {
  const r = rng(seed)
  const tilt = r() * Math.PI
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(tilt + t * 0.03)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius)
  const hue = hueOf(seed)
  g.addColorStop(0, `hsl(${hue} 70% 92% / 1)`)
  g.addColorStop(0.25, `hsl(${hue} 70% 70% / 0.6)`)
  g.addColorStop(1, 'transparent')
  ctx.scale(1, 0.35 + r() * 0.4)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function spiralGalaxy(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, seed: number, t: number) {
  const r = rng(seed)
  const hue = hueOf(seed)
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.3)
  core.addColorStop(0, `hsl(${hue} 60% 90% / 0.9)`)
  core.addColorStop(1, 'transparent')
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.ellipse(cx, cy, radius * 0.3, radius * 0.3 * 0.55, 0, 0, Math.PI * 2)
  ctx.fill()
  for (let i = 0; i < 1400; i++) {
    const arm = i % 2
    const along = Math.pow(r(), 0.8)
    const theta = along * 3.2 + arm * Math.PI + (r() - 0.5) * 0.5 + t * 0.02
    const spread = (r() - 0.5) * radius * 0.12
    const x = cx + Math.cos(theta) * (along * radius + spread)
    const y = cy + Math.sin(theta) * (along * radius + spread) * 0.55
    ctx.fillStyle = `hsl(${hue + r() * 60 - 30} 70% ${70 + r() * 25}% / ${0.25 + r() * 0.5})`
    ctx.fillRect(x, y, 1.4, 1.4)
  }
}

