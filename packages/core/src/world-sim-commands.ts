import { z } from 'zod'
import { Orbit, Star } from './astro'
import { batchOf, ownerOf, previousValues, type CommandContext, type HandlerResult } from './command-kit'
import type { Command, HandlerMap } from './commands'
import { EcoLink, Species } from './ecosystem'
import { NewId, create, deleteWith, refsWhere, update, type Fields } from './record-kit'
import type { RecordKind } from './records'
import { Id } from './schema'
import type { Store } from './store'

const StarFields = Star.pick({ massSun: true, luminositySun: true })
const OrbitFields = Orbit.pick({
  semiMajorAxisKm: true, eccentricity: true, inclinationDeg: true, phaseDeg: true, rotationHours: true, axialTiltDeg: true, massEarth: true, radiusKm: true, monthNames: true
})
const SpeciesFields = Species.pick({ name: true, kind: true, diet: true, biomes: true, color: true, notes: true, tags: true })
export type SpeciesPatch = Partial<z.infer<typeof SpeciesFields>>
export type OrbitFields = z.infer<typeof OrbitFields>

/** A system has at most one star record and a body one orbit, so their ids follow from the owner. */
export const starId = (systemId: string) => `star:${systemId}`
export const orbitId = (bodyId: string) => `orbit:${bodyId}`

export const WORLD_SIM_COMMANDS = [
  /** Sets a system's star (creating its record the first time). */
  z.object({ type: z.literal('star.set'), payload: z.object({ systemId: Id, star: StarFields }) }),
  z.object({ type: z.literal('star.reset'), payload: z.object({ systemId: Id }) }),
  /** Sets a body's orbit and spin in full (creating the record the first time); `orbit.reset` goes back to the defaults. */
  z.object({ type: z.literal('orbit.set'), payload: z.object({ bodyId: Id, orbit: OrbitFields }) }),
  z.object({ type: z.literal('orbit.reset'), payload: z.object({ bodyId: Id }) }),

  z.object({ type: z.literal('species.create'), payload: SpeciesFields.partial().extend({ ...NewId, ownerId: Id, name: Species.shape.name }) }),
  z.object({ type: z.literal('species.update'), payload: z.object({ id: Id, patch: SpeciesFields.partial() }) }),
  z.object({ type: z.literal('species.delete'), payload: z.object({ id: Id }) }),
  z.object({ type: z.literal('ecolink.create'), payload: z.object({ ...NewId, fromId: Id, toId: Id, type: EcoLink.shape.type.optional() }) }),
  z.object({ type: z.literal('ecolink.delete'), payload: z.object({ id: Id }) })
] as const

type WorldSimCommand = z.infer<(typeof WORLD_SIM_COMMANDS)[number]>

/** Creates the owner's single record, or replaces its fields (bringing it back if it was reset). Undo puts back what was there. */
function upsert<K extends 'star' | 'orbit'>(store: Store, kind: K, ctx: CommandContext, ownerId: string, id: string, fields: Fields<K>, set: (fields: Fields<K>) => Command, reset: Command): HandlerResult {
  const existing = store.records(kind).get(id)
  if (!existing) return { ...create(store, kind, ctx, ownerId, id, fields), inverse: reset }
  const { deletedAt } = existing
  if (deletedAt) store.records(kind).update({ ...existing, deletedAt: null })
  const result = update(store, kind, ctx, id, fields)
  const restore = set(previousValues(existing as Record<string, unknown>, fields as Record<string, unknown>) as Fields<K>)
  return { ...result, inverse: deletedAt ? batchOf([restore, { type: 'record.remove', payload: { refs: [{ kind: kind as RecordKind, id }] } }]) : restore }
}

export const worldSimHandlers: HandlerMap<WorldSimCommand> = {
  'star.set': (store, { systemId, star }, ctx) =>
    upsert(store, 'star', ctx, systemId, starId(systemId), star, (previous) => ({ type: 'star.set', payload: { systemId, star: previous } }), { type: 'star.reset', payload: { systemId } }),
  'star.reset': (store, { systemId }, ctx, run) => deleteWith(store, ctx, run, { kind: 'star', id: starId(systemId) }),
  'orbit.set': (store, { bodyId, orbit }, ctx) =>
    upsert(store, 'orbit', ctx, bodyId, orbitId(bodyId), orbit, (previous) => ({ type: 'orbit.set', payload: { bodyId, orbit: previous } }), {
      type: 'orbit.reset',
      payload: { bodyId }
    }),
  'orbit.reset': (store, { bodyId }, ctx, run) => deleteWith(store, ctx, run, { kind: 'orbit', id: orbitId(bodyId) }),

  'species.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'lifeform', ctx, ownerId, id, {
      name: p.name,
      kind: p.kind ?? 'fauna',
      diet: p.diet ?? (p.kind === 'flora' ? 'producer' : 'herbivore'),
      biomes: p.biomes ?? [],
      color: p.color ?? '#7fb069',
      notes: p.notes ?? '',
      tags: p.tags ?? []
    }),
  'species.update': (store, { id, patch }, ctx) => update(store, 'lifeform', ctx, id, patch),
  // Its links in the food web (which share its owner) go with it.
  'species.delete': (store, { id }, ctx, run) =>
    deleteWith(store, ctx, run, { kind: 'lifeform', id }, ({ ownerId }) => ({ remove: refsWhere(store, 'ecolink', ownerId, (l) => l.fromId === id || l.toId === id) })),
  'ecolink.create': (store, { id, fromId, toId, type }, ctx) => create(store, 'ecolink', ctx, ownerOf(store, 'lifeform', fromId), id, { fromId, toId, type: type ?? 'eats' }, [fromId]),
  'ecolink.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'ecolink', id })
}
