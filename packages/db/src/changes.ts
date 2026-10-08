import type { AssetRepository, Id, NodeRepository, RecordKind, RecordOf, RecordRepository, RegionRepository, Store, WorldRepository } from '@universe/core'

/** Rows written to one table (or record kind): every one touched, and which of them were added, in order. */
export interface TableChanges {
  touched: Set<Id>
  inserted: Set<Id>
}

const tableChanges = (): TableChanges => ({ touched: new Set(), inserted: new Set() })

/** What was written to a store since the changes were last taken. */
export class Changes {
  readonly nodes = tableChanges()
  readonly regions = tableChanges()
  /** Worlds whose settings or terrain changed. */
  readonly worlds = new Set<Id>()
  readonly records = new Map<RecordKind, TableChanges>()

  record(kind: RecordKind): TableChanges {
    let changes = this.records.get(kind)
    if (!changes) this.records.set(kind, (changes = tableChanges()))
    return changes
  }

  /** Adds `later`'s writes after this one's, keeping the order rows were added in. */
  merge(later: Changes): void {
    const into = (to: TableChanges, from: TableChanges) => {
      for (const id of from.touched) to.touched.add(id)
      for (const id of from.inserted) to.inserted.add(id)
    }
    into(this.nodes, later.nodes)
    into(this.regions, later.regions)
    for (const id of later.worlds) this.worlds.add(id)
    for (const [kind, changes] of later.records) into(this.record(kind), changes)
  }
}

/**
 * A store that notes every write it passes on, so a snapshot can reload just
 * those rows. Writes in a transaction are noted once it commits: one that
 * rolled back changed nothing.
 */
export class TrackedStore implements Store {
  readonly nodes: NodeRepository
  readonly regions: RegionRepository
  readonly worlds: WorldRepository
  /** Assets aren't part of a snapshot, so their writes aren't noted. */
  readonly assets: AssetRepository
  private changes = new Changes()
  /** Writes of the open transaction, until it commits. */
  private pending: Changes | undefined
  private readonly recordRepos = new Map<RecordKind, RecordRepository<unknown>>()

  constructor(private readonly inner: Store) {
    const { nodes, regions, worlds } = inner
    this.nodes = { get: (id) => nodes.get(id), children: (id) => nodes.children(id), all: () => nodes.all(), root: () => nodes.root(), ...this.noteWrites(nodes, (c) => c.nodes) }
    this.regions = { get: (id) => regions.get(id), all: () => regions.all(), ...this.noteWrites(regions, (c) => c.regions) }
    const world = (id: Id) => void this.noting().worlds.add(id)
    this.worlds = {
      getSettings: (id) => worlds.getSettings(id),
      putSettings: (id, settings) => {
        worlds.putSettings(id, settings)
        world(id)
      },
      getLayer: (id, layer, face) => worlds.getLayer(id, layer, face),
      putLayer: (id, layer, face, bytes) => {
        worlds.putLayer(id, layer, face, bytes)
        world(id)
      },
      terrainRevision: (id) => worlds.terrainRevision(id),
      bumpTerrainRevision: (id) => {
        worlds.bumpTerrainRevision(id)
        world(id)
      }
    }
    this.assets = inner.assets
  }

  records<K extends RecordKind>(kind: K): RecordRepository<RecordOf<K>> {
    let repo = this.recordRepos.get(kind) as RecordRepository<RecordOf<K>> | undefined
    if (!repo) {
      const inner = this.inner.records(kind)
      repo = { get: (id) => inner.get(id), all: () => inner.all(), byOwner: (ownerId) => inner.byOwner(ownerId), ...this.noteWrites(inner, (c) => c.record(kind)) }
      this.recordRepos.set(kind, repo as RecordRepository<unknown>)
    }
    return repo
  }

  transaction<T>(fn: () => T): T {
    if (this.pending) return this.inner.transaction(fn)
    const pending = (this.pending = new Changes())
    try {
      const result = this.inner.transaction(fn)
      this.changes.merge(pending)
      return result
    } finally {
      this.pending = undefined
    }
  }

  /** Everything written (and committed) since the last call. */
  takeChanges(): Changes {
    const taken = this.changes
    this.changes = new Changes()
    return taken
  }

  private noting(): Changes {
    return this.pending ?? this.changes
  }

  /** Insert and update that pass the row on, then note it. A write that throws is not noted. */
  private noteWrites<T extends { id: Id }>(repo: { insert(row: T): void; update(row: T): void }, table: (c: Changes) => TableChanges) {
    return {
      insert: (row: T) => {
        repo.insert(row)
        const changes = table(this.noting())
        changes.touched.add(row.id)
        changes.inserted.add(row.id)
      },
      update: (row: T) => {
        repo.update(row)
        table(this.noting()).touched.add(row.id)
      }
    }
  }
}
