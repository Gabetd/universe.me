import { CommandError, liveNode, liveRecord, type Check } from './command-kit'
import type { PowerAge, PowerSystem } from './powers'
import type { Store } from './store'

/** Validators for these record kinds (record-kit runs them on every write). */
export const powerValidators = {
  power: (store: Store, s: PowerSystem, { previous }: Check<'power'>) => {
    if (s.ownerId !== store.nodes.root()?.id) throw new CommandError('Power systems belong to the universe')
    const ids = s.aspects.map((a) => a.id)
    if (new Set(ids).size !== ids.length) throw new CommandError('Two aspects of a power system have the same id')
    if (new Set(s.pins).size !== s.pins.length) throw new CommandError('A power system is pinned to the same place twice')
    // Only new pins: one to a place since deleted (which comes back with an undo) stays.
    for (const id of s.pins) if (!previous?.pins.includes(id)) liveNode(store, id)
  },
  powerAge(store: Store, a: PowerAge) {
    liveRecord(store, 'power', a.systemId)
    if (liveRecord(store, 'era', a.eraId).ownerId !== a.ownerId) throw new CommandError('That era is on another timeline')
  }
}
