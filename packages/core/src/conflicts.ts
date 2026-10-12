import { z } from 'zod'
import { RecordMeta } from './schema'

/**
 * Conflict notes (PLAN.md §6.7, M20): when two devices change the same field
 * apart from each other, a merge keeps the later change, and the earlier
 * one is kept here, on what it was about (its owner: the node, or the node
 * a record or region belongs to), to be put back (`conflict.use`) or
 * dismissed. Notes changed apart are merged line by line and only leave a
 * note where both changed the same lines. Both devices make the same note
 * (its id comes from what was lost), so it's one note once they've synced.
 */
export const Conflict = z.object({
  ...RecordMeta,
  /** The row, by its sync key, and the field, by its path in the row (fields.ts). */
  key: z.string().min(1).max(2000),
  path: z.string().max(2000),
  /** What the version that lost had there (nothing, if it had taken the field out: `removed`). */
  value: z.unknown(),
  removed: z.boolean(),
  /** When the version that lost was written, and the one kept (sync stamps: milliseconds first). */
  lostStamp: z.string().max(100),
  keptStamp: z.string().max(100)
})
export type Conflict = z.infer<typeof Conflict>

/** A short hash of a text, as letters and digits (cyrb53): the same on every device. */
function hashOf(text: string): string {
  let [h1, h2] = [0xdeadbeef, 0x41c6ce57]
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** A conflict note's id: from the row, the field and the version lost, so every device that merges the same two versions makes the same note. */
export const conflictId = (key: string, path: string, lostStamp: string) => `conflict-${hashOf(JSON.stringify([key, path, lostStamp]))}`

/** When a version was written, from its sync stamp (milliseconds since 1970, in base 36 first). */
export const stampTime = (stamp: string): number => parseInt(stamp.split('.')[0] ?? '0', 36)

/** The device that wrote a version, from its sync stamp. */
export const stampDevice = (stamp: string): string => stamp.split('.').slice(2).join('.')

/** A field's path as words ("notes", "terrain › water"). */
export const pathWords = (path: string): string =>
  path
    .slice(1)
    .split('/')
    .map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join(' › ') || 'everything'
