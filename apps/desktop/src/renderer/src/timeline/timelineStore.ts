import { create } from 'zustand'
import { useUi } from '../store'
import type { TimeRange } from './scale'

/** View state of each timeline (not saved in the project): what's visible and where the playhead is. */
interface TimelineViewState {
  ranges: Record<string, TimeRange>
  playheads: Record<string, number>
  /** Height of the timeline panel in px. */
  height: number
  setRange(ownerId: string, range: TimeRange): void
  setPlayhead(ownerId: string, t: number): void
  setHeight(height: number): void
  /** Remembers the current height for next time. */
  saveHeight(): void
}

const HEIGHT_KEY = 'universe.timelineHeight'

function storedHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY))
    return v >= 120 ? v : 260
  } catch {
    return 260
  }
}

export const useTimelineView = create<TimelineViewState>((set, get) => ({
  ranges: {},
  playheads: {},
  height: storedHeight(),
  setRange: (ownerId, range) => set((s) => ({ ranges: { ...s.ranges, [ownerId]: range } })),
  setPlayhead: (ownerId, t) => set((s) => ({ playheads: { ...s.playheads, [ownerId]: t } })),
  setHeight: (height) => set({ height }),
  saveHeight() {
    try {
      localStorage.setItem(HEIGHT_KEY, String(get().height))
    } catch {
      // Not saved; the panel just starts at the default height next time.
    }
  }
}))

/** The story's "now" on a timeline: 0 (year 0) until the user sets it. */
export const useNow = (ownerId: string | undefined) => useUi((s) => s.timeline.timelines.find((t) => t.id === ownerId)?.now ?? 0)

/** The playhead's time on a timeline, outside React. */
export function playheadOf(ownerId: string): number {
  return useTimelineView.getState().playheads[ownerId] ?? useUi.getState().timeline.timelines.find((t) => t.id === ownerId)?.now ?? 0
}

/** The playhead's time on a timeline; it starts at "now". */
export function usePlayhead(ownerId: string | undefined): number {
  const now = useNow(ownerId)
  return useTimelineView((s) => (ownerId ? s.playheads[ownerId] : undefined)) ?? now
}
