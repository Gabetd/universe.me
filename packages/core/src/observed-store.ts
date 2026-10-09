import type { RecordKind, RecordOf } from './records'
import type { Id } from './schema'
import type { AssetRepository, NodeRepository, RecordRepository, RegionRepository, Store, WorldRepository } from './store'
import type { SyncLedger, SyncRef } from './sync'

/**
 * A store that passes everything on to another and tells its subclass about
 * each write that went through (one that throws isn't told), and about each
 * outermost transaction ending. A write outside a transaction is a
 * transaction of its own. Snapshots' change tracking (in `packages/db`) and
 * sync's stamps (`StampedStore`) are built on it, so a new kind of write is
 * wired once.
 */
export abstract class ObservedStore implements Store {
  readonly nodes: NodeRepository
  readonly regions: RegionRepository
  readonly worlds: WorldRepository
  readonly assets: AssetRepository
  private depth = 0
  private readonly recordRepos = new Map<RecordKind, RecordRepository<unknown>>()

  /** A row was written; `inserted` if it's new. */
  protected abstract wrote(ref: SyncRef, inserted: boolean): void
  /** A world's terrain revision went up (not a row of its own: each device counts its own). */
  protected bumped(_worldId: Id): void {}
  /** The writes are all in and the transaction is about to commit: writes made here land in it. */
  protected committing(): void {}
  /** The transaction is over: committed, or rolled back. */
  protected ended(_committed: boolean): void {}

  get sync(): SyncLedger | undefined {
    return this.inner.sync
  }

  constructor(protected readonly inner: Store) {
    const { nodes, regions, worlds, assets } = inner
    this.nodes = {
      get: (id) => nodes.get(id),
      children: (id) => nodes.children(id),
      all: () => nodes.all(),
      root: () => nodes.root(),
      insert: (n) => (nodes.insert(n), this.note({ t: 'node', id: n.id }, true)),
      update: (n) => (nodes.update(n), this.note({ t: 'node', id: n.id }, false))
    }
    this.regions = {
      get: (id) => regions.get(id),
      all: () => regions.all(),
      insert: (r) => (regions.insert(r), this.note({ t: 'region', id: r.id }, true)),
      update: (r) => (regions.update(r), this.note({ t: 'region', id: r.id }, false))
    }
    this.worlds = {
      getSettings: (id) => worlds.getSettings(id),
      putSettings: (id, settings) => (worlds.putSettings(id, settings), this.note({ t: 'world', id }, false)),
      getLayer: (id, layer, face) => worlds.getLayer(id, layer, face),
      putLayer: (id, layer, face, bytes) => (worlds.putLayer(id, layer, face, bytes), this.note({ t: 'layer', id, layer, face }, false)),
      terrainRevision: (id) => worlds.terrainRevision(id),
      bumpTerrainRevision: (id) => (worlds.bumpTerrainRevision(id), this.alone(() => this.bumped(id)))
    }
    this.assets = {
      get: (id) => assets.get(id),
      put: (a) => (assets.put(a), this.note({ t: 'asset', id: a.id }, false)),
      remove: (id) => (assets.remove(id), this.note({ t: 'asset', id }, false))
    }
  }

  records<K extends RecordKind>(kind: K): RecordRepository<RecordOf<K>> {
    let repo = this.recordRepos.get(kind) as RecordRepository<RecordOf<K>> | undefined
    if (!repo) {
      const inner = this.inner.records(kind)
      repo = {
        get: (id) => inner.get(id),
        all: () => inner.all(),
        byOwner: (ownerId) => inner.byOwner(ownerId),
        insert: (r) => (inner.insert(r), this.note({ t: 'record', kind, id: r.id }, true)),
        update: (r) => (inner.update(r), this.note({ t: 'record', kind, id: r.id }, false))
      }
      this.recordRepos.set(kind, repo as RecordRepository<unknown>)
    }
    return repo
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return this.inner.transaction(fn)
    let committed = false
    try {
      const result = this.inner.transaction(() => {
        this.depth++
        try {
          const out = fn()
          this.committing()
          return out
        } finally {
          this.depth--
        }
      })
      committed = true
      return result
    } finally {
      this.ended(committed)
    }
  }

  private note(ref: SyncRef, inserted: boolean): void {
    this.alone(() => this.wrote(ref, inserted))
  }

  /** Tells of a write; outside a transaction, it's committed as soon as it's made. */
  private alone(tell: () => void): void {
    tell()
    if (this.depth > 0) return
    this.committing()
    this.ended(true)
  }
}
