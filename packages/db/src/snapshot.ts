import { DEFAULT_WORLD_SETTINGS, EMPTY_TIMELINE, RECORD_KINDS, type Id, type RecordKind, type RecordOf, type Region, type SpatialNode, type Store, type TimelineData, type WorldInfo } from '@universe/core'
import type { Changes, TableChanges } from './changes'

/** Everything live in a project, as the app shows it. Treat it as read-only: unchanged parts are shared between snapshots. */
export interface Snapshot {
  nodes: SpatialNode[]
  /** Every live world's settings and terrain revision. */
  worlds: WorldInfo[]
  /** Every live region on a live world. */
  regions: Region[]
  /** Every live record whose owner is live. */
  timeline: TimelineData
}

interface Row {
  id: Id
  deletedAt: string | null
}

const isLive = (row: Row) => row.deletedAt == null

/**
 * The live rows of one table (or record kind), in the store's order, kept
 * between snapshots and brought up to date from what was written.
 */
class LiveRows<T extends Row> {
  /** The live rows. A new array whenever they change, so the last snapshot's stays as it was. */
  rows: T[] = []
  /** Every row seen since the last load, deleted ones too, so a restored row comes back in its old place. */
  private slots: T[] = []
  private index = new Map<Id, number>()
  private loaded = false

  constructor(
    private readonly repo: { get(id: Id): T | undefined; all(): T[] },
    /** Whether added rows sort last (records keep insertion order), so they can be appended instead of reloading. */
    private readonly addsLast: boolean,
    /** Whether an updated row may sort elsewhere now; then everything is reloaded. */
    private readonly moved: (before: T, after: T) => boolean = () => false
  ) {}

  /** Returns whether the rows changed. */
  update(changes: TableChanges | undefined): boolean {
    if (!this.loaded) return this.reload()
    if (!changes?.touched.size) return false
    // Patched in place: no snapshot holds the slots, and a failure resets the whole cache.
    const slots = this.slots
    const added = new Map<Id, T>()
    for (const id of changes.touched) {
      const row = this.repo.get(id)
      const at = this.index.get(id)
      if (at !== undefined) {
        if (!row || this.moved(slots[at]!, row)) return this.reload()
        slots[at] = row
      } else if (row && isLive(row)) {
        // A row deleted before the last load has no slot to come back to.
        if (!this.addsLast || !changes.inserted.has(id)) return this.reload()
        added.set(id, row)
      }
    }
    // Appended in the order they were added, which is the order the store keeps them in.
    for (const id of changes.inserted) {
      const row = added.get(id)
      if (!row) continue
      this.index.set(id, slots.length)
      slots.push(row)
    }
    this.rows = slots.filter(isLive)
    return true
  }

  private reload(): true {
    this.slots = this.repo.all()
    this.rows = this.slots.filter(isLive)
    this.index = new Map(this.slots.map((r, i) => [r.id, i]))
    this.loaded = true
    return true
  }
}

const sameSet = (a: Set<Id>, b: Set<Id>) => a.size === b.size && [...a].every((id) => b.has(id))
const createdElsewhere = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt !== b.createdAt

/**
 * Builds snapshots of a project, reloading only the rows written since the
 * last one (reported by `takeChanges`) and reusing the rest.
 */
export class SnapshotCache {
  private nodes!: LiveRows<SpatialNode>
  private regions!: LiveRows<Region>
  private readonly records = new Map<RecordKind, LiveRows<RecordOf<RecordKind>>>()
  private readonly worldInfo = new Map<Id, WorldInfo>()
  private liveIds = new Set<Id>()
  private worldIds = new Set<Id>()
  private last: Snapshot | undefined

  constructor(
    private readonly store: Store,
    private readonly takeChanges: () => Changes
  ) {
    this.reset()
  }

  snapshot(): Snapshot {
    const changes = this.takeChanges()
    try {
      return (this.last = this.build(changes))
    } catch (err) {
      // The changes are spent, so start over from the store next time.
      this.reset()
      throw err
    }
  }

  private build(changes: Changes): Snapshot {
    const last = this.last
    const nodesChanged = this.nodes.update(changes.nodes)
    let ownersChanged = !last
    let worldsChanged = !last
    if (nodesChanged) {
      const liveIds = new Set(this.nodes.rows.map((n) => n.id))
      const worldIds = new Set(this.nodes.rows.filter((n) => n.kind === 'world').map((n) => n.id))
      ownersChanged ||= !sameSet(liveIds, this.liveIds)
      worldsChanged ||= !sameSet(worldIds, this.worldIds)
      this.liveIds = liveIds
      this.worldIds = worldIds
    }
    for (const id of changes.worlds) this.worldInfo.delete(id)
    const regionsChanged = this.regions.update(changes.regions)

    let recordsChanged = false
    const timeline = { ...(last?.timeline ?? EMPTY_TIMELINE) } as Record<`${RecordKind}s`, Row[]>
    for (const kind of RECORD_KINDS) {
      const records = this.kind(kind)
      if (records.update(changes.records.get(kind)) || ownersChanged) {
        timeline[`${kind}s`] = records.rows.filter((r) => this.liveIds.has(r.ownerId))
        recordsChanged = true
      }
    }
    if (last && !nodesChanged && !regionsChanged && !recordsChanged && !changes.worlds.size) return last
    return {
      nodes: this.nodes.rows,
      worlds: !last || worldsChanged || changes.worlds.size ? [...this.worldIds].map((id) => this.world(id)) : last.worlds,
      regions: !last || worldsChanged || regionsChanged ? this.regions.rows.filter((r) => this.worldIds.has(r.worldId)) : last.regions,
      timeline: recordsChanged || !last ? (timeline as unknown as TimelineData) : last.timeline
    }
  }

  private reset(): void {
    // Nodes and regions sort by creation time, so added ones mean a reload.
    this.nodes = new LiveRows(this.store.nodes, false, createdElsewhere)
    this.regions = new LiveRows(this.store.regions, false, createdElsewhere)
    this.records.clear()
    this.worldInfo.clear()
    this.last = undefined
  }

  private kind(kind: RecordKind): LiveRows<RecordOf<RecordKind>> {
    let rows = this.records.get(kind)
    if (!rows) this.records.set(kind, (rows = new LiveRows(this.store.records(kind), true)))
    return rows
  }

  private world(id: Id): WorldInfo {
    let info = this.worldInfo.get(id)
    if (!info) {
      const { worlds } = this.store
      info = { id, settings: worlds.getSettings(id) ?? DEFAULT_WORLD_SETTINGS, terrainRevision: worlds.terrainRevision(id) }
      this.worldInfo.set(id, info)
    }
    return info
  }
}
