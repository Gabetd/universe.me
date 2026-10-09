import { ObservedStore, type Id, type RecordKind, type SyncRef } from '@universe/core'

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
export class TrackedStore extends ObservedStore {
  private changes = new Changes()
  /** Writes of the open transaction, until it commits. */
  private pending = new Changes()

  /** Everything written (and committed) since the last call. */
  takeChanges(): Changes {
    const taken = this.changes
    this.changes = new Changes()
    return taken
  }

  /** Assets aren't part of a snapshot, so their writes aren't noted. */
  protected wrote(ref: SyncRef, inserted: boolean): void {
    if (ref.t === 'world' || ref.t === 'layer') return void this.pending.worlds.add(ref.id)
    const table = ref.t === 'node' ? this.pending.nodes : ref.t === 'region' ? this.pending.regions : ref.t === 'record' ? this.pending.record(ref.kind) : undefined
    table?.touched.add(ref.id)
    if (inserted) table?.inserted.add(ref.id)
  }

  protected override bumped(worldId: Id): void {
    this.pending.worlds.add(worldId)
  }

  protected override ended(committed: boolean): void {
    if (committed) this.changes.merge(this.pending)
    this.pending = new Changes()
  }
}
