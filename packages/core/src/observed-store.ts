import type { RecordKind, RecordOf } from './records'
import type { Id } from './schema'
import type { AssetRepository, NodeRepository, RecordRepository, RegionRepository, Store, WorldRepository } from './store'
import type { SyncLedger, SyncRef } from './sync'

/**
 * A store that passes everything on to another and tells its subclass about
 * each write as it's about to be made and once it went through (one that
 * throws isn't told), and about each outermost transaction ending. A write
 * outside a transaction is a transaction of its own. Snapshots' change
 * tracking (in `packages/db`) and sync's stamps (`StampedStore`) are built
 * on it, so a new kind of write is wired once.
 */
export abstract class ObservedStore implements Store {
  readonly nodes: NodeRepository
  readonly regions: RegionRepository
  readonly worlds: WorldRepository
  readonly assets: AssetRepository
  private depth = 0
  private readonly recordRepos = new Map<RecordKind, RecordRepository<unknown>>()

  /** A row is about to be written; `inserted` if it's new. */
  protected writing(_ref: SyncRef, _inserted: boolean): void {}
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
      insert: (n) => this.write({ t: 'node', id: n.id }, true, () => nodes.insert(n)),
      update: (n) => this.write({ t: 'node', id: n.id }, false, () => nodes.update(n))
    }
    this.regions = {
      get: (id) => regions.get(id),
      all: () => regions.all(),
      insert: (r) => this.write({ t: 'region', id: r.id }, true, () => regions.insert(r)),
      update: (r) => this.write({ t: 'region', id: r.id }, false, () => regions.update(r))
    }
    this.worlds = {
      getSettings: (id) => worlds.getSettings(id),
      putSettings: (id, settings) => this.write({ t: 'world', id }, false, () => worlds.putSettings(id, settings)),
      getLayer: (id, layer, face) => worlds.getLayer(id, layer, face),
      putLayer: (id, layer, face, bytes) => this.write({ t: 'layer', id, layer, face }, false, () => worlds.putLayer(id, layer, face, bytes)),
      terrainRevision: (id) => worlds.terrainRevision(id),
      bumpTerrainRevision: (id) => (worlds.bumpTerrainRevision(id), this.alone(() => this.bumped(id)))
    }
    this.assets = {
      get: (id) => assets.get(id),
      put: (a) => this.write({ t: 'asset', id: a.id }, false, () => assets.put(a)),
      remove: (id) => this.write({ t: 'asset', id }, false, () => assets.remove(id))
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
        insert: (r) => this.write({ t: 'record', kind, id: r.id }, true, () => inner.insert(r)),
        update: (r) => this.write({ t: 'record', kind, id: r.id }, false, () => inner.update(r))
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

  /** Makes a write, telling of it before and after; outside a transaction, one that throws ends there. */
  private write(ref: SyncRef, inserted: boolean, write: () => void): void {
    this.writing(ref, inserted)
    try {
      write()
    } catch (err) {
      if (this.depth === 0) this.ended(false)
      throw err
    }
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
