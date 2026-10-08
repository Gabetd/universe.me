import type { NodeKind, Vec3 } from '@universe/core'
import { clamp } from './math'
import { rng, subSeed } from './random'
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

export const nameFor = (seed: number) => randomSeedName(rng(subSeed(seed, 0x4e41)))

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

/** Into the galaxy's own frame: unturned and unsquashed, in units of its radius. */
function galaxyFrame(shape: GalaxyShape, x: number, y: number): [number, number] {
  const c = Math.cos(-shape.angle)
  const s = Math.sin(-shape.angle)
  return [(x * c - y * s) / shape.radiusLy, (x * s + y * c) / shape.radiusLy / shape.flatten]
}

/**
 * How crowded with stars a point of the galaxy is, 0–1: a bright centre
 * fading outward, and for spirals, the arms (and the bar of a barred
 * spiral). Irregulars are patchy.
 */
export function galaxyDensity(shape: GalaxyShape, x: number, y: number): number {
  const [u, v] = galaxyFrame(shape, x, y)
  const r = Math.hypot(u, v)
  if (r > 1.15) return 0
  const core = Math.exp(-(r * r) / (2 * shape.bulge * shape.bulge))
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
  const arm = Math.exp(-((off * 4) ** 2)) * smoothRise(r, 0.08, 0.3)
  const bar = shape.type === 'barred' ? Math.exp(-((v / 0.05) ** 2)) * (Math.abs(u) < 0.3 ? 1 : 0) : 0
  return clamp(core * 0.95 + disc * (0.18 + 0.82 * arm) + bar * 0.6, 0, 1)
}

const smoothRise = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
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
  const r = rng(subSeed(galaxySeed ^ Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663), 0x57a2))
  const count = Math.floor(density * STARS_PER_CELL + r())
  return Array.from({ length: count }, (_, i) => {
    const seed = subSeed(galaxySeed ^ Math.imul(cx, 2654435761) ^ Math.imul(cy, 40503), i + 1)
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
  const out: ProcStar[] = []
  for (let tries = 0; out.length < count && tries < count * 40; tries++) {
    const x = (r() * 2 - 1) * shape.radiusLy
    const y = (r() * 2 - 1) * shape.radiusLy
    if (r() > galaxyDensity(shape, x, y)) continue
    const seed = subSeed(galaxySeed, 0x10000 + out.length)
    out.push({ seed, name: nameFor(seed), x, y, massSun: 2 + r() * 14 })
  }
  return out
}

/** Points scattered as a galaxy's stars fall, for drawing its glow. */
export function galaxyParticles(shape: GalaxyShape, seed: number, count: number): Float32Array {
  const r = rng(subSeed(seed, 0x9a17))
  const out = new Float32Array(count * 3)
  let n = 0
  for (let tries = 0; n < count && tries < count * 30; tries++) {
    const x = (r() * 2 - 1) * shape.radiusLy * 1.1
    const y = (r() * 2 - 1) * shape.radiusLy * 1.1
    const d = galaxyDensity(shape, x, y)
    if (r() > d) continue
    out[n * 3] = x
    out[n * 3 + 1] = y
    out[n * 3 + 2] = d
    n++
  }
  return out.subarray(0, n * 3)
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

/** Clusters of a universe, in Mly, strung along filaments (the cosmic web). */
export function universeClusters(universeSeed: number, count = 48): ProcCluster[] {
  const r = rng(subSeed(universeSeed, 0xc105))
  const knots = Array.from({ length: 9 }, () => [(r() * 2 - 1) * 4000, (r() * 2 - 1) * 2600] as const)
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
  const r = rng(subSeed(universeSeed, 0xc105))
  const knots = Array.from({ length: 9 }, () => [(r() * 2 - 1) * 4000, (r() * 2 - 1) * 2600] as const)
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

/** How big each level is, in its own units: how far out its view goes. */
export const LEVEL_EXTENT: Partial<Record<NodeKind, number>> = { universe: 5000, galaxy_cluster: 12, galaxy: 80_000 }

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
    for (let k = 0; k < 200; k++) {
      const px = (r() * 2 - 1) * shape.radiusLy * 0.8
      const py = (r() * 2 - 1) * shape.radiusLy * 0.8
      if (r() < galaxyDensity(shape, px, py)) return { x: px, y: py }
    }
    return { x: Math.cos(a) * shape.radiusLy * 0.3, y: Math.sin(a) * shape.radiusLy * 0.3 }
  }
  const extent = (parent && LEVEL_EXTENT[parent.kind]) ?? 1
  const d = extent * (0.15 + r() * 0.45)
  return { x: Math.cos(a) * d, y: Math.sin(a) * d * 0.7 }
}
