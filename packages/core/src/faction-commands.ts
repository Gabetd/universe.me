import { z } from 'zod'
import { pickColor } from './command-kit'
import type { Command, HandlerMap } from './commands'
import { Faction, FactionKind, Holding, Membership, Party, Relationship, RelationType, involves, sameParty } from './factions'
import { NewId, clearRefs, create, deleteWith, live, recordCrud, refsWhere } from './record-kit'
import { Id } from './schema'
import type { Store } from './store'
import { stripUndefined } from './util'

const SpanFields = { start: true, end: true, startEventId: true, endEventId: true } as const
const FactionFields = Faction.pick({ name: true, kind: true, color: true, emblem: true, parentId: true, summary: true, notes: true, tags: true, ...SpanFields })
const MembershipFields = Membership.pick({ role: true, ...SpanFields })
const HoldingFields = Holding.pick({ ...SpanFields })
const RelationshipFields = Relationship.pick({ type: true, label: true, note: true, ...SpanFields })
export type FactionPatch = Partial<z.infer<typeof FactionFields>>
export type MembershipPatch = Partial<z.infer<typeof MembershipFields>>
export type HoldingPatch = Partial<z.infer<typeof HoldingFields>>
export type RelationshipPatch = Partial<z.infer<typeof RelationshipFields>>

const factions = recordCrud('faction', FactionFields)
const memberships = recordCrud('membership', MembershipFields)
const holdings = recordCrud('holding', HoldingFields)
const relationships = recordCrud('relationship', RelationshipFields)

const NO_SPAN = { start: null, end: null, startEventId: null, endEventId: null }

export const FACTION_COMMANDS = [
  /** A faction on a world. `faction.delete` takes its memberships, holdings and relationships with it, and frees its parts. */
  z.object({ type: z.literal('faction.create'), payload: FactionFields.partial().extend({ ...NewId, ownerId: Id, kind: FactionKind.optional() }) }),
  ...factions.commands,
  /** A character joins a faction (for a span: from `start` until `end`). */
  z.object({ type: z.literal('membership.create'), payload: MembershipFields.partial().extend({ ...NewId, factionId: Id, characterId: Id }) }),
  ...memberships.commands,
  /** A faction holds a region (for a span). */
  z.object({ type: z.literal('holding.create'), payload: HoldingFields.partial().extend({ ...NewId, factionId: Id, regionId: Id }) }),
  ...holdings.commands,
  /** Two characters or factions (or one of each) related, for a span. */
  z.object({ type: z.literal('relationship.create'), payload: RelationshipFields.partial().extend({ ...NewId, ownerId: Id, from: Party, to: Party, type: RelationType }) }),
  ...relationships.commands
] as const

type FactionCommand = z.infer<(typeof FACTION_COMMANDS)[number]>

const ownerOfFaction = (store: Store, id: string) => store.records('faction').get(id)?.ownerId ?? ''

export const factionHandlers: HandlerMap<FactionCommand> = {
  'faction.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'faction', ctx, ownerId, id, {
      name: 'New faction', kind: 'other', color: pickColor(ctx), emblem: '', parentId: null, summary: '', notes: '', tags: [], ...NO_SPAN, ...stripUndefined(p)
    }),
  'faction.update': factions.update,
  'faction.delete': (store, { id }, ctx, run) =>
    deleteWith(store, ctx, run, { kind: 'faction', id }, ({ ownerId }) => ({
      detach: [
        ...live(store, 'faction').filter((f) => f.parentId === id).map((f): Command => ({ type: 'faction.update', payload: { id: f.id, patch: { parentId: null } } })),
        ...dropParticipant(store, ownerId, { kind: 'faction', id })
      ],
      remove: [
        ...refsWhere(store, 'membership', ownerId, (m) => m.factionId === id),
        ...refsWhere(store, 'holding', ownerId, (h) => h.factionId === id),
        ...relationshipsWith(store, ownerId, { kind: 'faction', id })
      ]
    })),
  'membership.create': (store, { id, factionId, characterId, ...p }, ctx) =>
    create(store, 'membership', ctx, ownerOfFaction(store, factionId), id, { factionId, characterId, role: '', ...NO_SPAN, ...stripUndefined(p) }),
  'membership.update': memberships.update,
  'membership.delete': memberships.delete,
  'holding.create': (store, { id, factionId, regionId, ...p }, ctx) =>
    create(store, 'holding', ctx, ownerOfFaction(store, factionId), id, { factionId, regionId, ...NO_SPAN, ...stripUndefined(p) }),
  'holding.update': holdings.update,
  'holding.delete': holdings.delete,
  'relationship.create': (store, { id, ownerId, from, to, type, ...p }, ctx) =>
    create(store, 'relationship', ctx, ownerId, id, { from, to, type, label: '', note: '', ...NO_SPAN, ...stripUndefined(p) }),
  'relationship.update': relationships.update,
  'relationship.delete': relationships.delete
}

/** What goes with a character: their memberships and relationships, and their part in events. */
export const characterDependents = (store: Store, ownerId: string, id: string) => ({
  detach: dropParticipant(store, ownerId, { kind: 'character', id }),
  remove: [...refsWhere(store, 'membership', ownerId, (m) => m.characterId === id), ...relationshipsWith(store, ownerId, { kind: 'character', id })]
})

/** Updates that take `party` out of the events they took part in. */
const dropParticipant = (store: Store, ownerId: string, party: Party): Command[] =>
  store.records('event').byOwner(ownerId).flatMap((e) =>
    e.participants?.some((p) => sameParty(p, party))
      ? [{ type: 'event.update', payload: { id: e.id, patch: { participants: e.participants.filter((p) => !sameParty(p, party)) } } } as Command]
      : []
  )

const relationshipsWith = (store: Store, ownerId: string, party: Party) => refsWhere(store, 'relationship', ownerId, (r) => involves(r, party))

/** Updates that forget an event that's going wherever these records on its world name it as a cause. */
export const forgetCause = (store: Store, ownerId: string, eventId: string): Command[] =>
  (['faction', 'membership', 'holding', 'relationship'] as const).flatMap((kind) =>
    (['startEventId', 'endEventId'] as const).flatMap((field) => clearRefs(store, kind, ownerId, field, eventId))
  )
