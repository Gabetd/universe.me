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
 * The parts still standing at a condition: from Damaged down, the most
 * fragile parts (shortest-lived material, then highest up) go first, down to
 * the sturdiest third at the end.
 */
export function standingParts(parts: BlueprintPart[], condition: number): BlueprintPart[] {
  if (condition >= 45 || parts.length < 2) return parts
  const keep = Math.max(1, Math.ceil(parts.length * (0.35 + 0.65 * (condition / 45))))
  const sturdiest = [...parts].sort((a, b) => MATERIAL_INFO[b.material].halfLifeYears - MATERIAL_INFO[a.material].halfLifeYears || a.at[1] - b.at[1])
  const kept = new Set(sturdiest.slice(0, keep))
  return parts.filter((p) => kept.has(p))
}
