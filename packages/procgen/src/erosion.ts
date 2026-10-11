import { CUBE_FACES, TERRAIN_RES } from '@universe/core'
import { neighbours, PLANET_CELLS, type Hydrology } from './hydrology'

/**
 * Erosion over time (PLAN.md §9, M15): a world's land wearing down as the
 * playhead moves, rivers cutting valleys and steep slopes slumping. Worked out
 * once for a terrain as how deep each cell would wear down by, in the long
 * run (`erosionField`); how much of that has happened by a moment depends only
 * on the years since the timeline began and the world's erosion speed
 * (`erosionAt`), so it's the same every time and cheap to move through. Cells
 * the user has sculpted don't erode: their edits win.
 */

const CELLS = TERRAIN_RES * TERRAIN_RES

/** How fast valleys cut: metres in the long run per unit of √water × slope. */
const CUTTING = 3500
/** How much of a river's cut its valley sides share. */
const VALLEY = 0.35
/** How far a cell can stand above its neighbours' average before it slumps (metres), and how much of the excess goes. */
const TALUS = 120
const SLUMP = 0.5
/** The most any cell wears down by. */
const MAX_DEPTH = 450
/** Years for erosion to get about two-thirds of the way (at speed 1). */
const YEARS = 4000

export interface ErosionInput {
  /** Metres above sea level, per face. */
  heights: ArrayLike<number>[]
  water: Pick<Hydrology, 'flow' | 'receiver' | 'lakeLevel'>
  /** Whether the user has sculpted a cell (face, cell): those don't erode. */
  edited?: (face: number, cell: number) => boolean
  radiusKm: number
}

/** How deep each cell (per face) wears down by in the long run: rivers' valleys and slumped slopes; nothing at sea, under a lake or where sculpted. */
export function erosionField({ heights, water, edited, radiusKm }: ErosionInput): Float32Array[] {
  const N = PLANET_CELLS
  const h = new Float32Array(N)
  for (let f = 0; f < CUBE_FACES; f++) for (let c = 0; c < CELLS; c++) h[f * CELLS + c] = heights[f]![c]!
  const cellM = Math.sqrt((4 * Math.PI * radiusKm * radiusKm) / N) * 1000
  const keep = (g: number) => {
    if (h[g]! <= 0 || !Number.isNaN(water.lakeLevel[g]!)) return true
    const face = Math.floor(g / CELLS)
    return !!edited?.(face, g - face * CELLS)
  }

  // Rivers cut: more water and steeper ground cut deeper, but never below where the water goes.
  const cut = new Float32Array(N)
  for (let g = 0; g < N; g++) {
    if (keep(g)) continue
    const r = water.receiver[g]!
    const below = r >= 0 ? Math.max(0, h[r]!) : 0
    const drop = h[g]! - below
    if (drop <= 0) continue
    cut[g] = Math.min(drop * 0.6, CUTTING * Math.sqrt(water.flow[g]!) * (drop / cellM))
  }

  const around = new Int32Array(8)
  const depth = new Float32Array(N)
  for (let g = 0; g < N; g++) {
    if (keep(g)) continue
    const n = neighbours(g, around)
    let sum = 0
    let valley = 0
    for (let k = 0; k < n; k++) {
      const nb = around[k]!
      sum += h[nb]!
      valley = Math.max(valley, cut[nb]! * VALLEY)
    }
    // Slumping: a cell far above its neighbours comes down toward them.
    const slump = Math.max(0, h[g]! - sum / n - TALUS) * SLUMP
    // Land stays land: it wears down to a little above the sea at most.
    depth[g] = Math.min(MAX_DEPTH, Math.max(cut[g]!, valley) + slump, Math.max(0, h[g]! - 2))
  }
  return Array.from({ length: CUBE_FACES }, (_, f) => depth.slice(f * CELLS, (f + 1) * CELLS))
}

/** How much of the long-run erosion has happened `years` into the timeline at `speed` (the world's erosion speed): 0 at the start, nearing 1. */
export const erosionAt = (years: number, speed: number) => (years > 0 && speed > 0 ? 1 - Math.exp((-years * speed) / YEARS) : 0)

/** Erosion in steps (thirty-two of them), so moving the playhead redraws the land only when it's changed enough to see. */
export const erosionStep = (amount: number) => Math.round(amount * 32) / 32
