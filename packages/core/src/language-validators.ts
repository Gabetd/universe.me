import { CommandError, liveNode, liveRecord, liveRegion } from './command-kit'
import type { Language, LanguageUse } from './languages'
import type { Store } from './store'

/** Validators for these record kinds (record-kit runs them on every write). */
export const languageValidators = {
  language(store: Store, l: Language) {
    liveNode(store, l.ownerId)
    if (l.maxSyllables < l.minSyllables) throw new CommandError('A language’s words can’t have fewer syllables at most than at least')
  },
  languageUse(store: Store, u: LanguageUse) {
    const node = liveNode(store, u.ownerId)
    liveRecord(store, 'language', u.languageId)
    if (u.regionId !== null) {
      if (node.kind !== 'world') throw new CommandError('Only a world has regions to speak a language in')
      if (liveRegion(store, u.regionId).worldId !== u.ownerId) throw new CommandError('That region is on another world')
    }
    // One language a place: changing it changes that use.
    if (store.records('languageUse').all().some((o) => o.id !== u.id && o.ownerId === u.ownerId && o.regionId === u.regionId)) throw new CommandError('A language is already spoken there: change that one')
  }
}
