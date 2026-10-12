import type { DatabaseSync } from 'node:sqlite'
import { deflateSync, inflateSync } from 'node:zlib'
import { CUBE_FACES, RECORD_KINDS, SyncClock, refKey, type FieldStamps, type Lineage, type RowStamps, type StampTable, type StampedKey, type SyncRef, type TerrainLayerName } from '@universe/core'

/** A row of `row_stamps`, as SQLite returns it. */
interface StampRow {
  stamp: string
  fields: string | null
  lineage: string | null
}

const stampsOf = ({ stamp, fields, lineage }: StampRow): RowStamps => ({
  stamp,
  ...(fields && { fields: JSON.parse(fields) as FieldStamps }),
  ...(lineage && { lineage: JSON.parse(lineage) as Lineage })
})

/** A kept version as stored: text as it is, terrain deflated (as its layers are). */
const storedBase = (value: unknown): string | Uint8Array => (value instanceof Uint8Array ? deflateSync(value, { level: 1 }) : String(value))
const readBase = (value: unknown): unknown => (value instanceof Uint8Array ? new Uint8Array(inflateSync(value)) : value)

/** Each row's sync stamps in the project file (PLAN.md §6.7), with the order this copy got them in. */
export class SqliteStampTable implements StampTable {
  private readonly s
  /** When this copy last got a row (0: never). */
  latest: number

  constructor(db: DatabaseSync) {
    this.s = {
      get: db.prepare('SELECT stamp, fields, lineage FROM row_stamps WHERE key = ?'),
      put: db.prepare(
        'INSERT INTO row_stamps (key, stamp, fields, lineage, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET stamp = excluded.stamp, fields = excluded.fields, lineage = excluded.lineage, seq = excluded.seq'
      ),
      // The device's own rows are left out here, so the limit counts only rows that are sent.
      since: db.prepare("SELECT key, stamp, fields, lineage, seq FROM row_stamps WHERE seq > ? AND stamp NOT LIKE '%.' || ? ESCAPE '\\' ORDER BY seq LIMIT ?"),
      base: db.prepare('SELECT value FROM sync_bases WHERE key = ? AND path = ? AND stamp = ?'),
      keepBase: db.prepare('INSERT OR REPLACE INTO sync_bases (key, path, stamp, value) VALUES (?, ?, ?, ?)'),
      bases: db.prepare('SELECT stamp FROM sync_bases WHERE key = ? AND path = ?'),
      dropBase: db.prepare('DELETE FROM sync_bases WHERE key = ? AND path = ? AND stamp = ?')
    }
    this.latest = (db.prepare('SELECT max(seq) AS n FROM row_stamps').get() as { n: number | null }).n ?? 0
  }

  get(key: string): RowStamps | undefined {
    const row = this.s.get.get(key) as StampRow | undefined
    return row && stampsOf(row)
  }

  put(key: string, { stamp, fields, lineage }: RowStamps): void {
    this.s.put.run(key, stamp, fields ? JSON.stringify(fields) : null, lineage ? JSON.stringify(lineage) : null, ++this.latest)
  }

  base(key: string, path: string, stamp: string): unknown {
    const row = this.s.base.get(key, path, stamp) as { value: unknown } | undefined
    return row && readBase(row.value)
  }

  keepBase(key: string, path: string, stamp: string, value: unknown): void {
    this.s.keepBase.run(key, path, stamp, storedBase(value))
  }

  pruneBases(key: string, path: string, keep: readonly string[]): void {
    for (const { stamp } of this.s.bases.all(key, path) as { stamp: string }[]) if (!keep.includes(stamp)) this.s.dropBase.run(key, path, stamp)
  }

  since(since: number, limit: number, skip?: string): StampedKey[] {
    // A device id's _ is a LIKE wildcard; escaped, it's itself. With no device to skip, '%.' matches no stamp.
    const rows = this.s.since.all(since, skip ? skip.replace(/[\\%_]/g, '\\$&') : '', limit) as unknown as (StampRow & { key: string; seq: number })[]
    return rows.map((row) => ({ key: row.key, ...stampsOf(row), seq: row.seq }))
  }
}

/**
 * Stamps every row a project from before sync already has, once, so a copy
 * made from it gets them all. Only ever needed on such a project's first
 * open: from then on every write is stamped as it's made. A project that
 * syncs already only has its worlds' settings to stamp, those migration 10
 * made rows of their own.
 */
export function stampExisting(db: DatabaseSync, table: SqliteStampTable, clock: SyncClock, transaction: (fn: () => void) => void): void {
  const ids = (sql: string) => db.prepare(sql).all() as { id: string }[]
  const worlds = () => ids('SELECT id FROM worlds WHERE settings IS NOT NULL').map(({ id }): SyncRef => ({ t: 'world', id }))
  const stamp = (refs: SyncRef[]) => refs.length && transaction(() => refs.forEach((ref) => table.put(refKey(ref), { stamp: clock.next() })))
  if (table.latest > 0) return void stamp(worlds().filter((ref) => !table.get(refKey(ref))))
  stamp([
    ...ids('SELECT id FROM nodes').map(({ id }): SyncRef => ({ t: 'node', id })),
    ...worlds(),
    ...(db.prepare('SELECT world_id AS id, layer, face FROM terrain_layers').all() as { id: string; layer: TerrainLayerName; face: number }[])
      .filter((r) => r.face >= 0 && r.face < CUBE_FACES)
      .map(({ id, layer, face }): SyncRef => ({ t: 'layer', id, layer, face })),
    ...ids('SELECT id FROM regions').map(({ id }): SyncRef => ({ t: 'region', id })),
    ...(db.prepare('SELECT kind, id FROM records').all() as { kind: string; id: string }[])
      .filter((r): r is { kind: (typeof RECORD_KINDS)[number]; id: string } => (RECORD_KINDS as string[]).includes(r.kind))
      .map(({ kind, id }): SyncRef => ({ t: 'record', kind, id })),
    ...ids('SELECT id FROM assets').map(({ id }): SyncRef => ({ t: 'asset', id }))
  ])
}
