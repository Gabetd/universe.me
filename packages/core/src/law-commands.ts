import { z } from 'zod'
import type { Command, HandlerMap } from './commands'
import { Law, LawKind, LawScope, lawOf } from './laws'
import { scopeOf } from './law-validators'
import { NewId, create, recordCrud, refsWhere, type Ref } from './record-kit'
import type { Store } from './store'
import { stripUndefined } from './util'

const LawFields = Law.pick({ name: true, kind: true, start: true, end: true, startEventId: true, endEventId: true, summary: true, penalty: true, notes: true, tags: true })
export type LawPatch = Partial<z.infer<typeof LawFields>>
const laws = recordCrud('law', LawFields)

export const LAW_COMMANDS = [
  /** A law of an era or a faction, on its world. */
  z.object({ type: z.literal('law.create'), payload: LawFields.partial().extend({ ...NewId, scope: LawScope, kind: LawKind.optional() }) }),
  ...laws.commands
] as const

type LawCommand = z.infer<(typeof LAW_COMMANDS)[number]>

export const lawHandlers: HandlerMap<LawCommand> = {
  'law.create': (store, { id, scope, ...p }, ctx) =>
    create(store, 'law', ctx, scopeOf(store, scope).ownerId, id, {
      name: 'New law', scope, kind: 'other', start: null, end: null, startEventId: null, endEventId: null, summary: '', penalty: '', notes: '', tags: [], ...stripUndefined(p)
    }),
  'law.update': laws.update,
  'law.delete': laws.delete
}

/** The laws of an era or a faction that's going: they go (and come back) with it. */
export const lawsOf = (store: Store, ownerId: string, of: LawScope['kind'], id: string): Ref[] =>
  refsWhere(store, 'law', ownerId, (l) => lawOf(l, { kind: of, id }))

/** Laws enacted or repealed by an event that's going: they stay, without a cause. */
export const forgetLawCause = (store: Store, ownerId: string, eventId: string): Command[] =>
  store.records('law').byOwner(ownerId).flatMap((l): Command[] => {
    const patch = { ...(l.startEventId === eventId && { startEventId: null }), ...(l.endEventId === eventId && { endEventId: null }) }
    return Object.keys(patch).length ? [{ type: 'law.update', payload: { id: l.id, patch } }] : []
  })
