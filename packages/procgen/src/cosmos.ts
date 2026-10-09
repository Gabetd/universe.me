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
  // Into the galaxy's own frame: unturned and unsquashed, in units of its radius.
  const c = Math.cos(-shape.angle) / shape.radiusLy
  const s = Math.sin(-shape.angle) / shape.radiusLy
  const squash = 1 / shape.flatten
  const spread = 2 * shape.bulge * shape.bulge
  return (x, y) => {
    const u = x * c - y * s
    const v = (x * s + y * c) * squash
    const r = Math.hypot(u, v)
    if (r > 1.15) return 0
    const core = Math.exp(-(r * r) / spread)
    const disc = Math.exp(-r * 3.2)
    if (shape.type === 'elliptical') return clamp(core * 0.9 + disc * 0.3, 0, 1)
    if (shape.type === 'irregular') {
      const patch = 0.5 + 0.5 * Math.sin(u * 9.1 + Math.sin(v * 7.3) * 2) * Math.cos(v * 8.7 - u * 3)
      return clamp(disc * patch * 1.3 + core * 0.3, 0, 1)
    }
    // Distance from the nearest arm, as an angle: arms are logarithmic spirals.
    const theta = Math.atan2(v, u)
    const along = Math.log(Math.max(r, 0.02)) * shape.twist
    const phase = (((theta - along) * shape.arms) / TAU) % 1
    const off = Math.min(Math.abs(phase - Math.round(phase)), 1)
    const arm = Math.exp(-((off * 4) ** 2)) * smoothstep(0.08, 0.3, r)
    const bar = shape.type === 'barred' ? Math.exp(-((v / 0.05) ** 2)) * (Math.abs(u) < 0.3 ? 1 : 0) : 0
    return clamp(core * 0.95 + disc * (0.18 + 0.82 * arm) + bar * 0.6, 0, 1)
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
export function landmarkStars(shape: GalaxyShape, galaxySeed: number, count = 160): ProcStar[] {
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
  const density = densityField(shape)
  // Light added up, premultiplied, the way stars drawn over each other add up.
  const sum = new Float32Array(size * size * 4)
  const half = size / 2
  const k = half / (shape.radiusLy * GLOW_REACH)
  const dot = Math.max(1, Math.round(size / 512))
  const young = shape.hue > 180 ? [120, 168, 255] : [140, 200, 255]
  const disc = shape.type !== 'elliptical'
  const add = (px: number, py: number, spread: number, cr: number, cg: number, cb: number, a: number) => {
    for (let dy = 0; dy < spread; dy++) {
      for (let dx = 0; dx < spread; dx++) {
        const x = px + dx
        const y = py + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const o = (y * size + x) * 4
        sum[o] = sum[o]! + cr * a
        sum[o + 1] = sum[o + 1]! + cg * a
        sum[o + 2] = sum[o + 2]! + cb * a
        sum[o + 3] = sum[o + 3]! + a
      }
    }
  }
  for (let n = 0, tries = 0; n < count && tries < count * 30; tries++) {
    const p = tryStarPoint(shape, density, r, 1.1)
    if (!p) continue
    n++
    const px = Math.floor(half + p.x * k)
    const py = Math.floor(half + p.y * k)
    if (p.d > 0.6) add(px, py, dot, 255, 214, 160, 0.17)
    // Out in a disc's arms, now and then a knot of newborn stars lit pink by their gas.
    else if (disc && p.d > 0.25 && r() < 0.03) add(px - dot, py - dot, dot * 3, 255, 120, 175, 0.12)
    else add(px, py, dot, young[0]!, young[1]!, young[2]!, 0.14)
  }
  const out = new Uint8ClampedArray(size * size * 4)
  for (let o = 0; o < out.length; o += 4) {
    const a = Math.min(1, sum[o + 3]!)
    if (!a) continue
    out[o] = Math.min(255, sum[o]!) / a
    out[o + 1] = Math.min(255, sum[o + 1]!) / a
    out[o + 2] = Math.min(255, sum[o + 2]!) / a
    out[o + 3] = a * 255
  }
  return out
}

/** Galaxies of a cluster, in Mly from its centre. */
export function clusterGalaxies(clusterSeed: number, count = 36): ProcGalaxy[] {
  const r = rng(subSeed(clusterSeed, 0x6c57))
  return Array.from({ length: count }, (_, i) => {
    const seed = subSeed(clusterSeed, 0x200 + i)
    // Crowded toward the middle, like real clusters.
    const d = 9 * r() ** 1.6
    const a = r() * TAU
    return { seed, name: nameFor(seed), x: Math.cos(a) * d, y: Math.sin(a) * d * 0.8, shape: galaxyShape(seed) }
  })
}

/** Where the cosmic web's filaments meet, the first draws of a universe's generator: clusters and filaments both start here. */
const webKnots = (r: () => number) => Array.from({ length: 9 }, () => [(r() * 2 - 1) * 4000, (r() * 2 - 1) * 2600] as const)

/** Clusters of a universe, in Mly, strung along filaments (the cosmic web). */
export function universeClusters(universeSeed: number, count = 48): ProcCluster[] {
  const r = rng(subSeed(universeSeed, 0xc105))
  const knots = webKnots(r)
  return Array.from({ length: count }, (_, i) => {
    const seed = subSeed(universeSeed, 0x300 + i)
    // Somewhere along a filament between two knots of the web.
    const a = knots[Math.floor(r() * knots.length)]!
    const b = knots[Math.floor(r() * knots.length)]!
    const t = r()
    const jitter = 160
    return { seed, name: nameFor(seed), x: a[0] + (b[0] - a[0]) * t + (r() - 0.5) * jitter, y: a[1] + (b[1] - a[1]) * t + (r() - 0.5) * jitter, sizeMly: 8 + r() * 22 }
  })
}

/** The filaments the clusters lie along, as line segments, for drawing the cosmic web. */
export function cosmicWeb(universeSeed: number): [number, number, number, number][] {
  const knots = webKnots(rng(subSeed(universeSeed, 0xc105)))
  // Each knot joins its two nearest; a pair that chose each other is one filament.
  const pairs = new Set<string>()
  knots.forEach((a, i) => {
    knots
      .map((b, j) => ({ j, d: Math.hypot(a[0] - b[0], a[1] - b[1]) }))
      .filter((x) => x.j !== i)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2)
      .forEach(({ j }) => pairs.add(`${Math.min(i, j)}:${Math.max(i, j)}`))
  })
  return [...pairs].map((key) => {
    const [i, j] = key.split(':').map(Number) as [number, number]
    return [knots[i]![0], knots[i]![1], knots[j]![0], knots[j]![1]]
  })
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
