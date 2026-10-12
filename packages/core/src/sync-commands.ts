import { z } from 'zod'
import { CommandError } from './command-kit'
import { keepLost } from './conflict-commands'
import { base64ToBytes, bytesToBase64 } from './encoding'
import { mergeFields, rowStamps, sameStamps, type LostField, type MergedStamps, type RowStamps } from './field-stamps'
import { isPlainObject } from './fields'
import { mergeCells } from './line-merge'
import { WHOLE, descends, joined, lineOf, meeting } from './lineage'
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
  stamps: MergedStamps
  /** Whether `data` is checked already (a merge of both versions is, to know it's a row at all): what its schema made of it. */
  checked?: boolean
  /** Whether this copy has the row, if it's known (it was read to merge with). */
  here?: boolean
}

/**
 * Keeps each field whose stamp is later than this copy's, with that stamp,
 * checked like any other write: the other device's row as it is when it's
 * later in every field, and otherwise a new one made of both. What a version
 * changed apart from the other lost is kept as a conflict note (made `now`).
 */
export function mergeRows(store: Store, rows: SyncRow[], now: string): void {
  const ledger = store.sync
  if (!ledger) throw new CommandError('This project doesn’t sync')
  const merges = rows.map((row) => ({ key: row.key, ...landingOf(store, ledger, parseRefKey(row.key), row) }))
  const landing = merges.flatMap((m) => m.landing ?? [])
  const nodes = landing.filter((r) => r.ref.t === 'node')
  const rest = landing.filter((r): r is Landing & { ref: Exclude<SyncRef, { t: 'node' }> } => r.ref.t !== 'node').sort((a, b) => ORDER[a.ref.t] - ORDER[b.ref.t])
  for (const row of [...parentsFirst(store, nodes), ...rest]) {
    // Said first, so the store knows not to work out new stamps for it.
    ledger.adopt(row.ref, row.stamps)
    write(store, row)
  }
  for (const { key, lost } of merges) if (lost?.length) keepLost(store, parseRefKey(key), key, lost, now)
}

/** What a row from another device comes to: what lands (nothing: this copy's stays as it is), and what a version lost. */
interface Merge {
  landing?: Landing
  lost?: LostField[]
}

/**
 * What a row from another device comes to here: theirs as it is, a merge of
 * theirs and this copy's (field by field, notes changed apart line by line,
 * a face of terrain changed apart cell by cell), or nothing (this copy's is
 * as late in every field). A merge that isn't a row (fields that only make
 * sense together, such as a canvas card's place made null on one device as
 * the other moved it) falls back to the later row, whole.
 */
function landingOf(store: Store, ledger: SyncLedger, ref: SyncRef, row: SyncRow): Merge {
  const theirs = { ref, data: row.data, stamps: rowStamps(row.stamp, row.fields, row.lineage) }
  const own = ledger.stampsOf(ref)
  if (!own) return { landing: theirs }
  const later = row.stamp > own.stamp ? theirs : undefined
  if (sameStamps(own, theirs.stamps)) return {}
  if (ref.t === 'layer') return { landing: cellsMerged(store, ledger, ref, own, theirs.stamps, row.data) ?? later }
  if (!hasFields(ref) || !isPlainObject(row.data)) return { landing: later }
  const data = readRow(store, ref)
  const here = (landing: Landing | undefined) => landing && { ...landing, here: data !== null }
  if (!isPlainObject(data)) return { landing: here(later) }
  const { outcome, lost } = mergeFields({ data, stamps: own }, theirs, (path, stamp) => ledger.base(ref, path, stamp))
  if ('keep' in outcome) return { landing: outcome.keep === 'theirs' ? here(theirs) : undefined, lost }
  const parsed = schemaOf(ref).safeParse(outcome.data)
  const merged = { ref, data: parsed.data, stamps: { fields: outcome.fields, ...(outcome.lineage && { lineage: outcome.lineage }) }, checked: true }
  return { landing: here(parsed.success ? merged : later), lost }
}

/**
 * Two versions of a face of terrain sculpted apart from one this copy kept,
 * cell by cell (each cell as the later sculpted it, if it did, and as the
 * earlier did otherwise), as a new version after both; undefined when one
 * was sculpted on top of the other, the version both came from isn't kept
 * here, or the merge is the later one (which is then kept whole).
 */
function cellsMerged(store: Store, ledger: SyncLedger, ref: Extract<SyncRef, { t: 'layer' }>, own: RowStamps, theirs: RowStamps, data: unknown): Landing | undefined {
  const [mine, yours] = [lineOf(own.lineage, WHOLE, own.stamp), lineOf(theirs.lineage, WHOLE, theirs.stamp)]
  const theirsLater = theirs.stamp > own.stamp
  const [earlier, later] = theirsLater ? [mine, yours] : [yours, mine]
  if (descends(later, earlier.stamp) || typeof data !== 'string') return undefined
  const met = meeting(mine, yours)
  const base = met === undefined ? undefined : ledger.base(ref, WHOLE, met)
  const ownBytes = store.worlds.getLayer(ref.id, ref.layer, ref.face)
  const theirBytes = base64ToBytes(data)
  const size = TERRAIN_RES * TERRAIN_RES * LAYER_BYTES_PER_CELL[ref.layer]
  if (!(base instanceof Uint8Array) || !ownBytes || [base, ownBytes, theirBytes].some((b) => b.length !== size)) return undefined
  const [e, l] = theirsLater ? [ownBytes, theirBytes] : [theirBytes, ownBytes]
  const merged = mergeCells(base, e, l, LAYER_BYTES_PER_CELL[ref.layer])
  if (merged.every((byte, i) => byte === l[i])) return undefined
  const from = own.lineage!.from > theirs.lineage!.from ? own.lineage!.from : theirs.lineage!.from
  return { ref, data: bytesToBase64(merged), stamps: { fields: {}, lineage: { from, paths: { [WHOLE]: joined(mine, yours) } } } }
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

/** Writes one row as another device has it, checked like any other write (unless it was as it was merged). */
function write(store: Store, { ref, data, checked, here }: Landing): void {
  const what = refKey(ref)
  const parse = <T>(schema: z.ZodType<T>): T => (checked ? (data as T) : schema.parse(data))
  switch (ref.t) {
    case 'node': {
      const node = parse(SpatialNode)
      if (node.id !== ref.id) throw new CommandError(`${what} holds another node`)
      return (here ?? store.nodes.get(node.id)) ? store.nodes.update(node) : store.nodes.insert(node)
    }
    case 'world':
      // A world never set keeps the defaults.
      if (data !== null) store.worlds.putSettings(ref.id, parse(WorldSettings))
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
      const region = parse(Region)
      if (region.id !== ref.id) throw new CommandError(`${what} holds another region`)
      return (here ?? store.regions.get(region.id)) ? store.regions.update(region) : store.regions.insert(region)
    }
    case 'record': {
      const record = parse(RECORD_SCHEMAS[ref.kind] as z.ZodType<{ id: string }>)
      if (record.id !== ref.id) throw new CommandError(`${what} holds another record`)
      const repo = store.records(ref.kind) as { get(id: string): unknown; insert(r: unknown): void; update(r: unknown): void }
      return (here ?? repo.get(record.id)) ? repo.update(record) : repo.insert(record)
    }
    case 'asset': {
      if (data === null) return store.assets.remove(ref.id)
      const asset = AssetFields.parse(data)
      return store.assets.put({ id: ref.id, name: asset.name, mime: asset.mime, data: base64ToBytes(asset.data) })
    }
  }
}
