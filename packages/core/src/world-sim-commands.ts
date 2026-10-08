import { z } from 'zod'
import { Orbit, Star } from './astro'
import { ownerOf } from './command-kit'
import type { HandlerMap } from './commands'
import { EcoLink, Species } from './ecosystem'
import { ById, NewId, create, deleteWith, deletes, recordCrud, refsWhere, upsert } from './record-kit'
import { Id } from './schema'

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

const species = recordCrud('lifeform', SpeciesFields, 'species')

export const WORLD_SIM_COMMANDS = [
  /** Sets a system's star (creating its record the first time). */
  z.object({ type: z.literal('star.set'), payload: z.object({ systemId: Id, star: StarFields }) }),
  z.object({ type: z.literal('star.reset'), payload: z.object({ systemId: Id }) }),
  /** Sets a body's orbit and spin in full (creating the record the first time); `orbit.reset` goes back to the defaults. */
  z.object({ type: z.literal('orbit.set'), payload: z.object({ bodyId: Id, orbit: OrbitFields }) }),
  z.object({ type: z.literal('orbit.reset'), payload: z.object({ bodyId: Id }) }),

  z.object({ type: z.literal('species.create'), payload: SpeciesFields.partial().extend({ ...NewId, ownerId: Id, name: Species.shape.name }) }),
  ...species.commands,
  z.object({ type: z.literal('ecolink.create'), payload: z.object({ ...NewId, fromId: Id, toId: Id, type: EcoLink.shape.type.optional() }) }),
  z.object({ type: z.literal('ecolink.delete'), payload: ById })
] as const

type WorldSimCommand = z.infer<(typeof WORLD_SIM_COMMANDS)[number]>

export const worldSimHandlers: HandlerMap<WorldSimCommand> = {
  // Set in full, so what undo puts back is full too.
  'star.set': (store, { systemId, star }, ctx) =>
    upsert(store, 'star', ctx, systemId, starId(systemId), star, (previous) => ({ type: 'star.set', payload: { systemId, star: previous as typeof star } }), { type: 'star.reset', payload: { systemId } }),
  'star.reset': (store, { systemId }, ctx, run) => deleteWith(store, ctx, run, { kind: 'star', id: starId(systemId) }),
  'orbit.set': (store, { bodyId, orbit }, ctx) =>
    upsert(store, 'orbit', ctx, bodyId, orbitId(bodyId), orbit, (previous) => ({ type: 'orbit.set', payload: { bodyId, orbit: previous as typeof orbit } }), {
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
  'species.update': species.update,
  // Its links in the food web (which share its owner) go with it.
  'species.delete': (store, { id }, ctx, run) =>
    deleteWith(store, ctx, run, { kind: 'lifeform', id }, ({ ownerId }) => ({ remove: refsWhere(store, 'ecolink', ownerId, (l) => l.fromId === id || l.toId === id) })),
  'ecolink.create': (store, { id, fromId, toId, type }, ctx) => create(store, 'ecolink', ctx, ownerOf(store, 'lifeform', fromId), id, { fromId, toId, type: type ?? 'eats' }, [fromId]),
  'ecolink.delete': deletes('ecolink')
}
