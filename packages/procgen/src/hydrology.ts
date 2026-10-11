import { CUBE_FACES, TERRAIN_RES, type LatLon } from '@universe/core'
import { cellCenter, cellDirections, dirToFace, dirToLatLon, faceToDir, nearestCell } from './cubesphere'
import { rng, subSeed } from './random'
import { randomSeedName } from './world-seed'

/**
 * Rivers and lakes (PLAN.md §9, M15): where the rain that falls on a world's
 * land runs to. Every cell drains to the sea, filling the basins it can't
 * leave (they're lakes) until it spills out of them; water gathers downhill,
 * and where enough has gathered it's a river. Pure, so the same terrain always
 * has the same rivers; run in a worker (it looks at every cell of the planet).
 *
 * Cells are numbered across the whole planet: face × TERRAIN_RES² + cell.
 */

const CELLS = TERRAIN_RES * TERRAIN_RES
export const PLANET_CELLS = CUBE_FACES * CELLS

/** How much a filled cell rises above the one it drains into, so even a filled basin runs somewhere. */
const FILL_STEP = 0.01
/** How far under the filled surface (metres) land is under a lake's water. */
const LAKE_DEPTH = 3
/** How deep (metres) a basin has to be somewhere, and how many cells it has to cover, to hold a lake; shallower hollows fill with the rivers running through them. */
const LAKE_MIN_DEPTH = 40
const LAKE_MIN_CELLS = 2
/** How much lake a basin's water keeps up, in cells per cell's worth of rain reaching it: the rest the sun takes. */
const LAKE_SHARE = 0.06
/** How much water (cells' worth of rain on wet land) makes a river. */
export const RIVER_FLOW = 15

export interface HydrologyInput {
  /** Metres above sea level, per face (TERRAIN_RES² cells each). */
  heights: ArrayLike<number>[]
  /** How wet each cell is (0–1), per face: wetter land gives more water. */
  moisture: ArrayLike<number>[]
  /** The world's seed, for the names. */
  seed: number
  radiusKm: number
}

export interface River {
  /** Stays the same while the river reaches the sea (or its lake, or the river it joins) at the same place. */
  id: string
  name: string
  /** Its cells (planet-wide numbers), from its source to its mouth; a tributary ends where it joins. */
  cells: number[]
  /** Where it runs, cell by cell, and on into the sea or lake it reaches (one point more than `cells` then). */
  points: LatLon[]
  /** Water through each point, in RIVER_FLOW units at the source and more downstream. */
  flow: number[]
  /** Where it ends: the sea, a lake (its id) or another river (its id). */
  into: { kind: 'sea' } | { kind: 'lake'; id: string } | { kind: 'river'; id: string }
  lengthKm: number
}

export interface Lake {
  id: string
  name: string
  cells: number[]
  /** Its surface, in metres above sea level. */
  level: number
  areaKm2: number
  /** Its middle, for a label. */
  center: LatLon
}

export interface Hydrology {
  /** Each cell's lake surface (metres above sea level), or NaN where there's no lake. */
  lakeLevel: Float32Array
  /** Water through each land cell. */
  flow: Float32Array
  /** Where each cell drains to (planet-wide number), or −1 for the sea. */
  receiver: Int32Array
  rivers: River[]
  lakes: Lake[]
}

/** A river's own water where it ends (a tributary's last point is where it joins another, so its own is the point before). */
export const mouthFlow = (r: River) => r.flow[r.flow.length - (r.into.kind === 'river' ? 2 : 1)]!

/** The neighbours across a face's edges, worked out once (inside a face they're just the next cells). */
let edgeNeighbours: Map<number, Int32Array> | undefined

function edgeNeighboursOf(face: number, i: number, j: number): Int32Array {
  const out = new Set<number>()
  const self = face * CELLS + j * TERRAIN_RES + i
  const step = 2 / TERRAIN_RES
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue
      const ni = i + di
      const nj = j + dj
      if (ni >= 0 && nj >= 0 && ni < TERRAIN_RES && nj < TERRAIN_RES) {
        out.add(face * CELLS + nj * TERRAIN_RES + ni)
        continue
      }
      // Off the face: a point a cell's width out, found on the face it's on.
      const d = faceToDir(face, cellCenter(i) + di * step, cellCenter(j) + dj * step)
      const p = dirToFace(d[0], d[1], d[2])
      const g = p.face * CELLS + nearestCell(p.s, p.t)
      if (g !== self) out.add(g)
    }
  }
  return Int32Array.from(out)
}

/** Fills `out` with cell `g`'s neighbours (eight, or seven at a cube corner); returns how many. */
export function neighbours(g: number, out: Int32Array): number {
  const face = Math.floor(g / CELLS)
  const cell = g - face * CELLS
  const i = cell % TERRAIN_RES
  const j = (cell - i) / TERRAIN_RES
  if (i > 0 && j > 0 && i < TERRAIN_RES - 1 && j < TERRAIN_RES - 1) {
    let n = 0
    for (let dj = -TERRAIN_RES; dj <= TERRAIN_RES; dj += TERRAIN_RES) for (let di = -1; di <= 1; di++) if (di || dj) out[n++] = g + dj + di
    return n
  }
  edgeNeighbours ??= new Map()
  let list = edgeNeighbours.get(g)
  if (!list) edgeNeighbours.set(g, (list = edgeNeighboursOf(face, i, j)))
  out.set(list)
  return list.length
}

/** A min-heap of cells by height. */
class CellHeap {
  private keys = new Float32Array(1024)
  private cells = new Int32Array(1024)
  size = 0

  push(key: number, cell: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float32Array(this.size * 2)
      keys.set(this.keys)
      const cells = new Int32Array(this.size * 2)
      cells.set(this.cells)
      this.keys = keys
      this.cells = cells
    }
    let k = this.size++
    while (k > 0) {
      const parent = (k - 1) >> 1
      if (this.keys[parent]! <= key) break
      this.keys[k] = this.keys[parent]!
      this.cells[k] = this.cells[parent]!
      k = parent
    }
    this.keys[k] = key
    this.cells[k] = cell
  }

  pop(): number {
    const top = this.cells[0]!
    const key = this.keys[--this.size]!
    const cell = this.cells[this.size]!
    let k = 0
    for (;;) {
      let child = 2 * k + 1
      if (child >= this.size) break
      if (child + 1 < this.size && this.keys[child + 1]! < this.keys[child]!) child++
      if (this.keys[child]! >= key) break
      this.keys[k] = this.keys[child]!
      this.cells[k] = this.cells[child]!
      k = child
    }
    this.keys[k] = key
    this.cells[k] = cell
    return top
  }
}

const nameOf = (seed: number, g: number, salt: number) => randomSeedName(rng(subSeed(seed ^ Math.imul(g, 0x9e3779b1), salt)))

/** Where a cell's centre is. */
function placeOf(g: number): LatLon {
  const face = Math.floor(g / CELLS)
  const c = (g - face * CELLS) * 3
  const dirs = cellDirections()[face]!
  return dirToLatLon(dirs[c]!, dirs[c + 1]!, dirs[c + 2]!)
}

/** Where every drop of rain on a world goes: its lakes and rivers (see the top of this file). */
export function hydrology({ heights, moisture, seed, radiusKm }: HydrologyInput): Hydrology {
  const N = PLANET_CELLS
  const h = new Float32Array(N)
  for (let f = 0; f < CUBE_FACES; f++) for (let c = 0; c < CELLS; c++) h[f * CELLS + c] = heights[f]![c]!
  const land = (g: number) => h[g]! > 0

  // Filling from the sea up: each cell, reached from the lowest one next to it, drains into that one.
  const filled = new Float32Array(N)
  const receiver = new Int32Array(N).fill(-1)
  const seen = new Uint8Array(N)
  const order = new Int32Array(N)
  const heap = new CellHeap()
  for (let g = 0; g < N; g++) {
    if (land(g)) continue
    seen[g] = 1
    filled[g] = h[g]!
    heap.push(h[g]!, g)
  }
  // A world without a sea drains to its lowest point.
  if (!heap.size) {
    let low = 0
    for (let g = 1; g < N; g++) if (h[g]! < h[low]!) low = g
    seen[low] = 1
    filled[low] = h[low]!
    heap.push(h[low]!, low)
  }
  const around = new Int32Array(8)
  let popped = 0
  while (heap.size) {
    const g = heap.pop()
    order[popped++] = g
    const n = neighbours(g, around)
    for (let k = 0; k < n; k++) {
      const nb = around[k]!
      if (seen[nb]) continue
      seen[nb] = 1
      filled[nb] = Math.max(h[nb]!, filled[g]! + FILL_STEP)
      receiver[nb] = g
      heap.push(filled[nb]!, nb)
    }
  }

  // Water: the rain on each land cell, carried down to the sea, upstream cells first. A basin that holds a lake with no outlet keeps what reaches it.
  const rain = (g: number) => {
    const face = Math.floor(g / CELLS)
    return 0.15 + moisture[face]![g - face * CELLS]!
  }
  const flow = new Float32Array(N)
  const gather = (keeps?: Uint8Array) => {
    flow.fill(0)
    for (let k = popped - 1; k >= 0; k--) {
      const g = order[k]!
      if (!land(g)) continue
      flow[g]! += rain(g)
      const r = receiver[g]!
      if (r >= 0 && land(r) && !(keeps?.[g] && !keeps[r])) flow[r]! += flow[g]!
    }
  }
  gather()

  // Basins: land under the filled surface. One holds a lake if it's deep enough and enough water reaches it to make up for what the sun takes:
  // filled to the brim (and spilling over) if there's plenty, else a smaller lake in its lowest part, with no outlet.
  const lakeLevel = new Float32Array(N).fill(NaN)
  const lakes: Lake[] = []
  const lakeOf = new Int32Array(N).fill(-1)
  const basinOf = new Int32Array(N).fill(-1)
  const keeps = new Uint8Array(N)
  const cellKm2 = (4 * Math.PI * radiusKm * radiusKm) / N
  for (let g = 0, basins = 0; g < N; g++) {
    if (!land(g) || basinOf[g]! >= 0 || filled[g]! - h[g]! <= LAKE_DEPTH) continue
    const cells: number[] = []
    const stack = [g]
    basinOf[g] = basins
    while (stack.length) {
      const c = stack.pop()!
      cells.push(c)
      const n = neighbours(c, around)
      for (let k = 0; k < n; k++) {
        const nb = around[k]!
        if (basinOf[nb]! < 0 && land(nb) && filled[nb]! - h[nb]! > LAKE_DEPTH) {
          basinOf[nb] = basins
          stack.push(nb)
        }
      }
    }
    basins++
    let rim = -Infinity
    let inflow = 0
    for (const c of cells) {
      rim = Math.max(rim, filled[c]!)
      inflow = Math.max(inflow, flow[c]!)
    }
    cells.sort((a, b) => h[a]! - h[b]! || a - b)
    // Named for its deepest cell, which stays put while the land round it changes.
    const deepest = cells[0]!
    const wet = Math.min(cells.length, Math.floor(inflow * LAKE_SHARE))
    if (rim - h[deepest]! < LAKE_MIN_DEPTH || wet < LAKE_MIN_CELLS) continue
    const water = cells.slice(0, wet)
    const brim = wet === cells.length
    const level = brim ? rim : h[cells[wet]!]!
    if (!brim) for (const c of cells) keeps[c] = 1
    for (const c of water) {
      lakeLevel[c] = level
      lakeOf[c] = lakes.length
    }
    lakes.push({ id: `l${deepest}`, name: `Lake ${nameOf(seed, deepest, 0x4c4b)}`, cells: water, level, areaKm2: Math.round(water.length * cellKm2), center: placeOf(deepest) })
  }
  // What a lake without an outlet keeps goes no further.
  if (keeps.some(Boolean)) gather(keeps)

  // Rivers: land (not lake) where enough water runs, each cell's upstream river cells linked to it.
  const river = (g: number) => land(g) && Number.isNaN(lakeLevel[g]!) && flow[g]! >= RIVER_FLOW
  const firstUp = new Int32Array(N).fill(-1)
  const nextUp = new Int32Array(N).fill(-1)
  const mouths: number[] = []
  for (let g = 0; g < N; g++) {
    if (!river(g)) continue
    const r = receiver[g]!
    if (r >= 0 && river(r)) {
      nextUp[g] = firstUp[r]!
      firstUp[r] = g
    } else mouths.push(g)
  }
  const kmPerCell = Math.sqrt(cellKm2)
  const rivers: River[] = []
  // From each mouth upstream, the biggest stream is the river itself; the others are tributaries, each a river of its own that ends where it joins.
  const starts: { g: number; into: River['into']; join?: number }[] = mouths.map((g) => {
    const r = receiver[g]!
    return { g, into: r >= 0 && lakeOf[r]! >= 0 ? { kind: 'lake', id: lakes[lakeOf[r]!]!.id } : { kind: 'sea' } }
  })
  while (starts.length) {
    const { g, into, join } = starts.pop()!
    const id = `r${g}`
    const path = [g]
    for (let cur = g; ; ) {
      let best = -1
      for (let up = firstUp[cur]!; up >= 0; up = nextUp[up]!) if (best < 0 || flow[up]! > flow[best]!) best = up
      if (best < 0) break
      for (let up = firstUp[cur]!; up >= 0; up = nextUp[up]!) if (up !== best) starts.push({ g: up, into: { kind: 'river', id }, join: cur })
      path.push(best)
      cur = best
    }
    path.reverse()
    if (join !== undefined) path.push(join)
    if (path.length < 2) continue
    const flows = path.map((c) => Math.round((flow[c]! / RIVER_FLOW) * 10) / 10)
    // Drawn on into the water it reaches, so it meets the shore.
    const outlet = into.kind === 'river' ? -1 : receiver[g]!
    rivers.push({
      id,
      name: nameOf(seed, g, 0x5256),
      cells: path,
      points: (outlet >= 0 ? [...path, outlet] : path).map(placeOf),
      flow: outlet >= 0 ? [...flows, flows.at(-1)!] : flows,
      into,
      lengthKm: Math.round((path.length - 1) * kmPerCell)
    })
  }
  // Biggest first: what's drawn on top, and listed first.
  rivers.sort((a, b) => mouthFlow(b) - mouthFlow(a) || (a.id < b.id ? -1 : 1))
  lakes.sort((a, b) => b.cells.length - a.cells.length || (a.id < b.id ? -1 : 1))
  return { lakeLevel, flow, receiver, rivers, lakes }
}
