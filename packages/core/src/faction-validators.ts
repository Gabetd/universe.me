import { CommandError, liveRecord, liveRegion, liveWorld, sameOwner, type Check } from './command-kit'
import { sameParty, wouldLoop, type Faction, type Holding, type Membership, type Party, type Relationship, type Span } from './factions'
import type { Store } from './store'

/** Validators for these record kinds (record-kit runs them on every write). */
export const factionValidators = {
  faction(store: Store, f: Faction, { previous }: Check<'faction'>) {
    liveWorld(store, f.ownerId)
    checkSpan(store, f, f.ownerId, 'A faction cannot be dissolved before it’s founded')
    if (f.parentId && f.parentId !== previous?.parentId) {
      if (f.parentId === f.id) throw new CommandError('A faction cannot be part of itself')
      onWorld(liveRecord(store, 'faction', f.parentId), f.ownerId, 'faction')
      if (wouldLoop(store.records('faction').byOwner(f.ownerId), f.id, f.parentId)) throw new CommandError('That faction is already part of this one')
    }
  },
  membership(store: Store, m: Membership, { previous }: Check<'membership'>) {
    if (m.factionId !== previous?.factionId) onWorld(liveRecord(store, 'faction', m.factionId), m.ownerId, 'faction')
    if (m.characterId !== previous?.characterId) onWorld(liveRecord(store, 'character', m.characterId), m.ownerId, 'character')
    checkSpan(store, m, m.ownerId, 'A membership cannot end before it starts')
  },
  // Like effect targets, a region isn't checked again once held: deleting it just leaves the holding reaching nothing.
  holding(store: Store, h: Holding, { previous }: Check<'holding'>) {
    if (h.factionId !== previous?.factionId) onWorld(liveRecord(store, 'faction', h.factionId), h.ownerId, 'faction')
    if (h.regionId !== previous?.regionId && liveRegion(store, h.regionId).worldId !== h.ownerId) throw new CommandError('That region is on another world')
    checkSpan(store, h, h.ownerId, 'A faction cannot lose a region before it takes it')
  },
  relationship(store: Store, r: Relationship, { previous }: Check<'relationship'>) {
    if (sameParty(r.from, r.to)) throw new CommandError('A relationship needs two sides')
    for (const side of [r.from, r.to]) if (!previous || (!sameParty(side, previous.from) && !sameParty(side, previous.to))) liveParty(store, side, r.ownerId)
    checkSpan(store, r, r.ownerId, 'A relationship cannot end before it starts')
  }
}

/** A character or faction on `worldId`. */
export function liveParty(store: Store, p: Party, worldId: string) {
  onWorld(liveRecord(store, p.kind, p.id), worldId, p.kind)
}

const onWorld = (record: { ownerId: string }, worldId: string, what: string) => sameOwner(record, worldId, what, 'world')

function checkSpan(store: Store, s: Span, worldId: string, backwards: string) {
  if (s.start !== null && s.end !== null && s.end < s.start) throw new CommandError(backwards)
  for (const id of [s.startEventId, s.endEventId]) if (id) onWorld(liveRecord(store, 'event', id), worldId, 'event')
}
