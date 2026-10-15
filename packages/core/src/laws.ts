import { z } from 'zod'
import type { Character } from './characters'
import { holdsAt, type Faction, type Membership, type Span } from './factions'
import { Id, Name, Notes, RecordMeta } from './schema'
import { Time } from './time'
import type { Era, TimelineEvent } from './timeline'
import { eventSpan, type Warning } from './timeline-queries'
import { ancestors, byId } from './util'

/**
 * Laws (PLAN.md §9, M30): what an era holds everyone to (its whole world, for
 * as long as it lasts), or what a faction holds its people to (a kingdom's
 * code, a guild's charter, a faith's commandments). Each is in force for a
 * span, like everything in factions.ts: from `start` until `end`, and null is
 * "from when its era or faction begins" and "until it ends". `startEventId`
 * and `endEventId` are the events that enacted and repealed it.
 */

export const LAW_KINDS = ['rule', 'crime', 'trade', 'land', 'faith', 'magic', 'war', 'custom', 'other'] as const
export const LawKind = z.enum(LAW_KINDS)
export type LawKind = z.infer<typeof LawKind>

export const LAW_KIND_LABELS: Record<LawKind, string> = {
  rule: 'Rule and succession',
  crime: 'Crime and punishment',
  trade: 'Trade and coin',
  land: 'Land and property',
  faith: 'Faith and worship',
  magic: 'Magic and powers',
  war: 'War and arms',
  custom: 'Custom',
  other: 'Other'
}

/** Whose law it is: an era's (everyone on the world, while it lasts) or a faction's (its members, and the land it holds). */
export const LawScope = z.discriminatedUnion('kind', [z.object({ kind: z.literal('era'), eraId: Id }), z.object({ kind: z.literal('faction'), factionId: Id })])
export type LawScope = z.infer<typeof LawScope>

export const Law = z.object({
  ...RecordMeta,
  name: Name,
  scope: LawScope,
  kind: LawKind,
  /** Enacted (null: from when its era or faction begins) and repealed (null: until it ends), and the events that did it. */
  start: Time.nullable(),
  end: Time.nullable(),
  startEventId: Id.nullable(),
  endEventId: Id.nullable(),
  /** What it says, in a line. */
  summary: z.string().max(2000),
  /** What breaking it costs. */
  penalty: z.string().max(500),
  notes: Notes,
  tags: z.array(z.string())
})
export type Law = z.infer<typeof Law>

/** What a law's span is bounded by: its era's or its faction's. */
export interface LawContext {
  eras: readonly Era[]
  factions: readonly Faction[]
}

/** When a law is in force: its own dates, within its era's or faction's (null: open-ended that way). */
export function lawSpan(law: Pick<Law, 'scope' | 'start' | 'end'>, { eras, factions }: LawContext): Pick<Span, 'start' | 'end'> {
  const outer = law.scope.kind === 'era' ? eras.find((e) => e.id === (law.scope as { eraId: string }).eraId) : factions.find((f) => f.id === (law.scope as { factionId: string }).factionId)
  if (!outer) return { start: law.start, end: law.end }
  const later = (a: Time | null, b: Time | null) => (a === null ? b : b === null ? a : Math.max(a, b))
  const sooner = (a: Time | null, b: Time | null) => (a === null ? b : b === null ? a : Math.min(a, b))
  return { start: later(law.start, outer.start), end: sooner(law.end, outer.end) }
}

/** Whether a law is in force at `t`. */
export const lawInForce = (law: Law, t: Time, context: LawContext) => holdsAt(lawSpan(law, context), t)

/** Where a law stands at `t`: in force, not yet, or no longer. */
export function lawStatus(law: Law, t: Time, context: LawContext): 'in force' | 'not yet' | 'repealed' {
  if (lawInForce(law, t, context)) return 'in force'
  const { start } = lawSpan(law, context)
  return start !== null && t < start ? 'not yet' : 'repealed'
}

/** Whether a law is one of an era's or a faction's. */
export const lawOf = (law: Pick<Law, 'scope'>, of: { kind: 'era' | 'faction'; id: string }) =>
  law.scope.kind === of.kind && (law.scope.kind === 'era' ? law.scope.eraId : law.scope.factionId) === of.id

/**
 * The laws a character lives under at `t`: every era's in force then, and
 * those of each faction they belong to then, and of what those factions are
 * part of (a kingdom's law reaches its houses' members). Each with whose it is.
 */
export function lawsOver(character: Pick<Character, 'id'>, t: Time, laws: readonly Law[], data: LawContext & { memberships: readonly Membership[] }): { law: Law; from: Era | Faction }[] {
  const factionById = byId(data.factions)
  const theirs = new Set<string>()
  for (const m of data.memberships) {
    const f = factionById.get(m.factionId)
    if (m.characterId !== character.id || !f || !holdsAt(m, t) || !holdsAt(f, t)) continue
    theirs.add(f.id)
    for (const up of ancestors(f, factionById)) theirs.add(up)
  }
  const eraById = byId(data.eras)
  return laws.flatMap((law) => {
    if (!lawInForce(law, t, data)) return []
    const from = law.scope.kind === 'era' ? eraById.get(law.scope.eraId) : theirs.has(law.scope.factionId) ? factionById.get(law.scope.factionId) : undefined
    return from ? [{ law, from }] : []
  })
}

/**
 * The mechanical mistakes in a world's laws: enacted before its era or
 * faction begins or after it's over, or on a date that doesn't line up with
 * the event said to enact or repeal it.
 */
export function lawWarnings(laws: readonly Law[], data: LawContext & { events: readonly TimelineEvent[] }): Warning[] {
  const eras = byId(data.eras)
  const factions = byId(data.factions)
  const events = byId(data.events)
  const warnings: Warning[] = []
  for (const law of laws) {
    const ref = { kind: 'law' as const, id: law.id }
    const outer = law.scope.kind === 'era' ? eras.get(law.scope.eraId) : factions.get(law.scope.factionId)
    if (outer && law.start !== null) {
      const whose = law.scope.kind === 'era' ? `the ${outer.name}` : (outer as Faction).name
      const outerRef = law.scope.kind === 'era' ? { kind: 'era' as const, id: outer.id } : { kind: 'faction' as const, id: outer.id }
      if (outer.start !== null && law.start < outer.start) warnings.push({ message: `${law.name} is enacted before ${whose} begins`, refs: [ref, outerRef] })
      else if (outer.end !== null && law.start > outer.end) warnings.push({ message: `${law.name} is enacted after ${whose} is over`, refs: [ref, outerRef] })
    }
    for (const [at, eventId, what] of [
      [law.start, law.startEventId, 'enacted'],
      [law.end, law.endEventId, 'repealed']
    ] as const) {
      const cause = eventId ? events.get(eventId) : undefined
      if (!cause || at === null) continue
      const [start, end] = eventSpan(cause)
      if (at < start || at > end) warnings.push({ message: `${law.name} is ${what} outside the time of “${cause.title}”, its cause`, refs: [ref, { kind: 'event', id: cause.id }] })
    }
  }
  return warnings
}
