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
    .filter((kind) => kind !== 'world' || !surfaceOf(nodes, node.id))
    .map((kind) => ({ kind, label: childLabel(node.kind, kind) }))
}

const childLabel = (parent: NodeKind, kind: NodeKind): string => (kind === 'world' ? 'Surface' : levelLabel(kind, parent))

export const kindLabel = (node: SpatialNode, nodes: SpatialNode[]): string => levelLabel(node.kind, nodes.find((n) => n.id === node.parentId)?.kind)

/**
 * A planet or moon and its surface are one thing to the user: one row in the
 * tree, one crumb, one name. The surface of a body, if it has one.
 */
export const surfaceOf = (nodes: readonly SpatialNode[], bodyId: string): SpatialNode | undefined => nodes.find((n) => n.parentId === bodyId && n.kind === 'world')

/** What picking a node in the tree or the breadcrumb opens: a body's surface, where it has one. */
export const opened = (node: SpatialNode, nodes: readonly SpatialNode[]): SpatialNode => (node.kind === 'body' && surfaceOf(nodes, node.id)) || node

/** The thing a node is shown as: a surface is its planet or moon. */
export const shownAs = (node: SpatialNode, nodes: readonly SpatialNode[]): SpatialNode => (node.kind === 'world' && nodes.find((n) => n.id === node.parentId && n.kind === 'body')) || node

/** Renames a node, and a planet or moon's surface with it (they go by one name), in one step. */
export function renameCommand(node: SpatialNode, nodes: readonly SpatialNode[], name: string): Command {
  const surface = node.kind === 'body' ? surfaceOf(nodes, node.id) : undefined
  const rename = (id: string): Command => ({ type: 'node.update', payload: { id, patch: { name } } })
  return surface ? { type: 'batch', payload: { commands: [rename(node.id), rename(surface.id)] } } : rename(node.id)
}

/**
 * Adds a new child to a node: what the inspector's + buttons and the
 * right-click menu's Add items do. A planet, moon, star or galaxy is named in
 * the language spoken where it's added, if one is; else after what it is
 * ("New Planet"). A surface takes its planet's or moon's name.
 */
export const addChildCommand = (node: SpatialNode, kind: NodeKind, label: string): Command => ({
  type: 'node.create',
  payload: { parentId: node.id, kind, name: kind === 'world' ? node.name : nameInPlace('planet', { nodeId: node.id }) || `New ${label}` }
})

/** Every node but the universe itself can be deleted. */
export const canDelete = (node: SpatialNode) => node.parentId !== null
