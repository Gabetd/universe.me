import { CommandError, liveNode, liveRecord, liveWorld } from './command-kit'
import type { Store } from './store'
import type { Theme, ThemeSpan } from './themes'

/** Validators for these record kinds (record-kit runs them on every write). */
export const themeValidators = {
  theme: (store: Store, t: Theme) => void liveNode(store, t.ownerId),
  themeSpan(store: Store, s: ThemeSpan) {
    liveWorld(store, s.ownerId)
    liveRecord(store, 'theme', s.themeId)
    if (s.end < s.start) throw new CommandError('A theme span cannot end before it starts')
    // Its region needn't be live, like an effect's targets: a span whose region was deleted reaches nothing, and can still be edited or brought back.
    if (s.regionId === null) return
    const region = store.regions.get(s.regionId)
    if (!region) throw new CommandError(`Region ${s.regionId} does not exist`)
    if (region.worldId !== s.ownerId) throw new CommandError('That region is on another world')
  }
}
