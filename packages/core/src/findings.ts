import { z } from 'zod'
import { Id, Name, RecordMeta } from './schema'

/**
 * Inconsistencies a reader found in a world (PLAN.md §6.5): what only
 * reading the world as a whole shows — a character in two places at once,
 * magic used in an age where it's gone, a region's history that contradicts
 * its notes. The connected AI reports them; they stay with the world (and
 * sync with it) until resolved or dismissed. The app's own checks
 * (timelineWarnings, structureWarnings, ecosystemWarnings) are worked out,
 * not kept.
 */

export const FINDING_SEVERITIES = ['contradiction', 'unlikely', 'question'] as const
export const FindingSeverity = z.enum(FINDING_SEVERITIES)
export type FindingSeverity = z.infer<typeof FindingSeverity>

/** What a finding can be about. */
export const FINDING_KINDS = ['node', 'region', 'event', 'era', 'group', 'link', 'structure', 'character', 'species', 'theme', 'themeSpan', 'power'] as const
export const FindingKind = z.enum(FINDING_KINDS)
export type FindingKind = z.infer<typeof FindingKind>

export const FindingRef = z.object({ kind: FindingKind, id: Id })
export type FindingRef = z.infer<typeof FindingRef>

/** Open until someone says it's fixed (resolved) or not a problem (dismissed: not to be raised again). */
export const FINDING_STATUSES = ['open', 'resolved', 'dismissed'] as const
export const FindingStatus = z.enum(FINDING_STATUSES)
export type FindingStatus = z.infer<typeof FindingStatus>

export const Finding = z.object({
  ...RecordMeta,
  severity: FindingSeverity,
  title: Name,
  /** What doesn't fit, and why. */
  explanation: z.string().max(20_000),
  /** A way to fix it, if there's one to offer. */
  suggestion: z.string().max(20_000),
  refs: z.array(FindingRef).max(20),
  status: FindingStatus,
  /** Who found it ("Claude"). */
  reporter: z.string().max(100),
  /** Why it was resolved or dismissed. */
  note: z.string().max(2000)
})
export type Finding = z.infer<typeof Finding>

export const SEVERITY_LABELS: Record<FindingSeverity, string> = { contradiction: 'Contradiction', unlikely: 'Unlikely', question: 'Question' }

/** Ids of what open findings are about. */
export const flaggedIds = (findings: readonly Finding[]) => new Set(findings.flatMap((f) => (f.status === 'open' ? f.refs.map((r) => r.id) : [])))

/** The same finding again: one with this title, open or dismissed (dismissed ones aren't raised again). */
export const sameFinding = (findings: readonly Finding[], title: string) => findings.find((f) => f.status !== 'resolved' && f.title.trim().toLowerCase() === title.trim().toLowerCase())
