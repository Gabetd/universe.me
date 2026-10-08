import { MATERIAL_INFO, type Blueprint, type BlueprintPart, type Stage } from '@universe/core'

/** One colour per condition stage, for map markers and the inspector. */
export const STAGE_COLORS: Record<Stage, string> = {
  pristine: '#6fd39a',
  worn: '#b7d36f',
  weathered: '#e3c25b',
  damaged: '#e8914f',
  ruin: '#d9604f',
  remnant: '#8c6f66',
  destroyed: '#555b6e'
}

/** The largest footprint or height of a blueprint, in metres. */
export function blueprintExtent(b: Blueprint): number {
  if (b.model) return b.model.heightM
  let extent = 1
  for (const p of b.parts) extent = Math.max(extent, Math.abs(p.at[0]) * 2 + p.size[0], Math.abs(p.at[2]) * 2 + p.size[2], p.at[1] + p.size[1])
  return extent
}

/** How far back to stand to see a whole structure up close, in metres. */
export const viewingDistance = (b: Blueprint, scale: number) => Math.max(40, blueprintExtent(b) * scale * 1.4)

/**
 * The parts still standing at a condition. Parts are ranked from most fragile
 * (shortest-lived material, then highest up) to sturdiest; the most fragile
 * falls when the structure becomes Damaged (45), the rest at evenly lower
 * conditions, and the sturdiest stays to the end. A part resting on others
 * falls once nothing under it stands, so nothing is left floating.
 */
export function standingParts(parts: BlueprintPart[], condition: number): BlueprintPart[] {
  if (condition >= 45 || parts.length < 2) return parts
  const order = parts.map((_, i) => i).sort((a, b) => MATERIAL_INFO[parts[a]!.material].halfLifeYears - MATERIAL_INFO[parts[b]!.material].halfLifeYears || parts[b]!.at[1] - parts[a]!.at[1])
  const fallen = new Array<boolean>(parts.length).fill(false)
  order.forEach((i, rank) => (fallen[i] = condition < 45 * (1 - rank / (parts.length - 1))))
  const supporters = supportsOf(parts)
  for (const i of bottomUp(parts)) {
    const under = supporters[i]!
    if (under.length && under.every((j) => fallen[j])) fallen[i] = true
  }
  return parts.filter((_, i) => !fallen[i])
}

const radius = (p: BlueprintPart) => Math.hypot(p.size[0], p.size[2]) / 2
const supportCache = new WeakMap<BlueprintPart[], number[][]>()
const orderCache = new WeakMap<BlueprintPart[], number[]>()

function bottomUp(parts: BlueprintPart[]): number[] {
  let order = orderCache.get(parts)
  if (!order) orderCache.set(parts, (order = parts.map((_, i) => i).sort((a, b) => parts[a]!.at[1] - parts[b]!.at[1])))
  return order
}

/**
 * For each part, the parts it rests on: lower parts whose top reaches its
 * base and whose footprint overlaps it. Parts on the ground rest on nothing.
 * Worked out once per blueprint, with a grid so a city's thousands of parts
 * only compare with their neighbours.
 */
function supportsOf(parts: BlueprintPart[]): number[][] {
  const cached = supportCache.get(parts)
  if (cached) return cached
  const CELL = 16
  const grid = new Map<string, number[]>()
  const cells = (p: BlueprintPart) => {
    const r = radius(p)
    const keys: string[] = []
    for (let x = Math.floor((p.at[0] - r) / CELL); x <= Math.floor((p.at[0] + r) / CELL); x++) {
      for (let z = Math.floor((p.at[2] - r) / CELL); z <= Math.floor((p.at[2] + r) / CELL); z++) keys.push(`${x},${z}`)
    }
    return keys
  }
  parts.forEach((p, i) => cells(p).forEach((k) => grid.set(k, [...(grid.get(k) ?? []), i])))
  const supports = parts.map((p, i) => {
    if (p.at[1] < 0.5) return []
    const near = new Set(cells(p).flatMap((k) => grid.get(k) ?? []))
    return [...near].filter((j) => {
      const q = parts[j]!
      return j !== i && q.at[1] < p.at[1] && q.at[1] + q.size[1] >= p.at[1] - 0.6 && Math.hypot(q.at[0] - p.at[0], q.at[2] - p.at[2]) < radius(p) + radius(q)
    })
  })
  supportCache.set(parts, supports)
  return supports
}
