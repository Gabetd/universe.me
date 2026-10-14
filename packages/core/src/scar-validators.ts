import { CommandError, liveRecord, liveRegion, liveWorld, sameOwner } from './command-kit'
import type { Scar } from './scars'
import type { Store } from './store'

/** Validators for these record kinds (record-kit runs them on every write). */
export const scarValidators = {
  // Its event and region are checked as it's made or changed; deleted later, the event is unlinked and the region simply reaches nothing.
  scar(store: Store, s: Scar, { previous }: { previous?: Scar }) {
    liveWorld(store, s.ownerId)
    if (s.end !== null && s.end < s.start) throw new CommandError('A scar can’t stop getting worse before it comes')
    if (s.eventId && s.eventId !== previous?.eventId) sameOwner(liveRecord(store, 'event', s.eventId), s.ownerId, 'event')
    if (s.regionId && s.regionId !== previous?.regionId && liveRegion(store, s.regionId).worldId !== s.ownerId) throw new CommandError('That region is on another world')
  }
}
