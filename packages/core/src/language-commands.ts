import { z } from 'zod'
import { CommandError } from './command-kit'
import type { Command, HandlerMap } from './commands'
import { DEFAULT_LANGUAGE, LANGUAGE_PRESETS, Language, LanguageUse, languageUseOf } from './languages'
import { NewId, create, deleteWith, live, recordCrud } from './record-kit'
import { Id } from './schema'
import { stripUndefined } from './util'

const LanguageFields = Language.pick({ name: true, consonants: true, vowels: true, syllables: true, minSyllables: true, maxSyllables: true, endings: true, rules: true, notes: true })
const UseFields = LanguageUse.pick({ languageId: true, regionId: true })
export type LanguagePatch = Partial<z.infer<typeof LanguageFields>>

const language = recordCrud('language', LanguageFields)
const use = recordCrud('languageUse', UseFields)

export const LANGUAGE_COMMANDS = [
  /** A language in the library of `ownerId` (the project's universe), starting from a preset if named (else Common's sounds and rules). */
  z.object({ type: z.literal('language.create'), payload: LanguageFields.partial().extend({ ...NewId, ownerId: Id, preset: z.string().optional() }) }),
  /** `language.delete` takes every use of it with it. */
  ...language.commands,
  /** A node (`ownerId`) speaks a language, or a region of it (a world) does. */
  z.object({ type: z.literal('languageUse.create'), payload: UseFields.partial({ regionId: true }).extend({ ...NewId, ownerId: Id }) }),
  ...use.commands
] as const

type LanguageCommand = z.infer<(typeof LANGUAGE_COMMANDS)[number]>

export const languageHandlers: HandlerMap<LanguageCommand> = {
  'language.create': (store, { id, ownerId, preset, ...p }, ctx) => {
    const base = preset ? LANGUAGE_PRESETS[preset] : undefined
    if (preset && !base) throw new CommandError(`There is no ${preset} language to start from`)
    return create(store, 'language', ctx, ownerId, id, { ...(base ?? { ...DEFAULT_LANGUAGE, name: 'New language' }), notes: '', ...stripUndefined(p) })
  },
  'language.update': language.update,
  // Wherever it's spoken, it's spoken no more (a deleted node's uses stay with it, so either can be brought back).
  'language.delete': (store, { id }, ctx, run) =>
    deleteWith(store, ctx, run, { kind: 'language', id }, () => ({
      remove: live(store, 'languageUse').flatMap((u) => (u.languageId === id && !store.nodes.get(u.ownerId)?.deletedAt ? [{ kind: 'languageUse' as const, id: u.id }] : []))
    })),
  'languageUse.create': (store, { id, ownerId, languageId, regionId }, ctx) => create(store, 'languageUse', ctx, ownerId, id, { languageId, regionId: regionId ?? null }),
  'languageUse.update': use.update,
  'languageUse.delete': use.delete
}

/** What makes a node (`regionId` null) or a region of a world speak `languageId` (null: speak what's around it again): its use made, changed or taken away. */
export function speakCommands(uses: readonly LanguageUse[], ownerId: string, regionId: string | null, languageId: string | null): Command[] {
  const current = languageUseOf(uses, ownerId, regionId)
  if (!languageId) return current ? [{ type: 'languageUse.delete', payload: { id: current.id } }] : []
  if (current) return current.languageId === languageId ? [] : [{ type: 'languageUse.update', payload: { id: current.id, patch: { languageId } } }]
  return [{ type: 'languageUse.create', payload: { ownerId, regionId, languageId } }]
}
