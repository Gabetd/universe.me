import { z } from 'zod'
import { CommandError } from './command-kit'
import type { HandlerMap } from './commands'
import { Conflict, conflictId } from './conflicts'
import { fieldsOf, rowOf, valueAt } from './fields'
import type { LostField } from './field-stamps'
import { patchThrough } from './footprint'
import { RECORD_SCHEMAS } from './records'
import { validate } from './record-kit'
import { Id, SpatialNode } from './schema'
import type { Store } from './store'
import { parseRefKey, readRow, type SyncRef } from './sync'
import { Region, WorldSettings } from './world'

/** Putting back what a conflict note kept (conflicts.ts); dismissing one is removing it, as any record. */
export const CONFLICT_COMMANDS = [
  /** The version a conflict note kept, put back in its place; the note is done with (taken off). */
  z.object({ type: z.literal('conflict.use'), payload: z.object({ id: Id }) }),
  /** Undoing that: the field as it was, and the note open again. */
  z.object({ type: z.literal('conflict.unuse'), payload: z.object({ id: Id, value: z.unknown(), removed: z.boolean() }) })
] as const

type ConflictCommand = z.infer<(typeof CONFLICT_COMMANDS)[number]>

/** A row with a field set to `value` (or taken out). */
function withField(row: unknown, path: string, value: unknown, removed: boolean): unknown {
  const fields = [...fieldsOf(row)].filter(([p]) => p !== path && !p.startsWith(`${path}/`))
  return rowOf(removed ? fields : [...fields, [path, value] as const])
}

/** Writes a row of fields as it now is, checked like any other write of it. */
function putRow(store: Store, ref: SyncRef, data: unknown): void {
  const fail = (err: unknown): never => {
    throw new CommandError(`That version can’t be put back: ${err instanceof z.ZodError ? (err.issues[0]?.message ?? 'not valid') : (err as Error).message}`)
  }
  try {
    switch (ref.t) {
      case 'node':
        return store.nodes.update(SpatialNode.parse(data))
      case 'world':
        return store.worlds.putSettings(ref.id, WorldSettings.parse(data))
      case 'region':
        return store.regions.update(Region.parse(data))
      case 'record': {
        const record = RECORD_SCHEMAS[ref.kind].parse(data) as { id: string }
        validate(store, ref.kind, record as never)
        return (store.records(ref.kind) as { update(r: unknown): void }).update(record)
      }
      default:
        throw new CommandError('Only a row of fields has a version to put back')
    }
  } catch (err) {
    fail(err)
  }
}

/** Sets a conflict's field to `value` (or takes it out), through the step's footprint, and opens or closes the note; gives back what the field held before. */
function put(store: Store, id: string, value: unknown, removed: boolean, deletedAt: string | null, now: string, footprint: Parameters<typeof patchThrough>[0]) {
  const conflict = store.records('conflict').get(id)
  if (!conflict) throw new CommandError('No such conflict note')
  const ref = parseRefKey(conflict.key)
  const row = readRow(store, ref)
  if (row === null) throw new CommandError('What that conflict note was about isn’t here any more')
  const previous = { value: valueAt(row, conflict.path) ?? null, removed: !fieldsOf(row).has(conflict.path) }
  patchThrough(footprint, ref, row, [[conflict.path]], () => {
    const next = withField(row, conflict.path, value, removed)
    putRow(store, ref, next)
    return next
  })
  store.records('conflict').update({ ...conflict, deletedAt, updatedAt: now })
  return { previous, owner: conflict.ownerId }
}

export const conflictHandlers: HandlerMap<ConflictCommand> = {
  'conflict.use': (store, { id }, ctx) => {
    const conflict = store.records('conflict').get(id)
    if (!conflict || conflict.deletedAt) throw new CommandError('No such conflict note open')
    const { previous, owner } = put(store, id, conflict.value, conflict.removed, ctx.now(), ctx.now(), ctx.footprint)
    return { inverse: { type: 'conflict.unuse', payload: { id, ...previous } }, target: { kind: 'conflict', id }, owner }
  },
  'conflict.unuse': (store, { id, value, removed }, ctx) => {
    const { owner } = put(store, id, value, removed, null, ctx.now(), ctx.footprint)
    return { inverse: { type: 'conflict.use', payload: { id } }, target: { kind: 'conflict', id }, owner }
  }
}

/** The node a row belongs to, for its conflict notes (undefined: it isn't here). */
function ownerOf(store: Store, ref: SyncRef): string | undefined {
  switch (ref.t) {
    case 'node':
    case 'world':
    case 'layer':
      return store.nodes.get(ref.id)?.id
    case 'region':
      return store.regions.get(ref.id)?.worldId
    case 'record':
      return store.records(ref.kind).get(ref.id)?.ownerId
    default:
      return undefined
  }
}

/** Keeps what a merge lost as conflict notes, each once (a note made already, here or on the device it came from, isn't made again). */
export function keepLost(store: Store, ref: SyncRef, key: string, lost: readonly LostField[], now: string): void {
  if (ref.t === 'record' && ref.kind === 'conflict') return
  const ownerId = ownerOf(store, ref)
  if (!ownerId) return
  const notes = store.records('conflict')
  for (const { path, value, stamp, kept } of lost) {
    const id = conflictId(key, path, stamp)
    if (notes.get(id)) continue
    notes.insert(Conflict.parse({ id, ownerId, createdAt: now, updatedAt: now, deletedAt: null, key, path, value: value ?? null, removed: value === undefined, lostStamp: stamp, keptStamp: kept }))
  }
}
