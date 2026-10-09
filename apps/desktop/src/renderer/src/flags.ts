import { flaggedIds, type Finding } from '@universe/core'
import { useUi } from './store'

/**
 * What open findings (inconsistencies Claude reported, PLAN.md §6.5) are
 * about, for the amber marks on them: worked out once per change to the
 * findings, however many rows ask.
 */
let cache: { findings: Finding[]; ids: Set<string> } | undefined
const idsOf = (findings: Finding[]) => (cache?.findings === findings ? cache.ids : (cache = { findings, ids: flaggedIds(findings) }).ids)

/** Whether an open finding is about this. */
export const useFlagged = (id: string) => useUi((s) => idsOf(s.timeline.findings).has(id))

/** Everything open findings are about. */
export const useFlaggedIds = () => useUi((s) => idsOf(s.timeline.findings))

/** Marks a flagged element: an amber dot after its name. */
export const flagClass = (flagged: boolean) => (flagged ? ' flagged' : '')
