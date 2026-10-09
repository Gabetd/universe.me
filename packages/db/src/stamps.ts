import type { DatabaseSync } from 'node:sqlite'
import { CUBE_FACES, RECORD_KINDS, SyncClock, refKey, type StampTable, type SyncRef, type TerrainLayerName } from '@universe/core'

/** Each row's sync stamp in the project file (PLAN.md §6.7), with the order this copy got them in. */
export class SqliteStampTable implements StampTable {
  private readonly s
  /** When this copy last got a row (0: never). */
  latest: number

  constructor(db: DatabaseSync) {
    this.s = {
      get: db.prepare('SELECT stamp FROM row_stamps WHERE key = ?'),
      put: db.prepare('INSERT INTO row_stamps (key, stamp, seq) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET stamp = excluded.stamp, seq = excluded.seq'),
      // The device's own rows are left out here, so the limit counts only rows that are sent.
      since: db.prepare("SELECT key, stamp, seq FROM row_stamps WHERE seq > ? AND stamp NOT LIKE '%.' || ? ESCAPE '\\' ORDER BY seq LIMIT ?")
    }
    this.latest = (db.prepare('SELECT max(seq) AS n FROM row_stamps').get() as { n: number | null }).n ?? 0
  }

  get(key: string): string | undefined {
    return (this.s.get.get(key) as { stamp: string } | undefined)?.stamp
  }

  put(key: string, stamp: string): void {
    this.s.put.run(key, stamp, ++this.latest)
  }

  since(since: number, limit: number, skip?: string): { key: string; stamp: string; seq: number }[] {
    // A device id's _ is a LIKE wildcard; escaped, it's itself. With no device to skip, '%.' matches no stamp.
    return this.s.since.all(since, skip ? skip.replace(/[\\%_]/g, '\\$&') : '', limit) as { key: string; stamp: string; seq: number }[]
  }
}

/**
 * Stamps every row a project from before sync already has, once, so a copy
 * made from it gets them all. Only ever needed on such a project's first
 * open: from then on every write is stamped as it's made.
 */
export function stampExisting(db: DatabaseSync, table: SqliteStampTable, clock: SyncClock, transaction: (fn: () => void) => void): void {
  if (table.latest > 0) return
  const ids = (sql: string) => db.prepare(sql).all() as { id: string }[]
  const refs: SyncRef[] = [
    ...ids('SELECT id FROM nodes').map(({ id }): SyncRef => ({ t: 'node', id })),
    ...ids('SELECT id FROM worlds WHERE settings IS NOT NULL').map(({ id }): SyncRef => ({ t: 'world', id })),
    ...(db.prepare('SELECT world_id AS id, layer, face FROM terrain_layers').all() as { id: string; layer: TerrainLayerName; face: number }[])
      .filter((r) => r.face >= 0 && r.face < CUBE_FACES)
      .map(({ id, layer, face }): SyncRef => ({ t: 'layer', id, layer, face })),
    ...ids('SELECT id FROM regions').map(({ id }): SyncRef => ({ t: 'region', id })),
    ...(db.prepare('SELECT kind, id FROM records').all() as { kind: string; id: string }[])
      .filter((r): r is { kind: (typeof RECORD_KINDS)[number]; id: string } => (RECORD_KINDS as string[]).includes(r.kind))
      .map(({ kind, id }): SyncRef => ({ t: 'record', kind, id })),
    ...ids('SELECT id FROM assets').map(({ id }): SyncRef => ({ t: 'asset', id }))
  ]
  transaction(() => {
    for (const ref of refs) table.put(refKey(ref), clock.next())
  })
}
