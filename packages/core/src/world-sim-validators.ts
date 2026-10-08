import type { Orbit, Star } from './astro'
import { CommandError, liveNode, liveRecord } from './command-kit'
import type { EcoLink, Species } from './ecosystem'
import type { Store } from './store'

/** Validators for these record kinds (record-kit runs them on every write). */
export const worldSimValidators = {
  star(store: Store, s: Star) {
    if (liveNode(store, s.ownerId).kind !== 'star_system') throw new CommandError('Only a star system has a star')
  },
  orbit(store: Store, o: Orbit) {
    if (liveNode(store, o.ownerId).kind !== 'body') throw new CommandError('Only planets and moons have an orbit')
  },
  lifeform(store: Store, s: Species) {
    if (liveNode(store, s.ownerId).kind !== 'world') throw new CommandError('Species live on a world')
  },
  ecolink(store: Store, l: EcoLink) {
    if (l.fromId === l.toId && l.type !== 'competes') throw new CommandError('A species cannot eat itself')
    for (const id of [l.fromId, l.toId]) {
      if (liveRecord(store, 'lifeform', id).ownerId !== l.ownerId) throw new CommandError('Those species live on different worlds')
    }
    if (store.records('ecolink').all().some((o) => o.id !== l.id && o.fromId === l.fromId && o.toId === l.toId && o.type === l.type)) throw new CommandError('Those species are already linked that way')
  }
}
