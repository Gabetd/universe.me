import { z } from 'zod'

/**
 * Levels of the zoom tree (PLAN.md §4.1). A `body` can hold other bodies
 * (moons, stations) and at most one `world`, its editable surface.
 */
export const NODE_KINDS = ['universe', 'galaxy_cluster', 'galaxy', 'star_system', 'body', 'world'] as const
export const NodeKind = z.enum(NODE_KINDS)
export type NodeKind = z.infer<typeof NodeKind>

export const ALLOWED_CHILDREN: Record<NodeKind, readonly NodeKind[]> = {
  universe: ['galaxy_cluster'],
  galaxy_cluster: ['galaxy'],
  galaxy: ['star_system'],
  star_system: ['body'],
  body: ['body', 'world'],
  world: []
}

export const KIND_LABELS: Record<NodeKind, string> = {
  universe: 'Universe',
  galaxy_cluster: 'Galaxy Cluster',
  galaxy: 'Galaxy',
  star_system: 'Star System',
  body: 'Body',
  world: 'World'
}

export const Id = z.string().min(1)
export type Id = z.infer<typeof Id>

/** The name or title of anything a user names. */
export const Name = z.string().min(1).max(200)

/** Fields every record in the `records` table has. `ownerId` is the node it belongs to. */
export const RecordMeta = {
  id: Id,
  ownerId: Id,
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable()
}

/** Seeds are unsigned 32-bit so they round-trip through SQLite and JS numbers exactly. */
export const Seed = z.number().int().min(0).max(0xffffffff)

export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() })
export type Vec3 = z.infer<typeof Vec3>

export const SpatialNode = z.object({
  id: Id,
  parentId: Id.nullable(),
  kind: NodeKind,
  name: Name,
  seed: Seed,
  /** Position relative to the parent's frame; units depend on the parent's kind. */
  position: Vec3,
  notes: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable()
})
export type SpatialNode = z.infer<typeof SpatialNode>

/** Fields a user (or the AI) may edit on an existing node. */
export const NodePatch = SpatialNode.pick({ name: true, seed: true, position: true, notes: true, tags: true }).partial()
export type NodePatch = z.infer<typeof NodePatch>

export const CommandSource = z.enum(['user', 'ai', 'system'])
export type CommandSource = z.infer<typeof CommandSource>
