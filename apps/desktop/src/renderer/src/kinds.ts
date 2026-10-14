import { ALLOWED_CHILDREN, levelLabel, type Command, type NodeKind, type SpatialNode } from '@universe/core'
import { nameInPlace } from './languages'

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

const childLabel = (parent: NodeKind, kind: NodeKind): string => (kind === 'world' ? 'World surface' : levelLabel(kind, parent))

export const kindLabel = (node: SpatialNode, nodes: SpatialNode[]): string => levelLabel(node.kind, nodes.find((n) => n.id === node.parentId)?.kind)

/**
 * Adds a new child to a node: what the inspector's + buttons and the
 * right-click menu's Add items do. A planet, moon, star or galaxy is named in
 * the language spoken where it's added, if one is; else (and a world's
 * surface always) after what it is ("New Planet").
 */
export const addChildCommand = (node: SpatialNode, kind: NodeKind, label: string): Command => ({
  type: 'node.create',
  payload: { parentId: node.id, kind, name: (kind !== 'world' && nameInPlace('planet', { nodeId: node.id })) || `New ${label}` }
})

/** Every node but the universe itself can be deleted. */
export const canDelete = (node: SpatialNode) => node.parentId !== null
