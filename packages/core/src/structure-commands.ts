import { z } from 'zod'
import { CommandError, liveRecord, liveWorld } from './command-kit'
import type { Command, HandlerMap } from './commands'
import { NewId, blueprintOf, create, deleteWith, live, update } from './record-kit'
import { base64ToBytes, bytesToBase64 } from './encoding'
import { Id } from './schema'
import { Blueprint, EventEffect, MaintenanceChange, Structure } from './structures'
import { Time } from './time'

const BlueprintFields = Blueprint.pick({ name: true, parts: true, model: true, maintainedByDefault: true, tags: true })
const StructureFields = Structure.pick({
  name: true, blueprintId: true, lat: true, lon: true, rotation: true, scale: true, builtAt: true, maintained: true, neverDecays: true, label: true, notes: true, tags: true
})
export type StructurePatch = Partial<z.infer<typeof StructureFields>>
export type EffectPatch = Partial<z.infer<typeof EffectFields>>

const EffectFields = EventEffect.pick({ type: true, target: true, filter: true, amount: true, maintained: true, rename: true, blueprintId: true })

export const STRUCTURE_COMMANDS = [
  z.object({ type: z.literal('blueprint.create'), payload: BlueprintFields.partial().extend({ ...NewId, ownerId: Id, name: Blueprint.shape.name }) }),
  z.object({ type: z.literal('blueprint.update'), payload: z.object({ id: Id, patch: BlueprintFields.partial() }) }),
  z.object({ type: z.literal('blueprint.delete'), payload: z.object({ id: Id }) }),

  z.object({
    type: z.literal('structure.create'),
    payload: StructureFields.partial().extend({ ...NewId, ownerId: Id, blueprintId: Id, lat: Structure.shape.lat, lon: Structure.shape.lon, builtAt: Time })
  }),
  z.object({ type: z.literal('structure.update'), payload: z.object({ id: Id, patch: StructureFields.partial() }) }),
  z.object({ type: z.literal('structure.delete'), payload: z.object({ id: Id }) }),

  /** Maintained (or not) from `at` on: replaces a change at that exact moment, otherwise adds one. */
  z.object({
    type: z.literal('maintenance.set'),
    payload: z.object({ structureId: Id, at: Time, maintained: z.boolean(), causeEventId: Id.nullable().optional() })
  }),
  z.object({ type: z.literal('maintenance.update'), payload: z.object({ id: Id, patch: MaintenanceChange.pick({ at: true, maintained: true, causeEventId: true }).partial() }) }),
  z.object({ type: z.literal('maintenance.delete'), payload: z.object({ id: Id }) }),

  /** Keeps a file (an imported model) in the project. `data` is base64. */
  z.object({ type: z.literal('asset.add'), payload: z.object({ id: Id, name: z.string().min(1).max(260), mime: z.string().min(1), data: z.string().min(1) }) }),
  z.object({ type: z.literal('asset.remove'), payload: z.object({ id: Id }) }),

  z.object({ type: z.literal('effect.create'), payload: EffectFields.partial().extend({ ...NewId, eventId: Id, type: EventEffect.shape.type, target: EventEffect.shape.target }) }),
  z.object({ type: z.literal('effect.update'), payload: z.object({ id: Id, patch: EffectFields.partial() }) }),
  z.object({ type: z.literal('effect.delete'), payload: z.object({ id: Id }) })
] as const

type StructureCommand = z.infer<(typeof STRUCTURE_COMMANDS)[number]>

export const structureHandlers: HandlerMap<StructureCommand> = {
  'blueprint.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'blueprint', ctx, ownerId, id, {
      name: p.name,
      parts: p.parts ?? [],
      model: p.model ?? null,
      maintainedByDefault: p.maintainedByDefault ?? true,
      tags: p.tags ?? []
    }),
  'blueprint.update': (store, { id, patch }, ctx) => update(store, 'blueprint', ctx, id, patch),
  'blueprint.delete'(store, { id }, ctx, run) {
    const users = live(store, 'structure').filter((s) => s.blueprintId === id)
    if (users.length) throw new CommandError(`${users.length === 1 ? `“${users[0]!.name}” uses` : `${users.length} structures use`} this blueprint`)
    return deleteWith(store, ctx, run, { kind: 'blueprint', id })
  },

  'structure.create'(store, { id, ownerId, blueprintId, ...p }, ctx) {
    liveWorld(store, ownerId)
    const blueprint = blueprintOf(store, blueprintId)
    return create(store, 'structure', ctx, ownerId, id, {
      name: p.name ?? blueprint.name,
      blueprintId,
      lat: p.lat,
      lon: p.lon,
      rotation: p.rotation ?? 0,
      scale: p.scale ?? 1,
      builtAt: p.builtAt,
      maintained: p.maintained ?? blueprint.maintainedByDefault,
      neverDecays: p.neverDecays ?? false,
      label: p.label ?? true,
      notes: p.notes ?? '',
      tags: p.tags ?? [...blueprint.tags]
    })
  },
  'structure.update': (store, { id, patch }, ctx) => update(store, 'structure', ctx, id, patch),
  // Its maintenance history goes with it; effects that named it stop naming it.
  'structure.delete'(store, { id }, ctx, run) {
    const detach: Command[] = live(store, 'effect')
      .filter((e) => e.target.kind === 'structures' && e.target.ids.includes(id))
      .map((e) => ({ type: 'effect.update', payload: { id: e.id, patch: { target: { kind: 'structures', ids: (e.target as { ids: string[] }).ids.filter((x) => x !== id) } } } }))
    const history = live(store, 'maintenance').filter((m) => m.structureId === id).map((m) => ({ kind: 'maintenance' as const, id: m.id }))
    return deleteWith(store, ctx, run, { kind: 'structure', id }, detach, history)
  },

  'maintenance.set'(store, { structureId, at, maintained, causeEventId }, ctx) {
    const structure = liveRecord(store, 'structure', structureId)
    const existing = live(store, 'maintenance').find((m) => m.structureId === structureId && m.at === at)
    if (existing) return update(store, 'maintenance', ctx, existing.id, { maintained, ...(causeEventId !== undefined ? { causeEventId } : {}) })
    return create(store, 'maintenance', ctx, structure.ownerId, undefined, { structureId, at, maintained, causeEventId: causeEventId ?? null })
  },
  'maintenance.update': (store, { id, patch }, ctx) => update(store, 'maintenance', ctx, id, patch),
  'maintenance.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'maintenance', id }),

  'asset.add'(store, { id, name, mime, data }) {
    if (store.assets.get(id)) throw new CommandError(`Asset ${id} already exists`)
    store.assets.put({ id, name, mime, data: base64ToBytes(data) })
    return { inverse: { type: 'asset.remove', payload: { id } } }
  },
  'asset.remove'(store, { id }) {
    const asset = store.assets.get(id)
    if (!asset) throw new CommandError(`Asset ${id} does not exist`)
    store.assets.remove(id)
    return { inverse: { type: 'asset.add', payload: { id, name: asset.name, mime: asset.mime, data: bytesToBase64(asset.data) } } }
  },

  'effect.create': (store, { id, eventId, ...p }, ctx) =>
    create(store, 'effect', ctx, liveRecord(store, 'event', eventId).ownerId, id, {
      eventId,
      type: p.type,
      target: p.target,
      filter: p.filter ?? { tags: [], materials: [] },
      amount: p.amount ?? (p.type === 'repair' ? 100 : 40),
      maintained: p.maintained ?? false,
      rename: p.rename ?? null,
      blueprintId: p.blueprintId ?? null
    }),
  'effect.update': (store, { id, patch }, ctx) => update(store, 'effect', ctx, id, patch),
  'effect.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'effect', id })
}
