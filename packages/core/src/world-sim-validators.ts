import type { Orbit, Star } from './astro'
import { CommandError, checkEdge, liveNode, type Check } from './command-kit'
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
  ecolink(store: Store, l: EcoLink, check: Check<'ecolink'>) {
    if (l.fromId === l.toId && l.type !== 'competes') throw new CommandError('A species cannot eat itself')
    checkEdge(store, 'ecolink', 'lifeform', l, check, 'Those species live on different worlds', 'Those species are already linked that way')
  }
}
