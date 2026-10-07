import type { Command } from './commands'
import type { SpatialNode } from './schema'
import type { Store } from './store'
import type { RecordKind, RecordOf } from './timeline'
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

export function liveNode(store: Store, id: string): SpatialNode {
  const node = store.nodes.get(id)
  if (!node || node.deletedAt) throw new CommandError(`Node ${id} does not exist`)
  return node
}

export function liveWorld(store: Store, id: string): SpatialNode {
  const node = liveNode(store, id)
  if (node.kind !== 'world') throw new CommandError(`${node.name} is not a world`)
  return node
}

export function liveRegion(store: Store, id: string): Region {
  const region = store.regions.get(id)
  if (!region || region.deletedAt) throw new CommandError(`Region ${id} does not exist`)
  return region
}

export function liveRecord<K extends RecordKind>(store: Store, kind: K, id: string): RecordOf<K> {
  const record = store.records(kind).get(id)
  if (!record || record.deletedAt) throw new CommandError(`${kind[0]!.toUpperCase()}${kind.slice(1)} ${id} does not exist`)
  return record
}

/** The record's current values for every key the patch sets: the patch that undoes it. */
export function previousValues<R extends object, P extends Partial<R>>(record: R, patch: P): P {
  const previous: Partial<R> = {}
  for (const key of Object.keys(patch) as (keyof P & keyof R)[]) {
    if (patch[key] !== undefined) previous[key] = record[key]
  }
  return previous as P
}

export const pickColor = (ctx: CommandContext) => PALETTE[ctx.randomSeed() % PALETTE.length]!

/** One command made of several, undone in reverse order. A single command stays as is. */
export function batchOf(commands: Command[]): Command {
  return commands.length === 1 ? commands[0]! : { type: 'batch', payload: { commands } }
}
