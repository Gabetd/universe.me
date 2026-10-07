import { z } from 'zod'
import { ALLOWED_CHILDREN, Id, KIND_LABELS, NodeKind, NodePatch, Seed, Vec3, type SpatialNode } from './schema'
import { base64ToBytes, bytesToBase64 } from './encoding'
import type { Store } from './store'
import { stripUndefined } from './util'
import {
  CUBE_FACES,
  DEFAULT_WORLD_SETTINGS,
  HexColor,
  LAYER_BYTES_PER_CELL,
  LatLon,
  RegionPatch,
  TERRAIN_RES,
  TerrainLayerName,
  TerrainPatch,
  emptyLayer,
  WorldSettings,
  WorldSettingsPatch,
  mergeWorldSettings,
  readRect,
  writeRect
} from './world'

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
  z.object({ type: z.literal('node.restore'), payload: z.object({ ids: z.array(Id).min(1) }) }),
  z.object({ type: z.literal('world.update'), payload: z.object({ id: Id, patch: WorldSettingsPatch }) }),
  z.object({
    type: z.literal('terrain.patch'),
    payload: z.object({ worldId: Id, layer: TerrainLayerName, patches: z.array(TerrainPatch) })
  }),
  z.object({ type: z.literal('terrain.reset'), payload: z.object({ worldId: Id, layer: TerrainLayerName }) }),
  z.object({
    type: z.literal('region.create'),
    payload: z.object({
      id: Id.optional(),
      worldId: Id,
      name: z.string().trim().min(1).max(200).optional(),
      color: HexColor.optional(),
      points: z.array(LatLon).min(3),
      notes: z.string().optional()
    })
  }),
  z.object({ type: z.literal('region.update'), payload: z.object({ id: Id, patch: RegionPatch }) }),
  z.object({ type: z.literal('region.delete'), payload: z.object({ id: Id }) }),
  z.object({ type: z.literal('region.restore'), payload: z.object({ id: Id }) })
])
export type Command = z.infer<typeof Command>
export type CommandType = Command['type']

export interface CommandContext {
  now(): string
  newId(): string
  /** Returns an unsigned 32-bit integer. */
  randomSeed(): number
}

/** The entity a command created or touched, so the UI can select it. */
export interface Target {
  kind: 'node' | 'region'
  id: string
}

export interface HandlerResult {
  /** The command that exactly reverses this one. */
  inverse: Command
  target?: Target
  /** Node that owns what changed (a world for its settings, terrain and regions); the bus bumps its `updatedAt`. */
  owner?: string
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
    return { inverse: { type: 'node.delete', payload: { id } }, target: { kind: 'node', id } }
  },

  'node.update'(store, { id, patch }, ctx) {
    const node = liveNode(store, id)
    store.nodes.update({ ...node, ...stripUndefined(patch), updatedAt: ctx.now() })
    return { inverse: { type: 'node.update', payload: { id, patch: previousValues(node, patch) } }, target: { kind: 'node', id } }
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
    return { inverse: { type: 'node.restore', payload: { ids } }, target: { kind: 'node', id: node.parentId } }
  },

  'world.update'(store, { id, patch }) {
    liveWorld(store, id)
    const previous = store.worlds.getSettings(id) ?? DEFAULT_WORLD_SETTINGS
    const next = WorldSettings.safeParse(mergeWorldSettings(previous, patch))
    if (!next.success) throw new CommandError(`Invalid world settings: ${next.error.issues[0]?.message}`)
    store.worlds.putSettings(id, next.data)
    return { inverse: { type: 'world.update', payload: { id, patch: previous } }, target: { kind: 'node', id }, owner: id }
  },

  'terrain.patch'(store, { worldId, layer, patches }) {
    liveWorld(store, worldId)
    const bytesPerCell = LAYER_BYTES_PER_CELL[layer]
    const faces = new Map<number, Uint8Array>()
    const undo: TerrainPatch[] = []
    for (const patch of patches) {
      if (patch.x + patch.w > TERRAIN_RES || patch.y + patch.h > TERRAIN_RES) {
        throw new CommandError(`Terrain patch on face ${patch.face} extends past the grid`)
      }
      const data = base64ToBytes(patch.data)
      if (data.length !== patch.w * patch.h * bytesPerCell) throw new CommandError('Terrain patch data has the wrong size')
      let face = faces.get(patch.face)
      if (!face) {
        face = store.worlds.getLayer(worldId, layer, patch.face) ?? emptyLayer(layer)
        faces.set(patch.face, face)
      }
      // Prepend, so overlapping patches are undone in reverse order.
      undo.unshift({ ...patch, data: bytesToBase64(readRect(face, patch, bytesPerCell)) })
      writeRect(face, patch, data, bytesPerCell)
    }
    for (const [index, bytes] of faces) store.worlds.putLayer(worldId, layer, index, bytes)
    store.worlds.bumpTerrainRevision(worldId)
    return { inverse: { type: 'terrain.patch', payload: { worldId, layer, patches: undo } }, target: { kind: 'node', id: worldId }, owner: worldId }
  },

  'terrain.reset'(store, { worldId, layer }) {
    liveWorld(store, worldId)
    const undo: TerrainPatch[] = []
    for (let face = 0; face < CUBE_FACES; face++) {
      const bytes = store.worlds.getLayer(worldId, layer, face)
      if (!bytes) continue
      undo.push({ face, x: 0, y: 0, w: TERRAIN_RES, h: TERRAIN_RES, data: bytesToBase64(bytes) })
      store.worlds.putLayer(worldId, layer, face, emptyLayer(layer))
    }
    store.worlds.bumpTerrainRevision(worldId)
    return { inverse: { type: 'terrain.patch', payload: { worldId, layer, patches: undo } }, target: { kind: 'node', id: worldId }, owner: worldId }
  },

  'region.create'(store, p, ctx) {
    liveWorld(store, p.worldId)
    const id = p.id ?? ctx.newId()
    if (store.regions.get(id)) throw new CommandError(`Region ${id} already exists`)
    const now = ctx.now()
    store.regions.insert({
      id,
      worldId: p.worldId,
      name: p.name ?? 'New Region',
      color: p.color ?? REGION_COLORS[ctx.randomSeed() % REGION_COLORS.length]!,
      points: p.points,
      notes: p.notes ?? '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    })
    return { inverse: { type: 'region.delete', payload: { id } }, target: { kind: 'region', id }, owner: p.worldId }
  },

  'region.update'(store, { id, patch }, ctx) {
    const region = liveRegion(store, id)
    store.regions.update({ ...region, ...stripUndefined(patch), updatedAt: ctx.now() })
    return { inverse: { type: 'region.update', payload: { id, patch: previousValues(region, patch) } }, target: { kind: 'region', id }, owner: region.worldId }
  },

  'region.delete'(store, { id }, ctx) {
    const region = liveRegion(store, id)
    const now = ctx.now()
    store.regions.update({ ...region, deletedAt: now, updatedAt: now })
    return { inverse: { type: 'region.restore', payload: { id } }, target: { kind: 'node', id: region.worldId }, owner: region.worldId }
  },

  'region.restore'(store, { id }, ctx) {
    const region = store.regions.get(id)
    if (!region) throw new CommandError(`Region ${id} does not exist`)
    store.regions.update({ ...region, deletedAt: null, updatedAt: ctx.now() })
    return { inverse: { type: 'region.delete', payload: { id } }, target: { kind: 'region', id }, owner: region.worldId }
  },

  'node.restore'(store, { ids }, ctx) {
    const now = ctx.now()
    for (const nid of ids) {
      const n = store.nodes.get(nid)
      if (!n) throw new CommandError(`Node ${nid} does not exist`)
      store.nodes.update({ ...n, deletedAt: null, updatedAt: now })
    }
    // ids[0] is the root of the restored subtree, so deleting it again re-collects the same set.
    return { inverse: { type: 'node.delete', payload: { id: ids[0]! } }, target: { kind: 'node', id: ids[0]! } }
  }
}

function liveNode(store: Store, id: string): SpatialNode {
  const node = store.nodes.get(id)
  if (!node || node.deletedAt) throw new CommandError(`Node ${id} does not exist`)
  return node
}

/** The record's current values for every key the patch sets: the patch that undoes it. */
function previousValues<R extends object, P extends Partial<R>>(record: R, patch: P): P {
  const previous: Partial<R> = {}
  for (const key of Object.keys(patch) as (keyof P & keyof R)[]) {
    if (patch[key] !== undefined) previous[key] = record[key]
  }
  return previous as P
}

function liveWorld(store: Store, id: string): SpatialNode {
  const node = liveNode(store, id)
  if (node.kind !== 'world') throw new CommandError(`${node.name} is not a world`)
  return node
}

function liveRegion(store: Store, id: string) {
  const region = store.regions.get(id)
  if (!region || region.deletedAt) throw new CommandError(`Region ${id} does not exist`)
  return region
}

/** Distinct, readable-on-dark colors for new regions. */
const REGION_COLORS = ['#e8a33d', '#5fb3d9', '#d9605f', '#8bc34a', '#b37fe0', '#4fc3a1', '#f06292', '#c0ca33']

function liveDescendants(store: Store, id: string): SpatialNode[] {
  const out: SpatialNode[] = []
  for (const child of store.nodes.children(id)) out.push(child, ...liveDescendants(store, child.id))
  return out
}
