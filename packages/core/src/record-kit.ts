import { z } from 'zod'
import {
  CommandError,
  batchOf,
  checkEdge,
  edgeTable,
  liveNode,
  liveRecord,
  liveRegion,
  liveWorld,
  patchRow,
  previousValues,
  requireRow,
  sameOwner,
  softDelete,
  type Check,
  type CommandContext,
  type HandlerResult,
  type Run
} from './command-kit'
import type { Command, Handler } from './commands'
import { RECORD_KINDS, type RecordKind, type RecordOf } from './records'
import { Id } from './schema'
import type { Store } from './store'
import { findBlueprint } from './builtin-blueprints'
import type { Blueprint } from './structures'
import { stripUndefined } from './util'
import { factionValidators, liveParty } from './faction-validators'
import { sameParty } from './factions'
import { powerValidators } from './power-validators'
import { themeValidators } from './theme-validators'
import { worldSimValidators } from './world-sim-validators'

/** Creating, updating and deleting records of any kind (records.ts), with each kind's checks. */

export const NewId = { id: Id.optional() }
/** What a delete names. */
export const ById = z.object({ id: Id })
export const Ref = z.object({ kind: z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]), id: Id })
export type Ref = z.infer<typeof Ref>

/**
 * A record kind's `name.update` and `name.delete` commands (`name` is the
 * kind's, unless the UI knows it by another): their schemas, and the plain
 * handlers that patch a record and delete it on its own.
 */
export function recordCrud<K extends RecordKind, F extends z.ZodRawShape, const N extends string = K>(kind: K, fields: z.ZodObject<F>, name: N = kind as unknown as N) {
  const Patch = fields.partial()
  return {
    commands: [
      z.object({ type: z.literal(`${name}.update` as const), payload: z.object({ id: Id, patch: Patch }) }),
      z.object({ type: z.literal(`${name}.delete` as const), payload: ById })
    ] as const,
    update: ((store, { id, patch }, ctx) => update(store, kind, ctx, id, patch as Partial<Fields<K>>, name)) as Handler<{ id: string; patch: z.infer<typeof Patch> }>,
    delete: deletes(kind)
  }
}

/** The plain handler of a delete: the record goes on its own. */
export function deletes<K extends RecordKind>(kind: K): Handler<z.infer<typeof ById>> {
  return (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind, id })
}

/** Checks a record against the rest of the project. */
export const validate = <K extends RecordKind>(store: Store, kind: K, record: RecordOf<K>, check: Partial<Check<K>> = {}) =>
  validators[kind](store, record, { verified: new Set(), edges: edgeTable(store), ...check })

/** Checks a record against the rest of the project; run on every create, update and restore. */
const validators: { [K in RecordKind]: (store: Store, record: RecordOf<K>, check: Check<K>) => void } = {
  event(store, e, { previous }) {
    const owner = liveNode(store, e.ownerId)
    if (e.end !== null && e.end < e.start) throw new CommandError('An event cannot end before it starts')
    if (e.laneId) sameOwner(liveRecord(store, 'lane', e.laneId), e.ownerId, 'lane')
    if (e.groupId) sameOwner(liveRecord(store, 'group', e.groupId), e.ownerId, 'group')
    if (e.locations.length && owner.kind !== 'world') throw new CommandError('Only events on a world surface can have locations')
    for (const loc of e.locations) {
      if (loc.kind === 'region' && liveRegion(store, loc.regionId).worldId !== e.ownerId) throw new CommandError('That region is on another world')
    }
    for (const p of e.participants ?? []) if (!previous?.participants?.some((q) => sameParty(p, q))) liveParty(store, p, e.ownerId)
  },
  link(store, l, check) {
    if (l.fromId === l.toId) throw new CommandError('An event cannot be linked to itself')
    checkEdge(store, 'link', 'event', l, check, 'That event is on another timeline', 'Those events are already linked')
  },
  group: (store, g) => void liveNode(store, g.ownerId),
  era(store, e) {
    liveNode(store, e.ownerId)
    if (e.end < e.start) throw new CommandError('An era cannot end before it starts')
  },
  lane: (store, l) => void liveNode(store, l.ownerId),
  change(store, c) {
    if (liveRegion(store, c.entityId).worldId !== c.ownerId) throw new CommandError('That region is on another world')
    if (c.causeEventId) sameOwner(liveRecord(store, 'event', c.causeEventId), c.ownerId, 'event')
    if (c.change === 'update' && Object.keys(stripUndefined(c.patch)).length === 0) throw new CommandError('A change needs something to change')
  },
  timeline: (store, t) => void liveNode(store, t.ownerId),
  blueprint(store, b) {
    liveNode(store, b.ownerId)
    if (!b.parts.length && !b.model) throw new CommandError('A blueprint needs at least one part or a model')
  },
  structure(store, s, { verified }) {
    if (!verified.has(s.ownerId)) liveWorld(store, s.ownerId)
    if (!verified.has(s.blueprintId)) blueprintOf(store, s.blueprintId)
  },
  maintenance(store, m, { verified }) {
    if (!verified.has(m.structureId)) sameOwner(liveRecord(store, 'structure', m.structureId), m.ownerId, 'structure')
    if (m.causeEventId) sameOwner(liveRecord(store, 'event', m.causeEventId), m.ownerId, 'event')
  },
  // Targets aren't checked: a structure or region it names may be deleted later, and then it simply reaches nothing.
  effect(store, e, { verified }) {
    if (!verified.has(e.eventId)) sameOwner(liveRecord(store, 'event', e.eventId), e.ownerId, 'event')
    if (e.type === 'modify' && !e.rename && !e.blueprintId) throw new CommandError('A modify effect needs a new name or blueprint')
  },
  // A stop's event isn't checked, like effect targets: deleting the event just unlinks it.
  character(store, c) {
    liveWorld(store, c.ownerId)
    if (c.died !== null && c.died < c.born) throw new CommandError('A character cannot die before they are born')
  },
  ...worldSimValidators,
  ...themeValidators,
  ...powerValidators,
  ...factionValidators,
  finding: (store, f) => void liveWorld(store, f.ownerId)
}

/** A blueprint by id: a built-in one or one in the project's library. */
export function blueprintOf(store: Store, id: string): Blueprint {
  const found = findBlueprint([], id) ?? store.records('blueprint').get(id)
  if (!found || found.deletedAt) throw new CommandError(`Blueprint ${id} does not exist`)
  return found
}

export { sameOwner } from './command-kit'

export type Fields<K extends RecordKind> = Omit<RecordOf<K>, 'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'deletedAt'>

/** Creates a record. `verified` are ids the caller has just checked itself (see `Check`). */
export function create<K extends RecordKind>(store: Store, kind: K, ctx: CommandContext, ownerId: string, id: string | undefined, fields: Fields<K>, verified: string[] = []): HandlerResult {
  const recordId = id ?? ctx.newId()
  if (store.records(kind).get(recordId)) throw new CommandError(`${recordId} already exists`)
  const now = ctx.now()
  const record = { ...fields, id: recordId, ownerId, createdAt: now, updatedAt: now, deletedAt: null } as RecordOf<K>
  validate(store, kind, record, { verified: new Set(verified) })
  store.records(kind).insert(record)
  return { inverse: { type: 'record.remove', payload: { refs: [{ kind, id: recordId }] } }, target: { kind, id: recordId }, owner: ownerId }
}

/** Patches a live record; undone by `name.update` (`name` is the kind's, unless its commands go by another). */
export function update<K extends RecordKind>(store: Store, kind: K, ctx: CommandContext, id: string, patch: Partial<Fields<K>>, name: string = kind): HandlerResult {
  const record = liveRecord(store, kind, id)
  const previous = patchRow(store.records(kind), record, patch, ctx.now(), (next) => validate(store, kind, next, { previous: record }))
  const inverse = { type: `${name}.update`, payload: { id, patch: previous } } as unknown as Command
  return { inverse, target: { kind, id }, owner: record.ownerId }
}

/**
 * An owner's single record (stars, orbits, timeline settings): created with
 * `fields` the first time, otherwise given `patch` (all of `fields` unless
 * said), and brought back if it was removed. Undo puts back what was there:
 * `set` makes the command that writes earlier values back, `reset` the one
 * that undoes the create.
 */
export function upsert<K extends RecordKind>(
  store: Store, kind: K, ctx: CommandContext, ownerId: string, id: string, fields: Fields<K>,
  set: (previous: Partial<Fields<K>>) => Command, reset: Command, patch: Partial<Fields<K>> = fields
): HandlerResult {
  const existing = store.records(kind).get(id)
  if (!existing) return { ...create(store, kind, ctx, ownerId, id, fields), inverse: reset }
  const { deletedAt } = existing
  if (deletedAt) store.records(kind).update({ ...existing, deletedAt: null })
  const result = update(store, kind, ctx, id, patch)
  const restore = set(previousValues(existing as Record<string, unknown>, patch as Record<string, unknown>) as Partial<Fields<K>>)
  return { ...result, inverse: deletedAt ? batchOf([restore, { type: 'record.remove', payload: { refs: [{ kind, id }] } }]) : restore }
}

export function setDeleted(store: Store, refs: Ref[], deletedAt: string | null, now: string): string | undefined {
  let owner: string | undefined
  for (const { kind, id } of refs) {
    const record = requireRow(store.records(kind).get(id), kind, id)
    softDelete(store.records(kind), record, deletedAt, now)
    owner ??= record.ownerId
  }
  return owner
}

/** What goes with a deleted record: commands that unhook its dependents, and records deleted with it. */
export interface Dependents {
  detach?: Command[]
  remove?: Ref[]
}

/** Deletes a live record and its dependents (worked out from the record), all undone together. */
export function deleteWith<K extends RecordKind>(store: Store, ctx: CommandContext, run: Run, ref: { kind: K; id: string }, dependents: (record: RecordOf<K>) => Dependents = () => ({})): HandlerResult {
  const record = liveRecord(store, ref.kind, ref.id)
  const { detach = [], remove = [] } = dependents(record)
  const undo = detach.map((c) => run(c).inverse)
  const refs = [ref, ...remove]
  setDeleted(store, refs, ctx.now(), ctx.now())
  return { inverse: batchOf([{ type: 'record.restore', payload: { refs } }, ...undo.reverse()]), owner: record.ownerId }
}

export const live = <K extends RecordKind>(store: Store, kind: K) => store.records(kind).all()

/** Refs to an owner's live records of one kind that pass `keep`. */
export const refsWhere = <K extends RecordKind>(store: Store, kind: K, ownerId: string, keep: (record: RecordOf<K>) => boolean): Ref[] =>
  store.records(kind).byOwner(ownerId).flatMap((r) => (keep(r) ? [{ kind, id: r.id }] : []))

/** Updates that set `field` to null on an owner's records where it is `id` (a lane, a group or a cause that's going). */
export function clearRefs<K extends RecordKind>(store: Store, kind: K, ownerId: string, field: keyof Fields<K> & string, id: string): Command[] {
  return store.records(kind).byOwner(ownerId).flatMap((r) => ((r as Record<string, unknown>)[field] === id ? [{ type: `${kind}.update`, payload: { id: r.id, patch: { [field]: null } } } as Command] : []))
}

