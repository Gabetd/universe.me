import { z } from 'zod'
import { CommandError } from './command-kit'
import { base64ToBytes } from './encoding'
import { mergeFields, sameStamps, type RowStamps } from './field-stamps'
import { isPlainObject } from './fields'
import { RECORD_SCHEMAS } from './records'
import { SpatialNode } from './schema'
import type { Store } from './store'
import { AssetFields } from './structure-commands'
import { MAX_MERGE_ROWS, SyncRow, hasFields, parseRefKey, readRow, refKey, type SyncLedger, type SyncRef } from './sync'
import { LAYER_BYTES_PER_CELL, Region, TERRAIN_RES, WorldSettings } from './world'

/**
 * Rows from another device (PLAN.md §6.7). Not a command anyone can send:
 * only the bus's `merge` takes it, from sync.
 */
export const SyncMerge = z.object({ type: z.literal('sync.merge'), payload: z.object({ rows: z.array(SyncRow).max(MAX_MERGE_ROWS) }) })

/** How a merge is logged: which rows, with what stamps (what they hold is in the tables already). */
export interface LoggedMerge {
  type: 'sync.merge'
  payload: { rows: { key: string; stamp: string }[] }
}

/** The order rows land in after the nodes (their parents first): everything belongs to a node. */
const ORDER: Record<Exclude<SyncRef['t'], 'node'>, number> = { world: 0, layer: 1, region: 2, record: 3, asset: 4 }

/** A row as a merge writes it: what it holds, and the stamps it keeps (without a row stamp, a new one: see `SyncLedger.adopt`). */
interface Landing {
  ref: SyncRef
  data: unknown
  stamps: RowStamps | { fields: Record<string, string> }
}

/**
 * Keeps each field whose stamp is later than this copy's, with that stamp,
 * checked like any other write: the other device's row as it is when it's
 * later in every field, and otherwise a new one made of both.
 */
export function mergeRows(store: Store, rows: SyncRow[]): void {
  const ledger = store.sync
  if (!ledger) throw new CommandError('This project doesn’t sync')
  const landing = rows.flatMap((row) => landingOf(store, ledger, parseRefKey(row.key), row) ?? [])
  const nodes = landing.filter((r) => r.ref.t === 'node')
  const rest = landing.filter((r): r is Landing & { ref: Exclude<SyncRef, { t: 'node' }> } => r.ref.t !== 'node').sort((a, b) => ORDER[a.ref.t] - ORDER[b.ref.t])
  for (const row of [...parentsFirst(store, nodes), ...rest]) {
    write(store, row.ref, row.data)
    ledger.adopt(row.ref, row.stamps)
  }
}

/**
 * What a row from another device comes to here: theirs as it is, a merge of
 * theirs and this copy's field by field, or nothing (this copy's is as late
 * in every field). A merge that isn't a row (fields that only make sense
 * together, such as a canvas card's place made null on one device as the
 * other moved it) falls back to the later row, whole.
 */
function landingOf(store: Store, ledger: SyncLedger, ref: SyncRef, row: SyncRow): Landing | undefined {
  const theirs = { ref, data: row.data, stamps: row.fields ? { stamp: row.stamp, fields: row.fields } : { stamp: row.stamp } }
  const own = ledger.stampsOf(ref)
  if (!own) return theirs
  const later = row.stamp > own.stamp ? theirs : undefined
  if (sameStamps(own, theirs.stamps)) return undefined
  const data = hasFields(ref) ? readRow(store, ref) : undefined
  if (!isPlainObject(data) || !isPlainObject(row.data)) return later
  const merged = mergeFields({ data, stamps: own }, theirs)
  if ('keep' in merged) return merged.keep === 'theirs' ? theirs : undefined
  return schemaOf(ref).safeParse(merged.data).success ? { ref, data: merged.data, stamps: { fields: merged.fields } } : later
}

/** What a row of fields has to be (bytes, never merged by field, are checked as they're written). */
function schemaOf(ref: SyncRef): z.ZodType {
  switch (ref.t) {
    case 'node':
      return SpatialNode
    case 'world':
      return WorldSettings
    case 'region':
      return Region
    case 'record':
      return RECORD_SCHEMAS[ref.kind]
    default:
      return z.never()
  }
}

/** Nodes in an order where each one's parent is there before it (here already, or earlier in the list). */
function parentsFirst<R extends Landing>(store: Store, nodes: R[]): R[] {
  const parentOf = (r: R) => (r.data as { parentId?: string | null } | null)?.parentId
  const pending = new Set(nodes.map((r) => r.ref.id))
  const orphan = (r: R) => {
    const parent = parentOf(r)
    return !!parent && !pending.has(parent) && !store.nodes.get(parent)
  }
  // A parent that isn't here and isn't coming: they can't land yet (it's an older row the next pull brings).
  if (nodes.some(orphan)) throw new CommandError('Some nodes from the other device belong to ones this copy doesn’t have yet')
  const out: R[] = []
  let left = nodes
  while (left.length) {
    const ready = left.filter((r) => {
      const parent = parentOf(r)
      return !parent || !pending.has(parent)
    })
    if (!ready.length) throw new CommandError('Some nodes from the other device are each other’s parents')
    for (const r of ready) pending.delete(r.ref.id)
    out.push(...ready)
    left = left.filter((r) => pending.has(r.ref.id))
  }
  return out
}

/** Writes one row as another device has it, checked like any other write. */
function write(store: Store, ref: SyncRef, data: unknown): void {
  const what = refKey(ref)
  switch (ref.t) {
    case 'node': {
      const node = SpatialNode.parse(data)
      if (node.id !== ref.id) throw new CommandError(`${what} holds another node`)
      return store.nodes.get(node.id) ? store.nodes.update(node) : store.nodes.insert(node)
    }
    case 'world':
      // A world never set keeps the defaults.
      if (data !== null) store.worlds.putSettings(ref.id, WorldSettings.parse(data))
      return
    case 'layer': {
      const size = TERRAIN_RES * TERRAIN_RES * LAYER_BYTES_PER_CELL[ref.layer]
      const bytes = data === null ? new Uint8Array(size) : base64ToBytes(z.string().parse(data))
      if (bytes.length !== size) throw new CommandError(`${what} isn’t a face of a terrain layer`)
      store.worlds.putLayer(ref.id, ref.layer, ref.face, bytes)
      // The views load the terrain again.
      store.worlds.bumpTerrainRevision(ref.id)
      return
    }
    case 'region': {
      const region = Region.parse(data)
      if (region.id !== ref.id) throw new CommandError(`${what} holds another region`)
      return store.regions.get(region.id) ? store.regions.update(region) : store.regions.insert(region)
    }
    case 'record': {
      const record = RECORD_SCHEMAS[ref.kind].parse(data) as { id: string }
      if (record.id !== ref.id) throw new CommandError(`${what} holds another record`)
      const repo = store.records(ref.kind) as { get(id: string): unknown; insert(r: unknown): void; update(r: unknown): void }
      return repo.get(record.id) ? repo.update(record) : repo.insert(record)
    }
    case 'asset': {
      if (data === null) return store.assets.remove(ref.id)
      const asset = AssetFields.parse(data)
      return store.assets.put({ id: ref.id, name: asset.name, mime: asset.mime, data: base64ToBytes(asset.data) })
    }
  }
}
