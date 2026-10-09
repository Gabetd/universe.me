import { z } from 'zod'
import { liveRecord } from './command-kit'
import type { HandlerMap } from './commands'
import { NewId, create, deleteWith, deletes, recordCrud, refsWhere, upsert } from './record-kit'
import { Id } from './schema'
import { POWER_TEMPLATE_INFO, PowerAge, PowerSystem, PowerTemplate, powerAgeId } from './powers'
import { stripUndefined } from './util'

const SystemFields = PowerSystem.pick({ name: true, template: true, color: true, summary: true, aspects: true, values: true, notes: true })
const AgeFields = PowerAge.pick({ summary: true, strength: true, values: true })
export type PowerPatch = Partial<z.infer<typeof SystemFields>>
export type PowerAgePatch = Partial<z.infer<typeof AgeFields>>

const system = recordCrud('power', SystemFields)

export const POWER_COMMANDS = [
  /** A power system on a world, starting from a template's name, colour and aspects. */
  z.object({ type: z.literal('power.create'), payload: SystemFields.partial().extend({ ...NewId, ownerId: Id, template: PowerTemplate.optional() }) }),
  /** `power.delete` takes its age entries with it. */
  ...system.commands,
  /** What's different about a system in one of its world's eras (creating the entry the first time); fields not given stay. */
  z.object({ type: z.literal('powerAge.set'), payload: z.object({ systemId: Id, eraId: Id, patch: AgeFields.partial() }) }),
  /** Forgets a system's entry for an era: it's back to its always-true answers then. */
  z.object({ type: z.literal('powerAge.delete'), payload: z.object({ id: Id }) })
] as const

type PowerCommand = z.infer<(typeof POWER_COMMANDS)[number]>

export const powerHandlers: HandlerMap<PowerCommand> = {
  'power.create': (store, { id, ownerId, template = 'other', ...p }, ctx) => {
    const t = POWER_TEMPLATE_INFO[template]
    return create(store, 'power', ctx, ownerId, id, { name: t.name, template, color: t.color, summary: '', aspects: t.aspects, values: {}, notes: '', ...stripUndefined(p) })
  },
  'power.update': system.update,
  'power.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'power', id }, ({ ownerId }) => ({ remove: refsWhere(store, 'powerAge', ownerId, (a) => a.systemId === id) })),
  'powerAge.set': (store, { systemId, eraId, patch }, ctx) => {
    const { ownerId } = liveRecord(store, 'power', systemId)
    const fields = { summary: '', strength: null, values: {}, ...stripUndefined(patch) }
    return upsert(
      store, 'powerAge', ctx, ownerId, powerAgeId(systemId, eraId), { systemId, eraId, ...fields },
      (previous) => ({ type: 'powerAge.set', payload: { systemId, eraId, patch: previous } }),
      { type: 'record.remove', payload: { refs: [{ kind: 'powerAge', id: powerAgeId(systemId, eraId) }] } },
      stripUndefined(patch)
    )
  },
  'powerAge.delete': deletes('powerAge')
}
