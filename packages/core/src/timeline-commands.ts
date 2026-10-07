import { z } from 'zod'
import { CommandError, batchOf, liveNode, liveRecord, liveRegion, pickColor, previousValues, type CommandContext, type HandlerResult, type Run } from './command-kit'
import type { Command, HandlerMap } from './commands'
import { Id } from './schema'
import type { Store } from './store'
import { Time } from './time'
import {
  EntityChange,
  Era,
  EventGroup,
  EventLink,
  Lane,
  LinkType,
  RECORD_KINDS,
  TimelineEvent,
  type RecordKind,
  type RecordOf
} from './timeline'
import { stripUndefined } from './util'

/** Fields of a record kind that commands may set. */
const EventFields = TimelineEvent.pick({
  title: true, start: true, end: true, precision: true, laneId: true, groupId: true, color: true, notes: true, tags: true, locations: true, canvas: true, canvasHidden: true
})
const EraFields = Era.pick({ name: true, start: true, end: true, color: true, notes: true })
const ChangeFields = EntityChange.pick({ at: true, change: true, patch: true, causeEventId: true, note: true })

const NewId = { id: Id.optional() }
const Ref = z.object({ kind: z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]), id: Id })
type Ref = z.infer<typeof Ref>

export const TIMELINE_COMMANDS = [
  z.object({
    type: z.literal('event.create'),
    payload: EventFields.partial().extend({ ...NewId, ownerId: Id, start: Time })
  }),
  z.object({ type: z.literal('event.update'), payload: z.object({ id: Id, patch: EventFields.partial() }) }),
  z.object({ type: z.literal('event.delete'), payload: z.object({ id: Id }) }),

  z.object({
    type: z.literal('link.create'),
    payload: z.object({ ...NewId, fromId: Id, toId: Id, type: LinkType.optional(), note: z.string().optional() })
  }),
  z.object({ type: z.literal('link.update'), payload: z.object({ id: Id, patch: EventLink.pick({ type: true, note: true }).partial() }) }),
  z.object({ type: z.literal('link.delete'), payload: z.object({ id: Id }) }),

  z.object({
    type: z.literal('group.create'),
    payload: z.object({ ...NewId, ownerId: Id, title: z.string().min(1).max(200).optional(), color: EventGroup.shape.color.optional(), eventIds: z.array(Id).min(1) })
  }),
  z.object({
    type: z.literal('group.update'),
    payload: z.object({ id: Id, patch: EventGroup.pick({ title: true, color: true, notes: true, collapsed: true }).partial() })
  }),
  z.object({ type: z.literal('group.delete'), payload: z.object({ id: Id }) }),

  z.object({ type: z.literal('era.create'), payload: EraFields.partial().extend({ ...NewId, ownerId: Id, start: Time, end: Time }) }),
  z.object({ type: z.literal('era.update'), payload: z.object({ id: Id, patch: EraFields.partial() }) }),
  z.object({ type: z.literal('era.delete'), payload: z.object({ id: Id }) }),

  z.object({ type: z.literal('lane.create'), payload: z.object({ ...NewId, ownerId: Id, name: Lane.shape.name.optional(), order: z.number().optional() }) }),
  z.object({ type: z.literal('lane.update'), payload: z.object({ id: Id, patch: Lane.pick({ name: true, order: true }).partial() }) }),
  z.object({ type: z.literal('lane.delete'), payload: z.object({ id: Id }) }),

  z.object({
    type: z.literal('change.create'),
    payload: ChangeFields.partial().extend({ ...NewId, ownerId: Id, entityKind: EntityChange.shape.entityKind, entityId: Id, at: Time, change: EntityChange.shape.change })
  }),
  z.object({ type: z.literal('change.update'), payload: z.object({ id: Id, patch: ChangeFields.partial() }) }),
  z.object({ type: z.literal('change.delete'), payload: z.object({ id: Id }) }),

  z.object({ type: z.literal('timeline.update'), payload: z.object({ ownerId: Id, patch: z.object({ now: Time.optional() }) }) }),

  /** Plain soft delete / undelete of records, without cascading. Inverses of the deletes above. */
  z.object({ type: z.literal('record.remove'), payload: z.object({ refs: z.array(Ref).min(1) }) }),
  z.object({ type: z.literal('record.restore'), payload: z.object({ refs: z.array(Ref).min(1) }) })
] as const

type TimelineCommand = z.infer<(typeof TIMELINE_COMMANDS)[number]>

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
  timeline: (store, t) => void liveNode(store, t.ownerId)
}

function sameOwner(record: { ownerId: string }, ownerId: string, what: string): void {
  if (record.ownerId !== ownerId) throw new CommandError(`That ${what} is on another timeline`)
}

type Fields<K extends RecordKind> = Omit<RecordOf<K>, 'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'deletedAt'>

function create<K extends RecordKind>(store: Store, kind: K, ctx: CommandContext, ownerId: string, id: string | undefined, fields: Fields<K>): HandlerResult {
  const recordId = id ?? ctx.newId()
  if (store.records(kind).get(recordId)) throw new CommandError(`${recordId} already exists`)
  const now = ctx.now()
  const record = { ...fields, id: recordId, ownerId, createdAt: now, updatedAt: now, deletedAt: null } as RecordOf<K>
  validators[kind](store, record)
  store.records(kind).insert(record)
  return { inverse: { type: 'record.remove', payload: { refs: [{ kind, id: recordId }] } }, target: { kind, id: recordId }, owner: ownerId }
}

function update<K extends RecordKind>(store: Store, kind: K, ctx: CommandContext, id: string, patch: Partial<Fields<K>>): HandlerResult {
  const record = liveRecord(store, kind, id)
  const next = { ...record, ...stripUndefined(patch), updatedAt: ctx.now() } as RecordOf<K>
  validators[kind](store, next)
  store.records(kind).update(next)
  const inverse = { type: `${kind}.update`, payload: { id, patch: previousValues(record as Record<string, unknown>, patch as Record<string, unknown>) } } as Command
  return { inverse, target: { kind, id }, owner: record.ownerId }
}

function setDeleted(store: Store, refs: Ref[], deletedAt: string | null, now: string): string | undefined {
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
function deleteWith(store: Store, ctx: CommandContext, run: Run, ref: Ref, detach: Command[] = [], alsoRemove: Ref[] = []): HandlerResult {
  const record = liveRecord(store, ref.kind, ref.id)
  const undo = detach.map((c) => run(c).inverse)
  const refs = [ref, ...alsoRemove]
  setDeleted(store, refs, ctx.now(), ctx.now())
  return { inverse: batchOf([{ type: 'record.restore', payload: { refs } }, ...undo.reverse()]), owner: record.ownerId }
}

const live = <K extends RecordKind>(store: Store, kind: K) => store.records(kind).all()

export const timelineHandlers: HandlerMap<TimelineCommand> = {
  'event.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'event', ctx, ownerId, id, {
      title: p.title ?? 'New event',
      start: p.start,
      end: p.end ?? null,
      precision: p.precision ?? 'year',
      laneId: p.laneId ?? null,
      groupId: p.groupId ?? null,
      color: p.color ?? pickColor(ctx),
      notes: p.notes ?? '',
      tags: p.tags ?? [],
      locations: p.locations ?? [],
      canvas: p.canvas ?? null,
      canvasHidden: p.canvasHidden ?? false
    }),
  'event.update': (store, { id, patch }, ctx) => update(store, 'event', ctx, id, patch),
  // Links can't outlive their events, so they go (and come back) with them.
  'event.delete': (store, { id }, ctx, run) =>
    deleteWith(store, ctx, run, { kind: 'event', id }, [], live(store, 'link').filter((l) => l.fromId === id || l.toId === id).map((l) => ({ kind: 'link', id: l.id }))),

  'link.create': (store, { id, fromId, ...p }, ctx) =>
    create(store, 'link', ctx, liveRecord(store, 'event', fromId).ownerId, id, { fromId, toId: p.toId, type: p.type ?? 'causes', note: p.note ?? '' }),
  'link.update': (store, { id, patch }, ctx) => update(store, 'link', ctx, id, patch),
  'link.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'link', id }),

  'group.create'(store, { id, ownerId, title, color, eventIds }, ctx, run) {
    const created = create(store, 'group', ctx, ownerId, id, { title: title ?? 'New group', color: color ?? pickColor(ctx), notes: '', collapsed: false })
    const groupId = created.target!.id
    const undo = eventIds.map((eventId) => run({ type: 'event.update', payload: { id: eventId, patch: { groupId } } }).inverse)
    return { ...created, inverse: batchOf([...undo.reverse(), created.inverse]) }
  },
  'group.update': (store, { id, patch }, ctx) => update(store, 'group', ctx, id, patch),
  // Deleting a group keeps its events, just ungrouped.
  'group.delete': (store, { id }, ctx, run) =>
    deleteWith(
      store, ctx, run, { kind: 'group', id },
      live(store, 'event').filter((e) => e.groupId === id).map((e) => ({ type: 'event.update', payload: { id: e.id, patch: { groupId: null } } }))
    ),

  'era.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'era', ctx, ownerId, id, { name: p.name ?? 'New era', start: p.start, end: p.end, color: p.color ?? pickColor(ctx), notes: p.notes ?? '' }),
  'era.update': (store, { id, patch }, ctx) => update(store, 'era', ctx, id, patch),
  'era.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'era', id }),

  'lane.create': (store, { id, ownerId, name, order }, ctx) => {
    const last = Math.max(0, ...live(store, 'lane').filter((l) => l.ownerId === ownerId).map((l) => l.order))
    return create(store, 'lane', ctx, ownerId, id, { name: name ?? 'New lane', order: order ?? last + 1 })
  },
  'lane.update': (store, { id, patch }, ctx) => update(store, 'lane', ctx, id, patch),
  // Events in a deleted lane move to the default lane.
  'lane.delete': (store, { id }, ctx, run) =>
    deleteWith(
      store, ctx, run, { kind: 'lane', id },
      live(store, 'event').filter((e) => e.laneId === id).map((e) => ({ type: 'event.update', payload: { id: e.id, patch: { laneId: null } } }))
    ),

  'change.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'change', ctx, ownerId, id, {
      entityKind: p.entityKind,
      entityId: p.entityId,
      at: p.at,
      change: p.change,
      patch: p.patch ?? {},
      causeEventId: p.causeEventId ?? null,
      note: p.note ?? ''
    }),
  'change.update': (store, { id, patch }, ctx) => update(store, 'change', ctx, id, patch),
  'change.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'change', id }),

  'timeline.update'(store, { ownerId, patch }, ctx) {
    const existing = store.records('timeline').get(ownerId)
    if (!existing) create(store, 'timeline', ctx, ownerId, ownerId, { now: 0 })
    const result = update(store, 'timeline', ctx, ownerId, patch)
    return { ...result, inverse: { type: 'timeline.update', payload: { ownerId, patch: previousValues(existing ?? { now: 0 }, patch) } }, target: undefined }
  },

  'record.remove': (store, { refs }, ctx) => ({
    inverse: { type: 'record.restore', payload: { refs } },
    owner: setDeleted(store, refs, ctx.now(), ctx.now())
  }),
  'record.restore'(store, { refs }, ctx) {
    const owner = setDeleted(store, refs, null, ctx.now())
    for (const { kind, id } of refs) validators[kind](store, store.records(kind).get(id) as never)
    return { inverse: { type: 'record.remove', payload: { refs } }, target: refs[0], owner }
  }
}

