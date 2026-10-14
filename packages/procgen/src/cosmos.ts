import type { NodeKind, Vec3 } from '@universe/core'
import { clamp, smoothstep } from './math'
import { cellSeed, rng, subSeed } from './random'
import { randomSeedName } from './world-seed'

/**
 * The universe above star systems (PLAN.md §4.1, §5.2): clusters in the
 * universe, galaxies in a cluster, stars in a galaxy, all generated from
 * their parent's seed and never stored, until someone claims one (a stored
 * node with the same seed, at the same place) or creates their own.
 *
 * Each level has its own units, so positions stay small numbers at every
 * scale: the universe and its clusters in millions of light years (Mly), a
 * galaxy in light years (ly).
 */

export type GalaxyType = 'spiral' | 'barred' | 'elliptical' | 'irregular'

export interface GalaxyShape {
  type: GalaxyType
  /** Light years from the centre to the edge of the disc. */
  radiusLy: number
  arms: number
  /** How tightly the arms wind. */
  twist: number
  /** Size of the bright centre, as a share of the radius. */
  bulge: number
  /** Ellipticals and tilted discs look squashed: height over width. */
  flatten: number
  /** Turns the whole galaxy, radians. */
  angle: number
  hue: number
}

/** A galaxy, star or cluster generated from its parent's seed: what claiming it stores. */
export interface Procedural {
  seed: number
  name: string
  /** In the parent's units (Mly for clusters and galaxies, ly for stars). */
  x: number
  y: number
}

export interface ProcStar extends Procedural {
  /** Solar masses: most stars are small red dwarfs, a few are bright giants. */
  massSun: number
}

export interface ProcGalaxy extends Procedural {
  shape: GalaxyShape
}

export interface ProcCluster extends Procedural {
  /** Mly across. */
  sizeMly: number
}

const TAU = Math.PI * 2

const nameFor = (seed: number) => randomSeedName(rng(subSeed(seed, 0x4e41)))

export function galaxyShape(seed: number): GalaxyShape {
  const r = rng(subSeed(seed, 0x6a1a))
  const roll = r()
  const type: GalaxyType = roll < 0.45 ? 'spiral' : roll < 0.7 ? 'barred' : roll < 0.9 ? 'elliptical' : 'irregular'
  return {
    type,
    radiusLy: 20_000 + r() * 60_000,
    arms: type === 'barred' ? 2 : 2 + Math.floor(r() * 3),
    twist: 2.2 + r() * 2.5,
    bulge: type === 'elliptical' ? 0.9 : 0.12 + r() * 0.12,
    flatten: type === 'elliptical' ? 0.55 + r() * 0.4 : 0.85 + r() * 0.15,
    angle: r() * TAU,
    hue: Math.floor(r() * 360)
  }
}

/**
 * How crowded with stars each point of the galaxy is, 0–1: a bright centre
 * fading outward, and for spirals, the arms (and the bar of a barred
 * spiral). Irregulars are patchy. Worked out once per shape, for the
 * generators that ask about thousands of points.
 */
export function densityField(shape: GalaxyShape): (x: number, y: number) => number {
  const frame = galaxyFrame(shape)
  const spread = 2 * shape.bulge * shape.bulge
  return (x, y) => {
    const { u, v, r } = frame(x, y)
    if (r > 1.15) return 0
    const core = Math.exp(-(r * r) / spread)
    const disc = Math.exp(-r * 3.2)
    if (shape.type === 'elliptical') return clamp(core * 0.9 + disc * 0.3, 0, 1)
    if (shape.type === 'irregular') {
      const patch = 0.5 + 0.5 * Math.sin(u * 9.1 + Math.sin(v * 7.3) * 2) * Math.cos(v * 8.7 - u * 3)
      return clamp(disc * patch * 1.3 + core * 0.3, 0, 1)
    }
    const off = Math.abs(armPhase(shape, u, v, r))
    const arm = Math.exp(-((off * 4) ** 2)) * smoothstep(0.08, 0.3, r)
    const bar = shape.type === 'barred' ? Math.exp(-((v / 0.05) ** 2)) * (Math.abs(u) < 0.3 ? 1 : 0) : 0
    return clamp(core * 0.95 + disc * (0.18 + 0.82 * arm) + bar * 0.6, 0, 1)
  }
}

/** A point in a galaxy's own frame: unturned and unsquashed, in units of its radius (`r` from its centre). */
function galaxyFrame(shape: GalaxyShape): (x: number, y: number) => { u: number; v: number; r: number } {
  const c = Math.cos(-shape.angle) / shape.radiusLy
  const s = Math.sin(-shape.angle) / shape.radiusLy
  const squash = 1 / shape.flatten
  const out = { u: 0, v: 0, r: 0 }
  return (x, y) => {
    out.u = x * c - y * s
    out.v = (x * s + y * c) * squash
    out.r = Math.hypot(out.u, out.v)
    return out
  }
}

/** How far round from the nearest spiral arm a point is, −0.5 to 0.5 of the gap between arms (arms are logarithmic spirals). */
function armPhase(shape: GalaxyShape, u: number, v: number, r: number): number {
  const along = Math.log(Math.max(r, 0.02)) * shape.twist
  const phase = (((Math.atan2(v, u) - along) * shape.arms) / TAU) % 1
  return phase - Math.round(phase)
}

/**
 * How much dust darkens each point of a disc galaxy, 0–1: lanes along the
 * inner edge of each arm, as in real spirals, and none in the bright core or
 * far out. Ellipticals have none.
 */
export function dustField(shape: GalaxyShape): (x: number, y: number) => number {
  if (shape.type === 'elliptical') return () => 0
  const frame = galaxyFrame(shape)
  return (x, y) => {
    const { u, v, r } = frame(x, y)
    if (r > 1 || r < 0.08) return 0
    const lane = shape.type === 'irregular' ? 0.5 + 0.5 * Math.sin(u * 13 + v * 5) * Math.sin(v * 11 - u * 4) : Math.exp(-(((armPhase(shape, u, v, r) + 0.11) * 9) ** 2))
    return lane * smoothstep(0.08, 0.3, r) * (1 - smoothstep(0.6, 1, r))
  }
}

/** The density at one point (see `densityField`). */
export const galaxyDensity = (shape: GalaxyShape, x: number, y: number) => densityField(shape)(x, y)

/** One try at a point within `spread` radii of a galaxy's centre, kept as often as stars crowd there. */
function tryStarPoint(shape: GalaxyShape, density: (x: number, y: number) => number, r: () => number, spread: number) {
  const x = (r() * 2 - 1) * shape.radiusLy * spread
  const y = (r() * 2 - 1) * shape.radiusLy * spread
  const d = density(x, y)
  return r() < d ? { x, y, d } : undefined
}

/** Light years on a side of a galaxy's star cells; stars are generated a cell at a time, as they come into view. */
export const STAR_CELL_LY = 600
/** Stars in the densest cells. */
const STARS_PER_CELL = 24

/** A star's mass: most are small red dwarfs, a few are bright giants. */
const starMass = (u: number) => 0.08 + 0.7 * u ** 3 + 18 * u ** 22

/** The stars generated in one cell of a galaxy. Same galaxy, same cell: the same stars. */
export function cellStars(shape: GalaxyShape, galaxySeed: number, cx: number, cy: number): ProcStar[] {
  const x0 = cx * STAR_CELL_LY
  const y0 = cy * STAR_CELL_LY
  const density = galaxyDensity(shape, x0 + STAR_CELL_LY / 2, y0 + STAR_CELL_LY / 2)
  const cell = cellSeed(galaxySeed, cx, cy)
  const r = rng(subSeed(cell, 0x57a2))
  const count = Math.floor(density * STARS_PER_CELL + r())
  return Array.from({ length: count }, (_, i) => {
    const seed = subSeed(cell, i + 1)
    return { seed, name: nameFor(seed), x: x0 + r() * STAR_CELL_LY, y: y0 + r() * STAR_CELL_LY, massSun: starMass(r()) }
  })
}

/** The cells a view of a galaxy covers, if not too many; undefined when zoomed too far out for single stars. */
export function cellsIn(x0: number, y0: number, x1: number, y1: number, max = 400): [number, number][] | undefined {
  const c0 = Math.floor(x0 / STAR_CELL_LY)
  const c1 = Math.floor(x1 / STAR_CELL_LY)
  const r0 = Math.floor(y0 / STAR_CELL_LY)
  const r1 = Math.floor(y1 / STAR_CELL_LY)
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > max) return undefined
  const out: [number, number][] = []
  for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) out.push([cx, cy])
  return out
}

/**
 * Bright landmark stars across a whole galaxy, shown when it's too far out
 * for single cells. They're stars like any other: they can be claimed.
 */
export function landmarkStars(shape: GalaxyShape, galaxySeed: number, count = 110): ProcStar[] {
  const r = rng(subSeed(galaxySeed, 0x1a4d))
  const density = densityField(shape)
  const out: ProcStar[] = []
  for (let tries = 0; out.length < count && tries < count * 40; tries++) {
    const p = tryStarPoint(shape, density, r, 1)
    if (!p) continue
    const seed = subSeed(galaxySeed, 0x10000 + out.length)
    out.push({ seed, name: nameFor(seed), x: p.x, y: p.y, massSun: 2 + r() * 14 })
  }
  return out
}

/** How much a galaxy's glow image shows past its radius. */
export const GLOW_REACH = 1.15

/**
 * A galaxy's stars as a `size`² RGBA image (not premultiplied), from `count`
 * of them scattered as they fall: old gold stars in the middle, young blue
 * ones out in the arms, and in a disc galaxy, pink knots where stars are
 * being born along the arms. The image spans GLOW_REACH radii each way. Pure
 * arithmetic, so it can be made off the UI thread.
 */
export function galaxyGlowPixels(shape: GalaxyShape, seed: number, size: number, count: number): Uint8ClampedArray<ArrayBuffer> {
  const r = rng(subSeed(seed, 0x9a17))
  const frame = galaxyFrame(shape)
  const density = densityField(shape)
  const dust = dustField(shape)
  const half = size / 2
  const k = half / (shape.radiusLy * GLOW_REACH)
  // Light added up, premultiplied: first the galaxy's smooth light pixel by pixel, then single stars and knots over it.
  const sum = new Float32Array(size * size * 4)
  const spread = 2 * shape.bulge * shape.bulge
  const disc = shape.type !== 'elliptical'
  // A grain of unresolved stars, finer the bigger the image.
  const grain = (x: number, y: number) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296
  }
  for (let py = 0, o = 0; py < size; py++) {
    for (let px = 0; px < size; px++, o += 4) {
      const x = (px + 0.5 - half) / k
      const y = (py + 0.5 - half) / k
      const { u, v, r: rr } = frame(x, y)
      if (rr > 1.2) continue
      const core = Math.exp(-(rr * rr) / spread)
      let light: number
      let young: number
      if (shape.type === 'elliptical') {
        light = core * 0.9 + Math.exp(-rr * 2.4) * 0.55
        young = 0
      } else if (shape.type === 'irregular') {
        light = density(x, y) * 0.9
        young = 0.7
      } else {
        // Sharp arms (sharper than where stars are counted), a bar across a barred spiral's middle, and the faint disc between.
        const off = Math.abs(armPhase(shape, u, v, rr))
        const arm = Math.exp(-((off * 6.5) ** 2)) * smoothstep(0.1, 0.3, rr) * (1 - smoothstep(0.92, 1.12, rr))
        const bar = shape.type === 'barred' ? Math.exp(-((v / 0.06) ** 2)) * (1 - smoothstep(0.22, 0.34, Math.abs(u))) : 0
        light = core * 1.05 + Math.exp(-rr * 2) * (0.08 + 1.35 * arm) + bar * 0.55
        young = arm
      }
      const g = 0.75 + 0.5 * grain(px, py)
      const lit = light * g * (1 - 0.65 * dust(x, y))
      if (lit <= 0.002) continue
      // Warm white where old stars crowd the middle, blue-white out along the arms.
      const warm = core / (core + young * 0.6 + 0.05)
      const [cr, cg, cb] = starTint(0.2 + warm * 0.8, grain(py, px))
      sum[o] = cr * lit
      sum[o + 1] = cg * lit
      sum[o + 2] = cb * lit
      sum[o + 3] = lit
    }
  }
  const add = (px: number, py: number, reach: number, cr: number, cg: number, cb: number, a: number) => {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = px + dx
        const y = py + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const w = a / (1 + 2 * (dx * dx + dy * dy))
        const o = (y * size + x) * 4
        sum[o] = sum[o]! + cr * w
        sum[o + 1] = sum[o + 1]! + cg * w
        sum[o + 2] = sum[o + 2]! + cb * w
        sum[o + 3] = sum[o + 3]! + w
      }
    }
  }
  // Single stars sparkling over it, and along a disc's arms, pink knots where stars are being born.
  const spot = size >= 512 ? 1 : 0
  for (let n = 0, tries = 0; n < count / 4 && tries < count * 8; tries++) {
    const p = tryStarPoint(shape, density, r, 1.05)
    if (!p) continue
    n++
    const px = Math.floor(half + p.x * k)
    const py = Math.floor(half + p.y * k)
    if (disc && p.d > 0.3 && p.d < 0.7 && r() < 0.05) add(px, py, spot + 1, 255, 110, 170, 0.35)
    else {
      const [cr, cg, cb] = starTint(p.d, r())
      add(px, py, spot, cr, cg, cb, 0.12 + r() * 0.25)
    }
  }
  const out = new Uint8ClampedArray(size * size * 4)
  for (let o = 0; o < out.length; o += 4) {
    const a = sum[o + 3]!
    if (!a) continue
    // Brightness rolls off rather than clipping, so the middle stays a glow, not a flat disc.
    out[o] = sum[o]! / a
    out[o + 1] = sum[o + 1]! / a
    out[o + 2] = sum[o + 2]! / a
    out[o + 3] = (1 - Math.exp(-a * 1.6)) * 255
  }
  return out
}

/** A star's colour by how crowded its part of the galaxy is (0–1), varied a little by `jitter` (0–1). */
function starTint(dense: number, jitter: number): [number, number, number] {
  const gold: [number, number, number] = [255, 226, 196]
  const white: [number, number, number] = [250, 240, 228]
  const blue: [number, number, number] = [128, 170, 255]
  const t = clamp(dense + (jitter - 0.5) * 0.25, 0, 1)
  const [a, b, f] = t > 0.55 ? [white, gold, (t - 0.55) / 0.45] : [blue, white, t / 0.55]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Galaxies of a cluster, in Mly from its centre. */
export function clusterGalaxies(clusterSeed: number, count = 36): ProcGalaxy[] {
  const r = rng(subSeed(clusterSeed, 0x6c57))
  const galaxies = Array.from({ length: count }, (_, i) => {
    const seed = subSeed(clusterSeed, 0x200 + i)
    // Crowded toward the middle, like real clusters.
    const d = 9 * r() ** 1.6
    const a = r() * TAU
    return { seed, name: nameFor(seed), x: Math.cos(a) * d, y: Math.sin(a) * d * 0.8, shape: galaxyShape(seed) }
  })
  // As drawn in a cluster (GALAXY_SCALE times life size, glow and all), none overlaps another.
  return spreadApart(galaxies, (g) => (g.shape.radiusLy / 1e6) * GALAXY_SCALE * GLOW_REACH, 0.15)
}

/** Galaxies are drawn larger than life in a cluster, or they'd be specks. */
export const GALAXY_SCALE = 8

/**
 * Pushes things apart until none overlaps another (each `radius` round, at
 * least `gap` between), moving each as little as it can: the same things in,
 * the same places out. For the few dozen a level generates.
 */
export function spreadApart<T extends { x: number; y: number }>(things: readonly T[], radius: (t: T) => number, gap: number): T[] {
  const out = things.map((t) => ({ ...t }))
  const radii = out.map(radius)
  for (let pass = 0; pass < 60; pass++) {
    let moved = false
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!
        const b = out[j]!
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d = Math.hypot(dx, dy)
        const need = radii[i]! + radii[j]! + gap
        if (d >= need) continue
        // Exactly on top of each other: apart along a direction of their own.
        if (d < 1e-9) [dx, dy, d] = [Math.cos(i * 2.399), Math.sin(i * 2.399), 1]
        const push = (need - d) / 2 + 1e-6
        a.x -= (dx / d) * push
        a.y -= (dy / d) * push
        b.x += (dx / d) * push
        b.y += (dy / d) * push
        moved = true
      }
    }
    if (!moved) break
  }
  return out
}

/** Where the cosmic web's filaments meet, the first draws of a universe's generator: clusters and filaments both start here. */
const webKnots = (r: () => number) => Array.from({ length: 9 }, () => [(r() * 2 - 1) * 4000, (r() * 2 - 1) * 2600] as const)

/** Clusters of a universe, in Mly, strung along filaments (the cosmic web). */
export function universeClusters(universeSeed: number, count = 48): ProcCluster[] {
  const r = rng(subSeed(universeSeed, 0xc105))
  const knots = webKnots(r)
  const clusters = Array.from({ length: count }, (_, i) => {
    const seed = subSeed(universeSeed, 0x300 + i)
    // Somewhere along a filament between two knots of the web.
    const a = knots[Math.floor(r() * knots.length)]!
    const b = knots[Math.floor(r() * knots.length)]!
    const t = r()
    const jitter = 160
    return { seed, name: nameFor(seed), x: a[0] + (b[0] - a[0]) * t + (r() - 0.5) * jitter, y: a[1] + (b[1] - a[1]) * t + (r() - 0.5) * jitter, sizeMly: 8 + r() * 22 }
  })
  // Each drawn 1.4 times its radius across: none overlaps another.
  return spreadApart(clusters, (c) => c.sizeMly * 0.7, 20)
}

/** How far out from its centre a level's view goes, in its own units (a galaxy's depends on its shape). */
export function levelExtent(kind: NodeKind, seed: number): number {
  return kind === 'universe' ? 5000 : kind === 'galaxy_cluster' ? 12 : kind === 'galaxy' ? galaxyShape(seed).radiusLy * 1.25 : 1
}

/**
 * Where a stored node sits in its parent's frame: its own position, or, for
 * one made before it had a place (all zero), somewhere decided by its seed.
 */
export function placeOf(node: { kind: NodeKind; seed: number; position: Vec3 }, parent?: { kind: NodeKind; seed: number }): { x: number; y: number } {
  const { x, y, z } = node.position
  if (x || y || z) return { x, y }
  const r = rng(subSeed(node.seed, 0x91ac))
  const a = r() * TAU
  if (parent?.kind === 'galaxy') {
    // On the disc, where its stars are.
    const shape = galaxyShape(parent.seed)
    const density = densityField(shape)
    for (let k = 0; k < 200; k++) {
      const p = tryStarPoint(shape, density, r, 0.8)
      if (p) return { x: p.x, y: p.y }
    }
    return { x: Math.cos(a) * shape.radiusLy * 0.3, y: Math.sin(a) * shape.radiusLy * 0.3 }
  }
  const extent = parent ? levelExtent(parent.kind, parent.seed) : 1
  const d = extent * (0.15 + r() * 0.45)
  return { x: Math.cos(a) * d, y: Math.sin(a) * d * 0.7 }
}

/** A constellation in a galaxy: a few of its bright landmark stars joined by lines, with a name. */
export interface Constellation {
  name: string
  /** The seeds of its stars (landmark stars, see `landmarkStars`). */
  stars: number[]
  /** Its lines, as pairs of those seeds. */
  links: [number, number][]
}

/**
 * Constellations among a galaxy's landmark stars: `count` of them, spread
 * across it (each started from a star far from the others' first), each
 * joining its 4 to 7 nearest unused stars by their shortest lines (a spanning
 * tree, so no line crosses another of its own), and one more line now and
 * then to close a shape. The same galaxy, the same constellations.
 */
export function galaxyConstellations(shape: GalaxyShape, galaxySeed: number, stars: readonly ProcStar[], count = 9): Constellation[] {
  const r = rng(subSeed(galaxySeed, 0xc057))
  const used = new Set<number>()
  const out: Constellation[] = []
  const anchors: ProcStar[] = []
  const reach = shape.radiusLy * 0.32
  for (let c = 0; c < count && used.size < stars.length; c++) {
    // The next one starts as far as it can from those before it.
    let first: ProcStar | undefined
    let far = -1
    for (const s of stars) {
      if (used.has(s.seed)) continue
      const d = anchors.length ? Math.min(...anchors.map((a) => Math.hypot(a.x - s.x, a.y - s.y))) : r()
      if (d > far) [far, first] = [d, s]
    }
    if (!first) break
    anchors.push(first)
    const size = 4 + Math.floor(r() * 4)
    const group = stars
      .filter((s) => !used.has(s.seed) && Math.hypot(s.x - first.x, s.y - first.y) < reach)
      .sort((a, b) => Math.hypot(a.x - first.x, a.y - first.y) - Math.hypot(b.x - first.x, b.y - first.y))
      .slice(0, size)
    if (group.length < 3) {
      used.add(first.seed)
      continue
    }
    // Prim's spanning tree: each star joins the nearest one already in.
    const links: [number, number][] = []
    const inTree = [group[0]!]
    const rest = group.slice(1)
    while (rest.length) {
      let best = { i: 0, from: inTree[0]!, d: Infinity }
      rest.forEach((s, i) => {
        for (const t of inTree) {
          const d = Math.hypot(s.x - t.x, s.y - t.y)
          if (d < best.d) best = { i, from: t, d }
        }
      })
      const [next] = rest.splice(best.i, 1)
      links.push([best.from.seed, next!.seed])
      inTree.push(next!)
    }
    // Now and then a shape is closed: the last star back to the first.
    if (group.length > 4 && r() < 0.4) links.push([group.at(-1)!.seed, group[0]!.seed])
    for (const s of group) used.add(s.seed)
    out.push({ name: nameFor(subSeed(galaxySeed, 0xc0 + c)), stars: group.map((s) => s.seed), links })
  }
  return out
}

/** What lies among a galaxy's stars besides them: clouds of glowing gas, dark dust, the shells of exploded stars, dying stars' rings and young clusters. */
export type GalaxyFeatureKind = 'emission' | 'reflection' | 'dark' | 'supernova' | 'planetary' | 'cluster'

export interface GalaxyFeature {
  kind: GalaxyFeatureKind
  seed: number
  x: number
  y: number
  radiusLy: number
}

/** How large each kind is, as a share of the galaxy's radius, from least to most: great complexes of gas and dust, seen from across the galaxy. */
const FEATURE_SIZE: Record<GalaxyFeatureKind, [number, number]> = {
  emission: [0.04, 0.15],
  reflection: [0.03, 0.08],
  dark: [0.05, 0.17],
  supernova: [0.02, 0.05],
  planetary: [0.01, 0.02],
  cluster: [0.015, 0.035]
}

/**
 * The nebulae and the rest of a galaxy (see GalaxyFeatureKind): glowing gas
 * and dark dust along a disc's arms where stars are born, supernova
 * remnants, planetary nebulae and clusters anywhere stars are; an elliptical
 * has only old things (no newborn stars' gas). The same galaxy, the same.
 */
export function galaxyFeatures(shape: GalaxyShape, galaxySeed: number, count = 70): GalaxyFeature[] {
  const r = rng(subSeed(galaxySeed, 0xfea7))
  const density = densityField(shape)
  const kinds: [GalaxyFeatureKind, number][] =
    shape.type === 'elliptical'
      ? [['planetary', 0.5], ['supernova', 0.25], ['cluster', 0.25]]
      : [['emission', 0.3], ['dark', 0.22], ['reflection', 0.14], ['cluster', 0.14], ['supernova', 0.12], ['planetary', 0.08]]
  const out: GalaxyFeature[] = []
  for (let tries = 0; out.length < count && tries < count * 60; tries++) {
    const p = tryStarPoint(shape, density, r, 1)
    if (!p) continue
    let pick = r()
    const kind = kinds.find(([, share]) => (pick -= share) < 0)?.[0] ?? kinds[0]![0]
    // Newborn stars' gas and dust lie in the arms, not the old crowded middle.
    if ((kind === 'emission' || kind === 'reflection' || kind === 'dark') && (p.d > 0.6 || p.d < 0.12)) continue
    const [lo, hi] = FEATURE_SIZE[kind]
    out.push({ kind, seed: subSeed(galaxySeed, 0xf000 + out.length), x: p.x, y: p.y, radiusLy: shape.radiusLy * (lo + (hi - lo) * r() ** 2) })
  }
  return out
}
