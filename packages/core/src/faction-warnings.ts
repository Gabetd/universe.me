import type { Character } from './characters'
import { RELATION_INFO, sameParty, spansOverlap, type Faction, type Holding, type Membership, type Party, type Relationship, type Span } from './factions'
import type { TimelineEvent } from './timeline'
import { eventSpan, type Warning } from './timeline-queries'
import { byId, groupBy } from './util'
import type { Region } from './world'

export interface FactionData {
  factions: readonly Faction[]
  memberships: readonly Membership[]
  holdings: readonly Holding[]
  relationships: readonly Relationship[]
  characters: readonly Character[]
  events: readonly TimelineEvent[]
}

/**
 * The mechanical mistakes in a world's factions (PLAN.md §9, M14): someone in
 * a faction before they're born or before it's founded, a region held by two
 * factions at once, allies who are enemies at the same time, a span that
 * doesn't line up with the event said to begin or end it. What only a reader
 * sees is left to the connected AI.
 */
export function factionWarnings(data: FactionData, regions: readonly Region[]): Warning[] {
  const factions = byId(data.factions)
  const characters = byId(data.characters)
  const events = byId(data.events)
  const regionById = byId(regions)
  const regionName = (id: string) => regionById.get(id)?.name ?? 'A region'
  const partyName = (p: Party) => (p.kind === 'faction' ? factions.get(p.id)?.name : characters.get(p.id)?.name) ?? 'Someone'
  const warnings: Warning[] = []
  const warn = (message: string, ...refs: Warning['refs']) => warnings.push({ message, refs })

  for (const m of data.memberships) {
    const f = factions.get(m.factionId)
    const c = characters.get(m.characterId)
    if (!f || !c) continue
    const refs: Warning['refs'] = [{ kind: 'faction', id: f.id }, { kind: 'character', id: c.id }]
    if (m.start !== null && m.start < c.born) warn(`${c.name} joins ${f.name} before they’re born`, ...refs)
    else if (m.start !== null && c.died !== null && m.start > c.died) warn(`${c.name} joins ${f.name} after they die`, ...refs)
    outsideFaction(m, f, `${c.name} is in ${f.name}`, refs)
  }

  for (const h of data.holdings) {
    const f = factions.get(h.factionId)
    if (f) outsideFaction(h, f, `${f.name} holds ${regionName(h.regionId)}`, [{ kind: 'faction', id: f.id }, { kind: 'region', id: h.regionId }])
  }
  const byRegion = groupBy(data.holdings.filter((h) => factions.has(h.factionId)), (h) => h.regionId)
  for (const [regionId, held] of byRegion) {
    for (let i = 0; i < held.length; i++) {
      for (let j = i + 1; j < held.length; j++) {
        const [a, b] = [factions.get(held[i]!.factionId)!, factions.get(held[j]!.factionId)!]
        if (a.id === b.id || within(a, b, factions) || within(b, a, factions) || !spansOverlap(held[i]!, held[j]!)) continue
        warn(`${regionName(regionId)} is held by both ${a.name} and ${b.name} at once`, { kind: 'region', id: regionId }, { kind: 'faction', id: a.id }, { kind: 'faction', id: b.id })
      }
    }
  }

  for (const r of data.relationships) {
    for (const side of [r.from, r.to]) {
      const c = side.kind === 'character' ? characters.get(side.id) : undefined
      if (c && r.start !== null && c.died !== null && r.start > c.died) {
        warn(`${c.name} is ${RELATION_INFO[r.type].from.toLowerCase()} to ${partyName(sameParty(side, r.from) ? r.to : r.from)} after they die`, { kind: 'relationship', id: r.id }, { kind: 'character', id: c.id })
      }
    }
  }
  const tone = (r: Relationship) => RELATION_INFO[r.type].tone
  const pairKey = (r: Relationship) => [r.from, r.to].map((p) => `${p.kind}:${p.id}`).sort().join('|')
  for (const rels of groupBy(data.relationships, pairKey).values()) {
    const good = rels.filter((r) => tone(r) === 'good' || r.type === 'spouse')
    const bad = rels.filter((r) => tone(r) === 'bad' && r.type !== 'rival')
    for (const g of good) {
      const b = bad.find((x) => spansOverlap(g, x))
      if (b) warn(`${partyName(g.from)} and ${partyName(g.to)} are ${g.type === 'spouse' ? 'married' : `${g.type === 'ally' ? 'allies' : 'friends'}`} and enemies at once`, { kind: 'relationship', id: g.id }, { kind: 'relationship', id: b.id })
    }
  }

  const spans: [Span, string, Warning['refs'][number]][] = [
    ...data.factions.map((f): [Span, string, Warning['refs'][number]] => [f, f.name, { kind: 'faction', id: f.id }]),
    ...data.relationships.map((r): [Span, string, Warning['refs'][number]] => [r, `${partyName(r.from)} and ${partyName(r.to)}`, { kind: 'relationship', id: r.id }])
  ]
  for (const [s, name, ref] of spans) {
    for (const [at, eventId, what] of [[s.start, s.startEventId, 'begins'], [s.end, s.endEventId, 'ends']] as const) {
      const cause = eventId ? events.get(eventId) : undefined
      if (!cause || at === null) continue
      const [start, end] = eventSpan(cause)
      if (at < start || at > end) warn(`${name} ${what} outside the time of “${cause.title}”, its cause`, ref, { kind: 'event', id: cause.id })
    }
  }
  return warnings

  /** A membership or holding that starts before its faction is founded, or after it's gone. */
  function outsideFaction(s: Span, f: Faction, what: string, refs: Warning['refs']) {
    if (s.start !== null && f.start !== null && s.start < f.start) warn(`${what} before it’s founded`, ...refs)
    else if (s.start !== null && f.end !== null && s.start >= f.end) warn(`${what} after it’s dissolved`, ...refs)
  }
}

/** Whether `inner` is part of `outer` (at any depth). */
function within(inner: Faction, outer: Faction, factions: ReadonlyMap<string, Faction>): boolean {
  for (let p = inner.parentId, n = 0; p && n < 50; p = factions.get(p)?.parentId ?? null, n++) if (p === outer.id) return true
  return false
}
