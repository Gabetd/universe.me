import { z } from 'zod'
import { CommandError, liveRecord, liveWorld, ownerOf } from './command-kit'
import type { Command, HandlerMap } from './commands'
import { ById, NewId, blueprintOf, create, deleteWith, live, recordCrud, refsWhere, update } from './record-kit'
import { base64ToBytes, bytesToBase64 } from './encoding'
import { Id } from './schema'
import { Blueprint, EventEffect, MaintenanceChange, Structure } from './structures'
import { Time } from './time'

/** The biggest asset (a 3D model), as base64: about 75 MB. */
const MAX_ASSET_BASE64 = 100_000_000

/** An asset as it's added (or synced): its bytes as base64. */
export const AssetFields = z.object({ name: z.string().min(1).max(260), mime: z.string().min(1).max(100), data: z.string().min(1).max(MAX_ASSET_BASE64) })

const BlueprintFields = Blueprint.pick({ name: true, parts: true, model: true, maintainedByDefault: true, tags: true })
const StructureFields = Structure.pick({
  name: true, blueprintId: true, lat: true, lon: true, rotation: true, scale: true, builtAt: true, maintained: true, neverDecays: true, label: true, notes: true, tags: true
})
export type StructurePatch = Partial<z.infer<typeof StructureFields>>
export type EffectPatch = Partial<z.infer<typeof EffectFields>>

const EffectFields = EventEffect.pick({ type: true, target: true, filter: true, amount: true, maintained: true, rename: true, blueprintId: true })

const blueprints = recordCrud('blueprint', BlueprintFields)
const structures = recordCrud('structure', StructureFields)
const maintenances = recordCrud('maintenance', MaintenanceChange.pick({ at: true, maintained: true, causeEventId: true }))
const effects = recordCrud('effect', EffectFields)

export const STRUCTURE_COMMANDS = [
  z.object({ type: z.literal('blueprint.create'), payload: BlueprintFields.partial().extend({ ...NewId, ownerId: Id, name: Blueprint.shape.name }) }),
  ...blueprints.commands,

  z.object({
    type: z.literal('structure.create'),
    payload: StructureFields.partial().extend({ ...NewId, ownerId: Id, blueprintId: Id, lat: Structure.shape.lat, lon: Structure.shape.lon, builtAt: Time })
  }),
  ...structures.commands,

  /** Maintained (or not) from `at` on: replaces a change at that exact moment, otherwise adds one. */
  z.object({
    type: z.literal('maintenance.set'),
    payload: z.object({ structureId: Id, at: Time, maintained: z.boolean(), causeEventId: Id.nullable().optional() })
  }),
  ...maintenances.commands,

  /** Keeps a file (an imported model) in the project. `data` is base64. */
  z.object({ type: z.literal('asset.add'), payload: AssetFields.extend({ id: Id }) }),
  z.object({ type: z.literal('asset.remove'), payload: ById }),

  z.object({ type: z.literal('effect.create'), payload: EffectFields.partial().extend({ ...NewId, eventId: Id, type: EventEffect.shape.type, target: EventEffect.shape.target }) }),
  ...effects.commands
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
  'blueprint.update': blueprints.update,
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
    }, [ownerId, blueprintId])
  },
  'structure.update': structures.update,
  // Its maintenance history (which shares its owner) goes with it; effects that named it stop naming it. Targets aren't checked, so every effect is looked at.
  'structure.delete': (store, { id }, ctx, run) =>
    deleteWith(store, ctx, run, { kind: 'structure', id }, ({ ownerId }) => ({
      detach: live(store, 'effect')
        .filter((e) => e.target.kind === 'structures' && e.target.ids.includes(id))
        .map((e): Command => ({ type: 'effect.update', payload: { id: e.id, patch: { target: { kind: 'structures', ids: (e.target as { ids: string[] }).ids.filter((x) => x !== id) } } } })),
      remove: refsWhere(store, 'maintenance', ownerId, (m) => m.structureId === id)
    })),

  'maintenance.set'(store, { structureId, at, maintained, causeEventId }, ctx) {
    const structure = liveRecord(store, 'structure', structureId)
    const existing = store.records('maintenance').byOwner(structure.ownerId).find((m) => m.structureId === structureId && m.at === at)
    if (existing) return update(store, 'maintenance', ctx, existing.id, { maintained, ...(causeEventId !== undefined ? { causeEventId } : {}) })
    return create(store, 'maintenance', ctx, structure.ownerId, undefined, { structureId, at, maintained, causeEventId: causeEventId ?? null }, [structureId])
  },
  'maintenance.update': maintenances.update,
  'maintenance.delete': maintenances.delete,

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
    create(store, 'effect', ctx, ownerOf(store, 'event', eventId), id, {
      eventId,
      type: p.type,
      target: p.target,
      filter: p.filter ?? { tags: [], materials: [] },
      amount: p.amount ?? (p.type === 'repair' ? 100 : 40),
      maintained: p.maintained ?? false,
      rename: p.rename ?? null,
      blueprintId: p.blueprintId ?? null
    }, [eventId]),
  'effect.update': effects.update,
  'effect.delete': effects.delete
}
