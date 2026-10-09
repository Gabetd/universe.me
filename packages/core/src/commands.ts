import { z } from 'zod'
import { ALLOWED_CHILDREN, Id, KIND_LABELS, NodeKind, NodePatch, Notes, Seed, Vec3, type SpatialNode } from './schema'
import { base64ToBytes, bytesToBase64 } from './encoding'
import type { Store } from './store'
import { CommandError, batchOf, liveNode, liveRegion, liveWorld, newNode, patchRow, pickColor, requireRow, softDelete, type CommandContext, type HandlerResult, type Run } from './command-kit'
import { CHARACTER_COMMANDS, characterHandlers } from './character-commands'
import { FINDING_COMMANDS, findingHandlers } from './finding-commands'
import { POWER_COMMANDS, powerHandlers } from './power-commands'
import { SYNC_COMMANDS, syncHandlers } from './sync-commands'
import { THEME_COMMANDS, themeHandlers } from './theme-commands'
import { WORLD_SIM_COMMANDS, worldSimHandlers } from './world-sim-commands'
import { STRUCTURE_COMMANDS, structureHandlers } from './structure-commands'
import { TIMELINE_COMMANDS, timelineHandlers } from './timeline-commands'
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
  quantizeSettings,
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
  notes: Notes.optional(),
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
      notes: Notes.optional()
    })
  }),
  z.object({ type: z.literal('region.update'), payload: z.object({ id: Id, patch: RegionPatch }) }),
  z.object({ type: z.literal('region.delete'), payload: z.object({ id: Id }) }),
  z.object({ type: z.literal('region.restore'), payload: z.object({ id: Id }) }),
  ...TIMELINE_COMMANDS,
  ...STRUCTURE_COMMANDS,
  ...CHARACTER_COMMANDS,
  ...WORLD_SIM_COMMANDS,
  ...THEME_COMMANDS,
  ...POWER_COMMANDS,
  ...FINDING_COMMANDS,
  ...SYNC_COMMANDS,
  /** Several commands applied together; each is validated when it runs. The batch focuses `focusId`, or what its last command did. */
  z.object({ type: z.literal('batch'), payload: z.object({ commands: z.array(z.unknown()).min(1), focusId: Id.optional() }) })
])
export type Command = z.infer<typeof Command>
export type CommandType = Command['type']

export type Handler<P> = (store: Store, payload: P, ctx: CommandContext, run: Run) => HandlerResult
/** A handler for each command type in a union of commands. */
export type HandlerMap<C extends { type: string; payload: unknown }> = { [T in C['type']]: Handler<Extract<C, { type: T }>['payload']> }

type Handlers = HandlerMap<Command>

export const handlers: Handlers = {
  ...timelineHandlers,
  ...structureHandlers,
  ...characterHandlers,
  ...worldSimHandlers,
  ...themeHandlers,
  ...powerHandlers,
  ...findingHandlers,
  ...syncHandlers,

  batch(store, { commands, focusId }, ctx) {
    const results = commands.map((input) => {
      const parsed = Command.safeParse(input)
      if (!parsed.success) throw new CommandError(`Invalid command in batch: ${parsed.error.issues[0]?.message}`)
      return applyCommand(store, parsed.data, ctx)
    })
    return {
      inverse: batchOf(results.map((r) => r.inverse).reverse()),
      target: focusId ? { kind: 'node', id: focusId } : results.findLast((r) => r.target)?.target,
      owner: results.find((r) => r.owner)?.owner
    }
  },

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
    store.nodes.insert(newNode({ ...p, id, parentId: parent.id, name: p.name ?? `New ${KIND_LABELS[p.kind]}`, seed: p.seed ?? ctx.randomSeed() }, now))
    return { inverse: { type: 'node.delete', payload: { id } }, target: { kind: 'node', id } }
  },

  'node.update'(store, { id, patch }, ctx) {
    const previous = patchRow(store.nodes, liveNode(store, id), patch, ctx.now())
    return { inverse: { type: 'node.update', payload: { id, patch: previous } }, target: { kind: 'node', id } }
  },

  'node.delete'(store, { id }, ctx) {
    const node = liveNode(store, id)
    if (node.parentId === null) throw new CommandError('The universe itself cannot be deleted')
    // Soft-delete the node and its live descendants. Descendants deleted
    // earlier stay deleted when this is undone, because they are not collected here.
    const nodes = [node, ...liveDescendants(store, node.id)]
    const now = ctx.now()
    for (const n of nodes) softDelete(store.nodes, n, now, now)
    return { inverse: { type: 'node.restore', payload: { ids: nodes.map((n) => n.id) } }, target: { kind: 'node', id: node.parentId } }
  },

  'world.update'(store, { id, patch }) {
    liveWorld(store, id)
    const previous = store.worlds.getSettings(id) ?? DEFAULT_WORLD_SETTINGS
    const next = WorldSettings.safeParse(quantizeSettings(mergeWorldSettings(previous, patch)))
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
      color: p.color ?? pickColor(ctx),
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
    const previous = patchRow(store.regions, region, patch, ctx.now())
    return { inverse: { type: 'region.update', payload: { id, patch: previous } }, target: { kind: 'region', id }, owner: region.worldId }
  },

  'region.delete'(store, { id }, ctx) {
    const region = liveRegion(store, id)
    const now = ctx.now()
    softDelete(store.regions, region, now, now)
    return { inverse: { type: 'region.restore', payload: { id } }, target: { kind: 'node', id: region.worldId }, owner: region.worldId }
  },

  'region.restore'(store, { id }, ctx) {
    const region = requireRow(store.regions.get(id), 'Region', id)
    softDelete(store.regions, region, null, ctx.now())
    return { inverse: { type: 'region.delete', payload: { id } }, target: { kind: 'region', id }, owner: region.worldId }
  },

  'node.restore'(store, { ids }, ctx) {
    const now = ctx.now()
    for (const nid of ids) softDelete(store.nodes, requireRow(store.nodes.get(nid), 'Node', nid), null, now)
    // ids[0] is the root of the restored subtree, so deleting it again re-collects the same set.
    return { inverse: { type: 'node.delete', payload: { id: ids[0]! } }, target: { kind: 'node', id: ids[0]! } }
  }
}

/** Applies an already-validated command inside the current transaction. */
export function applyCommand(store: Store, command: Command, ctx: CommandContext): HandlerResult {
  const handler = handlers[command.type] as Handler<unknown>
  return handler(store, command.payload as never, ctx, (c) => applyCommand(store, c, ctx))
}

/** A node's live descendants, each before its own (one query per node that has any). */
function liveDescendants(store: Store, id: string, out: SpatialNode[] = []): SpatialNode[] {
  for (const child of store.nodes.children(id)) {
    out.push(child)
    liveDescendants(store, child.id, out)
  }
  return out
}

export { CommandError, type CommandContext, type HandlerResult, type Target } from './command-kit'
