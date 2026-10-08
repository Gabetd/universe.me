import { RECORD_KINDS, type TimelineData, type WorldInfo } from '@universe/core'
import type { AppState } from '../../shared/api'

/**
 * Keeps what a command didn't change. Each reply from main is a whole copy of
 * the project, so without this every node, record and world would be a new
 * object after every command, and every cache keyed on them (star systems,
 * structure conditions, planet textures, the globe's colours, timeline
 * warnings, memos) would start over. Every write stamps `updatedAt`, so a
 * record with the same id and stamp is the same record; an array whose
 * records are all kept is kept too.
 */
export function reconcile(prev: AppState, next: AppState): AppState {
  return {
    ...next,
    project: prev.project && next.project && JSON.stringify(prev.project) === JSON.stringify(next.project) ? prev.project : next.project,
    nodes: keepSame(prev.nodes, next.nodes, sameStamp),
    regions: keepSame(prev.regions, next.regions, sameStamp),
    worlds: keepSame(prev.worlds, next.worlds, sameWorld),
    timeline: keepTimeline(prev.timeline, next.timeline),
    proposals: JSON.stringify(prev.proposals) === JSON.stringify(next.proposals) ? prev.proposals : next.proposals
  }
}

const sameStamp = (a: { updatedAt: string }, b: { updatedAt: string }) => a.updatedAt === b.updatedAt
const sameWorld = (a: WorldInfo, b: WorldInfo) => a.terrainRevision === b.terrainRevision && JSON.stringify(a.settings) === JSON.stringify(b.settings)

function keepSame<T extends { id: string }>(prev: T[], next: T[], same: (a: T, b: T) => boolean): T[] {
  const before = new Map(prev.map((r) => [r.id, r]))
  let unchanged = prev.length === next.length
  const out = next.map((r, i) => {
    const old = before.get(r.id)
    const kept = old && same(old, r) ? old : r
    if (kept !== prev[i]) unchanged = false
    return kept
  })
  return unchanged ? prev : out
}

function keepTimeline(prev: TimelineData, next: TimelineData): TimelineData {
  const out = { ...next } as Record<string, { id: string; updatedAt: string }[]>
  let unchanged = true
  for (const kind of RECORD_KINDS) {
    const key = `${kind}s` as keyof TimelineData
    const kept = keepSame(prev[key] as { id: string; updatedAt: string }[], next[key] as { id: string; updatedAt: string }[], sameStamp)
    out[key] = kept
    if (kept !== prev[key]) unchanged = false
  }
  return unchanged ? prev : (out as unknown as TimelineData)
}
