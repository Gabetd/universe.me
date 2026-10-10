import { z } from 'zod'
import { pickColor } from './command-kit'
import type { HandlerMap } from './commands'
import { Character, CharacterStop, sortStops } from './characters'
import { characterDependents } from './faction-commands'
import { NewId, create, deleteWith, recordCrud, update } from './record-kit'
import { Id } from './schema'
import { Time } from './time'

const CharacterFields = Character.pick({ name: true, born: true, died: true, color: true, notes: true, tags: true, stops: true })
export type CharacterPatch = Partial<z.infer<typeof CharacterFields>>
const characters = recordCrud('character', CharacterFields)

export const CHARACTER_COMMANDS = [
  z.object({ type: z.literal('character.create'), payload: CharacterFields.partial().extend({ ...NewId, ownerId: Id, born: Time }) }),
  ...characters.commands,
  /** Adds a stop to the journey, kept in time order. */
  z.object({ type: z.literal('character.travel'), payload: z.object({ id: Id, stop: CharacterStop }) })
] as const

type CharacterCommand = z.infer<(typeof CHARACTER_COMMANDS)[number]>

export const characterHandlers: HandlerMap<CharacterCommand> = {
  'character.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'character', ctx, ownerId, id, {
      name: p.name ?? 'New character',
      born: p.born,
      died: p.died ?? null,
      color: p.color ?? pickColor(ctx),
      notes: p.notes ?? '',
      tags: p.tags ?? [],
      stops: sortStops(p.stops ?? [])
    }),
  'character.update': (store, { id, patch }, ctx) => update(store, 'character', ctx, id, patch.stops ? { ...patch, stops: sortStops(patch.stops) } : patch),
  'character.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'character', id }, ({ ownerId }) => characterDependents(store, ownerId, id)),
  'character.travel'(store, { id, stop }, ctx) {
    const character = store.records('character').get(id)
    return update(store, 'character', ctx, id, { stops: sortStops([...(character?.stops ?? []), stop]) })
  }
}
