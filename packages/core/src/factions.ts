import { z } from 'zod'
import { Id, Name, Notes, RecordMeta } from './schema'
import { Time } from './time'
import { byId } from './util'
import { HexColor } from './world'

/**
 * Factions and relationships (PLAN.md §9, M14): the kingdoms, houses, guilds
 * and faiths of a world, who belongs to them and what land they hold, and how
 * its people and factions stand with each other, all over time.
 *
 * Everything here holds for a span: from `start` (null: from the beginning,
 * or from the faction's founding) until `end` (null: still), `start <= t < end`,
 * so one span can end the moment the next begins (a region changing hands).
 * `startEventId` and `endEventId` answer "why": the event that began or ended
 * it (a coronation, a treaty, a war). The times are their own; a span that
 * doesn't line up with its event is flagged, not moved.
 */

export const FACTION_KINDS = ['kingdom', 'empire', 'house', 'clan', 'guild', 'order', 'faith', 'company', 'band', 'other'] as const
export const FactionKind = z.enum(FACTION_KINDS)
export type FactionKind = z.infer<typeof FactionKind>

export const FACTION_KIND_LABELS: Record<FactionKind, string> = {
  kingdom: 'Kingdom',
  empire: 'Empire',
  house: 'House',
  clan: 'Clan',
  guild: 'Guild',
  order: 'Order',
  faith: 'Faith',
  company: 'Company',
  band: 'Band',
  other: 'Other'
}

const SpanFields = {
  start: Time.nullable(),
  end: Time.nullable(),
  startEventId: Id.nullable(),
  endEventId: Id.nullable()
}
export interface Span {
  start: Time | null
  end: Time | null
  startEventId: string | null
  endEventId: string | null
}

export const Faction = z.object({
  ...RecordMeta,
  name: Name,
  kind: FactionKind,
  color: HexColor,
  /** A symbol or two (an emoji, a letter) drawn as its badge. */
  emblem: z.string().max(8),
  /** The faction it's part of (a house in a kingdom), if any. */
  parentId: Id.nullable(),
  /** When it was founded (`start`) and dissolved (`end`), and the events that did it. */
  ...SpanFields,
  summary: z.string().max(2000),
  notes: Notes,
  tags: z.array(z.string())
})
export type Faction = z.infer<typeof Faction>

/** A character in a faction, from one time to another, perhaps with a role ("king", "master of coin"). */
export const Membership = z.object({
  ...RecordMeta,
  factionId: Id,
  characterId: Id,
  role: z.string().max(100),
  ...SpanFields
})
export type Membership = z.infer<typeof Membership>

/** A region held by a faction, from one time to another: its territory. */
export const Holding = z.object({
  ...RecordMeta,
  factionId: Id,
  regionId: Id,
  ...SpanFields
})
export type Holding = z.infer<typeof Holding>

/** One side of a relationship. */
export const Party = z.object({ kind: z.enum(['character', 'faction']), id: Id })
export type Party = z.infer<typeof Party>

export const RELATION_TYPES = ['parent', 'spouse', 'sibling', 'kin', 'friend', 'ally', 'rival', 'enemy', 'mentor', 'liege', 'other'] as const
export const RelationType = z.enum(RELATION_TYPES)
export type RelationType = z.infer<typeof RelationType>

/**
 * How each type reads from each side: `from` is the parent, mentor or liege
 * of `to` (who is the child, student or vassal); the rest read the same both
 * ways. `tone` colours the line between them.
 */
export const RELATION_INFO: Record<RelationType, { from: string; to: string; tone: 'kin' | 'good' | 'bad' | 'bond' | 'other' }> = {
  parent: { from: 'Parent', to: 'Child', tone: 'kin' },
  spouse: { from: 'Spouse', to: 'Spouse', tone: 'kin' },
  sibling: { from: 'Sibling', to: 'Sibling', tone: 'kin' },
  kin: { from: 'Kin', to: 'Kin', tone: 'kin' },
  friend: { from: 'Friend', to: 'Friend', tone: 'good' },
  ally: { from: 'Ally', to: 'Ally', tone: 'good' },
  rival: { from: 'Rival', to: 'Rival', tone: 'bad' },
  enemy: { from: 'Enemy', to: 'Enemy', tone: 'bad' },
  mentor: { from: 'Mentor', to: 'Student', tone: 'bond' },
  liege: { from: 'Liege', to: 'Vassal', tone: 'bond' },
  other: { from: 'Related', to: 'Related', tone: 'other' }
}

export const Relationship = z.object({
  ...RecordMeta,
  from: Party,
  to: Party,
  type: RelationType,
  /** Its own name for it ("sworn brother", "betrothed"), shown instead of the type's. */
  label: z.string().max(100),
  ...SpanFields,
  note: z.string().max(2000)
})
export type Relationship = z.infer<typeof Relationship>

/** Whether a span holds at `t`. */
export const holdsAt = (s: Pick<Span, 'start' | 'end'>, t: Time) => (s.start === null || s.start <= t) && (s.end === null || t < s.end)

/** Whether two spans share a moment. */
export const spansOverlap = (a: Pick<Span, 'start' | 'end'>, b: Pick<Span, 'start' | 'end'>) =>
  (a.start === null || b.end === null || a.start < b.end) && (b.start === null || a.end === null || b.start < a.end)

export const sameParty = (a: Party, b: Party) => a.kind === b.kind && a.id === b.id

/** Whether `party` is one side of `rel`. */
export const involves = (rel: Pick<Relationship, 'from' | 'to'>, party: Party) => sameParty(rel.from, party) || sameParty(rel.to, party)

/** A faction's ancestors' ids, its parent first; stops at a loop (which validation keeps out) rather than going round it. */
export function* ancestors(f: Pick<Faction, 'parentId'>, factions: ReadonlyMap<string, Pick<Faction, 'parentId'>>): Generator<string> {
  const seen = new Set<string>()
  for (let p = f.parentId; p && !seen.has(p); p = factions.get(p)?.parentId ?? null) {
    seen.add(p)
    yield p
  }
}

/** What `rel` makes the other side, seen from `side` ("Child" from the parent's side reads the child as their child). */
export function relationLabel(rel: Pick<Relationship, 'type' | 'label' | 'from'>, side: Party): string {
  if (rel.label.trim()) return rel.label.trim()
  const info = RELATION_INFO[rel.type]
  return sameParty(rel.from, side) ? info.to : info.from
}

/** The other side of `rel` from `side`. */
export const otherParty = (rel: Pick<Relationship, 'from' | 'to'>, side: Party): Party => (sameParty(rel.from, side) ? rel.to : rel.from)

/** A faction's members at `t` (memberships that hold then, of a faction that exists then). */
export function membersAt(faction: Faction, memberships: readonly Membership[], t: Time): Membership[] {
  if (!holdsAt(faction, t)) return []
  return memberships.filter((m) => m.factionId === faction.id && holdsAt(m, t))
}

/** The factions a character belongs to at `t`. */
export function factionsOf(characterId: string, factions: readonly Faction[], memberships: readonly Membership[], t: Time): Faction[] {
  const all = byId(factions)
  const out: Faction[] = []
  for (const m of memberships) {
    const f = m.characterId === characterId && holdsAt(m, t) ? all.get(m.factionId) : undefined
    if (f && holdsAt(f, t) && !out.includes(f)) out.push(f)
  }
  return out
}

/** How deep a faction is (0: no parent). */
function depthOf(f: Faction, factions: ReadonlyMap<string, Faction>): number {
  let depth = 0
  for (const _ of ancestors(f, factions)) depth++
  return depth
}

/**
 * Who holds each region at `t`: of the holdings in force (of factions that
 * exist then), the most specific faction (a house before its kingdom), then
 * the one that took it last.
 */
export function holdersAt(factions: readonly Faction[], holdings: readonly Holding[], t: Time): Map<string, Faction> {
  const all = byId(factions)
  const best = new Map<string, { faction: Faction; depth: number; since: number }>()
  for (const h of holdings) {
    const faction = all.get(h.factionId)
    if (!faction || !holdsAt(h, t) || !holdsAt(faction, t)) continue
    const depth = depthOf(faction, all)
    const since = h.start ?? -Infinity
    const was = best.get(h.regionId)
    if (!was || depth > was.depth || (depth === was.depth && since > was.since)) best.set(h.regionId, { faction, depth, since })
  }
  return new Map([...best].map(([regionId, { faction }]) => [regionId, faction]))
}

/** The regions a faction holds at `t`, its own and (with `withParts`) its parts'. */
export function territoryAt(faction: Faction, factions: readonly Faction[], holdings: readonly Holding[], t: Time, withParts = true): string[] {
  const ids = new Set([faction.id])
  if (withParts) {
    for (let grew = true; grew; ) {
      grew = false
      for (const f of factions) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id)
          grew = true
        }
      }
    }
  }
  const alive = new Set(factions.filter((f) => ids.has(f.id) && holdsAt(f, t)).map((f) => f.id))
  return [...new Set(holdings.filter((h) => alive.has(h.factionId) && holdsAt(h, t)).map((h) => h.regionId))]
}

/** Relationships in force at `t`, optionally only those `party` is in. */
export function relationshipsAt(rels: readonly Relationship[], t: Time, party?: Party): Relationship[] {
  return rels.filter((r) => holdsAt(r, t) && (!party || involves(r, party)))
}

/** Whether making `parentId` the parent of `id` would put a faction inside itself. */
export function wouldLoop(factions: readonly Pick<Faction, 'id' | 'parentId'>[], id: string, parentId: string | null): boolean {
  return parentId === id || [...ancestors({ parentId }, byId(factions))].includes(id)
}
