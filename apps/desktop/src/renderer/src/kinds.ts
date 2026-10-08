import { ALLOWED_CHILDREN, KIND_LABELS, type Command, type NodeKind, type SpatialNode } from '@universe/core'

export const KIND_ICONS: Record<NodeKind, string> = {
  universe: '✦',
  galaxy_cluster: '⁂',
  galaxy: '🌀',
  star_system: '☀',
  body: '●',
  world: '🌍'
}

/** What to offer under "Add…" for a node, with friendlier names than the raw kinds. */
export function addOptions(node: SpatialNode, nodes: SpatialNode[]): { kind: NodeKind; label: string }[] {
  return ALLOWED_CHILDREN[node.kind]
    .filter((kind) => kind !== 'world' || !nodes.some((n) => n.parentId === node.id && n.kind === 'world'))
    .map((kind) => ({ kind, label: childLabel(node.kind, kind) }))
}

function childLabel(parent: NodeKind, kind: NodeKind): string {
  if (kind === 'body') return parent === 'body' ? 'Moon' : 'Planet'
  if (kind === 'world') return 'World surface'
  return KIND_LABELS[kind]
}

export function kindLabel(node: SpatialNode, nodes: SpatialNode[]): string {
  if (node.kind !== 'body') return KIND_LABELS[node.kind]
  const parent = nodes.find((n) => n.id === node.parentId)
  return parent?.kind === 'body' ? 'Moon' : 'Planet'
}

/** Adds a new child to a node, named after what it is ("New Planet"): what the inspector's + buttons and the right-click menu's Add items do. */
export const addChildCommand = (node: SpatialNode, kind: NodeKind, label: string): Command => ({ type: 'node.create', payload: { parentId: node.id, kind, name: `New ${label}` } })

/** Every node but the universe itself can be deleted. */
export const canDelete = (node: SpatialNode) => node.parentId !== null
