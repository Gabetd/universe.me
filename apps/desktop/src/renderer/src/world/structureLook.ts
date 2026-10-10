import { MATERIAL_INFO, type Blueprint, type BlueprintPart, type Material, type Stage } from '@universe/core'

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

/** The colour a structure's own colours fade toward as it ages. */
export const WEATHERED_COLOR = '#6b6455'
/** How far toward that a structure at `condition` (0–100) has faded: 0 new, about 0.65 a ruin. */
export const weatheringOf = (condition: number) => Math.min(0.65, (1 - condition / 100) * 0.8)
/** How tall a structure at `condition` stands, of its full height: ruins and remnants slump. */
export const slumpOf = (condition: number) => (condition < 20 ? 0.45 + 0.55 * (condition / 20) : 1)

/** A blueprint seen from far off: the box around it, in its own metres, in the colour of most of it. */
export interface Massing {
  width: number
  depth: number
  height: number
  color: string
}

const massings = new WeakMap<Blueprint, Massing>()

/** A blueprint's massing (worked out once per blueprint). */
export function blueprintMassing(b: Blueprint): Massing {
  let m = massings.get(b)
  if (m) return m
  if (b.model) m = { width: b.model.heightM * 0.5, depth: b.model.heightM * 0.5, height: b.model.heightM, color: '#7a7268' }
  else {
    let [x0, x1, z0, z1, top, most, color] = [0, 0, 0, 0, 1, -1, '#8a8278']
    for (const p of b.parts) {
      const [w, h, d] = p.size
      x0 = Math.min(x0, p.at[0] - w / 2)
      x1 = Math.max(x1, p.at[0] + w / 2)
      z0 = Math.min(z0, p.at[2] - d / 2)
      z1 = Math.max(z1, p.at[2] + d / 2)
      top = Math.max(top, p.at[1] + h)
      if (w * h * d > most) [most, color] = [w * h * d, p.color]
    }
    // About its middle, as the structure stands about its origin.
    m = { width: Math.max(1, 2 * Math.max(-x0, x1)), depth: Math.max(1, 2 * Math.max(-z0, z1)), height: top, color }
  }
  massings.set(b, m)
  return m
}

/** How far back to stand to see a whole structure up close, in metres. */
export const viewingDistance = (b: Blueprint, scale: number) => Math.max(40, blueprintExtent(b) * scale * 1.4)

/**
 * The parts still standing. With each material's own condition (the
 * condition engine works them out part by part), a material's parts fall
 * from the top down as it decays past Damaged (45): a thatched roof is gone
 * while the stone walls under it still stand. Without them (a preview with a
 * single condition), parts are ranked from most fragile (shortest-lived
 * material, then highest up) to sturdiest and fall in that order. Either
 * way, a part resting on others falls once nothing under it stands, so
 * nothing is left floating.
 */
export function standingParts(parts: BlueprintPart[], condition: number, materials?: Partial<Record<Material, number>>): BlueprintPart[] {
  const fallen = new Array<boolean>(parts.length).fill(false)
  if (materials) {
    const byMaterial = new Map<Material, number[]>()
    parts.forEach((p, i) => byMaterial.set(p.material, [...(byMaterial.get(p.material) ?? []), i]))
    for (const [material, list] of byMaterial) {
      const c = materials[material] ?? condition
      if (c >= 45) continue
      list.sort((a, b) => parts[b]!.at[1] + parts[b]!.size[1] - (parts[a]!.at[1] + parts[a]!.size[1]))
      list.forEach((i, rank) => (fallen[i] = c < 45 * (1 - rank / list.length)))
    }
  } else {
    if (condition >= 45 || parts.length < 2) return parts
    const order = parts.map((_, i) => i).sort((a, b) => MATERIAL_INFO[parts[a]!.material].halfLifeYears - MATERIAL_INFO[parts[b]!.material].halfLifeYears || parts[b]!.at[1] - parts[a]!.at[1])
    order.forEach((i, rank) => (fallen[i] = condition < 45 * (1 - rank / (parts.length - 1))))
  }
  if (!fallen.some(Boolean)) return parts
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
