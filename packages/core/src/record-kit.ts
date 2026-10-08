import { z } from 'zod'
import { CommandError, batchOf, liveNode, liveRecord, liveRegion, liveWorld, previousValues, type CommandContext, type HandlerResult, type Run } from './command-kit'
import type { Command } from './commands'
import { RECORD_KINDS, type RecordKind, type RecordOf } from './records'
import { Id } from './schema'
import type { Store } from './store'
import { findBlueprint } from './builtin-blueprints'
import type { Blueprint } from './structures'
import { stripUndefined } from './util'
import { worldSimValidators } from './world-sim-validators'

/** Creating, updating and deleting records of any kind (records.ts), with each kind's checks. */

export const NewId = { id: Id.optional() }
export const Ref = z.object({ kind: z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]), id: Id })
export type Ref = z.infer<typeof Ref>

/** Checks a record against the rest of the project. */
export const validate = <K extends RecordKind>(store: Store, kind: K, record: RecordOf<K>) => validators[kind](store, record)

/** Checks a record against the rest of the project; run on every create and update. */
const validators: { [K in RecordKind]: (store: Store, record: RecordOf<K>) => void } = {
  event(store, e) {
    const owner = liveNode(store, e.ownerId)
    if (e.end !== null && e.end < e.start) throw new CommandError('An event cannot end before it starts')
    if (e.laneId) sameOwner(liveRecord(store, 'lane', e.laneId), e.ownerId, 'lane')
    if (e.groupId) sameOwner(liveRecord(store, 'group', e.groupId), e.ownerId, 'group')
    if (e.locations.length && owner.kind !== 'world') throw new CommandError('Only events on a world surface can have locations')
    for (const loc of e.locations) {
      if (loc.kind === 'region' && liveRegion(store, loc.regionId).worldId !== e.ownerId) throw new CommandError('That region is on another world')
    }
  },
  link(store, l) {
    if (l.fromId === l.toId) throw new CommandError('An event cannot be linked to itself')
    for (const id of [l.fromId, l.toId]) sameOwner(liveRecord(store, 'event', id), l.ownerId, 'event')
    const duplicate = store.records('link').all().some((o) => o.id !== l.id && o.fromId === l.fromId && o.toId === l.toId)
    if (duplicate) throw new CommandError('Those events are already linked')
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
  structure(store, s) {
    liveWorld(store, s.ownerId)
    blueprintOf(store, s.blueprintId)
  },
  maintenance(store, m) {
    sameOwner(liveRecord(store, 'structure', m.structureId), m.ownerId, 'structure')
    if (m.causeEventId) sameOwner(liveRecord(store, 'event', m.causeEventId), m.ownerId, 'event')
  },
  // Targets aren't checked: a structure or region it names may be deleted later, and then it simply reaches nothing.
  effect(store, e) {
    sameOwner(liveRecord(store, 'event', e.eventId), e.ownerId, 'event')
    if (e.type === 'modify' && !e.rename && !e.blueprintId) throw new CommandError('A modify effect needs a new name or blueprint')
  },
  // A stop's event isn't checked, like effect targets: deleting the event just unlinks it.
  character(store, c) {
    liveWorld(store, c.ownerId)
    if (c.died !== null && c.died < c.born) throw new CommandError('A character cannot die before they are born')
  },
  ...worldSimValidators
}

/** A blueprint by id: a built-in one or one in the project's library. */
export function blueprintOf(store: Store, id: string): Blueprint {
  const found = findBlueprint([], id) ?? store.records('blueprint').get(id)
  if (!found || found.deletedAt) throw new CommandError(`Blueprint ${id} does not exist`)
  return found
}

export function sameOwner(record: { ownerId: string }, ownerId: string, what: string): void {
  if (record.ownerId !== ownerId) throw new CommandError(`That ${what} is on another timeline`)
}

export type Fields<K extends RecordKind> = Omit<RecordOf<K>, 'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'deletedAt'>

export function create<K extends RecordKind>(store: Store, kind: K, ctx: CommandContext, ownerId: string, id: string | undefined, fields: Fields<K>): HandlerResult {
  const recordId = id ?? ctx.newId()
  if (store.records(kind).get(recordId)) throw new CommandError(`${recordId} already exists`)
  const now = ctx.now()
  const record = { ...fields, id: recordId, ownerId, createdAt: now, updatedAt: now, deletedAt: null } as RecordOf<K>
  validate(store, kind, record)
  store.records(kind).insert(record)
  return { inverse: { type: 'record.remove', payload: { refs: [{ kind, id: recordId }] } }, target: { kind, id: recordId }, owner: ownerId }
}

export function update<K extends RecordKind>(store: Store, kind: K, ctx: CommandContext, id: string, patch: Partial<Fields<K>>): HandlerResult {
  const record = liveRecord(store, kind, id)
  const next = { ...record, ...stripUndefined(patch), updatedAt: ctx.now() } as RecordOf<K>
  validate(store, kind, next)
  store.records(kind).update(next)
  const inverse = { type: `${kind}.update`, payload: { id, patch: previousValues(record as Record<string, unknown>, patch as Record<string, unknown>) } } as Command
  return { inverse, target: { kind, id }, owner: record.ownerId }
}

export function setDeleted(store: Store, refs: Ref[], deletedAt: string | null, now: string): string | undefined {
  let owner: string | undefined
  for (const { kind, id } of refs) {
    const record = store.records(kind).get(id)
    if (!record) throw new CommandError(`${kind} ${id} does not exist`)
    store.records(kind).update({ ...record, deletedAt, updatedAt: now })
    owner ??= record.ownerId
  }
  return owner
}

/** Deletes a record after running `detach` (commands that unhook dependents), all undone together. */
export function deleteWith(store: Store, ctx: CommandContext, run: Run, ref: Ref, detach: Command[] = [], alsoRemove: Ref[] = []): HandlerResult {
  const record = liveRecord(store, ref.kind, ref.id)
  const undo = detach.map((c) => run(c).inverse)
  const refs = [ref, ...alsoRemove]
  setDeleted(store, refs, ctx.now(), ctx.now())
  return { inverse: batchOf([{ type: 'record.restore', payload: { refs } }, ...undo.reverse()]), owner: record.ownerId }
}

export const live = <K extends RecordKind>(store: Store, kind: K) => store.records(kind).all()

