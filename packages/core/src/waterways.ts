import { z } from 'zod'
import { Notes, RecordMeta } from './schema'

/**
 * Rivers and lakes (PLAN.md §9, M15) come from a world's terrain, worked out
 * afresh as it changes (procgen's hydrology), each known by an id that stays
 * while it ends at the same place: a river by its mouth, a lake by its
 * deepest point. What the user gives one (a name of its own, notes) is kept
 * here, by that id, so it's still theirs when the land around it changes.
 */

export const WATERWAY_KINDS = ['river', 'lake'] as const
export const WaterwayKind = z.enum(WATERWAY_KINDS)
export type WaterwayKind = z.infer<typeof WaterwayKind>

/** A river's or lake's id as the hydrology has it: `r` (river) or `l` (lake) and a cell. */
export const WaterwayKey = z.string().regex(/^[rl]\d+$/)

export const Waterway = z.object({
  ...RecordMeta,
  /** Its id in the world's hydrology. */
  key: WaterwayKey,
  /** Its own name; empty keeps the one it was given. */
  name: z.string().trim().max(200),
  notes: Notes
})
export type Waterway = z.infer<typeof Waterway>

/** A world's waterway records have one per river or lake, so the id follows from both. */
export const waterwayId = (worldId: string, key: string) => `waterway:${worldId}:${key}`

/** Which kind a hydrology id names. */
export const waterwayKind = (key: string): WaterwayKind => (key.startsWith('l') ? 'lake' : 'river')

/** What a river or lake is called: its own name if it's been given one, else its generated one. */
export const waterwayName = (generated: string, own: Pick<Waterway, 'name'> | undefined) => own?.name || generated
