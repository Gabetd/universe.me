import { z } from 'zod'
import { bytesToBase64 } from './encoding'
import { RECORD_KINDS, type RecordKind } from './records'
import type { Id } from './schema'
import { ObservedStore } from './observed-store'
import type { Store } from './store'
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

/** A device's id: in every stamp it makes. */
export const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/
const STAMP = /^([0-9a-z]{11})\.([0-9a-z]{5})\.[A-Za-z0-9_-]{1,64}$/

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
    if (!DEVICE_ID.test(device)) throw new Error('A device id is letters, digits, - and _')
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
  const m = STAMP.exec(text)
  if (!m) throw new Error(`${text.slice(0, 40)} is not a sync stamp`)
  return [parseInt(m[1]!, 36), parseInt(m[2]!, 36)]
}

export const SyncStamp = z.string().regex(STAMP)

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
  /** Up to `limit` rows got after `since` (0 for all), in the order they came, but those `skip` (a device) stamped. */
  since(since: number, limit: number, skip?: string): { key: string; stamp: string; seq: number }[]
  /** When this copy last got a row (0: never). */
  readonly latest: number
}

export class MemoryStampTable implements StampTable {
  private readonly rows = new Map<string, { stamp: string; seq: number }>()
  latest = 0
  get = (key: string) => this.rows.get(key)?.stamp
  put = (key: string, stamp: string) => void this.rows.set(key, { stamp, seq: ++this.latest })
  since = (since: number, limit: number, skip?: string) =>
    [...this.rows]
      .filter(([, r]) => r.seq > since && !(skip && r.stamp.endsWith(`.${skip}`)))
      .sort((a, b) => a[1].seq - b[1].seq)
      .slice(0, limit)
      .map(([key, r]) => ({ key, ...r }))
}

/** What a store that syncs offers the merge: a row's stamp, and taking another device's stamp for a row it writes. */
export interface SyncLedger {
  stampOf(ref: SyncRef): string | undefined
  /** The row `merge` is writing keeps `stamp` rather than getting a new one. */
  adopt(ref: SyncRef, stamp: string): void
}

/** Rows from another device in one merge, at most: a pull is asked for in pages smaller than this. */
export const MAX_MERGE_ROWS = 2000
/** About how much a page of rows holds, at most (a face of terrain is about 170 kB as base64): one more row is sent past it. */
const PAGE_BYTES = 2_000_000

/**
 * A store that stamps every row written through it (PLAN.md §6.7), when its
 * transaction commits, in the same transaction. Reads go straight through.
 */
export class StampedStore extends ObservedStore {
  private readonly ledger: SyncLedger
  /** Rows written in the open transaction, and the stamps merged ones keep. */
  private readonly touched = new Set<string>()
  private readonly adopted = new Map<string, string>()

  constructor(
    inner: Store,
    private readonly table: StampTable,
    private readonly clock: SyncClock
  ) {
    super(inner)
    this.ledger = {
      stampOf: (ref) => this.table.get(refKey(ref)),
      adopt: (ref, s) => {
        this.adopted.set(refKey(ref), s)
        this.clock.see(s)
      }
    }
  }

  override get sync(): SyncLedger {
    return this.ledger
  }

  /**
   * What another device asks for: the rows this copy got after `since` (0 for
   * all), as they are now, but those the asking device wrote itself (it has
   * them); where to ask from next, and whether there's more after that.
   */
  changesSince(since: number, { limit = 500, from }: { limit?: number; from?: string } = {}): SyncPage {
    const got = this.table.since(since, limit, from)
    const rows: SyncRow[] = []
    let bytes = 0
    for (const { key, stamp: s } of got) {
      if (bytes > PAGE_BYTES) break
      const data = readRow(this.inner, parseRefKey(key))
      bytes += sizeOf(data)
      rows.push({ key, stamp: s, data })
    }
    const more = rows.length < got.length || got.length === limit
    // Everything got up to now has been seen, the asker's own rows too, unless the page ended first.
    return { rows, upTo: more ? got[rows.length - 1]!.seq : Math.max(since, this.table.latest), more }
  }

  protected wrote(ref: SyncRef): void {
    this.touched.add(refKey(ref))
  }

  /** Each row its own stamp (rows that only share one would tie, and a page could end between them), or the one merged with it. */
  protected override committing(): void {
    for (const key of this.touched) this.table.put(key, this.adopted.get(key) ?? this.clock.next())
  }

  protected override ended(): void {
    this.touched.clear()
    this.adopted.clear()
  }
}

/** About how many bytes a row's data takes as it travels. */
function sizeOf(data: unknown): number {
  if (typeof data === 'string') return data.length
  const asset = data as { data?: unknown } | null
  return typeof asset?.data === 'string' ? asset.data.length : JSON.stringify(data).length
}

/** A row as it travels: its key, its stamp, and what it holds (null: nothing, as an asset removed). */
export const SyncRow = z.object({ key: z.string().min(1).max(2000), stamp: SyncStamp, data: z.unknown() })
export type SyncRow = z.infer<typeof SyncRow>

/** A page of rows another device asked for: where to ask from next, and whether there's more after it. */
export const SyncPage = z.object({ rows: z.array(SyncRow).max(MAX_MERGE_ROWS), upTo: z.number().int().min(0), more: z.boolean() })
export type SyncPage = z.infer<typeof SyncPage>

/** What a row holds now, as it travels: byte arrays as base64, nothing as null. */
function readRow(store: Store, ref: SyncRef): unknown {
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

