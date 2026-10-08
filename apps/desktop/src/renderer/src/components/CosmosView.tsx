import { KIND_LABELS, type Command, type NodeKind, type SpatialNode } from '@universe/core'
import {
  GLOW_REACH,
  cellStars,
  cellsIn,
  clusterGalaxies,
  cosmicWeb,
  galaxyDensity,
  galaxyGlowPixels,
  galaxyShape,
  landmarkStars,
  levelExtent,
  placeOf,
  universeClusters,
  type GalaxyShape,
  type ProcCluster,
  type ProcGalaxy,
  type ProcStar
} from '@universe/procgen'
import { starInfo } from '@universe/sim'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../store'
import { SPACE_BG } from '../theme'
import { label, starfield } from './canvasDraw'
import { arrival, cameras, claimInto, zoomInto, zoomOut, zooming, type Camera } from './zoom'

/**
 * The universe, a galaxy cluster or a galaxy (PLAN.md §5.2): a map you can
 * pan and zoom, with the node's own children and everything generated from
 * its seed. Zooming all the way in on something goes into it; all the way
 * out goes up a level. Generated things can be claimed into the project.
 */

type CosmosKind = 'universe' | 'galaxy_cluster' | 'galaxy'
export const isCosmos = (kind: NodeKind): kind is CosmosKind => kind === 'universe' || kind === 'galaxy_cluster' || kind === 'galaxy'

const CHILD: Record<CosmosKind, NodeKind> = { universe: 'galaxy_cluster', galaxy_cluster: 'galaxy', galaxy: 'star_system' }
const UNIT: Record<CosmosKind, string> = { universe: 'Mly', galaxy_cluster: 'Mly', galaxy: 'ly' }
/** Closest each level zooms (units per pixel) before going into what's under the cursor. */
const MIN_UPP: Record<CosmosKind, number> = { universe: 0.4, galaxy_cluster: 0.0015, galaxy: 2 }
/** Galaxies are drawn larger than life in a cluster, or they'd be specks. */
const GALAXY_SCALE = 6

/** Something on the map: a stored child, or one generated from the seed. */
interface Item {
  key: string
  name: string
  x: number
  y: number
  seed: number
  /** Stored child; undefined for a generated one. */
  node?: SpatialNode
  star?: ProcStar
  galaxy?: GalaxyShape
  cluster?: ProcCluster
}

interface Hit {
  item: Item
  sx: number
  sy: number
  r: number
}

export function CosmosView({ node }: { node: SpatialNode & { kind: CosmosKind } }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodes = useUi((s) => s.nodes)
  const kind = node.kind
  const shape = useMemo(() => (kind === 'galaxy' ? galaxyShape(node.seed) : undefined), [kind, node.seed])
  const extent = levelExtent(kind, node.seed)

  // Stored children, and what the seed generates (minus anything already claimed: same seed).
  const stored = useMemo(() => nodes.filter((n) => n.parentId === node.id), [nodes, node.id])
  const items = useMemo<Item[]>(() => {
    const claimed = new Set(stored.map((n) => n.seed))
    const own: Item[] = stored.map((n) => ({ key: n.id, name: n.name, seed: n.seed, node: n, ...placeOf(n, node), galaxy: n.kind === 'galaxy' ? galaxyShape(n.seed) : undefined }))
    const generated: Item[] =
      kind === 'universe'
        ? universeClusters(node.seed).map((c) => ({ key: `proc:${c.seed}`, ...c, cluster: c }))
        : kind === 'galaxy_cluster'
          ? clusterGalaxies(node.seed).map((g: ProcGalaxy) => ({ key: `proc:${g.seed}`, ...g, galaxy: g.shape }))
          : landmarkStars(shape!, node.seed).map((s) => ({ key: `proc:${s.seed}`, ...s, star: s }))
    return [...generated.filter((g) => !claimed.has(g.seed)), ...own]
  }, [stored, kind, node, shape])
  const claimedSeeds = useMemo(() => new Set(stored.map((n) => n.seed)), [stored])

  // The camera (kept per node, so coming back finds it as it was): framing the whole level at first.
  const cam = () => cameraFor(node.id, () => ({ x: 0, y: 0, upp: (extent * 2.2) / Math.max(400, window.innerWidth * 0.5) }))
  const hoverKeyRef = useRef<string | null>(null)
  const [hover, setHover] = useState<Hit | null>(null)
  const [picked, setPicked] = useState<Hit | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; at: { x: number; y: number }; hit: Hit | null } | null>(null)
  const hits = useRef<Hit[]>([])
  const stars = useRef(new Map<string, ProcStar[]>())

  useEffect(() => {
    // Coming up from a child: start looking at it, close in.
    const from = items.find((i) => i.node && i.node.id === arrival.fromId)
    if (from) cameras.set(node.id, { x: from.x, y: from.y, upp: MIN_UPP[kind] * 4 })
    arrival.fromId = null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the view opens
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current!
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
      hits.current = drawLevel(ctx, w, h, { kind, node, shape, items, claimedSeeds, cam: cam(), stars: stars.current, hoverKey: hoverKeyRef.current, t: (performance.now() - start) / 1000 })
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `cam` reads the kept camera of this node
  }, [kind, node, shape, items, claimedSeeds])

  useEffect(() => {
    hoverKeyRef.current = hover?.item.key ?? picked?.item.key ?? null
  }, [hover, picked])

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const toWorld = (p: { x: number; y: number }) => {
    const c = canvasRef.current!
    const { x, y, upp } = cam()
    return { x: x + (p.x - c.clientWidth / 2) * upp, y: y + (p.y - c.clientHeight / 2) * upp }
  }
  const hitAt = (p: { x: number; y: number }) => {
    let best: Hit | null = null
    let bestD = Infinity
    for (const hit of hits.current) {
      const d = Math.hypot(hit.sx - p.x, hit.sy - p.y)
      if (d <= Math.max(hit.r, 9) && d < bestD) [best, bestD] = [hit, d]
    }
    return best
  }

  const open = (hit: Hit) => {
    if (hit.item.node) zoomInto(canvasRef.current, hit.item.node.id, hit.sx, hit.sy)
    else setPicked(hit)
  }

  const claim = async (hit: Hit) => {
    setPicked(null)
    const item = hit.item
    const id = crypto.randomUUID()
    const commands: Command[] = [{ type: 'node.create', payload: { id, parentId: node.id, kind: CHILD[kind], name: item.name, seed: item.seed, position: { x: item.x, y: item.y, z: 0 } } }]
    // A claimed star keeps the mass (and so the colour) it had on the map.
    if (item.star) commands.push({ type: 'star.set', payload: { systemId: id, star: { massSun: Number(item.star.massSun.toFixed(3)), luminositySun: null } } })
    await claimInto(canvasRef.current, commands, id, hit.sx, hit.sy)
  }

  const createHere = (at: { x: number; y: number }) =>
    void useUi.getState().execute({ type: 'node.create', payload: { parentId: node.id, kind: CHILD[kind], name: `New ${KIND_LABELS[CHILD[kind]]}`, position: { ...at, z: 0 } } })

  // Panning by drag; a press that doesn't move is a click.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pushes = useRef({ in: 0, out: 0 })
  const onWheel = (e: React.WheelEvent) => {
    const p = local(e)
    const before = toWorld(p)
    const canvas = canvasRef.current!
    const c = cam()
    const fit = (extent * 2.4) / Math.max(1, Math.min(canvas.clientWidth, canvas.clientHeight))
    const next = c.upp * Math.exp(e.deltaY * 0.0015)
    // Past either end, a few more pushes change level (once the last change has played out).
    if (zooming()) {
      pushes.current = { in: 0, out: 0 }
      c.upp = Math.min(fit, Math.max(MIN_UPP[kind], next))
    } else if (next < MIN_UPP[kind]) {
      pushes.current = { in: pushes.current.in + 1, out: 0 }
      const hit = hitAt(p) ?? hitAt({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 })
      if (pushes.current.in >= 3 && hit) {
        pushes.current.in = 0
        open(hit)
      }
      c.upp = MIN_UPP[kind]
    } else if (next > fit) {
      pushes.current = { in: 0, out: pushes.current.out + 1 }
      if (pushes.current.out >= 3) zoomOut(canvas)
      c.upp = fit
    } else {
      pushes.current = { in: 0, out: 0 }
      c.upp = next
    }
    // Zoom around the cursor.
    const after = toWorld(p)
    c.x += before.x - after.x
    c.y += before.y - after.y
  }

  const describe = (item: Item): string => {
    if (item.node) return `${KIND_LABELS[item.node.kind]} in your project`
    if (item.star) {
      const info = starInfo({ massSun: item.star.massSun, luminositySun: null })
      return `${spectralClass(info.temperatureK)} star · ${item.star.massSun.toFixed(2)} M☉ · not claimed yet`
    }
    if (item.galaxy) return `${item.galaxy.type[0]!.toUpperCase()}${item.galaxy.type.slice(1)} galaxy · ${Math.round((item.galaxy.radiusLy * 2) / 1000)},000 ly across · not claimed yet`
    return `Galaxy cluster · ${Math.round(item.cluster!.sizeMly)} Mly across · not claimed yet`
  }

  const card = picked ?? hover
  return (
    <div className="viewport" onContextMenu={(e) => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        className="viewport-canvas"
        data-testid="viewport"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          drag.current = { ...local(e), moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
          setMenu(null)
        }}
        onPointerMove={(e) => {
          const p = local(e)
          const d = drag.current
          if (d) {
            if (Math.hypot(p.x - d.x, p.y - d.y) > 3) d.moved = true
            if (d.moved) {
              const c = cam()
              c.x -= (p.x - d.x) * c.upp
              c.y -= (p.y - d.y) * c.upp
              d.x = p.x
              d.y = p.y
            }
            return
          }
          const hit = hitAt(p)
          if (hit?.item.key !== hover?.item.key) setHover(hit)
          canvasRef.current!.style.cursor = hit ? 'pointer' : 'grab'
        }}
        onPointerUp={(e) => {
          if (e.button !== 0) return
          const d = drag.current
          drag.current = null
          if (d?.moved) return
          const hit = hitAt(local(e))
          if (hit) open(hit)
          else setPicked(null)
        }}
        onPointerLeave={() => setHover(null)}
        onWheel={onWheel}
        onContextMenu={(e) => {
          const p = local(e)
          setMenu({ ...p, at: toWorld(p), hit: hitAt(p) })
        }}
      />
      <div className="viewport-overlay top">
        <div className="viewport-title">{node.name}</div>
        <div className="muted small">
          {KIND_LABELS[kind]} view{shape ? ` · ${shape.type} galaxy, ${Math.round((shape.radiusLy * 2) / 1000)},000 ly across` : ''}
        </div>
      </div>
      {card && (
        <div className="cosmos-card" style={{ left: card.sx + 14, top: card.sy + 10 }} role="dialog" aria-label={card.item.name}>
          <b>{card.item.name}</b>
          <span className="muted small">{describe(card.item)}</span>
          {picked && !picked.item.node && (
            <button className="primary" onClick={() => void claim(picked)}>
              Claim and go there
            </button>
          )}
        </div>
      )}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          {menu.hit && !menu.hit.item.node && (
            <button role="menuitem" onClick={() => (setMenu(null), void claim(menu.hit!))}>
              Claim {menu.hit.item.name}
            </button>
          )}
          {menu.hit?.item.node && (
            <button role="menuitem" onClick={() => (setMenu(null), open(menu.hit!))}>
              Go to {menu.hit.item.name}
            </button>
          )}
          <button role="menuitem" onClick={() => (setMenu(null), createHere(menu.at))}>
            New {KIND_LABELS[CHILD[kind]].toLowerCase()} here
          </button>
        </div>
      )}
      <ScaleBar nodeId={node.id} unit={UNIT[kind]} />
      <div className="viewport-overlay bottom muted small">Drag to move · scroll to zoom, all the way in to go there, out to go up · right-click to add or claim</div>
    </div>
  )
}

function cameraFor(nodeId: string, init: () => Camera): Camera {
  let camera = cameras.get(nodeId)
  if (!camera) cameras.set(nodeId, (camera = init()))
  return camera
}

function spectralClass(k: number): string {
  return k > 30_000 ? 'O-type' : k > 10_000 ? 'B-type' : k > 7_500 ? 'A-type' : k > 6_000 ? 'F-type' : k > 5_200 ? 'G-type' : k > 3_700 ? 'K-type' : 'M-type red dwarf'
}

/** A bar 60–150 px long showing a round distance at the current zoom. */
function ScaleBar({ nodeId, unit }: { nodeId: string; unit: string }) {
  // The camera changes outside React; a few updates a second are plenty.
  const [upp, setUpp] = useState(() => cameras.get(nodeId)?.upp ?? 1)
  useEffect(() => {
    const t = setInterval(() => setUpp(cameras.get(nodeId)?.upp ?? 1), 200)
    return () => clearInterval(t)
  }, [nodeId])
  const target = upp * 100
  const pow = 10 ** Math.floor(Math.log10(target))
  const nice = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= target * 0.6) ?? pow * 10
  return (
    <div className="scale-bar small" aria-label="Scale">
      <span style={{ width: nice / upp }} />
      {nice >= 1 ? nice.toLocaleString() : nice.toPrecision(1)} {unit}
    </div>
  )
}

interface DrawInput {
  kind: CosmosKind
  node: SpatialNode
  shape: GalaxyShape | undefined
  items: Item[]
  claimedSeeds: Set<number>
  cam: Camera
  stars: Map<string, ProcStar[]>
  hoverKey: string | null
  t: number
}

const galaxyImages = new Map<number, HTMLCanvasElement>()

/** A galaxy's glow, drawn once from thousands of its stars into an image. */
function galaxyImage(shape: GalaxyShape, seed: number, size: number, particles: number): HTMLCanvasElement {
  const key = seed * 4 + (size > 256 ? 1 : 0)
  const cached = galaxyImages.get(key)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const half = size / 2
  // The bulge's glow, kept inside the image so its edges never show.
  const glow = ctx.createRadialGradient(half, half, 0, half, half, Math.min(half, half * shape.bulge * 2.2))
  glow.addColorStop(0, 'rgba(255,240,215,0.9)')
  glow.addColorStop(1, 'rgba(255,220,180,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(half, half, half, 0, Math.PI * 2)
  ctx.fill()
  // The stars, added over it.
  const stars = document.createElement('canvas')
  stars.width = stars.height = size
  stars.getContext('2d')!.putImageData(new ImageData(galaxyGlowPixels(shape, seed, size, particles), size), 0, 0)
  ctx.globalCompositeOperation = 'lighter'
  ctx.drawImage(stars, 0, 0)
  if (galaxyImages.size > 80) galaxyImages.delete(galaxyImages.keys().next().value!)
  galaxyImages.set(key, canvas)
  return canvas
}

function drawLevel(ctx: CanvasRenderingContext2D, w: number, h: number, d: DrawInput): Hit[] {
  const { cam, kind } = d
  const sx = (x: number) => w / 2 + (x - cam.x) / cam.upp
  const sy = (y: number) => h / 2 + (y - cam.y) / cam.upp
  const onScreen = (x: number, y: number, r: number) => x > -r && x < w + r && y > -r && y < h + r
  ctx.fillStyle = SPACE_BG
  ctx.fillRect(0, 0, w, h)
  starfield(ctx, w, h, d.node.seed, kind === 'universe' ? 180 : 320)
  const hits: Hit[] = []

  if (kind === 'universe') {
    ctx.strokeStyle = 'rgba(120,140,220,0.14)'
    ctx.lineWidth = Math.max(1, 60 / cam.upp)
    ctx.lineCap = 'round'
    for (const [x0, y0, x1, y1] of cosmicWeb(d.node.seed)) {
      ctx.beginPath()
      ctx.moveTo(sx(x0), sy(y0))
      ctx.lineTo(sx(x1), sy(y1))
      ctx.stroke()
    }
  }

  if (kind === 'galaxy' && d.shape) {
    // The glow: a sharper image when zoomed in, fading out as single stars take
    // over, leaving a faint wash as thick as the galaxy is where you're looking.
    const fade = Math.min(1, Math.max(0, (cam.upp - MIN_UPP.galaxy) / 40))
    if (fade > 0) {
      const span = (d.shape.radiusLy * 2 * GLOW_REACH) / cam.upp
      const img = galaxyImage(d.shape, d.node.seed, span > 900 ? 1024 : 256, span > 900 ? 90_000 : 20_000)
      ctx.globalAlpha = fade
      ctx.drawImage(img, sx(-d.shape.radiusLy * GLOW_REACH), sy(-d.shape.radiusLy * GLOW_REACH), span, span)
      ctx.globalAlpha = 1
    }
    if (fade < 1) {
      ctx.fillStyle = `rgba(150,165,230,${(0.1 * (1 - fade) * galaxyDensity(d.shape, cam.x, cam.y)).toFixed(3)})`
      ctx.fillRect(0, 0, w, h)
    }
    // Close enough, the stars of the cells in view.
    const cells = cellsIn(cam.x - (w / 2) * cam.upp, cam.y - (h / 2) * cam.upp, cam.x + (w / 2) * cam.upp, cam.y + (h / 2) * cam.upp, 220)
    if (cells) {
      for (const [cx, cy] of cells) {
        const key = `${cx}:${cy}`
        let list = d.stars.get(key)
        if (!list) {
          d.stars.set(key, (list = cellStars(d.shape, d.node.seed, cx, cy)))
          if (d.stars.size > 3000) d.stars.delete(d.stars.keys().next().value!)
        }
        for (const s of list) {
          if (d.claimedSeeds.has(s.seed)) continue
          const x = sx(s.x)
          const y = sy(s.y)
          if (!onScreen(x, y, 4)) continue
          const r = starRadius(s.massSun, cam.upp)
          drawStar(ctx, x, y, r, s.massSun, `proc:${s.seed}` === d.hoverKey)
          hits.push({ item: { key: `proc:${s.seed}`, name: s.name, x: s.x, y: s.y, seed: s.seed, star: s }, sx: x, sy: y, r: r + 3 })
        }
      }
    }
  }

  for (const item of d.items) {
    const x = sx(item.x)
    const y = sy(item.y)
    const hovered = item.key === d.hoverKey
    let r: number
    if (item.cluster || (kind === 'universe' && item.node)) {
      r = Math.max(5, (item.cluster?.sizeMly ?? 14) / 2 / cam.upp)
      if (!onScreen(x, y, r)) continue
      clusterBlob(ctx, x, y, r, item.seed)
    } else if (item.galaxy) {
      r = Math.max(4, ((item.galaxy.radiusLy / 1e6) * GALAXY_SCALE) / cam.upp)
      if (!onScreen(x, y, r)) continue
      const img = galaxyImage(item.galaxy, item.seed, 128, 3000)
      ctx.save()
      ctx.translate(x, y)
      ctx.drawImage(img, -r * GLOW_REACH, -r * GLOW_REACH, r * 2 * GLOW_REACH, r * 2 * GLOW_REACH)
      ctx.restore()
    } else {
      // A star system: claimed ones show the star they claimed, others a plain star.
      const mass = item.star?.massSun ?? 1
      r = starRadius(mass, cam.upp) + (item.node ? 1.5 : 0)
      if (!onScreen(x, y, r)) continue
      drawStar(ctx, x, y, r, mass, hovered)
    }
    if (item.node) {
      ctx.strokeStyle = 'rgba(140,200,255,0.75)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, y, r + 4, 0, Math.PI * 2)
      ctx.stroke()
    }
    // Your own things are always named; generated ones when they're big enough to matter, or under the cursor.
    if (item.node || hovered || r > 16) label(ctx, item.name, x, y + r + 15, hovered || !!item.node)
    hits.push({ item, sx: x, sy: y, r: r + 4 })
  }
  return hits
}

/** Stars as points of light: bigger for heavier (brighter) stars, and a little bigger close in. */
const starRadius = (massSun: number, upp: number) => (0.8 + 0.6 * Math.min(5, massSun ** 0.4)) * (upp < 8 ? 1.5 : 1)

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, massSun: number, hovered: boolean) {
  const color = starInfo({ massSun, luminositySun: null }).color
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(0.25, color)
  g.addColorStop(1, 'transparent')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r * 2.6, 0, Math.PI * 2)
  ctx.fill()
  if (hovered) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.arc(x, y, r + 5, 0, Math.PI * 2)
    ctx.stroke()
  }
}

/** A galaxy cluster from afar: a soft knot of light, speckled with galaxies. */
function clusterBlob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, seed: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, 'rgba(225,215,255,0.55)')
  g.addColorStop(0.4, 'rgba(170,160,240,0.22)')
  g.addColorStop(1, 'rgba(120,120,220,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  let s = seed >>> 0
  for (let i = 0; i < 14; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const a = (s / 4294967296) * Math.PI * 2
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const d = Math.sqrt(s / 4294967296) * r * 0.8
    ctx.fillStyle = 'rgba(255,245,230,0.8)'
    ctx.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.4, 1.4)
  }
}
