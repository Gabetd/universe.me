import { DEFAULT_CONTEXT, newNode } from './command-kit'
import type { Id, SpatialNode } from './schema'
import type { Store } from './store'

export interface TreeNode extends SpatialNode {
  children: TreeNode[]
}

/** Builds the zoom tree from a flat list of live nodes, children sorted by creation. */
export function buildTree(nodes: SpatialNode[]): TreeNode | undefined {
  const byId = new Map<Id, TreeNode>(nodes.map((n) => [n.id, { ...n, children: [] }]))
  let root: TreeNode | undefined
  for (const node of byId.values()) {
    if (node.parentId === null) root = node
    else byId.get(node.parentId)?.children.push(node)
  }
  for (const node of byId.values()) node.children.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return root
}

/** Path from the universe down to `id`, inclusive. Empty if `id` is unknown. */
export function ancestry(nodes: SpatialNode[], id: Id): SpatialNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const path: SpatialNode[] = []
  for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) path.unshift(cur)
  return path
}

export function findRoot(store: Store): SpatialNode | undefined {
  return store.nodes.root()
}

/** Seeds a new project with its root Universe node. Not undoable: a project always has a root. */
export function createRootUniverse(store: Store, name: string, now = DEFAULT_CONTEXT.now()): SpatialNode {
  const root = newNode({ id: DEFAULT_CONTEXT.newId(), parentId: null, kind: 'universe', name, seed: DEFAULT_CONTEXT.randomSeed() }, now)
  store.transaction(() => store.nodes.insert(root))
  return root
}
