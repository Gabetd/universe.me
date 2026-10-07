import { existsSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  CommandBus,
  createRootUniverse,
  findRoot,
  type CommandBusOptions,
  type HistoryLog,
  type NodeRepository,
  type SpatialNode,
  type Store
} from '@universe/core'
import { MIGRATIONS, SCHEMA_VERSION } from './migrations'

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

interface NodeRow {
  id: string
  parent_id: string | null
  kind: string
  name: string
  seed: number
  pos_x: number
  pos_y: number
  pos_z: number
  notes: string
  tags: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

const toNode = (r: NodeRow): SpatialNode => ({
  id: r.id,
  parentId: r.parent_id,
  kind: r.kind as SpatialNode['kind'],
  name: r.name,
  seed: r.seed,
  position: { x: r.pos_x, y: r.pos_y, z: r.pos_z },
  notes: r.notes,
  tags: JSON.parse(r.tags) as string[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at
})

const toParams = (n: SpatialNode) => ({
  id: n.id,
  parent_id: n.parentId,
  kind: n.kind,
  name: n.name,
  seed: n.seed,
  pos_x: n.position.x,
  pos_y: n.position.y,
  pos_z: n.position.z,
  notes: n.notes,
  tags: JSON.stringify(n.tags),
  created_at: n.createdAt,
  updated_at: n.updatedAt,
  deleted_at: n.deletedAt
})

class SqliteStore implements Store {
  readonly nodes: NodeRepository
  private depth = 0

  constructor(private readonly db: DatabaseSync) {
    const q = {
      get: db.prepare('SELECT * FROM nodes WHERE id = ?'),
      children: db.prepare('SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at, id'),
      all: db.prepare('SELECT * FROM nodes WHERE deleted_at IS NULL ORDER BY created_at, id'),
      insert: db.prepare(`INSERT INTO nodes (id, parent_id, kind, name, seed, pos_x, pos_y, pos_z, notes, tags, created_at, updated_at, deleted_at)
        VALUES (:id, :parent_id, :kind, :name, :seed, :pos_x, :pos_y, :pos_z, :notes, :tags, :created_at, :updated_at, :deleted_at)`),
      update: db.prepare(`UPDATE nodes SET parent_id = :parent_id, kind = :kind, name = :name, seed = :seed,
        pos_x = :pos_x, pos_y = :pos_y, pos_z = :pos_z, notes = :notes, tags = :tags,
        created_at = :created_at, updated_at = :updated_at, deleted_at = :deleted_at WHERE id = :id`)
    } satisfies Record<string, StatementSync>

    this.nodes = {
      get: (id) => {
        const row = q.get.get(id) as NodeRow | undefined
        return row && toNode(row)
      },
      children: (parentId) => (q.children.all(parentId) as unknown as NodeRow[]).map(toNode),
      all: () => (q.all.all() as unknown as NodeRow[]).map(toNode),
      insert: (node) => void q.insert.run(toParams(node)),
      update: (node) => {
        const { changes } = q.update.run(toParams(node))
        if (changes === 0) throw new Error(`Node ${node.id} does not exist`)
      }
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.depth++
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this.depth--
    }
  }
}

class SqliteHistoryLog implements HistoryLog {
  private readonly insert: StatementSync

  constructor(db: DatabaseSync) {
    this.insert = db.prepare('INSERT INTO command_log (at, action, source, type, command, inverse) VALUES (?, ?, ?, ?, ?, ?)')
  }

  append(r: Parameters<HistoryLog['append']>[0]): void {
    this.insert.run(r.at, r.action, r.source, r.command.type, JSON.stringify(r.command), JSON.stringify(r.inverse))
  }
}
