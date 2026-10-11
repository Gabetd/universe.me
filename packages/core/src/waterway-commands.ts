import { z } from 'zod'
import { liveWorld } from './command-kit'
import type { HandlerMap } from './commands'
import { upsert } from './record-kit'
import { Id } from './schema'
import { Waterway, WaterwayKey, waterwayId } from './waterways'
import { stripUndefined } from './util'

const WaterwayFields = Waterway.pick({ name: true, notes: true })
export type WaterwayPatch = Partial<z.infer<typeof WaterwayFields>>

export const WATERWAY_COMMANDS = [
  /** Names a river or lake of a world, or writes its notes (creating its record the first time); fields not given stay. */
  z.object({ type: z.literal('waterway.set'), payload: z.object({ worldId: Id, key: WaterwayKey, patch: WaterwayFields.partial() }) })
] as const

type WaterwayCommand = z.infer<(typeof WATERWAY_COMMANDS)[number]>

export const waterwayHandlers: HandlerMap<WaterwayCommand> = {
  'waterway.set': (store, { worldId, key, patch }, ctx) => {
    liveWorld(store, worldId)
    const id = waterwayId(worldId, key)
    return upsert(
      store, 'waterway', ctx, worldId, id, { key, name: '', notes: '', ...stripUndefined(patch) },
      (previous) => ({ type: 'waterway.set', payload: { worldId, key, patch: previous } }),
      { type: 'record.remove', payload: { refs: [{ kind: 'waterway', id }] } },
      stripUndefined(patch)
    )
  }
}
