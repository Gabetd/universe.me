import type { Id, SpatialNode } from './schema'
import { RECORD_KINDS, type RecordKind, type RecordOf } from './records'
import type { Region, TerrainLayerName, WorldSettings } from './world'

/** Storage the domain layer needs. `packages/db` implements it on SQLite; tests use `MemoryStore`. */
export interface NodeRepository {
  /** Returns the node even if soft-deleted. */
  get(id: Id): SpatialNode | undefined
  /** Live (not deleted) children. */
  children(parentId: Id): SpatialNode[]
  /** Every live node. */
  all(): SpatialNode[]
  /** The live node without a parent: the universe. */
  root(): SpatialNode | undefined
  insert(node: SpatialNode): void
  update(node: SpatialNode): void
}

export interface WorldRepository {
  /** Undefined until the world's settings are first changed; callers fall back to defaults. */
  getSettings(worldId: Id): WorldSettings | undefined
  putSettings(worldId: Id, settings: WorldSettings): void
  /** Raw bytes of one cube face of a terrain layer, or undefined if never edited (all zeros). */
  getLayer(worldId: Id, layer: TerrainLayerName, face: number): Uint8Array | undefined
  putLayer(worldId: Id, layer: TerrainLayerName, face: number, bytes: Uint8Array): void
  terrainRevision(worldId: Id): number
  bumpTerrainRevision(worldId: Id): void
}

export interface RegionRepository {
  /** Returns the region even if soft-deleted. */
  get(id: Id): Region | undefined
  /** Every live region, across all worlds. */
  all(): Region[]
  insert(region: Region): void
  update(region: Region): void
}

/** Timeline records of one kind (events, links, eras…), across all owners. */
export interface RecordRepository<T> {
  /** Returns the record even if soft-deleted. */
  get(id: Id): T | undefined
  /** Every live record. */
  all(): T[]
  /** Every live record of one owner, in the order of `all()`. */
  byOwner(ownerId: Id): T[]
  insert(record: T): void
  update(record: T): void
}

/** A file kept inside the project (an imported glTF model). Assets are immutable. */
export interface Asset {
  id: Id
  name: string
  mime: string
  data: Uint8Array
}

export interface AssetRepository {
  get(id: Id): Asset | undefined
  put(asset: Asset): void
  remove(id: Id): void
}

export interface Store {
  nodes: NodeRepository
  assets: AssetRepository
  worlds: WorldRepository
  regions: RegionRepository
  records<K extends RecordKind>(kind: K): RecordRepository<RecordOf<K>>
  /** Runs `fn` atomically: all of its writes land, or none do. */
  transaction<T>(fn: () => T): T
}

/** A soft-deletable record kept in a Map; shared by MemoryStore's repositories. */
class MemoryTable<T extends { id: Id; deletedAt: string | null }> {
  rows = new Map<Id, T>()

  get = (id: Id): T | undefined => clone(this.rows.get(id))
  /** Live rows that pass `keep`, copied. */
  where = (keep: (row: T) => boolean): T[] => {
    const out: T[] = []
    for (const r of this.rows.values()) if (!r.deletedAt && keep(r)) out.push(clone(r))
    return out
  }
  live = (): T[] => this.where(() => true)
  insert = (row: T): void => {
    if (this.rows.has(row.id)) throw new Error(`${row.id} already exists`)
    this.rows.set(row.id, clone(row)!)
  }
  update = (row: T): void => {
    if (!this.rows.has(row.id)) throw new Error(`${row.id} does not exist`)
    this.rows.set(row.id, clone(row)!)
  }
}

export class MemoryStore implements Store {
  private readonly nodeTable = new MemoryTable<SpatialNode>()
  private readonly regionTable = new MemoryTable<Region>()
  private readonly recordTables = new Map(RECORD_KINDS.map((k) => [k, new MemoryTable<RecordOf<RecordKind>>()]))
  private settings = new Map<Id, WorldSettings>()
  private layers = new Map<string, Uint8Array>()
  private revisions = new Map<Id, number>()
  private assetRows = new Map<Id, Asset>()

  assets: AssetRepository = {
    get: (id) => clone(this.assetRows.get(id)),
    put: (asset) => void this.assetRows.set(asset.id, clone(asset)),
    remove: (id) => void this.assetRows.delete(id)
  }

  nodes: NodeRepository = {
    get: this.nodeTable.get,
    children: (parentId) => this.nodeTable.where((n) => n.parentId === parentId),
    all: this.nodeTable.live,
    root: () => this.nodeTable.where((n) => n.parentId === null)[0],
    insert: this.nodeTable.insert,
    update: this.nodeTable.update
  }

  regions: RegionRepository = {
    get: this.regionTable.get,
    all: this.regionTable.live,
    insert: this.regionTable.insert,
    update: this.regionTable.update
  }

  records<K extends RecordKind>(kind: K): RecordRepository<RecordOf<K>> {
    const t = this.recordTables.get(kind)! as unknown as MemoryTable<RecordOf<K>>
    return { get: t.get, all: t.live, byOwner: (ownerId) => t.where((r) => r.ownerId === ownerId), insert: t.insert, update: t.update }
  }

  worlds: WorldRepository = {
    getSettings: (id) => clone(this.settings.get(id)),
    putSettings: (id, s) => void this.settings.set(id, clone(s)),
    getLayer: (id, layer, face) => this.layers.get(`${id}/${layer}/${face}`)?.slice(),
    putLayer: (id, layer, face, bytes) => void this.layers.set(`${id}/${layer}/${face}`, bytes.slice()),
    terrainRevision: (id) => this.revisions.get(id) ?? 0,
    bumpTerrainRevision: (id) => void this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
  }

  transaction<T>(fn: () => T): T {
    const snapshot = {
      nodes: new Map(this.nodeTable.rows),
      regions: new Map(this.regionTable.rows),
      records: [...this.recordTables.values()].map((t) => new Map(t.rows)),
      settings: new Map(this.settings),
      layers: new Map(this.layers),
      revisions: new Map(this.revisions),
      assets: new Map(this.assetRows)
    }
    try {
      return fn()
    } catch (err) {
      this.nodeTable.rows = snapshot.nodes
      this.regionTable.rows = snapshot.regions
      ;[...this.recordTables.values()].forEach((t, i) => (t.rows = snapshot.records[i]!))
      this.settings = snapshot.settings
      this.layers = snapshot.layers
      this.revisions = snapshot.revisions
      this.assetRows = snapshot.assets
      throw err
    }
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}
