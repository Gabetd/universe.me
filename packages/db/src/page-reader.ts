import { DatabaseSync } from 'node:sqlite'
import { StampedStore, SyncClock, type SyncPage } from '@universe/core'
import { SqliteStore } from './sqlite-store'
import { SqliteStampTable } from './stamps'

/**
 * Reads pages of what a project got since a point, as another device asks
 * for them (PLAN.md §6.7, M21), through a read-only connection of its own:
 * in a worker, while the app's own connection goes on writing (WAL lets a
 * reader see what's committed without waiting for writes). Opened once per
 * file, and closed with `close`.
 */
export class PageReader {
  private readonly db: DatabaseSync
  private readonly sqlite: SqliteStore

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path, { readOnly: true })
    this.db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 2000;')
    this.sqlite = new SqliteStore(this.db)
  }

  /** The rows got after `since` (but `from`'s own), as `Project.changesSince` gives them. */
  changesSince(since: number, options: { limit?: number; from?: string } = {}): SyncPage {
    // A table read afresh each time: what it got last moves on as the app writes.
    return new StampedStore(this.sqlite, new SqliteStampTable(this.db), new SyncClock('reader')).changesSince(since, options)
  }

  close(): void {
    this.db.close()
  }
}
