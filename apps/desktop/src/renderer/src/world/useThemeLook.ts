import { spanWeight, themeAt, type Theme, type ThemeLook, type ThemeSpan } from '@universe/core'
import { useMemo } from 'react'
import { useOwnRecords, useUi } from '../store'
import { playheadOf, useNow, useTimelineView } from '../timeline/timelineStore'
import { useByValue } from '../useByValue'
import { viewTheme, type ViewTheme } from './viewTheme'

/** A world's theme spans, and the project's theme library. */
export function useWorldThemes(worldId: string | undefined): { spans: ThemeSpan[]; themes: Theme[] } {
  return { spans: useOwnRecords('themeSpans', worldId ?? ''), themes: useUi((s) => s.timeline.themes) }
}

/**
 * How much of each span shows at the world's playhead, as a key. The look in
 * force follows from it alone, and it changes only while a span fades in or
 * out (or the playhead jumps), so whatever follows it doesn't re-render as the
 * playhead moves through a theme, or where there is none.
 */
function useShown(worldId: string | undefined, spans: readonly ThemeSpan[]): string {
  const now = useNow(worldId)
  return useTimelineView((s) => (worldId && spans.length ? spans.map((sp) => Math.round(spanWeight(sp, s.playheads[worldId] ?? now) * 1000)).join(',') : ''))
}

/**
 * The look and tone in force on a world at its playhead (PLAN.md §4.5): its
 * themes blended, in a place lying in `regionIds` (spans for a region apply
 * only there). Undefined while no theme shows.
 */
export function useThemeLook(worldId: string | undefined, regionIds?: readonly string[]): ThemeLook | undefined {
  const { spans, themes } = useWorldThemes(worldId)
  const shown = useShown(worldId, spans)
  const regions = useByValue(regionIds)
  return useMemo(() => (worldId && shown ? themeAt(spans, themes, playheadOf(worldId), regions) : undefined), [worldId, spans, themes, shown, regions])
}

/** What the theme in force does to a view (see `viewTheme`). */
export function useViewTheme(worldId: string | undefined, regionIds?: readonly string[]): ViewTheme {
  const look = useThemeLook(worldId, regionIds)
  return useMemo(() => viewTheme(look), [look])
}

/** What the theme in force does to a view in each of `regionIds` that has spans of its own; the others look like the world around them. */
export function useRegionViewThemes(worldId: string | undefined, regionIds: readonly string[]): Map<string, ViewTheme> {
  const { spans, themes } = useWorldThemes(worldId)
  const shown = useShown(worldId, spans)
  const regions = useByValue(regionIds)
  return useMemo(() => {
    if (!worldId || !shown) return new Map()
    const own = new Set(spans.flatMap((s) => (s.regionId ? [s.regionId] : [])))
    const t = playheadOf(worldId)
    return new Map(regions.filter((id) => own.has(id)).map((id) => [id, viewTheme(themeAt(spans, themes, t, [id]))]))
  }, [worldId, spans, themes, shown, regions])
}
