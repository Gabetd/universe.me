import { z } from 'zod'
import { batchOf, liveRecord, pickColor, previousValues } from './command-kit'
import type { HandlerMap } from './commands'
import { NewId, Ref, create, deleteWith, live, setDeleted, update, validate } from './record-kit'
import { Id } from './schema'
import { Time } from './time'
import { EntityChange, Era, EventGroup, EventLink, Lane, LinkType, TimelineEvent } from './timeline'

/** Fields of a record kind that commands may set. */
const EventFields = TimelineEvent.pick({
  title: true, start: true, end: true, precision: true, laneId: true, groupId: true, color: true, notes: true, tags: true, locations: true, canvas: true, canvasHidden: true
})
const EraFields = Era.pick({ name: true, start: true, end: true, color: true, notes: true })
const ChangeFields = EntityChange.pick({ at: true, change: true, patch: true, causeEventId: true, note: true })

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
    for (const { kind, id } of refs) validate(store, kind, store.records(kind).get(id)!)
    return { inverse: { type: 'record.remove', payload: { refs } }, target: refs[0], owner }
  }
}

