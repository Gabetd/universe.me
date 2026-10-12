import { changedFields, fieldsOf, rowOf } from './fields'
import type { Footprint } from './footprint'
import { LAYER_BYTES_PER_CELL, type TerrainLayerName } from './world'
import type { RecordKind, RecordOf } from './records'
import type { Store } from './store'
import { refKey, type SyncRef } from './sync'

/** What a step is doing: made for the first time, or undone or redone. */
export type StepAction = 'do' | 'undo' | 'redo'

/** Paths every write changes, which no one's change is kept for. */
const BOOKKEEPING = new Set(['/updatedAt'])

/**
 * The store as one step on the undo stack writes to it (PLAN.md §6.7, M21):
 * per-person undo in the write path, for every write a command makes (a
 * create, a delete, a restore, a patch, terrain). Made for the first time, a
 * step notes what each write left in each field it changed (each cell of
 * terrain) in its footprint; undone or redone, a field or cell that holds
 * something else by then (someone's change since, merged from another
 * device) is left as it is, and the rest written. A write that comes to
 * nothing then isn't made.
 */
export function stepStore(inner: Store, footprint: Footprint, action: StepAction): Store {
  const again = action !== 'do'

  /** A row of fields as a write would leave it: as asked making it, the fields changed since kept when undoing or redoing. */
  const throughFields = <T>(ref: SyncRef, before: T | undefined, after: T, write: (row: T) => void) => {
    const key = refKey(ref)
    if (before === undefined) {
      write(after)
      return footprint.wrote(key, after, fieldsOf(after).keys())
    }
    const was = fieldsOf(before)
    const changed = changedFields(was, fieldsOf(after)).filter((path) => !BOOKKEEPING.has(path))
    const kept = again ? changed.filter((path) => footprint.holds(key, before, path)) : changed
    if (again && !kept.length) return
    const row = kept.length === changed.length ? after : (asBefore(after, was, changed.filter((path) => !kept.includes(path))) as T)
    write(row)
    footprint.wrote(key, row, kept)
  }

  const records = new Map<RecordKind, unknown>()
  return {
    get sync() {
      return inner.sync
    },
    transaction: (fn) => inner.transaction(fn),
    assets: inner.assets,
    nodes: {
      get: (id) => inner.nodes.get(id),
      children: (id) => inner.nodes.children(id),
      all: () => inner.nodes.all(),
      root: () => inner.nodes.root(),
      insert: (n) => throughFields({ t: 'node', id: n.id }, undefined, n, (row) => inner.nodes.insert(row)),
      update: (n) => throughFields({ t: 'node', id: n.id }, inner.nodes.get(n.id), n, (row) => inner.nodes.update(row))
    },
    regions: {
      get: (id) => inner.regions.get(id),
      all: () => inner.regions.all(),
      insert: (r) => throughFields({ t: 'region', id: r.id }, undefined, r, (row) => inner.regions.insert(row)),
      update: (r) => throughFields({ t: 'region', id: r.id }, inner.regions.get(r.id), r, (row) => inner.regions.update(row))
    },
    worlds: {
      getSettings: (id) => inner.worlds.getSettings(id),
      putSettings: (id, settings) => throughFields({ t: 'world', id }, inner.worlds.getSettings(id), settings, (row) => inner.worlds.putSettings(id, row)),
      getLayer: (id, layer, face) => inner.worlds.getLayer(id, layer, face),
      putLayer: (id, layer, face, bytes) => {
        const row = throughCells(footprint, refKey({ t: 'layer', id, layer, face }), layer, inner.worlds.getLayer(id, layer, face), bytes, again)
        if (row) inner.worlds.putLayer(id, layer, face, row)
      },
      terrainRevision: (id) => inner.worlds.terrainRevision(id),
      bumpTerrainRevision: (id) => inner.worlds.bumpTerrainRevision(id)
    },
    records<K extends RecordKind>(kind: K) {
      let repo = records.get(kind) as ReturnType<Store['records']> | undefined
      if (!repo) {
        const base = inner.records(kind) as unknown as { get(id: string): { id: string } | undefined; all(): unknown[]; byOwner(ownerId: string): unknown[]; insert(r: unknown): void; update(r: unknown): void }
        const ref = (id: string): SyncRef => ({ t: 'record', kind, id })
        repo = {
          get: (id: string) => base.get(id),
          all: () => base.all(),
          byOwner: (ownerId: string) => base.byOwner(ownerId),
          insert: (r: { id: string }) => throughFields(ref(r.id), undefined, r, (row) => base.insert(row)),
          update: (r: { id: string }) => throughFields(ref(r.id), base.get(r.id), r, (row) => base.update(row))
        } as unknown as ReturnType<Store['records']>
        records.set(kind, repo)
      }
      return repo as unknown as ReturnType<Store['records']> & { get(id: string): RecordOf<K> | undefined }
    }
  } as Store
}

/** A row as written, but at `paths` as it was before (`was`, its fields): a field taken out there, out again. */
function asBefore(after: unknown, was: ReadonlyMap<string, unknown>, paths: readonly string[]): unknown {
  const back = new Set(paths)
  const kept = [...fieldsOf(after)].filter(([path]) => !back.has(path))
  return rowOf([...kept, ...paths.flatMap((path) => (was.has(path) ? [[path, was.get(path)] as const] : []))])
}

/** A cell's bytes as one number. */
const cellAt = (bytes: Uint8Array | undefined, at: number, size: number) => {
  let v = 0
  for (let k = 0; k < size; k++) v = v * 256 + (bytes?.[at + k] ?? 0)
  return v
}

/**
 * A face of terrain as a write would leave it (undefined: nothing to write):
 * each cell as asked making it, a cell changed since kept as it is when
 * undoing or redoing; what it left noted, cell by cell.
 */
function throughCells(footprint: Footprint, key: string, layer: TerrainLayerName, before: Uint8Array | undefined, after: Uint8Array, again: boolean): Uint8Array | undefined {
  const size = LAYER_BYTES_PER_CELL[layer]
  const out = after.slice()
  const left: [number, number][] = []
  for (let at = 0; at < after.length; at += size) {
    const [was, now] = [cellAt(before, at, size), cellAt(after, at, size)]
    if (was === now) continue
    if (again && !footprint.holdsCell(key, at / size, was)) {
      for (let k = 0; k < size; k++) out[at + k] = before?.[at + k] ?? 0
      continue
    }
    left.push([at / size, now])
  }
  if (again && !left.length) return undefined
  footprint.wroteCells(key, left)
  return out
}

