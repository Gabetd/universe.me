import { themeAt, type Theme, type ThemeLook, type ThemeSpan } from '@universe/core'
import { useMemo } from 'react'
import { useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'

const NO_SPANS: ThemeSpan[] = []

/** A world's theme spans, and the project's theme library. */
export function useWorldThemes(worldId: string | undefined): { spans: ThemeSpan[]; themes: Theme[] } {
  const all = useUi((s) => s.timeline.themeSpans)
  const themes = useUi((s) => s.timeline.themes)
  const spans = useMemo(() => (worldId ? all.filter((s) => s.ownerId === worldId) : NO_SPANS), [all, worldId])
  return { spans, themes }
}

/**
 * The look and tone in force on a world at its playhead (PLAN.md §4.5): its
 * themes blended, in a place lying in `regionIds` (spans for a region apply
 * only there). Undefined while no theme shows. Re-renders with the
 * playhead, so use it in small components.
 */
export function useThemeLook(worldId: string | undefined, regionIds?: readonly string[]): ThemeLook | undefined {
  const { spans, themes } = useWorldThemes(worldId)
  const t = usePlayhead(worldId)
  const key = regionIds?.join(',') ?? ''
  // eslint-disable-next-line react-hooks/exhaustive-deps -- regions by value, so a new array with the same ids doesn't recompute
  return useMemo(() => (spans.length ? themeAt(spans, themes, t, regionIds) : undefined), [spans, themes, t, key])
}
