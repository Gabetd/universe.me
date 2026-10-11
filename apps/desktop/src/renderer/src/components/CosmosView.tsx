import { ALLOWED_CHILDREN, KIND_LABELS, type SpatialNode } from '@universe/core'
import {
  GLOW_REACH,
  STAR_CELL_LY,
  cellSeed,
  cellStars,
  cellsIn,
  clusterGalaxies,
  cosmicWeb,
  galaxyDensity,
  galaxyShape,
  landmarkStars,
  levelExtent,
  placeOf,
  rng,
  universeClusters,
  type GalaxyShape,
  type ProcCluster,
  type Procedural
} from '@universe/procgen'
import { claimGenerated, starInfo } from '@universe/sim'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../store'
import { workerCalls } from '../workerCalls'
import { label, ring, starGlow, targetAt, useCanvasLoop } from './canvasDraw'
import { clusterGas, clusterSprite, drawFilaments, hexRgb, spaceBackdrop, starCloud, starSpikes } from './spaceArt'
import { ClaimCard, newId } from './ClaimPlanets'
import type { GlowRequest } from './galaxy.worker'
import GalaxyWorker from './galaxy.worker?worker'
import { EdgePush, arrival, cameras, claimInto, zoomOut, zoomTo, type Camera } from './zoom'
import { openElementMenu, useContextMenu, type MenuItem } from '../contextMenu'

/**
 * The universe, a galaxy cluster or a galaxy (PLAN.md §5.2): a map you can
 * pan and zoom, with the node's own children and everything generated from
 * its seed. Zooming all the way in on something goes into it; all the way
 * out goes up a level. Generated things can be claimed into the project.
 */

type CosmosKind = 'universe' | 'galaxy_cluster' | 'galaxy'
export const isCosmos = (node: SpatialNode): node is SpatialNode & { kind: CosmosKind } =>
  node.kind === 'universe' || node.kind === 'galaxy_cluster' || node.kind === 'galaxy'

const UNIT: Record<CosmosKind, string> = { universe: 'Mly', galaxy_cluster: 'Mly', galaxy: 'ly' }
/** Closest each level zooms (units per pixel) before going into what's under the cursor. */
const MIN_UPP: Record<CosmosKind, number> = { universe: 0.4, galaxy_cluster: 0.0015, galaxy: 2 }
/** Galaxies are drawn larger than life in a cluster, or they'd be specks. */
const GALAXY_SCALE = 8

/** Something on the map: a stored child, or one generated from the seed. */
interface Item extends Procedural {
  key: string
  /** Stored child; undefined for a generated one. */
  node?: SpatialNode
  /** A star's mass (a star system's, once claimed). */
  massSun?: number
  galaxy?: GalaxyShape
  cluster?: ProcCluster
}

/** Something generated from a seed, as an item on the map. */
const generatedItem = (thing: Procedural, more: Partial<Item> = {}): Item => ({ key: `proc:${thing.seed}`, seed: thing.seed, name: thing.name, x: thing.x, y: thing.y, ...more })

/** An item where it was drawn, in px from the view's corner. */
interface Hit {
  item: Item
  x: number
  y: number
  r: number
}

export function CosmosView({ node }: { node: SpatialNode & { kind: CosmosKind } }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scaleRef = useRef<HTMLDivElement>(null)
  const nodes = useUi((s) => s.nodes)
  const stars = useUi((s) => s.timeline.stars)
  const kind = node.kind
  const child = ALLOWED_CHILDREN[kind][0]!
  const shape = useMemo(() => (kind === 'galaxy' ? galaxyShape(node.seed) : undefined), [kind, node.seed])
  const extent = useMemo(() => levelExtent(kind, node.seed), [kind, node.seed])
  const web = useMemo(() => (kind === 'universe' ? cosmicWeb(node.seed) : []), [kind, node.seed])

  // What the seed generates, and the stored children (anything claimed has the same seed, so it replaces the generated one).
  const generated = useMemo<Item[]>(
    () =>
      kind === 'universe'
        ? universeClusters(node.seed).map((c) => generatedItem(c, { cluster: c }))
        : kind === 'galaxy_cluster'
          ? clusterGalaxies(node.seed).map((g) => generatedItem(g, { galaxy: g.shape }))
          : landmarkStars(shape!, node.seed).map((s) => generatedItem(s, { massSun: s.massSun })),
    [kind, node.seed, shape]
  )
  const { items, claimedSeeds } = useMemo(() => {
    const stored = nodes.filter((n) => n.parentId === node.id)
    const claimedSeeds = new Set(stored.map((n) => n.seed))
    const massOf = new Map(stars.map((s) => [s.ownerId, s.massSun]))
    const own = stored.map<Item>((n) => ({
      key: n.id,
      name: n.name,
      seed: n.seed,
      node: n,
      ...placeOf(n, node),
      galaxy: n.kind === 'galaxy' ? galaxyShape(n.seed) : undefined,
      massSun: n.kind === 'star_system' ? (massOf.get(n.id) ?? 1) : undefined
    }))
    return { items: [...generated.filter((g) => !claimedSeeds.has(g.seed)), ...own], claimedSeeds }
  }, [nodes, stars, node, generated])

  // The camera (kept per node, so coming back finds it as it was): framing the whole level at first.
  const cam = () => cameraFor(node.id, () => ({ x: 0, y: 0, upp: (extent * 2.2) / Math.max(400, window.innerWidth * 0.5) }))
  const [hover, setHover] = useState<Hit | null>(null)
  const [picked, setPicked] = useState<Hit | null>(null)
  const hits = useRef<Hit[]>([])
  const cells = useRef(new Map<string, Item[]>())
  const lastFrame = useRef<Frame | null>(null)

  useEffect(() => {
    // Coming up from a child: start looking at it, close in.
    const from = items.find((i) => i.node && i.node.id === arrival.fromId)
    if (from) cameras.set(node.id, { x: from.x, y: from.y, upp: MIN_UPP[kind] * 4 })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the view opens
  }, [])

  useCanvasLoop(canvasRef, (ctx, w, h, resized) => {
    const c = cam()
    // A map only changes when it's moved, resized, pointed at, edited or a glow arrives: otherwise the last frame stands.
    const frame: Frame = { x: c.x, y: c.y, upp: c.upp, w, h, hoverKey: (picked ?? hover)?.item.key ?? null, items, glows: glowsArrived }
    if (!resized && lastFrame.current && sameFrame(lastFrame.current, frame)) return
    lastFrame.current = frame
    hits.current = drawLevel(ctx, w, h, { kind, node, shape, web, extent, items, claimedSeeds, cam: c, cells: cells.current, hoverKey: frame.hoverKey })
    showScale(scaleRef.current, c.upp, UNIT[kind])
  })

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const toWorld = (p: { x: number; y: number }) => {
    const c = canvasRef.current!
    const { x, y, upp } = cam()
    return { x: x + (p.x - c.clientWidth / 2) * upp, y: y + (p.y - c.clientHeight / 2) * upp }
  }
  const hitAt = (p: { x: number; y: number }) => targetAt(hits.current, p.x, p.y, 9) ?? null

  const open = (hit: Hit) => {
    if (hit.item.node) zoomTo(hit.item.node.id, canvasRef.current, hit)
    else setPicked(hit)
  }
  const claim = (hit: Hit) => {
    setPicked(null)
    void claimInto(claimGenerated(node, hit.item, newId), canvasRef.current, hit)
  }
  /** With nothing in view, the item nearest the point `p` looks at, wherever it is (zoomed in where nothing is drawn). */
  const nearestOffScreen = (p: { x: number; y: number }): Hit | undefined => {
    const at = toWorld(p)
    let best: Item | undefined
    for (const item of items) if (!best || Math.hypot(item.x - at.x, item.y - at.y) < Math.hypot(best.x - at.x, best.y - at.y)) best = item
    return best && { item: best, ...p, r: 0 }
  }
  const createHere = (at: { x: number; y: number }) => void useUi.getState().execute({ type: 'node.create', payload: { parentId: node.id, kind: child, position: { ...at, z: 0 } } })

  // Panning by drag; a press that doesn't move is a click.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const edge = useRef(new EdgePush())
  const onWheel = (e: React.WheelEvent) => {
    const p = local(e)
    const before = toWorld(p)
    const canvas = canvasRef.current!
    const c = cam()
    const fit = (extent * 2.4) / Math.max(1, Math.min(canvas.clientWidth, canvas.clientHeight))
    const next = c.upp * Math.exp(e.deltaY * 0.0015)
    c.upp = Math.min(fit, Math.max(MIN_UPP[kind], next))
    // Past either end, a few more pushes change level.
    const push = next < MIN_UPP[kind] ? -1 : next > fit ? 1 : 0
    if (edge.current.push(push)) {
      if (push > 0) return zoomOut(canvas)
      // In to what's under the cursor, or else the nearest thing to it; something not claimed yet is claimed on the way in (one undo).
      const hit = hitAt(p) ?? targetAt(hits.current, p.x, p.y, Infinity) ?? nearestOffScreen(p)
      if (hit) return hit.item.node ? open(hit) : claim(hit)
    }
    // Zoom around the cursor.
    const after = toWorld(p)
    c.x += before.x - after.x
    c.y += before.y - after.y
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
          e.preventDefault()
          const p = local(e)
          const hit = hitAt(p)
          const at = toWorld(p)
          const here: MenuItem = { label: `New ${KIND_LABELS[child].toLowerCase()} here`, run: () => createHere(at) }
          // A claimed one is a node like any other; a generated one can only be claimed.
          if (hit?.item.node) return openElementMenu({ kind: 'node', id: hit.item.node.id }, e.clientX, e.clientY, { open: () => open(hit), extra: [here] })
          useContextMenu.getState().open({
            x: e.clientX,
            y: e.clientY,
            title: hit ? `${hit.item.name} · not claimed yet` : node.name,
            items: [...(hit ? [{ label: `Claim ${hit.item.name}`, run: () => claim(hit) }] : []), here]
          })
        }}
      />
      <div className="viewport-overlay top">
        <div className="viewport-title">{node.name}</div>
        <div className="muted small">
          {KIND_LABELS[kind]} view{shape ? ` · ${galaxySummary(shape).toLowerCase()}` : ''}
        </div>
      </div>
      {card && <ClaimCard x={card.x} y={card.y} name={card.item.name} description={describe(card.item)} onClaim={picked && !picked.item.node ? () => claim(picked) : undefined} />}
      <div className="scale-bar small" aria-label="Scale" ref={scaleRef}>
        <span className="scale-line" />
        <span />
      </div>
      <div className="viewport-overlay bottom muted small">Drag to move · scroll to zoom, all the way in to go there, out to go up · right-click to add or claim</div>
    </div>
  )
}

function cameraFor(nodeId: string, init: () => Camera): Camera {
  let camera = cameras.get(nodeId)
  if (!camera) cameras.set(nodeId, (camera = init()))
  return camera
}

/** What a view drew from: the same again draws the same picture. */
interface Frame {
  x: number
  y: number
  upp: number
  w: number
  h: number
  hoverKey: string | null
  items: Item[]
  glows: number
}
const sameFrame = (a: Frame, b: Frame) => (Object.keys(a) as (keyof Frame)[]).every((k) => a[k] === b[k])

/** "Barred galaxy · 104,000 ly across". */
const galaxySummary = (shape: GalaxyShape) => `${shape.type[0]!.toUpperCase()}${shape.type.slice(1)} galaxy · ${Math.round((shape.radiusLy * 2) / 1000)},000 ly across`

function describe(item: Item): string {
  if (item.node) return `${KIND_LABELS[item.node.kind]} in your project`
  if (item.massSun !== undefined) {
    const info = starInfo({ massSun: item.massSun, luminositySun: null })
    return `${spectralClass(info.temperatureK)} star · ${item.massSun.toFixed(2)} M☉ · not claimed yet`
  }
  if (item.galaxy) return `${galaxySummary(item.galaxy)} · not claimed yet`
  return `Galaxy cluster · ${Math.round(item.cluster!.sizeMly)} Mly across · not claimed yet`
}

function spectralClass(k: number): string {
  return k > 30_000 ? 'O-type' : k > 10_000 ? 'B-type' : k > 7_500 ? 'A-type' : k > 6_000 ? 'F-type' : k > 5_200 ? 'G-type' : k > 3_700 ? 'K-type' : 'M-type red dwarf'
}

/** The scale bar in the corner: 60–150 px long, for a round distance at the current zoom. */
function showScale(bar: HTMLElement | null, upp: number, unit: string) {
  if (!bar) return
  const target = upp * 100
  const pow = 10 ** Math.floor(Math.log10(target))
  const nice = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= target * 0.6) ?? pow * 10
  ;(bar.firstElementChild as HTMLElement).style.width = `${nice / upp}px`
  bar.lastElementChild!.textContent = `${nice >= 1 ? nice.toLocaleString() : nice.toPrecision(1)} ${unit}`
}

const makeGlow = workerCalls<GlowRequest, Uint8ClampedArray<ArrayBuffer>>(() => new GalaxyWorker())
/** Glow images by seed and size, least recently drawn first, kept within a memory budget. */
const glows = new Map<string, HTMLCanvasElement>()
const GLOW_BUDGET_BYTES = 48 * 2 ** 20
let glowBytes = 0
/** Glows whose stars have come back from the worker. */
const finished = new WeakSet<HTMLCanvasElement>()
/** Counts them, so a view knows to draw again. */
let glowsArrived = 0

/** Glow images to choose from: px square, and how many stars make them (one size, one count, so one image per size). */
const GLOW_SMALL = { size: 64, stars: 1_200 }
const GLOW_MEDIUM = { size: 256, stars: 20_000 }
const GLOW_LARGE = { size: 1024, stars: 90_000 }

/** A galaxy's glow at `coarse`, or at `sharp` once that one is finished (asking for it). */
function glowOf(shape: GalaxyShape, seed: number, coarse: typeof GLOW_SMALL, sharp?: typeof GLOW_SMALL): HTMLCanvasElement {
  const fine = sharp && galaxyGlow(shape, seed, sharp.size, sharp.stars)
  return fine && finished.has(fine) ? fine : galaxyGlow(shape, seed, coarse.size, coarse.stars)
}

/**
 * A galaxy's glow from `count` of its stars, `size` px square: its bright
 * bulge at once, its stars added when the worker has scattered them.
 */
function galaxyGlow(shape: GalaxyShape, seed: number, size: number, count: number): HTMLCanvasElement {
  const key = `${seed}:${size}`
  const cached = glows.get(key)
  if (cached) {
    glows.delete(key)
    glows.set(key, cached)
    return cached
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const half = size / 2
  // The bulge's glow, kept inside the image so its edges never show.
  const bulge = ctx.createRadialGradient(half, half, 0, half, half, Math.min(half, half * shape.bulge * 2.2))
  bulge.addColorStop(0, 'rgba(255,240,215,0.9)')
  bulge.addColorStop(1, 'rgba(255,220,180,0)')
  ctx.fillStyle = bulge
  ctx.beginPath()
  ctx.arc(half, half, half, 0, Math.PI * 2)
  ctx.fill()
  makeGlow({ shape, seed, size, count }).then(
    (pixels) => {
      const layer = document.createElement('canvas')
      layer.width = layer.height = size
      layer.getContext('2d')!.putImageData(new ImageData(pixels, size), 0, 0)
      ctx.globalCompositeOperation = 'lighter'
      ctx.drawImage(layer, 0, 0)
      finished.add(canvas)
      glowsArrived++
    },
    // Without its stars the glow is just the bulge; asking again next time it's drawn.
    () => glows.delete(key)
  )
  glows.set(key, canvas)
  glowBytes += size * size * 4
  for (const [k, old] of glows) {
    if (glowBytes <= GLOW_BUDGET_BYTES) break
    glows.delete(k)
    glowBytes -= old.width * old.height * 4
  }
  return canvas
}

/** Star glows by colour (masses in quarter steps of log₂), each drawn once and stamped for every star of that colour. */
const starSprites = new Map<number, HTMLCanvasElement>()
const SPRITE_PX = 32

function starSprite(massSun: number): HTMLCanvasElement {
  const step = Math.round(Math.log2(massSun) * 4)
  let sprite = starSprites.get(step)
  if (!sprite) {
    sprite = document.createElement('canvas')
    sprite.width = sprite.height = SPRITE_PX
    // The glow reaches three radii out: the sprite's edge.
    starGlow(sprite.getContext('2d')!, SPRITE_PX / 2, SPRITE_PX / 2, SPRITE_PX / 6, starColour(massSun))
    starSprites.set(step, sprite)
  }
  return sprite
}

/** Stars as points of light: bigger for heavier (brighter) stars, and a little bigger close in. */
const starRadius = (massSun: number, upp: number) => (0.8 + 0.6 * Math.min(5, massSun ** 0.4)) * (upp < 8 ? 1.5 : 1)

/** Stars this heavy are bright enough to show spikes: among single stars close up, and among a galaxy's landmark giants. */
const SPIKED_MASS = 6
const SPIKED_LANDMARK = 14

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, massSun: number, hovered: boolean, spikeFrom = SPIKED_MASS) {
  const glow = r * 2.6
  ctx.drawImage(starSprite(massSun), x - glow, y - glow, glow * 2, glow * 2)
  if (massSun >= spikeFrom) starSpikes(ctx, x, y, r * (3 + Math.min(6, massSun / 3)), hexRgb(starColour(massSun)), 0.45)
  if (hovered) ring(ctx, x, y, r + 5, '#ffffff', 1.2)
}

/** A star's colour by its mass (in the same quarter steps as its sprite). */
const starColour = (massSun: number) => starInfo({ massSun: 2 ** (Math.round(Math.log2(massSun) * 4) / 4), luminositySun: null }).color

interface DrawInput {
  kind: CosmosKind
  node: SpatialNode
  shape: GalaxyShape | undefined
  /** The cosmic web's filaments, for the universe. */
  web: [number, number, number, number][]
  /** How far the level's things reach from its middle, in its units. */
  extent: number
  items: Item[]
  claimedSeeds: Set<number>
  cam: Camera
  /** Each star cell's stars, generated once. */
  cells: Map<string, Item[]>
  hoverKey: string | null
}

/** Maps level units to the screen for a camera. */
interface Screen {
  sx: (x: number) => number
  sy: (y: number) => number
  onScreen: (x: number, y: number, r: number) => boolean
}

function drawLevel(ctx: CanvasRenderingContext2D, w: number, h: number, d: DrawInput): Hit[] {
  const { cam } = d
  const screen: Screen = {
    sx: (x) => w / 2 + (x - cam.x) / cam.upp,
    sy: (y) => h / 2 + (y - cam.y) / cam.upp,
    onScreen: (x, y, r) => x > -r && x < w + r && y > -r && y < h + r
  }
  spaceBackdrop(ctx, w, h, d.node.seed, d.kind === 'universe' ? { stars: 220, nebula: 0.8 } : d.kind === 'galaxy_cluster' ? { stars: 320, nebula: 0.55 } : { stars: 320, nebula: 0.4 })
  const hits: Hit[] = []
  if (d.kind === 'universe') drawFilaments(ctx, d.web.map(([x0, y0, x1, y1]) => [screen.sx(x0), screen.sy(y0), screen.sx(x1), screen.sy(y1)]), Math.max(1, 25 / cam.upp), d.node.seed)
  if (d.kind === 'galaxy_cluster') clusterGas(ctx, screen.sx(0), screen.sy(0), (d.extent * 1.1) / cam.upp, d.node.seed)
  if (d.shape) drawGalaxy(ctx, w, h, d, d.shape, screen, hits)
  drawItems(ctx, d, screen, hits)
  return hits
}

/** The galaxy in view: its glow, and close enough, the single stars of the cells in view. */
function drawGalaxy(ctx: CanvasRenderingContext2D, w: number, h: number, d: DrawInput, shape: GalaxyShape, { sx, sy, onScreen }: Screen, hits: Hit[]) {
  const { cam } = d
  // A sharper glow when zoomed in, fading out as single stars take over,
  // leaving a faint wash as thick as the galaxy is where you're looking.
  const fade = Math.min(1, Math.max(0, (cam.upp - MIN_UPP.galaxy) / 40))
  if (fade > 0) {
    const span = (shape.radiusLy * 2 * GLOW_REACH) / cam.upp
    const img = glowOf(shape, d.node.seed, GLOW_MEDIUM, span > 900 ? GLOW_LARGE : undefined)
    ctx.globalAlpha = fade
    ctx.drawImage(img, sx(-shape.radiusLy * GLOW_REACH), sy(-shape.radiusLy * GLOW_REACH), span, span)
    ctx.globalAlpha = 1
  }
  if (fade < 1) {
    // Where you're looking: gold toward the old middle, blue out in the arms.
    const dense = galaxyDensity(shape, cam.x, cam.y)
    const wash = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2)
    const tint = dense > 0.6 ? '255,214,160' : '140,170,255'
    wash.addColorStop(0, `rgba(${tint},${(0.16 * (1 - fade) * dense).toFixed(3)})`)
    wash.addColorStop(1, `rgba(${tint},${(0.06 * (1 - fade) * dense).toFixed(3)})`)
    ctx.fillStyle = wash
    ctx.fillRect(0, 0, w, h)
  }
  const cells = cellsIn(cam.x - (w / 2) * cam.upp, cam.y - (h / 2) * cam.upp, cam.x + (w / 2) * cam.upp, cam.y + (h / 2) * cam.upp, 220)
  // Clouds where stars are being born, in the arms more than the old middle.
  if (cells && shape.type !== 'elliptical') {
    for (const [cx, cy] of cells) {
      const r = rng(cellSeed(d.node.seed, cx, cy) ^ 0x4e8b)
      const dense = galaxyDensity(shape, (cx + 0.5) * STAR_CELL_LY, (cy + 0.5) * STAR_CELL_LY)
      if (r() > dense * (1 - dense) * 0.9) continue
      const x = sx((cx + r()) * STAR_CELL_LY)
      const y = sy((cy + r()) * STAR_CELL_LY)
      const radius = ((120 + r() * 380) / cam.upp) * (1 - fade * 0.5)
      if (onScreen(x, y, radius)) starCloud(ctx, x, y, radius, r() < 0.7, 0.16)
    }
  }
  for (const [cx, cy] of cells ?? []) {
    const key = `${cx}:${cy}`
    let list = d.cells.get(key)
    if (!list) {
      d.cells.set(key, (list = cellStars(shape, d.node.seed, cx, cy).map((s) => generatedItem(s, { massSun: s.massSun }))))
      if (d.cells.size > 3000) d.cells.delete(d.cells.keys().next().value!)
    }
    for (const item of list) {
      if (d.claimedSeeds.has(item.seed)) continue
      const x = sx(item.x)
      const y = sy(item.y)
      if (!onScreen(x, y, 4)) continue
      const r = starRadius(item.massSun!, cam.upp)
      drawStar(ctx, x, y, r, item.massSun!, item.key === d.hoverKey)
      hits.push({ item, x, y, r: r + 3 })
    }
  }
}

/** The level's own things and its generated landmarks: clusters, galaxies or star systems. */
function drawItems(ctx: CanvasRenderingContext2D, d: DrawInput, { sx, sy, onScreen }: Screen, hits: Hit[]) {
  const { cam } = d
  for (const item of d.items) {
    const x = sx(item.x)
    const y = sy(item.y)
    const hovered = item.key === d.hoverKey
    let r: number
    if (item.cluster || (d.kind === 'universe' && item.node)) {
      r = Math.max(7, (item.cluster?.sizeMly ?? 14) / 2 / cam.upp)
      if (!onScreen(x, y, r)) continue
      ctx.drawImage(clusterSprite(item.seed), x - r * 1.4, y - r * 1.4, r * 2.8, r * 2.8)
    } else if (item.galaxy) {
      r = Math.max(6, ((item.galaxy.radiusLy / 1e6) * GALAXY_SCALE) / cam.upp)
      if (!onScreen(x, y, r)) continue
      // Small on screen, a small image is plenty; a little bigger, enough to show its arms.
      const img = glowOf(item.galaxy, item.seed, GLOW_SMALL, r * 2 * GLOW_REACH > 36 ? GLOW_MEDIUM : undefined)
      ctx.drawImage(img, x - r * GLOW_REACH, y - r * GLOW_REACH, r * 2 * GLOW_REACH, r * 2 * GLOW_REACH)
    } else {
      // A star system: the star it claimed, or a generated landmark star.
      const mass = item.massSun ?? 1
      r = starRadius(mass, cam.upp) + (item.node ? 1.5 : 0)
      if (!onScreen(x, y, r)) continue
      drawStar(ctx, x, y, r, mass, hovered, item.node ? SPIKED_MASS : SPIKED_LANDMARK)
    }
    if (item.node) ring(ctx, x, y, r + 4, 'rgba(140,200,255,0.75)', 1.5)
    // Your own things are always named; generated ones when they're big enough to matter, or under the cursor.
    if (item.node || hovered || r > 30) label(ctx, item.name, x, y + r + 15, hovered || !!item.node)
    hits.push({ item, x, y, r: r + 4 })
  }
}
