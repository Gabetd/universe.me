import { ALLOWED_CHILDREN, KIND_LABELS, type NodeKind, type SpatialNode } from '@universe/core'

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
