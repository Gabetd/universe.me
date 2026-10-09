import { z } from 'zod'
import { CommandError } from './command-kit'
import type { HandlerMap } from './commands'
import { base64ToBytes } from './encoding'
import { RECORD_SCHEMAS } from './records'
import { SpatialNode } from './schema'
import type { Store } from './store'
import { SyncRow, parseRefKey, refKey, type SyncRef } from './sync'
import { LAYER_BYTES_PER_CELL, Region, TERRAIN_RES, WorldSettings } from './world'

/** Rows from another device in one merge, at most: a pull is asked for in pages smaller than this. */
export const MAX_MERGE_ROWS = 2000

const Asset = z.object({ name: z.string().min(1).max(260), mime: z.string().min(1).max(100), data: z.string().max(100_000_000) })

export const SYNC_COMMANDS = [
  /**
   * Rows from another device (PLAN.md §6.7): each kept if its stamp is later
   * than this copy's, with that stamp. Checked like any write, logged, but not
   * undone with the user's own changes.
   */
  z.object({ type: z.literal('sync.merge'), payload: z.object({ rows: z.array(SyncRow).max(MAX_MERGE_ROWS) }) })
] as const

type SyncCommand = z.infer<(typeof SYNC_COMMANDS)[number]>

/** The order rows land in: a node's parent before it, everything else after the nodes it belongs to. */
const ORDER: Record<SyncRef['t'], number> = { node: 0, world: 1, layer: 2, region: 3, record: 4, asset: 5 }

export const syncHandlers: HandlerMap<SyncCommand> = {
  'sync.merge': (store, { rows }) => {
    const ledger = store.sync
    if (!ledger) throw new CommandError('This project doesn’t sync')
    const newer = rows
      .map((row) => ({ ...row, ref: parseRefKey(row.key) }))
      .filter((row) => {
        const own = ledger.stampOf(row.ref)
        return own === undefined || row.stamp > own
      })
    for (const row of parentsFirst(store, newer.sort((a, b) => ORDER[a.ref.t] - ORDER[b.ref.t]))) {
      write(store, row.ref, row.data)
      ledger.adopt(row.ref, row.stamp)
    }
    // Merged rows aren't undone with the user's changes: there's nothing to put back.
    return { inverse: { type: 'sync.merge', payload: { rows: [] } } }
  }
}

/** Nodes in an order where each one's parent is there before it (here already, or earlier in the list). */
function parentsFirst<R extends { ref: SyncRef; data: unknown }>(store: Store, rows: R[]): R[] {
  const nodes = rows.filter((r) => r.ref.t === 'node')
  const rest = rows.filter((r) => r.ref.t !== 'node')
  const placed = new Set<string>()
  const out: R[] = []
  let left = nodes
  while (left.length) {
    const ready = left.filter((r) => {
      const parent = (r.data as { parentId?: string | null } | null)?.parentId
      return !parent || placed.has(parent) || (store.nodes.get(parent) && !left.some((o) => o.ref.id === parent))
    })
    // A parent that isn't here and isn't coming: the rest can't land yet (it's an older row the next pull brings).
    if (!ready.length) throw new CommandError('Some nodes from the other device belong to ones this copy doesn’t have yet')
    for (const r of ready) placed.add(r.ref.id)
    out.push(...ready)
    left = left.filter((r) => !ready.includes(r))
  }
  return [...out, ...rest]
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
      const bytes = base64ToBytes(z.string().parse(data ?? ''))
      const size = TERRAIN_RES * TERRAIN_RES * LAYER_BYTES_PER_CELL[ref.layer]
      if (data !== null && bytes.length !== size) throw new CommandError(`${what} isn’t a face of a terrain layer`)
      store.worlds.putLayer(ref.id, ref.layer, ref.face, data === null ? new Uint8Array(size) : bytes)
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
      const asset = Asset.parse(data)
      return store.assets.put({ id: ref.id, name: asset.name, mime: asset.mime, data: base64ToBytes(asset.data) })
    }
  }
}
