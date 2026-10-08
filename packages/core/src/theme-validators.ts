import { CommandError, liveNode, liveRecord, liveRegion, liveWorld } from './command-kit'
import type { Store } from './store'
import type { Theme, ThemeSpan } from './themes'

/** Validators for these record kinds (record-kit runs them on every write). */
export const themeValidators = {
  theme: (store: Store, t: Theme) => void liveNode(store, t.ownerId),
  themeSpan(store: Store, s: ThemeSpan) {
    liveWorld(store, s.ownerId)
    liveRecord(store, 'theme', s.themeId)
    if (s.end < s.start) throw new CommandError('A theme span cannot end before it starts')
    if (s.regionId && liveRegion(store, s.regionId).worldId !== s.ownerId) throw new CommandError('That region is on another world')
  }
}
