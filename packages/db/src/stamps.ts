import type { DatabaseSync } from 'node:sqlite'
import { CUBE_FACES, RECORD_KINDS, SyncClock, refKey, type StampTable, type SyncRef, type TerrainLayerName } from '@universe/core'

/** Each row's sync stamp in the project file (PLAN.md §6.7), with the order this copy got them in. */
export class SqliteStampTable implements StampTable {
  private readonly s
  private seq: number

  constructor(db: DatabaseSync) {
    this.s = {
      get: db.prepare('SELECT stamp FROM row_stamps WHERE key = ?'),
      put: db.prepare('INSERT INTO row_stamps (key, stamp, seq) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET stamp = excluded.stamp, seq = excluded.seq'),
      since: db.prepare('SELECT key, stamp, seq FROM row_stamps WHERE seq > ? ORDER BY seq LIMIT ?')
    }
    this.seq = (db.prepare('SELECT max(seq) AS n FROM row_stamps').get() as { n: number | null }).n ?? 0
  }

  get(key: string): string | undefined {
    return (this.s.get.get(key) as { stamp: string } | undefined)?.stamp
  }

  put(key: string, stamp: string): void {
    this.s.put.run(key, stamp, ++this.seq)
  }

  since(since: number, limit: number): { key: string; stamp: string; seq: number }[] {
    return this.s.since.all(since, limit) as { key: string; stamp: string; seq: number }[]
  }

  /** How many rows have stamps: none in a project from before sync. */
  get size(): number {
    return this.seq
  }
}

/**
 * Stamps every row a project from before sync already has, once, so a copy
 * made from it gets them all. Only ever needed on such a project's first
 * open: from then on every write is stamped as it's made.
 */
export function stampExisting(db: DatabaseSync, table: SqliteStampTable, clock: SyncClock): void {
  if (table.size > 0) return
  const refs: SyncRef[] = [
    ...(db.prepare('SELECT id FROM nodes').all() as { id: string }[]).map(({ id }): SyncRef => ({ t: 'node', id })),
    ...(db.prepare('SELECT id FROM worlds WHERE settings IS NOT NULL').all() as { id: string }[]).map(({ id }): SyncRef => ({ t: 'world', id })),
    ...(db.prepare('SELECT world_id AS id, layer, face FROM terrain_layers').all() as { id: string; layer: TerrainLayerName; face: number }[])
      .filter((r) => r.face >= 0 && r.face < CUBE_FACES)
      .map(({ id, layer, face }): SyncRef => ({ t: 'layer', id, layer, face })),
    ...(db.prepare('SELECT id FROM regions').all() as { id: string }[]).map(({ id }): SyncRef => ({ t: 'region', id })),
    ...(db.prepare('SELECT kind, id FROM records').all() as { kind: string; id: string }[])
      .filter((r): r is { kind: (typeof RECORD_KINDS)[number]; id: string } => (RECORD_KINDS as string[]).includes(r.kind))
      .map(({ kind, id }): SyncRef => ({ t: 'record', kind, id })),
    ...(db.prepare('SELECT id FROM assets').all() as { id: string }[]).map(({ id }): SyncRef => ({ t: 'asset', id }))
  ]
  db.exec('BEGIN')
  try {
    for (const ref of refs) table.put(refKey(ref), clock.next())
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
