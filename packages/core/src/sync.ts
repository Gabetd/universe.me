import { z } from 'zod'
import { bytesToBase64 } from './encoding'
import { RECORD_KINDS, type RecordKind, type RecordOf } from './records'
import type { Id } from './schema'
import type { AssetRepository, NodeRepository, RecordRepository, RegionRepository, Store, WorldRepository } from './store'
import { TerrainLayerName } from './world'

/**
 * Sync between devices (PLAN.md §6.7): rows, not commands. Every row a
 * project keeps (a node, a world's settings, a face of a terrain layer, a
 * region, a record, an asset) carries the stamp of its last write, from a
 * hybrid logical clock that orders writes across devices. A device asks the
 * others for the rows stamped after the last one it saw, and keeps each one
 * whose stamp is later than its own copy's (`sync.merge`): the last write
 * wins, row by row. Deletes are soft, so they're rows like any other (an
 * asset, which is removed outright, comes as nothing).
 */

/** Which row: its table and key. */
export type SyncRef =
  | { t: 'node'; id: Id }
  | { t: 'world'; id: Id }
  | { t: 'layer'; id: Id; layer: TerrainLayerName; face: number }
  | { t: 'region'; id: Id }
  | { t: 'record'; kind: RecordKind; id: Id }
  | { t: 'asset'; id: Id }

/** A row's key as text: the same for the same row on every device. */
export function refKey(ref: SyncRef): string {
  switch (ref.t) {
    case 'layer':
      return JSON.stringify([ref.t, ref.id, ref.layer, ref.face])
    case 'record':
      return JSON.stringify([ref.t, ref.kind, ref.id])
    default:
      return JSON.stringify([ref.t, ref.id])
  }
}

const KeyParts = z.union([
  z.tuple([z.enum(['node', 'world', 'region', 'asset']), z.string().min(1)]),
  z.tuple([z.literal('layer'), z.string().min(1), TerrainLayerName, z.number().int().min(0).max(5)]),
  z.tuple([z.literal('record'), z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]), z.string().min(1)])
])

/** The row a key names; throws on one that isn't a key. */
export function parseRefKey(key: string): SyncRef {
  const parts = KeyParts.parse(JSON.parse(key))
  if (parts[0] === 'layer') return { t: 'layer', id: parts[1], layer: parts[2], face: parts[3] }
  if (parts[0] === 'record') return { t: 'record', kind: parts[1], id: parts[2] }
  return { t: parts[0], id: parts[1] }
}

/**
 * Stamps that sort as text in the order the writes happened, on any device:
 * milliseconds, then a count for writes in the same millisecond, then the
 * device (so two never tie). Never behind a stamp it has seen, so a write
 * made after receiving another's comes after it even if this device's clock
 * is behind.
 */
export class SyncClock {
  private ms = 0
  private count = 0

  constructor(
    readonly device: string,
    private readonly now: () => number = Date.now
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(device)) throw new Error('A device id is letters, digits, - and _')
  }

  next(): string {
    const now = this.now()
    if (now > this.ms) [this.ms, this.count] = [now, 0]
    else this.count++
    return stamp(this.ms, this.count, this.device)
  }

  /** A stamp from elsewhere: the next one here comes after it. */
  see(other: string): void {
    const [ms, count] = readStamp(other)
    if (ms > this.ms || (ms === this.ms && count > this.count)) [this.ms, this.count] = [ms, count]
  }
}

const stamp = (ms: number, count: number, device: string) => `${ms.toString(36).padStart(11, '0')}.${count.toString(36).padStart(5, '0')}.${device}`

function readStamp(text: string): [number, number] {
  const m = /^([0-9a-z]{11})\.([0-9a-z]{5})\.[A-Za-z0-9_-]{1,64}$/.exec(text)
  if (!m) throw new Error(`${text.slice(0, 40)} is not a sync stamp`)
  return [parseInt(m[1]!, 36), parseInt(m[2]!, 36)]
}

export const SyncStamp = z.string().regex(/^[0-9a-z]{11}\.[0-9a-z]{5}\.[A-Za-z0-9_-]{1,64}$/)

/**
 * Each row's last stamp, by key, and when this copy got it: a count of its
 * own, so another device can ask for everything since the last it saw. (Not
 * by stamp: a row merged from a third device can carry a stamp older than
 * ones already asked for, and would never be asked for.)
 */
export interface StampTable {
  get(key: string): string | undefined
  /** Notes a row's stamp, as the latest thing this copy got. */
  put(key: string, stamp: string): void
  /** Up to `limit` rows got after `since` (0 for all), in the order they came. */
  since(since: number, limit: number): { key: string; stamp: string; seq: number }[]
}

export class MemoryStampTable implements StampTable {
  private readonly rows = new Map<string, { stamp: string; seq: number }>()
  private seq = 0
  get = (key: string) => this.rows.get(key)?.stamp
  put = (key: string, stamp: string) => void this.rows.set(key, { stamp, seq: ++this.seq })
  since = (since: number, limit: number) =>
    [...this.rows]
      .filter(([, r]) => r.seq > since)
      .sort((a, b) => a[1].seq - b[1].seq)
      .slice(0, limit)
      .map(([key, r]) => ({ key, ...r }))
}

/** What a store that syncs offers the merge: a row's stamp, and taking another device's stamp for a row it writes. */
export interface SyncLedger {
  stampOf(ref: SyncRef): string | undefined
  /** The row `merge` is writing keeps `stamp` rather than getting a new one. */
  adopt(ref: SyncRef, stamp: string): void
  device: string
}

/**
 * A store that stamps every row written through it (PLAN.md §6.7), when its
 * transaction commits, in the same transaction. Reads go straight through.
 */
export class StampedStore implements Store {
  readonly nodes: NodeRepository
  readonly regions: RegionRepository
  readonly worlds: WorldRepository
  readonly assets: AssetRepository
  readonly sync: SyncLedger
  private depth = 0
  /** Rows written in the open transaction, and the stamps merged ones keep. */
  private readonly touched = new Set<string>()
  private readonly adopted = new Map<string, string>()
  private readonly recordRepos = new Map<RecordKind, RecordRepository<unknown>>()

  constructor(
    private readonly inner: Store,
    private readonly table: StampTable,
    private readonly clock: SyncClock
  ) {
    const touch = (ref: SyncRef) => this.touch(ref)
    const { nodes, regions, worlds, assets } = inner
    this.nodes = {
      get: (id) => nodes.get(id),
      children: (id) => nodes.children(id),
      all: () => nodes.all(),
      root: () => nodes.root(),
      insert: (n) => (nodes.insert(n), touch({ t: 'node', id: n.id })),
      update: (n) => (nodes.update(n), touch({ t: 'node', id: n.id }))
    }
    this.regions = {
      get: (id) => regions.get(id),
      all: () => regions.all(),
      insert: (r) => (regions.insert(r), touch({ t: 'region', id: r.id })),
      update: (r) => (regions.update(r), touch({ t: 'region', id: r.id }))
    }
    this.worlds = {
      getSettings: (id) => worlds.getSettings(id),
      putSettings: (id, settings) => (worlds.putSettings(id, settings), touch({ t: 'world', id })),
      getLayer: (id, layer, face) => worlds.getLayer(id, layer, face),
      putLayer: (id, layer, face, bytes) => (worlds.putLayer(id, layer, face, bytes), touch({ t: 'layer', id, layer, face })),
      terrainRevision: (id) => worlds.terrainRevision(id),
      // Each device counts its own revisions: they tell its views to load the terrain again, and aren't synced.
      bumpTerrainRevision: (id) => worlds.bumpTerrainRevision(id)
    }
    this.assets = {
      get: (id) => assets.get(id),
      put: (a) => (assets.put(a), touch({ t: 'asset', id: a.id })),
      remove: (id) => (assets.remove(id), touch({ t: 'asset', id }))
    }
    this.sync = {
      device: clock.device,
      stampOf: (ref) => this.table.get(refKey(ref)),
      adopt: (ref, s) => {
        this.adopted.set(refKey(ref), s)
        this.clock.see(s)
      }
    }
  }

  records<K extends RecordKind>(kind: K): RecordRepository<RecordOf<K>> {
    let repo = this.recordRepos.get(kind) as RecordRepository<RecordOf<K>> | undefined
    if (!repo) {
      const inner = this.inner.records(kind)
      repo = {
        get: (id) => inner.get(id),
        all: () => inner.all(),
        byOwner: (ownerId) => inner.byOwner(ownerId),
        insert: (r) => (inner.insert(r), this.touch({ t: 'record', kind, id: r.id })),
        update: (r) => (inner.update(r), this.touch({ t: 'record', kind, id: r.id }))
      }
      this.recordRepos.set(kind, repo as RecordRepository<unknown>)
    }
    return repo
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    return this.inner.transaction(() => {
      this.depth++
      try {
        const result = fn()
        this.flush()
        return result
      } finally {
        this.depth--
        this.touched.clear()
        this.adopted.clear()
      }
    })
  }

  /**
   * What another device asks for: the rows this copy got after `since` (0 for
   * all), as they are now, but those the asking device wrote itself (it has
   * them); where to ask from next, and whether there's more after that.
   */
  changesSince(since: number, { limit = 500, from }: { limit?: number; from?: string } = {}): { rows: SyncRow[]; upTo: number; more: boolean } {
    const got = this.table.since(since, limit)
    const theirs = from && `.${from}`
    const rows = got.filter(({ stamp: s }) => !theirs || !s.endsWith(theirs)).map(({ key, stamp: s }) => ({ key, stamp: s, data: readRow(this.inner, parseRefKey(key)) }))
    return { rows, upTo: got.at(-1)?.seq ?? since, more: got.length === limit }
  }

  private touch(ref: SyncRef): void {
    this.touched.add(refKey(ref))
    // A write outside a transaction (making a project's universe) is stamped at once.
    if (this.depth === 0) {
      this.flush()
      this.touched.clear()
    }
  }

  /** Each row its own stamp (rows that only share one would tie, and a page could end between them), or the one merged with it. */
  private flush(): void {
    for (const key of this.touched) this.table.put(key, this.adopted.get(key) ?? this.clock.next())
  }
}

/** A row as it travels: its key, its stamp, and what it holds (null: nothing, as an asset removed). */
export const SyncRow = z.object({ key: z.string().min(1).max(2000), stamp: SyncStamp, data: z.unknown() })
export type SyncRow = z.infer<typeof SyncRow>

/** What a row holds now, as it travels: byte arrays as base64, nothing as null. */
export function readRow(store: Store, ref: SyncRef): unknown {
  switch (ref.t) {
    case 'node':
      return store.nodes.get(ref.id) ?? null
    case 'world':
      return store.worlds.getSettings(ref.id) ?? null
    case 'layer': {
      const bytes = store.worlds.getLayer(ref.id, ref.layer, ref.face)
      return bytes ? bytesToBase64(bytes) : null
    }
    case 'region':
      return store.regions.get(ref.id) ?? null
    case 'record':
      return store.records(ref.kind).get(ref.id) ?? null
    case 'asset': {
      const asset = store.assets.get(ref.id)
      return asset ? { name: asset.name, mime: asset.mime, data: bytesToBase64(asset.data) } : null
    }
  }
}

