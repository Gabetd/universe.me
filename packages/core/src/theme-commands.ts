import { z } from 'zod'
import { CommandError } from './command-kit'
import type { HandlerMap } from './commands'
import { NewId, create, deleteWith, live, recordCrud } from './record-kit'
import { Id } from './schema'
import { THEME_PRESETS, Theme, ThemeSpan } from './themes'
import { Time } from './time'

const ThemeFields = Theme.pick({ name: true, palette: true, lighting: true, atmosphere: true, typography: true, mood: true, style: true, ambience: true, notes: true })
const SpanFields = ThemeSpan.pick({ themeId: true, start: true, end: true, regionId: true, priority: true, blendIn: true, blendOut: true })
export type ThemePatch = Partial<z.infer<typeof ThemeFields>>
export type ThemeSpanPatch = Partial<z.infer<typeof SpanFields>>

const theme = recordCrud('theme', ThemeFields)
const span = recordCrud('themeSpan', SpanFields)

export const THEME_COMMANDS = [
  /** A theme in the library of `ownerId` (the project's universe), starting from a preset if named. */
  z.object({ type: z.literal('theme.create'), payload: ThemeFields.partial().extend({ ...NewId, ownerId: Id, preset: z.string().optional() }) }),
  /** `theme.delete` takes every span that uses the theme with it. */
  ...theme.commands,
  z.object({ type: z.literal('themeSpan.create'), payload: SpanFields.partial().extend({ ...NewId, ownerId: Id, themeId: Id, start: Time, end: Time }) }),
  ...span.commands
] as const

type ThemeCommand = z.infer<(typeof THEME_COMMANDS)[number]>

export const themeHandlers: HandlerMap<ThemeCommand> = {
  'theme.create': (store, { id, ownerId, preset, ...p }, ctx) => {
    const base = preset ? THEME_PRESETS[preset] : undefined
    if (preset && !base) throw new CommandError(`There is no ${preset} theme to start from`)
    const from = base ?? THEME_PRESETS.Verdant!
    return create(store, 'theme', ctx, ownerId, id, {
      name: p.name ?? (base ? base.name : 'New theme'),
      palette: p.palette ?? from.palette,
      lighting: p.lighting ?? from.lighting,
      atmosphere: p.atmosphere ?? from.atmosphere,
      typography: p.typography ?? from.typography,
      mood: p.mood ?? (base ? base.mood : []),
      style: p.style ?? (base ? base.style : ''),
      ambience: p.ambience ?? (base ? base.ambience : []),
      notes: p.notes ?? ''
    })
  },
  'theme.update': theme.update,
  // Spans of it on any world go with it.
  'theme.delete': (store, { id }, ctx, run) =>
    deleteWith(store, ctx, run, { kind: 'theme', id }, () => ({ remove: live(store, 'themeSpan').flatMap((s) => (s.themeId === id ? [{ kind: 'themeSpan' as const, id: s.id }] : [])) })),
  'themeSpan.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'themeSpan', ctx, ownerId, id, {
      themeId: p.themeId,
      start: p.start,
      end: p.end,
      regionId: p.regionId ?? null,
      priority: p.priority ?? 0,
      blendIn: p.blendIn ?? 0,
      blendOut: p.blendOut ?? 0
    }),
  'themeSpan.update': span.update,
  'themeSpan.delete': span.delete
}
