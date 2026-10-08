import { z } from 'zod'
import { pickColor } from './command-kit'
import type { HandlerMap } from './commands'
import { Character, CharacterStop, sortStops } from './characters'
import { NewId, create, deleteWith, update } from './record-kit'
import { Id } from './schema'
import { Time } from './time'

const CharacterFields = Character.pick({ name: true, born: true, died: true, color: true, notes: true, tags: true, stops: true })
export type CharacterPatch = Partial<z.infer<typeof CharacterFields>>

export const CHARACTER_COMMANDS = [
  z.object({ type: z.literal('character.create'), payload: CharacterFields.partial().extend({ ...NewId, ownerId: Id, born: Time }) }),
  z.object({ type: z.literal('character.update'), payload: z.object({ id: Id, patch: CharacterFields.partial() }) }),
  z.object({ type: z.literal('character.delete'), payload: z.object({ id: Id }) }),
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
  'character.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'character', id }),
  'character.travel'(store, { id, stop }, ctx) {
    const character = store.records('character').get(id)
    return update(store, 'character', ctx, id, { stops: sortStops([...(character?.stops ?? []), stop]) })
  }
}
