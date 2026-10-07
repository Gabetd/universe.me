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

/**
 * The parts still standing at a condition. Parts are ranked from most fragile
 * (shortest-lived material, then highest up) to sturdiest; the most fragile
 * falls when the structure becomes Damaged (45), the rest at evenly lower
 * conditions, and the sturdiest stays to the end.
 */
export function standingParts(parts: BlueprintPart[], condition: number): BlueprintPart[] {
  if (condition >= 45 || parts.length < 2) return parts
  const fragileFirst = [...parts].sort((a, b) => MATERIAL_INFO[a.material].halfLifeYears - MATERIAL_INFO[b.material].halfLifeYears || b.at[1] - a.at[1])
  const fallen = new Set(fragileFirst.filter((_, rank) => condition < 45 * (1 - rank / (parts.length - 1))))
  return parts.filter((p) => !fallen.has(p))
}
