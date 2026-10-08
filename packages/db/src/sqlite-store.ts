import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { deflateSync, inflateSync } from 'node:zlib'
import { DEFAULT_WORLD_SETTINGS, mergeWorldSettings } from '@universe/core'
import type {
  Asset,
  AssetRepository,
  NodeRepository,
  RecordKind,
  RecordOf,
  RecordRepository,
  Region,
  RegionRepository,
  SpatialNode,
  Store,
  WorldRepository,
  WorldSettingsPatch
} from '@universe/core'

type SqlValue = string | number | null
/** A table's columns, each with how to get its value from the object a row holds. */
type Columns<T> = Record<string, (value: T) => SqlValue>
/** A row as SQLite returns it: each column has the type its getter writes. */
type RowOf<C extends Columns<never>> = { [K in keyof C]: ReturnType<C[K]> }

const NODE_COLUMNS = {
  id: (n: SpatialNode) => n.id,
  parent_id: (n: SpatialNode) => n.parentId,
  kind: (n: SpatialNode) => n.kind,
  name: (n: SpatialNode) => n.name,
  seed: (n: SpatialNode) => n.seed,
  pos_x: (n: SpatialNode) => n.position.x,
  pos_y: (n: SpatialNode) => n.position.y,
  pos_z: (n: SpatialNode) => n.position.z,
  notes: (n: SpatialNode) => n.notes,
  tags: (n: SpatialNode) => JSON.stringify(n.tags),
  created_at: (n: SpatialNode) => n.createdAt,
  updated_at: (n: SpatialNode) => n.updatedAt,
  deleted_at: (n: SpatialNode) => n.deletedAt
}

const toNode = (r: RowOf<typeof NODE_COLUMNS>): SpatialNode => ({
  id: r.id,
  parentId: r.parent_id,
  kind: r.kind,
  name: r.name,
  seed: r.seed,
  position: { x: r.pos_x, y: r.pos_y, z: r.pos_z },
  notes: r.notes,
  tags: JSON.parse(r.tags) as string[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at
})

const REGION_COLUMNS = {
  id: (r: Region) => r.id,
  world_id: (r: Region) => r.worldId,
  name: (r: Region) => r.name,
  color: (r: Region) => r.color,
  points: (r: Region) => JSON.stringify(r.points),
  notes: (r: Region) => r.notes,
  created_at: (r: Region) => r.createdAt,
  updated_at: (r: Region) => r.updatedAt,
  deleted_at: (r: Region) => r.deletedAt
}

const toRegion = (r: RowOf<typeof REGION_COLUMNS>): Region => ({
  id: r.id,
  worldId: r.world_id,
  name: r.name,
  color: r.color,
  points: JSON.parse(r.points) as Region['points'],
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at
})

/** `UPDATE` that fails loudly when the row is missing, instead of silently doing nothing. */
function updateExisting(stmt: StatementSync, params: Record<string, SqlValue>, what: string): void {
  if (stmt.run(params).changes === 0) throw new Error(`${what} ${params.id} does not exist`)
}

/**
 * Reads and writes of a soft-deletable table, with the SQL made from its
 * columns. Live rows come oldest first; `query` reads other selects the same way.
 */
function softDeleteTable<T extends { id: string }, C extends Columns<T>>(db: DatabaseSync, table: string, columns: C, read: (row: RowOf<C>) => T, what: string) {
  const names = Object.keys(columns)
  const s = {
    get: db.prepare(`SELECT * FROM ${table} WHERE id = ?`),
    all: db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY created_at, id`),
    insert: db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((c) => `:${c}`).join(', ')})`),
    update: db.prepare(`UPDATE ${table} SET ${names.filter((c) => c !== 'id').map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`)
  }
  const params = (value: T) => Object.fromEntries(names.map((c) => [c, columns[c]!(value)]))
  const query = (stmt: StatementSync, ...args: SqlValue[]) => (stmt.all(...args) as unknown as RowOf<C>[]).map(read)
  return {
    get: (id: string) => {
      const row = s.get.get(id) as RowOf<C> | undefined
      return row && read(row)
    },
    all: () => query(s.all),
    insert: (value: T) => void s.insert.run(params(value)),
    update: (value: T) => updateExisting(s.update, params(value), what),
    query
  }
}

export class SqliteStore implements Store {
  readonly nodes: NodeRepository
  readonly worlds: WorldRepository
  readonly regions: RegionRepository
  readonly assets: AssetRepository
  private depth = 0
  private readonly recordRepos = new Map<RecordKind, RecordRepository<unknown>>()
  private readonly recordStmts: Record<'get' | 'all' | 'insert' | 'update', StatementSync>

  constructor(private readonly db: DatabaseSync) {
    const { query, ...nodes } = softDeleteTable(db, 'nodes', NODE_COLUMNS, toNode, 'Node')
    const children = db.prepare('SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
    this.nodes = { ...nodes, children: (parentId) => query(children, parentId) }

    const w = {
      getSettings: db.prepare('SELECT settings FROM worlds WHERE id = ?'),
      putSettings: db.prepare(
        'INSERT INTO worlds (id, settings) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings'
      ),
      revision: db.prepare('SELECT terrain_revision AS r FROM worlds WHERE id = ?'),
      bump: db.prepare(
        'INSERT INTO worlds (id, terrain_revision) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET terrain_revision = terrain_revision + 1'
      ),
      getLayer: db.prepare('SELECT data FROM terrain_layers WHERE world_id = ? AND layer = ? AND face = ?'),
      putLayer: db.prepare(
        'INSERT INTO terrain_layers (world_id, layer, face, data) VALUES (?, ?, ?, ?) ON CONFLICT(world_id, layer, face) DO UPDATE SET data = excluded.data'
      )
    }
    this.worlds = {
      getSettings: (id) => {
        const row = w.getSettings.get(id) as { settings: string | null } | undefined
        // Older projects saved fewer options; the rest get their defaults.
        return row?.settings ? mergeWorldSettings(DEFAULT_WORLD_SETTINGS, JSON.parse(row.settings) as WorldSettingsPatch) : undefined
      },
      putSettings: (id, settings) => void w.putSettings.run(id, JSON.stringify(settings)),
      // Edit layers are mostly zeros, so they compress to a few KB per face.
      getLayer: (id, layer, face) => {
        const row = w.getLayer.get(id, layer, face) as { data: Uint8Array } | undefined
        return row && new Uint8Array(inflateSync(row.data))
      },
      putLayer: (id, layer, face, bytes) => void w.putLayer.run(id, layer, face, deflateSync(bytes, { level: 1 })),
      terrainRevision: (id) => (w.revision.get(id) as { r: number } | undefined)?.r ?? 0,
      bumpTerrainRevision: (id) => void w.bump.run(id)
    }

    const { get, all, insert, update } = softDeleteTable(db, 'regions', REGION_COLUMNS, toRegion, 'Region')
    this.regions = { get, all, insert, update }

    const a = {
      get: db.prepare('SELECT id, name, mime, data FROM assets WHERE id = ?'),
      put: db.prepare('INSERT INTO assets (id, name, mime, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'),
      remove: db.prepare('DELETE FROM assets WHERE id = ?')
    }
    this.assets = {
      get: (id) => {
        const row = a.get.get(id) as (Omit<Asset, 'data'> & { data: Uint8Array }) | undefined
        // SQLite hands back a fresh buffer for every read, so there's no need to copy it.
        return row && { id: row.id, name: row.name, mime: row.mime, data: row.data }
      },
      put: (asset) => void a.put.run(asset.id, asset.name, asset.mime, asset.data),
      remove: (id) => void a.remove.run(id)
    }

    // Timeline records are stored whole as JSON, one table for every kind.
    this.recordStmts = {
      get: db.prepare('SELECT data FROM records WHERE kind = ? AND id = ?'),
      all: db.prepare('SELECT data FROM records WHERE kind = ? AND deleted_at IS NULL ORDER BY rowid'),
      insert: db.prepare('INSERT INTO records (kind, id, owner_id, data, deleted_at) VALUES (:kind, :id, :owner_id, :data, :deleted_at)'),
      update: db.prepare('UPDATE records SET owner_id = :owner_id, data = :data, deleted_at = :deleted_at WHERE kind = :kind AND id = :id')
    }
  }

  records<K extends RecordKind>(kind: K): RecordRepository<RecordOf<K>> {
    let repo = this.recordRepos.get(kind)
    if (!repo) {
      const s = this.recordStmts
      const params = (r: RecordOf<K>) => ({ kind, id: r.id, owner_id: r.ownerId, data: JSON.stringify(r), deleted_at: r.deletedAt })
      const parse = (row: { data: string } | undefined) => row && (JSON.parse(row.data) as RecordOf<K>)
      const typed: RecordRepository<RecordOf<K>> = {
        get: (id) => parse(s.get.get(kind, id) as { data: string } | undefined),
        all: () => (s.all.all(kind) as unknown as { data: string }[]).map((row) => parse(row)!),
        insert: (record) => void s.insert.run(params(record)),
        update: (record) => updateExisting(s.update, params(record), kind)
      }
      repo = typed as RecordRepository<unknown>
      this.recordRepos.set(kind, repo)
    }
    return repo as RecordRepository<RecordOf<K>>
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
