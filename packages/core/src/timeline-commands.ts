import { z } from 'zod'
import { batchOf, edgeTable, ownerOf, pickColor, previousValues } from './command-kit'
import type { Command, HandlerMap } from './commands'
import { NewId, Ref, clearRefs, create, deleteWith, live, recordCrud, refsWhere, setDeleted, upsert, validate } from './record-kit'
import { Id } from './schema'
import { Time } from './time'
import { EntityChange, Era, EventGroup, EventLink, Lane, LinkType, TimelineEvent } from './timeline'

/** Fields of a record kind that commands may set. */
const EventFields = TimelineEvent.pick({
  title: true, start: true, end: true, precision: true, laneId: true, groupId: true, color: true, notes: true, tags: true, locations: true, canvas: true, canvasHidden: true
})
const EraFields = Era.pick({ name: true, start: true, end: true, color: true, notes: true })
const ChangeFields = EntityChange.pick({ at: true, change: true, patch: true, causeEventId: true, note: true })

const events = recordCrud('event', EventFields)
const links = recordCrud('link', EventLink.pick({ type: true, note: true }))
const groups = recordCrud('group', EventGroup.pick({ title: true, color: true, notes: true, collapsed: true }))
const eras = recordCrud('era', EraFields)
const lanes = recordCrud('lane', Lane.pick({ name: true, order: true }))
const changes = recordCrud('change', ChangeFields)

export const TIMELINE_COMMANDS = [
  z.object({
    type: z.literal('event.create'),
    payload: EventFields.partial().extend({ ...NewId, ownerId: Id, start: Time })
  }),
  ...events.commands,

  z.object({
    type: z.literal('link.create'),
    payload: z.object({ ...NewId, fromId: Id, toId: Id, type: LinkType.optional(), note: z.string().optional() })
  }),
  ...links.commands,

  z.object({
    type: z.literal('group.create'),
    payload: z.object({ ...NewId, ownerId: Id, title: z.string().min(1).max(200).optional(), color: EventGroup.shape.color.optional(), eventIds: z.array(Id).min(1) })
  }),
  ...groups.commands,

  z.object({ type: z.literal('era.create'), payload: EraFields.partial().extend({ ...NewId, ownerId: Id, start: Time, end: Time }) }),
  ...eras.commands,

  z.object({ type: z.literal('lane.create'), payload: z.object({ ...NewId, ownerId: Id, name: Lane.shape.name.optional(), order: z.number().optional() }) }),
  ...lanes.commands,

  z.object({
    type: z.literal('change.create'),
    payload: ChangeFields.partial().extend({ ...NewId, ownerId: Id, entityKind: EntityChange.shape.entityKind, entityId: Id, at: Time, change: EntityChange.shape.change })
  }),
  ...changes.commands,

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
  'event.update': events.update,
  // Its links and structure effects can't outlive it, so they go (and come back) with it; maintenance changes it caused stay, uncaused.
  // Those all share its owner; a character's stops aren't checked, so every character is looked at.
  'event.delete': (store, { id }, ctx, run) =>
    deleteWith(store, ctx, run, { kind: 'event', id }, ({ ownerId }) => ({
      detach: [
        ...clearRefs(store, 'maintenance', ownerId, 'causeEventId', id),
        ...live(store, 'character')
          .filter((c) => c.stops.some((s) => s.eventId === id))
          .map((c): Command => ({ type: 'character.update', payload: { id: c.id, patch: { stops: c.stops.map((s) => (s.eventId === id ? { ...s, eventId: null } : s)) } } }))
      ],
      remove: [...refsWhere(store, 'link', ownerId, (l) => l.fromId === id || l.toId === id), ...refsWhere(store, 'effect', ownerId, (e) => e.eventId === id)]
    })),

  'link.create': (store, { id, fromId, ...p }, ctx) =>
    create(store, 'link', ctx, ownerOf(store, 'event', fromId), id, { fromId, toId: p.toId, type: p.type ?? 'causes', note: p.note ?? '' }, [fromId]),
  'link.update': links.update,
  'link.delete': links.delete,

  'group.create'(store, { id, ownerId, title, color, eventIds }, ctx, run) {
    const created = create(store, 'group', ctx, ownerId, id, { title: title ?? 'New group', color: color ?? pickColor(ctx), notes: '', collapsed: false })
    const groupId = created.target!.id
    const undo = eventIds.map((eventId) => run({ type: 'event.update', payload: { id: eventId, patch: { groupId } } }).inverse)
    return { ...created, inverse: batchOf([...undo.reverse(), created.inverse]) }
  },
  'group.update': groups.update,
  // Deleting a group keeps its events, just ungrouped.
  'group.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'group', id }, ({ ownerId }) => ({ detach: clearRefs(store, 'event', ownerId, 'groupId', id) })),

  'era.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'era', ctx, ownerId, id, { name: p.name ?? 'New era', start: p.start, end: p.end, color: p.color ?? pickColor(ctx), notes: p.notes ?? '' }),
  'era.update': eras.update,
  'era.delete': eras.delete,

  'lane.create': (store, { id, ownerId, name, order }, ctx) => {
    const last = Math.max(0, ...store.records('lane').byOwner(ownerId).map((l) => l.order))
    return create(store, 'lane', ctx, ownerId, id, { name: name ?? 'New lane', order: order ?? last + 1 })
  },
  'lane.update': lanes.update,
  // Events in a deleted lane move to the default lane.
  'lane.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'lane', id }, ({ ownerId }) => ({ detach: clearRefs(store, 'event', ownerId, 'laneId', id) })),

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
  'change.update': changes.update,
  'change.delete': changes.delete,

  // A timeline's settings start out at their defaults, so undoing the first change goes back to those.
  'timeline.update': (store, { ownerId, patch }, ctx) => ({
    ...upsert(
      store, 'timeline', ctx, ownerId, ownerId, { now: patch.now ?? 0 },
      (previous) => ({ type: 'timeline.update', payload: { ownerId, patch: previous } }),
      { type: 'timeline.update', payload: { ownerId, patch: previousValues({ now: 0 }, patch) } },
      patch
    ),
    target: undefined
  }),

  'record.remove': (store, { refs }, ctx) => ({
    inverse: { type: 'record.restore', payload: { refs } },
    owner: setDeleted(store, refs, ctx.now(), ctx.now())
  }),
  'record.restore'(store, { refs }, ctx) {
    const owner = setDeleted(store, refs, null, ctx.now())
    // One read of the link tables for all the links coming back, not one each.
    const edges = edgeTable(store)
    for (const { kind, id } of refs) validate(store, kind, store.records(kind).get(id)!, { edges })
    return { inverse: { type: 'record.remove', payload: { refs } }, target: refs[0], owner }
  }
}

