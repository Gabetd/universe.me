import { CommandError, liveRecord, sameOwner } from './command-kit'
import type { Law, LawScope } from './laws'
import type { Store } from './store'

/** The era or faction a law belongs to, live. */
export const scopeOf = (store: Store, scope: LawScope) => (scope.kind === 'era' ? liveRecord(store, 'era', scope.eraId) : liveRecord(store, 'faction', scope.factionId))

/** Validators for laws (record-kit runs them on every write): its era or faction on its world, enacted before it's repealed, its events on its world. */
export const lawValidators = {
  law(store: Store, law: Law, { previous }: { previous?: Law }) {
    if (!previous) sameOwner(scopeOf(store, law.scope), law.ownerId, law.scope.kind, 'world')
    if (law.start !== null && law.end !== null && law.end < law.start) throw new CommandError('A law can’t be repealed before it’s enacted')
    for (const [id, was] of [
      [law.startEventId, previous?.startEventId],
      [law.endEventId, previous?.endEventId]
    ] as const)
      if (id && id !== was) sameOwner(liveRecord(store, 'event', id), law.ownerId, 'event', 'world')
  }
}
