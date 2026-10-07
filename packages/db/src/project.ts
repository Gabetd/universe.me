import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { CommandBus, createRootUniverse, findRoot, type CommandBusOptions, type Store } from '@universe/core'
import { MIGRATIONS, SCHEMA_VERSION } from './migrations'
import { SqliteHistoryLog, SqliteStore } from './sqlite-store'

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
 * (WAL mode), so there is no separate "save" step; `saveAs` copies the file.
 */
export class Project {
  readonly store: Store
  readonly bus: CommandBus
  private closed = false

  private constructor(
    readonly path: string,
    private readonly db: DatabaseSync,
    busOptions: Omit<CommandBusOptions, 'log'>
  ) {
    this.store = new SqliteStore(db)
    this.bus = new CommandBus(this.store, { ...busOptions, log: new SqliteHistoryLog(db) })
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
      createRootUniverse(project.store, name)
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
      if (!findRoot(project.store)) throw new ProjectError(`${path} has no universe root`)
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
      name: this.getMeta('name') ?? 'Untitled',
      rootId: findRoot(this.store)!.id,
      schemaVersion: SCHEMA_VERSION
    }
  }

  getMeta(key: string): string | undefined {
    return readMeta(this.db, key)
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /** Writes a compacted copy to `path`. The current project stays open at its old path. */
  saveCopy(path: string): void {
    if (existsSync(path)) throw new ProjectError(`A file already exists at ${path}`)
    this.db.prepare('VACUUM INTO ?').run(path)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.close()
  }
}

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;')
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
