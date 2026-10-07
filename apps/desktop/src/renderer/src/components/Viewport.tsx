import type { NodeKind, SpatialNode } from '@universe/core'
import { useEffect, useMemo, useRef } from 'react'
import { kindLabel } from '../kinds'
import { selectNode, useUi } from '../store'

/**
 * M0 placeholder viewport: a 2D canvas sketch of the selected level and its
 * children, all derived from seeds. Click a child to zoom in; scroll down or
 * press Escape to zoom out. Replaced by the three.js scenes in M1/M5.
 */
export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodes = useUi((s) => s.nodes)
  const node = useUi(selectNode)
  const select = useUi((s) => s.select)

  const scene = useMemo(() => {
    if (!node) return undefined
    // A world is shown on its body, so the view of a world matches the view of its planet.
    const focus = node.kind === 'world' ? (nodes.find((n) => n.id === node.parentId) ?? node) : node
    return {
      node,
      focus,
      children: nodes.filter((n) => n.parentId === focus.id),
      world: nodes.find((n) => n.parentId === focus.id && n.kind === 'world'),
      label: kindLabel(node, nodes)
    }
  }, [node, nodes])

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
      targets.current = drawScene(ctx, w, h, scene, hover.current, (performance.now() - start) / 1000)
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
      <div className="viewport-overlay bottom muted small">
        Click to zoom in · Scroll down or Esc to zoom out
        {scene.node.kind === 'world' && ' · Surface editor arrives in M1'}
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
  focus: SpatialNode
  children: SpatialNode[]
  world: SpatialNode | undefined
}

/** Small, fast seeded PRNG (mulberry32), so every node always looks the same. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hueOf = (seed: number) => Math.floor(rng(seed ^ 0x9e3779b9)() * 360)

function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, scene: Scene, hoverId: string | null, t: number): Target[] {
  const { focus, children } = scene
  ctx.fillStyle = '#05070d'
  ctx.fillRect(0, 0, w, h)
  starfield(ctx, w, h, focus.seed, focus.kind)

  const cx = w / 2
  const cy = h / 2 + 10
  const size = Math.min(w, h)
  const targets: Target[] = []

  switch (focus.kind) {
    case 'universe':
    case 'galaxy_cluster': {
      const isUniverse = focus.kind === 'universe'
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
      spiralGalaxy(ctx, cx, cy, radius, focus.seed, t)
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
      const isSystem = focus.kind === 'star_system'
      const centerR = size * (isSystem ? 0.05 : 0.12)
      if (isSystem) star(ctx, cx, cy, centerR, focus.seed)
      else planet(ctx, cx, cy, centerR, focus.seed, !!scene.world)
      const orbiting = children.filter((c) => c.kind === 'body')
      orbiting.forEach((child, i) => {
        const r = rng(child.seed)
        const orbit = centerR + size * 0.06 + i * size * (0.32 / Math.max(orbiting.length, 3))
        const speed = 0.6 / Math.pow(orbit / 60, 1.5)
        const angle = r() * Math.PI * 2 + t * speed
        ctx.strokeStyle = 'rgba(140,160,220,0.18)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.ellipse(cx, cy, orbit, orbit * 0.42, 0, 0, Math.PI * 2)
        ctx.stroke()
        const x = cx + Math.cos(angle) * orbit
        const y = cy + Math.sin(angle) * orbit * 0.42
        const pr = size * (isSystem ? 0.012 : 0.02) * (0.7 + r() * 0.8)
        planet(ctx, x, y, pr, child.seed, false)
        targets.push({ id: child.id, x, y, r: pr + 4 })
        label(ctx, child.name, x, y + pr + 14, child.id === hoverId)
      })
      if (!isSystem && scene.world) {
        targets.push({ id: scene.world.id, x: cx, y: cy, r: centerR })
        label(ctx, `World: ${scene.world.name}`, cx, cy + centerR + 18, scene.world.id === hoverId || scene.node.kind === 'world')
      }
      break
    }
    case 'world':
      // Only reached for a world without a parent body, which the model does not allow.
      break
  }

  if (children.length === 0 && focus.kind !== 'world') {
    ctx.fillStyle = 'rgba(200,210,240,0.55)'
    ctx.font = '14px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`Nothing here yet. Use “Add inside” in the inspector to create a ${childHint(focus.kind)}.`, cx, h - 70)
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

function star(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, seed: number) {
  const hue = 20 + (hueOf(seed) % 40)
  const g = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius * 3)
  g.addColorStop(0, '#fffbe8')
  g.addColorStop(0.3, `hsl(${hue} 100% 65% / 0.9)`)
  g.addColorStop(1, 'transparent')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, radius * 3, 0, Math.PI * 2)
  ctx.fill()
}

function planet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, seed: number, hasWorld: boolean) {
  const hue = hueOf(seed)
  const g = ctx.createRadialGradient(x - radius * 0.4, y - radius * 0.4, radius * 0.1, x, y, radius)
  g.addColorStop(0, `hsl(${hue} 55% 70%)`)
  g.addColorStop(1, `hsl(${hue} 45% 22%)`)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  if (hasWorld) {
    // Continents hint that this body has an editable surface.
    const r = rng(seed ^ 0xabc)
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.clip()
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = `hsl(${100 + r() * 40} 35% ${30 + r() * 15}% / 0.85)`
      ctx.beginPath()
      ctx.ellipse(x + (r() - 0.5) * radius * 1.4, y + (r() - 0.5) * radius * 1.4, radius * (0.15 + r() * 0.3), radius * (0.1 + r() * 0.2), r() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    ctx.strokeStyle = 'rgba(140,200,255,0.5)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(x, y, radius + 2, 0, Math.PI * 2)
    ctx.stroke()
  }
}
