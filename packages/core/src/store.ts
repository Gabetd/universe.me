import type { Id, SpatialNode } from './schema'

/** Storage the domain layer needs. `packages/db` implements it on SQLite; tests use `MemoryStore`. */
export interface NodeRepository {
  /** Returns the node even if soft-deleted. */
  get(id: Id): SpatialNode | undefined
  /** Live (not deleted) children. */
  children(parentId: Id): SpatialNode[]
  /** Every live node. */
  all(): SpatialNode[]
  insert(node: SpatialNode): void
  update(node: SpatialNode): void
}

export interface Store {
  nodes: NodeRepository
  /** Runs `fn` atomically: all of its writes land, or none do. */
  transaction<T>(fn: () => T): T
}

export class MemoryStore implements Store {
  private readonly rows = new Map<Id, SpatialNode>()

  nodes: NodeRepository = {
    get: (id) => clone(this.rows.get(id)),
    children: (parentId) =>
      [...this.rows.values()].filter((n) => n.parentId === parentId && !n.deletedAt).map((n) => clone(n)!),
    all: () => [...this.rows.values()].filter((n) => !n.deletedAt).map((n) => clone(n)!),
    insert: (node) => {
      if (this.rows.has(node.id)) throw new Error(`Node ${node.id} already exists`)
      this.rows.set(node.id, clone(node)!)
    },
    update: (node) => {
      if (!this.rows.has(node.id)) throw new Error(`Node ${node.id} does not exist`)
      this.rows.set(node.id, clone(node)!)
    }
  }

  transaction<T>(fn: () => T): T {
    const snapshot = new Map(this.rows)
    try {
      return fn()
    } catch (err) {
      this.rows.clear()
      for (const [k, v] of snapshot) this.rows.set(k, v)
      throw err
    }
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}
