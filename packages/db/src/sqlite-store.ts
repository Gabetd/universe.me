import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { deflateSync, inflateSync } from 'node:zlib'
import type {
  HistoryLog,
  HistoryRecord,
  NodeRepository,
  Region,
  RegionRepository,
  SpatialNode,
  Store,
  WorldRepository,
  WorldSettings
} from '@universe/core'

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

const nodeParams = (n: SpatialNode) => ({
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

interface RegionRow {
  id: string
  world_id: string
  name: string
  color: string
  points: string
  notes: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

const toRegion = (r: RegionRow): Region => ({
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

const regionParams = (r: Region) => ({
  id: r.id,
  world_id: r.worldId,
  name: r.name,
  color: r.color,
  points: JSON.stringify(r.points),
  notes: r.notes,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
  deleted_at: r.deletedAt
})

/** `UPDATE` that fails loudly when the row is missing, instead of silently doing nothing. */
function updateExisting(stmt: StatementSync, params: Record<string, string | number | null>, what: string): void {
  if (stmt.run(params).changes === 0) throw new Error(`${what} ${params.id} does not exist`)
}

export class SqliteStore implements Store {
  readonly nodes: NodeRepository
  readonly worlds: WorldRepository
  readonly regions: RegionRepository
  private depth = 0

  constructor(private readonly db: DatabaseSync) {
    const n = {
      get: db.prepare('SELECT * FROM nodes WHERE id = ?'),
      children: db.prepare('SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at, id'),
      all: db.prepare('SELECT * FROM nodes WHERE deleted_at IS NULL ORDER BY created_at, id'),
      insert: db.prepare(`INSERT INTO nodes (id, parent_id, kind, name, seed, pos_x, pos_y, pos_z, notes, tags, created_at, updated_at, deleted_at)
        VALUES (:id, :parent_id, :kind, :name, :seed, :pos_x, :pos_y, :pos_z, :notes, :tags, :created_at, :updated_at, :deleted_at)`),
      update: db.prepare(`UPDATE nodes SET parent_id = :parent_id, kind = :kind, name = :name, seed = :seed,
        pos_x = :pos_x, pos_y = :pos_y, pos_z = :pos_z, notes = :notes, tags = :tags,
        created_at = :created_at, updated_at = :updated_at, deleted_at = :deleted_at WHERE id = :id`)
    }
    this.nodes = {
      get: (id) => {
        const row = n.get.get(id) as NodeRow | undefined
        return row && toNode(row)
      },
      children: (parentId) => (n.children.all(parentId) as unknown as NodeRow[]).map(toNode),
      all: () => (n.all.all() as unknown as NodeRow[]).map(toNode),
      insert: (node) => void n.insert.run(nodeParams(node)),
      update: (node) => updateExisting(n.update, nodeParams(node), 'Node')
    }

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
        return row?.settings ? (JSON.parse(row.settings) as WorldSettings) : undefined
      },
      putSettings: (id, settings) => void w.putSettings.run(id, JSON.stringify(settings)),
      // Edit layers are mostly zeros, so they compress to a few KB per face.
      getLayer: (id, layer, face) => {
        const row = w.getLayer.get(id, layer, face) as { data: Uint8Array } | undefined
        return row && new Uint8Array(inflateSync(row.data))
      },
      putLayer: (id, layer, face, bytes) => void w.putLayer.run(id, layer, face, deflateSync(bytes)),
      terrainRevision: (id) => (w.revision.get(id) as { r: number } | undefined)?.r ?? 0,
      bumpTerrainRevision: (id) => void w.bump.run(id)
    }

    const r = {
      get: db.prepare('SELECT * FROM regions WHERE id = ?'),
      all: db.prepare('SELECT * FROM regions WHERE deleted_at IS NULL ORDER BY created_at, id'),
      insert: db.prepare(`INSERT INTO regions (id, world_id, name, color, points, notes, created_at, updated_at, deleted_at)
        VALUES (:id, :world_id, :name, :color, :points, :notes, :created_at, :updated_at, :deleted_at)`),
      update: db.prepare(`UPDATE regions SET world_id = :world_id, name = :name, color = :color, points = :points, notes = :notes,
        created_at = :created_at, updated_at = :updated_at, deleted_at = :deleted_at WHERE id = :id`)
    }
    this.regions = {
      get: (id) => {
        const row = r.get.get(id) as RegionRow | undefined
        return row && toRegion(row)
      },
      all: () => (r.all.all() as unknown as RegionRow[]).map(toRegion),
      insert: (region) => void r.insert.run(regionParams(region)),
      update: (region) => updateExisting(r.update, regionParams(region), 'Region')
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

export class SqliteHistoryLog implements HistoryLog {
  private readonly insert: StatementSync

  constructor(db: DatabaseSync) {
    this.insert = db.prepare('INSERT INTO command_log (at, action, source, type, command, inverse) VALUES (?, ?, ?, ?, ?, ?)')
  }

  append(r: HistoryRecord): void {
    this.insert.run(r.at, r.action, r.source, r.command.type, JSON.stringify(r.command), JSON.stringify(r.inverse))
  }
}
