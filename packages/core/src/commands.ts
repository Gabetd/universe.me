import { z } from 'zod'
import { ALLOWED_CHILDREN, Id, KIND_LABELS, NodeKind, NodePatch, Seed, Vec3, type SpatialNode } from './schema'
import type { Store } from './store'

/**
 * Every write to a project is a Command (PLAN.md §4.8). The UI, the REST API
 * and the MCP server all go through `CommandBus.execute`, so validation,
 * undo/redo and the history log behave the same for all of them.
 */
export const CreateNodePayload = z.object({
  id: Id.optional(),
  parentId: Id,
  kind: NodeKind,
  name: z.string().trim().min(1).max(200).optional(),
  seed: Seed.optional(),
  position: Vec3.optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional()
})

export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('node.create'), payload: CreateNodePayload }),
  z.object({ type: z.literal('node.update'), payload: z.object({ id: Id, patch: NodePatch }) }),
  z.object({ type: z.literal('node.delete'), payload: z.object({ id: Id }) }),
  z.object({ type: z.literal('node.restore'), payload: z.object({ ids: z.array(Id).min(1) }) })
])
export type Command = z.infer<typeof Command>
export type CommandType = Command['type']

export interface CommandContext {
  now(): string
  newId(): string
  /** Returns an unsigned 32-bit integer. */
  randomSeed(): number
}

export interface HandlerResult {
  /** The command that exactly reverses this one. */
  inverse: Command
  /** Id of the entity the command created or touched, for selection in the UI. */
  targetId?: string
}

export class CommandError extends Error {
  override name = 'CommandError'
}

type Handlers = {
  [T in CommandType]: (store: Store, payload: Extract<Command, { type: T }>['payload'], ctx: CommandContext) => HandlerResult
}

export const handlers: Handlers = {
  'node.create'(store, p, ctx) {
    const parent = liveNode(store, p.parentId)
    if (!ALLOWED_CHILDREN[parent.kind].includes(p.kind)) {
      throw new CommandError(`A ${KIND_LABELS[p.kind]} cannot be placed inside a ${KIND_LABELS[parent.kind]}`)
    }
    if (p.kind === 'world' && store.nodes.children(parent.id).some((c) => c.kind === 'world')) {
      throw new CommandError(`${parent.name} already has a world`)
    }
    const id = p.id ?? ctx.newId()
    if (store.nodes.get(id)) throw new CommandError(`Node ${id} already exists`)
    const now = ctx.now()
    store.nodes.insert({
      id,
      parentId: parent.id,
      kind: p.kind,
      name: p.name ?? `New ${KIND_LABELS[p.kind]}`,
      seed: p.seed ?? ctx.randomSeed(),
      position: p.position ?? { x: 0, y: 0, z: 0 },
      notes: p.notes ?? '',
      tags: p.tags ?? [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    })
    return { inverse: { type: 'node.delete', payload: { id } }, targetId: id }
  },

  'node.update'(store, { id, patch }, ctx) {
    const node = liveNode(store, id)
    const previous: Record<string, unknown> = {}
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (patch[key] !== undefined) previous[key] = node[key]
    }
    store.nodes.update({ ...node, ...stripUndefined(patch), updatedAt: ctx.now() })
    return { inverse: { type: 'node.update', payload: { id, patch: previous as typeof patch } }, targetId: id }
  },

  'node.delete'(store, { id }, ctx) {
    const node = liveNode(store, id)
    if (node.parentId === null) throw new CommandError('The universe itself cannot be deleted')
    // Soft-delete the node and its live descendants. Descendants deleted
    // earlier stay deleted when this is undone, because they are not collected here.
    const ids = [node.id, ...liveDescendants(store, node.id).map((n) => n.id)]
    const now = ctx.now()
    for (const nid of ids) {
      const n = store.nodes.get(nid)!
      store.nodes.update({ ...n, deletedAt: now, updatedAt: now })
    }
    return { inverse: { type: 'node.restore', payload: { ids } }, targetId: node.parentId }
  },

  'node.restore'(store, { ids }, ctx) {
    const now = ctx.now()
    for (const nid of ids) {
      const n = store.nodes.get(nid)
      if (!n) throw new CommandError(`Node ${nid} does not exist`)
      store.nodes.update({ ...n, deletedAt: null, updatedAt: now })
    }
    // ids[0] is the root of the restored subtree, so deleting it again re-collects the same set.
    return { inverse: { type: 'node.delete', payload: { id: ids[0]! } }, targetId: ids[0] }
  }
}

function liveNode(store: Store, id: string): SpatialNode {
  const node = store.nodes.get(id)
  if (!node || node.deletedAt) throw new CommandError(`Node ${id} does not exist`)
  return node
}

function liveDescendants(store: Store, id: string): SpatialNode[] {
  const out: SpatialNode[] = []
  for (const child of store.nodes.children(id)) out.push(child, ...liveDescendants(store, child.id))
  return out
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
