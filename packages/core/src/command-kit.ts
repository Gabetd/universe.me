import type { Command } from './commands'
import type { SpatialNode } from './schema'
import type { Store } from './store'
import type { RecordKind, RecordOf } from './records'
import { stripUndefined } from './util'
import { PALETTE, type Region } from './world'

/** Shared plumbing for command handlers (commands.ts, timeline-commands.ts). */
export interface CommandContext {
  now(): string
  newId(): string
  /** Returns an unsigned 32-bit integer. */
  randomSeed(): number
}

/** The entity a command created or touched, so the UI can select it. */
export interface Target {
  kind: 'node' | 'region' | RecordKind
  id: string
}

export interface HandlerResult {
  /** The command that exactly reverses this one. */
  inverse: Command
  target?: Target
  /** Node that owns what changed (a world for its settings, terrain and regions); the bus bumps its `updatedAt`. */
  owner?: string
}

/** Runs another command as part of this one (no validation: callers build it), returning its result. */
export type Run = (command: Command) => HandlerResult

export class CommandError extends Error {
  override name = 'CommandError'
}

/** What nodes, regions and records have in common: rows that are soft-deleted and know when they last changed. */
interface Row {
  updatedAt: string
  deletedAt: string | null
}

/** A repository of rows (`store.nodes`, `store.regions`, `store.records(kind)`). */
interface Rows<T extends Row> {
  update(row: T): void
}

/** The row, deleted or not; a CommandError naming it if there's none. */
export function requireRow<T>(row: T | undefined, what: string, id: string): T {
  if (!row) throw new CommandError(`${what} ${id} does not exist`)
  return row
}

/** The row if it exists and isn't deleted; otherwise a CommandError naming it. */
function requireLive<T extends Row>(row: T | undefined, what: string, id: string): T {
  if (row?.deletedAt) throw new CommandError(`${what} ${id} does not exist`)
  return requireRow(row, what, id)
}

export function liveNode(store: Store, id: string): SpatialNode {
  return requireLive(store.nodes.get(id), 'Node', id)
}

export function liveWorld(store: Store, id: string): SpatialNode {
  const node = liveNode(store, id)
  if (node.kind !== 'world') throw new CommandError(`${node.name} is not a world`)
  return node
}

export function liveRegion(store: Store, id: string): Region {
  return requireLive(store.regions.get(id), 'Region', id)
}

export function liveRecord<K extends RecordKind>(store: Store, kind: K, id: string): RecordOf<K> {
  return requireLive(store.records(kind).get(id), `${kind[0]!.toUpperCase()}${kind.slice(1)}`, id)
}

/** Writes a patch over a row, once `check` (if any) accepts the result; returns the patch that undoes it. */
export function patchRow<T extends Row, P extends object>(rows: Rows<T>, row: T, patch: P, now: string, check?: (next: T) => void): P {
  const next = { ...row, ...stripUndefined(patch), updatedAt: now }
  check?.(next)
  rows.update(next)
  return previousValues(row as Record<string, unknown>, patch as Record<string, unknown>) as P
}

/** Marks a row deleted at `deletedAt`, or with null, not deleted. */
export function softDelete<T extends Row>(rows: Rows<T>, row: T, deletedAt: string | null, now: string): void {
  rows.update({ ...row, deletedAt, updatedAt: now })
}

/** The node a live record belongs to. */
export const ownerOf = (store: Store, kind: RecordKind, id: string): string => liveRecord(store, kind, id).ownerId

/** What a record's validator is told besides the record. */
export interface Check<K extends RecordKind> {
  /** The record before this update; undefined for a create or a restore. */
  previous?: RecordOf<K>
  /** Ids the command has itself just found live and right for the record (an owner, a blueprint), so they aren't read again. */
  verified: ReadonlySet<string>
  edges: Edges
}

/** Records that join two others: links between events, and the food web's links between species. */
export type EdgeKind = 'link' | 'ecolink'

/** Two live edges can't have the same key: the same ends (and, in the food web, the same type). */
const EDGE_KEYS: { [K in EdgeKind]: (edge: RecordOf<K>) => string } = {
  link: (l) => JSON.stringify([l.fromId, l.toId]),
  ecolink: (l) => JSON.stringify([l.fromId, l.toId, l.type])
}
const edgeKey = <K extends EdgeKind>(kind: K, edge: RecordOf<K>) => (EDGE_KEYS[kind] as (edge: RecordOf<K>) => string)(edge)

/** An owner's live edges of one kind, by key: the ids that have it. */
export type Edges = (kind: EdgeKind, ownerId: string) => ReadonlyMap<string, readonly string[]>

/** Reads each owner's edges once, however many records a command checks against them. */
export function edgeTable(store: Store): Edges {
  const tables = new Map<string, Map<string, string[]>>()
  return (kind, ownerId) => {
    const name = JSON.stringify([kind, ownerId])
    let table = tables.get(name)
    if (!table) {
      tables.set(name, (table = new Map()))
      for (const edge of store.records(kind).byOwner(ownerId)) {
        const key = edgeKey(kind, edge)
        const ids = table.get(key)
        if (ids) ids.push(edge.id)
        else table.set(key, [edge.id])
      }
    }
    return table
  }
}

/**
 * Checks an edge: both ends are live records of its owner, and no other live
 * edge has its key. An update that keeps the ends can't make a duplicate, so
 * it isn't looked for (links share an owner with their ends, so only that
 * owner's edges are).
 */
export function checkEdge<K extends EdgeKind>(store: Store, kind: K, ends: RecordKind, edge: RecordOf<K>, check: Check<K>, elsewhere: string, duplicate: string): void {
  for (const id of [edge.fromId, edge.toId]) {
    if (!check.verified.has(id) && ownerOf(store, ends, id) !== edge.ownerId) throw new CommandError(elsewhere)
  }
  const key = edgeKey(kind, edge)
  if (check.previous && edgeKey(kind, check.previous) === key) return
  if (check.edges(kind, edge.ownerId).get(key)?.some((id) => id !== edge.id)) throw new CommandError(duplicate)
}

/** The record's current values for every key the patch sets: the patch that undoes it. */
export function previousValues<R extends object, P extends Partial<R>>(record: R, patch: P): P {
  const previous: Partial<R> = {}
  for (const key of Object.keys(patch) as (keyof P & keyof R)[]) {
    // A field the record doesn't have yet (added in a later version) is undone to null.
    if (patch[key] !== undefined) previous[key] = record[key] ?? (null as R[keyof P & keyof R])
  }
  return previous as P
}

export const pickColor = (ctx: CommandContext) => PALETTE[ctx.randomSeed() % PALETTE.length]!

/** One command made of several, undone in reverse order. A single command stays as is. */
export function batchOf(commands: Command[]): Command {
  return commands.length === 1 ? commands[0]! : { type: 'batch', payload: { commands } }
}
