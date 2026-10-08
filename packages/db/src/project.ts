import { existsSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { CommandBus, createRootUniverse, findRoot, type CommandBusOptions, type Store } from '@universe/core'
import { TrackedStore } from './changes'
import { SqliteHistoryLog } from './history-log'
import { MIGRATIONS, SCHEMA_VERSION } from './migrations'
import { SnapshotCache, type Snapshot } from './snapshot'
import { SqliteStore } from './sqlite-store'
import { vacuumInto } from './vacuum'

const FORMAT = 'universe.me'

export class ProjectError extends Error {
  override name = 'ProjectError'
}

export interface ProjectInfo {
  path: string
  name: string
  rootId: string
  schemaVersion: number
}

/**
 * An open `.universe` file. Every command is written through immediately
 * (WAL mode), so there is no separate "save" step; `saveCopy` copies the file.
 */
export class Project {
  readonly store: Store
  readonly bus: CommandBus
  private closed = false
  /** Copies being written from this file right now. */
  private saving = 0
  private readonly meta: { get: StatementSync; set: StatementSync }
  private readonly snapshots: SnapshotCache
  /** Read once: the name only changes through `setMeta` and the root is never deleted. */
  private name: string | undefined
  private rootId = ''

  private constructor(
    readonly path: string,
    private readonly db: DatabaseSync,
    busOptions: Omit<CommandBusOptions, 'log'>
  ) {
    // Every write goes through the tracked store, so a snapshot reloads only what changed; reads go straight to SQLite.
    const sqlite = new SqliteStore(db)
    const tracked = new TrackedStore(sqlite)
    this.store = tracked
    this.snapshots = new SnapshotCache(sqlite, () => tracked.takeChanges())
    this.bus = new CommandBus(this.store, { ...busOptions, log: new SqliteHistoryLog(db) })
    this.meta = {
      get: db.prepare('SELECT value FROM meta WHERE key = ?'),
      set: db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    }
    this.name = this.getMeta('name')
  }

  /** Creates a new project file. Fails if `path` already exists. */
  static create(path: string, name: string, busOptions: Omit<CommandBusOptions, 'log'> = {}): Project {
    if (existsSync(path)) throw new ProjectError(`A file already exists at ${path}`)
    const db = openDb(path)
    try {
      migrate(db)
      const project = new Project(path, db, busOptions)
      project.store.transaction(() => {
        project.setMeta('format', FORMAT)
        project.setMeta('createdAt', new Date().toISOString())
        project.setMeta('name', name)
      })
      project.rootId = createRootUniverse(project.store, name).id
      return project
    } catch (err) {
      db.close()
      throw err
    }
  }

  static open(path: string, busOptions: Omit<CommandBusOptions, 'log'> = {}): Project {
    if (!existsSync(path)) throw new ProjectError(`No project found at ${path}`)
    let db: DatabaseSync | undefined
    try {
      db = openDb(path)
      const format = readMeta(db, 'format')
      if (format !== FORMAT) throw new ProjectError(`${path} is not a universe.me project`)
      migrate(db)
      const project = new Project(path, db, busOptions)
      const root = findRoot(project.store)
      if (!root) throw new ProjectError(`${path} has no universe root`)
      project.rootId = root.id
      return project
    } catch (err) {
      db?.close()
      if (err instanceof ProjectError) throw err
      throw new ProjectError(`Could not open ${path}: ${(err as Error).message}`)
    }
  }

  info(): ProjectInfo {
    return {
      path: this.path,
      name: this.name ?? 'Untitled',
      rootId: this.rootId,
      schemaVersion: SCHEMA_VERSION
    }
  }

  /** Everything live in the project. Cheap to call again: only what was written since the last call is reloaded. */
  snapshot(): Snapshot {
    return this.snapshots.snapshot()
  }

  getMeta(key: string): string | undefined {
    return (this.meta.get.get(key) as { value: string } | undefined)?.value
  }

  setMeta(key: string, value: string): void {
    this.meta.set.run(key, value)
    if (key === 'name') this.name = value
  }

  /** Writes a compacted copy to `path`, off the main thread. The current project stays open at its old path. */
  async saveCopy(path: string): Promise<void> {
    if (existsSync(path)) throw new ProjectError(`A file already exists at ${path}`)
    this.saving++
    try {
      await vacuumInto(this.path, path)
    } finally {
      this.saving--
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // Emptying the WAL waits for every reader, so while a copy is being saved it's left for the next open.
    this.db.exec(`PRAGMA wal_checkpoint(${this.saving ? 'PASSIVE' : 'TRUNCATE'})`)
    this.db.close()
  }
}

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  // NORMAL skips the sync on every commit (WAL syncs at checkpoints instead): a commit still survives the
  // app crashing, and only an OS crash or power cut can lose the last few. FULL made each command ~2.5x slower.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;')
  return db
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  if (!hasMeta) return undefined
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (current > SCHEMA_VERSION) {
    throw new ProjectError(`This project was made by a newer version of universe.me (schema ${current}). Please update the app.`)
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v]!)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
