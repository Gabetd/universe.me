import { CommandError, liveRecord, liveWorld } from './command-kit'
import type { PowerAge, PowerSystem } from './powers'
import type { Store } from './store'

/** Validators for these record kinds (record-kit runs them on every write). */
export const powerValidators = {
  power: (store: Store, s: PowerSystem) => {
    liveWorld(store, s.ownerId)
    const ids = s.aspects.map((a) => a.id)
    if (new Set(ids).size !== ids.length) throw new CommandError('Two aspects of a power system have the same id')
  },
  powerAge(store: Store, a: PowerAge) {
    if (liveRecord(store, 'power', a.systemId).ownerId !== a.ownerId) throw new CommandError('That power system is on another world')
    if (liveRecord(store, 'era', a.eraId).ownerId !== a.ownerId) throw new CommandError('That era is on another world')
  }
}
