import type { Command } from '@universe/core'
import { asCommand, useUi } from '../store'

/**
 * Puts a theme on a world from `start` to `end`, fading in and out over a
 * tenth of that: a theme from the library, or a new one from a preset (in
 * the project's library), in one undo step.
 */
export function themeSpanCommand(worldId: string, start: number, end: number, theme: { themeId: string } | { preset: string }): Command | undefined {
  const blend = (end - start) / 10
  const span = (themeId: string): Command => ({ type: 'themeSpan.create', payload: { ownerId: worldId, themeId, start, end, blendIn: blend, blendOut: blend } })
  if ('themeId' in theme) return span(theme.themeId)
  const rootId = useUi.getState().project?.rootId
  if (!rootId) return undefined
  const id = crypto.randomUUID()
  return asCommand([{ type: 'theme.create', payload: { id, ownerId: rootId, preset: theme.preset } }, span(id)])
}

/** The theme put on a world last (on any world), else the one edited last. */
export function lastUsedTheme(): string | undefined {
  const { themeSpans, themes } = useUi.getState().timeline
  const latest = <T extends { updatedAt: string }>(list: readonly T[]) => list.reduce<T | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined)
  return latest(themeSpans)?.themeId ?? latest(themes)?.id
}
