import type { Id, SpatialNode } from './schema'
import type { Region, TerrainLayerName, WorldSettings } from './world'

/** Storage the domain layer needs. `packages/db` implements it on SQLite; tests use `MemoryStore`. */
export interface NodeRepository {
  /** Returns the node even if soft-deleted. */
  get(id: Id): SpatialNode | undefined
  /** Live (not deleted) children. */
  children(parentId: Id): SpatialNode[]
  /** Every live node. */
  all(): SpatialNode[]
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

export interface Store {
  nodes: NodeRepository
  worlds: WorldRepository
  regions: RegionRepository
  /** Runs `fn` atomically: all of its writes land, or none do. */
  transaction<T>(fn: () => T): T
}

/** A soft-deletable record kept in a Map; shared by MemoryStore's repositories. */
class MemoryTable<T extends { id: Id; deletedAt: string | null }> {
  rows = new Map<Id, T>()

  get = (id: Id): T | undefined => clone(this.rows.get(id))
  live = (): T[] => [...this.rows.values()].filter((r) => !r.deletedAt).map((r) => clone(r)!)
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
  private settings = new Map<Id, WorldSettings>()
  private layers = new Map<string, Uint8Array>()
  private revisions = new Map<Id, number>()

  nodes: NodeRepository = {
    get: this.nodeTable.get,
    children: (parentId) => this.nodeTable.live().filter((n) => n.parentId === parentId),
    all: this.nodeTable.live,
    insert: this.nodeTable.insert,
    update: this.nodeTable.update
  }

  regions: RegionRepository = {
    get: this.regionTable.get,
    all: this.regionTable.live,
    insert: this.regionTable.insert,
    update: this.regionTable.update
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
      settings: new Map(this.settings),
      layers: new Map(this.layers),
      revisions: new Map(this.revisions)
    }
    try {
      return fn()
    } catch (err) {
      this.nodeTable.rows = snapshot.nodes
      this.regionTable.rows = snapshot.regions
      this.settings = snapshot.settings
      this.layers = snapshot.layers
      this.revisions = snapshot.revisions
      throw err
    }
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}
