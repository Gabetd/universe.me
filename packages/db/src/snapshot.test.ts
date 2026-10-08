import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_SETTINGS, MemoryStore, RECORD_KINDS, asBytes, bytesToBase64, type Store, type TimelineData } from '@universe/core'
import { TrackedStore } from './changes'
import { Project, type Snapshot } from './index'

let dir: string
let p: Project

/** A snapshot built from scratch, the way the app did before snapshots were kept. */
function reloaded(store: Store): Snapshot {
  const nodes = store.nodes.all()
  const worldIds = new Set(nodes.filter((n) => n.kind === 'world').map((n) => n.id))
  const liveIds = new Set(nodes.map((n) => n.id))
  return {
    nodes,
    worlds: [...worldIds].map((id) => ({ id, settings: store.worlds.getSettings(id) ?? DEFAULT_WORLD_SETTINGS, terrainRevision: store.worlds.terrainRevision(id) })),
    regions: store.regions.all().filter((r) => worldIds.has(r.worldId)),
    timeline: Object.fromEntries(RECORD_KINDS.map((k) => [`${k}s`, store.records(k).all().filter((r) => liveIds.has(r.ownerId))])) as unknown as TimelineData
  }
}

const exec = (type: string, payload: object) => p.bus.execute({ type, payload }).targetId!

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'universe-snapshot-'))
  // Ids that sort backwards and a clock that stands still, so nothing can lean on ids or times matching the store's order.
  let n = 1_000_000
  p = Project.create(join(dir, 's.universe'), 'S', { context: { newId: () => `id-${--n}`, now: () => '2026-01-01T00:00:00.000Z', randomSeed: () => 7 } })
})

afterEach(() => {
  p.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Project.snapshot', () => {
  it('matches a full reload after every kind of change', () => {
    const steps: [string, () => unknown][] = []
    const step = (label: string, fn: () => unknown) => steps.push([label, fn])
    let world = ''
    let world2 = ''
    let region = ''
    let event = ''
    let later = ''
    step('nodes', () => {
      let system = p.info().rootId
      for (const kind of ['galaxy_cluster', 'galaxy', 'star_system']) system = exec('node.create', { parentId: system, kind })
      world = exec('node.create', { parentId: exec('node.create', { parentId: system, kind: 'body' }), kind: 'world' })
      world2 = exec('node.create', { parentId: exec('node.create', { parentId: system, kind: 'body' }), kind: 'world' })
    })
    step('world settings', () => exec('world.update', { id: world, patch: { seaLevel: 120 } }))
    step('terrain', () =>
      exec('terrain.patch', { worldId: world, layer: 'height', patches: [{ face: 0, x: 1, y: 1, w: 1, h: 1, data: bytesToBase64(asBytes(new Int16Array([500]))) }] })
    )
    step('region', () => (region = exec('region.create', { worldId: world, name: 'Shire', points: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, { lat: 5, lon: 1 }] })))
    step('region update', () => exec('region.update', { id: region, patch: { name: 'The Shire' } }))
    step('events', () => {
      event = exec('event.create', { ownerId: world, title: 'A', start: 10 })
      later = exec('event.create', { ownerId: world, title: 'B', start: 5 })
      exec('event.create', { ownerId: world2, title: 'C', start: 1 })
    })
    step('a batch adds several', () =>
      exec('batch', { commands: [1, 2, 3].map((start) => ({ type: 'event.create', payload: { ownerId: world, title: `Batch ${start}`, start } })) })
    )
    step('event update', () => exec('event.update', { id: event, patch: { title: 'A2' } }))
    step('link', () => exec('link.create', { fromId: event, toId: later }))
    step('event delete', () => exec('event.delete', { id: event }))
    step('undo restores it in place', () => p.bus.undo())
    step('redo deletes it again', () => p.bus.redo())
    step('undo again', () => p.bus.undo())
    step('a failed batch', () =>
      expect(() => exec('batch', { commands: [{ type: 'event.create', payload: { ownerId: world, start: 0 } }, { type: 'event.delete', payload: { id: 'nope' } }] })).toThrow()
    )
    step('region delete', () => exec('region.delete', { id: region }))
    step('world delete hides its records', () => exec('node.delete', { id: world }))
    step('world restore', () => p.bus.undo())
    step('node update', () => exec('node.update', { id: world2, patch: { name: 'Second' } }))
    step('a write outside the bus', () => {
      const root = p.store.nodes.get(p.info().rootId)!
      p.store.nodes.update({ ...root, notes: 'direct' })
    })
    step('undo everything', () => {
      while (p.bus.canUndo) p.bus.undo()
    })
    step('redo everything', () => {
      while (p.bus.canRedo) p.bus.redo()
    })
    p.snapshot()
    for (const [label, fn] of steps) {
      fn()
      expect(p.snapshot(), label).toEqual(reloaded(p.store))
    }
  })

  it('reuses what a command did not change', () => {
    let parent = p.info().rootId
    for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body']) parent = exec('node.create', { parentId: parent, kind })
    const world = exec('node.create', { parentId: parent, kind: 'world' })
    const a = exec('event.create', { ownerId: world, title: 'A', start: 1 })
    exec('event.create', { ownerId: world, title: 'B', start: 2 })
    exec('lane.create', { ownerId: world, name: 'Kings' })
    const before = p.snapshot()

    exec('event.update', { id: a, patch: { title: 'A2' } })
    const after = p.snapshot()
    expect(after.timeline.events).not.toBe(before.timeline.events)
    expect(after.timeline.events.map((e) => e.title)).toEqual(['A2', 'B'])
    expect(after.timeline.events[1]).toBe(before.timeline.events[1])
    expect(after.timeline.lanes).toBe(before.timeline.lanes)
    expect(after.worlds).toBe(before.worlds)
    expect(after.regions).toBe(before.regions)
    // The event's world was stamped as changed, but nothing else was.
    expect(after.nodes.find((n) => n.id === world)).not.toBe(before.nodes.find((n) => n.id === world))
    const root = (s: Snapshot) => s.nodes.find((n) => n.parentId === null)
    expect(root(after)).toBe(root(before))

    // Nothing written: the same snapshot again.
    expect(p.snapshot()).toBe(after)
  })

  it('puts back rows deleted before it was opened', () => {
    const root = p.info().rootId
    const ids = ['A', 'B', 'C'].map((title, start) => exec('event.create', { ownerId: root, title, start }))
    exec('record.remove', { refs: [{ kind: 'event', id: ids[1] }] })
    const path = p.path
    p.close()
    p = Project.open(path)
    expect(p.snapshot().timeline.events.map((e) => e.title)).toEqual(['A', 'C'])
    exec('record.restore', { refs: [{ kind: 'event', id: ids[1] }] })
    expect(p.snapshot()).toEqual(reloaded(p.store))
    expect(p.snapshot().timeline.events.map((e) => e.title)).toEqual(['A', 'B', 'C'])
  })

  it('ignores writes that were rolled back', () => {
    const before = p.snapshot()
    expect(() => exec('node.create', { parentId: p.info().rootId, kind: 'world' })).toThrow()
    const after = p.snapshot()
    expect(after.nodes).toBe(before.nodes)
    expect(after.timeline.events).toBe(before.timeline.events)
  })
})

describe('TrackedStore', () => {
  const node = (id: string) => ({
    id,
    parentId: null,
    kind: 'universe' as const,
    name: id,
    seed: 1,
    position: { x: 0, y: 0, z: 0 },
    notes: '',
    tags: [],
    createdAt: 'x',
    updatedAt: 'x',
    deletedAt: null
  })

  it('notes writes once they commit, in the order rows were added', () => {
    const store = new TrackedStore(new MemoryStore())
    store.nodes.insert(node('b'))
    store.transaction(() => {
      store.nodes.insert(node('a'))
      store.transaction(() => store.nodes.update({ ...node('b'), name: 'B' }))
      store.worlds.bumpTerrainRevision('w')
    })
    const changes = store.takeChanges()
    expect([...changes.nodes.inserted]).toEqual(['b', 'a'])
    expect([...changes.nodes.touched]).toEqual(['b', 'a'])
    expect([...changes.worlds]).toEqual(['w'])
    expect(store.takeChanges().nodes.touched.size).toBe(0)
  })

  it('forgets writes of a transaction that rolled back, and writes that failed', () => {
    const store = new TrackedStore(new MemoryStore())
    expect(() =>
      store.transaction(() => {
        store.records('event').insert({ id: 'e', ownerId: 'o' } as never)
        throw new Error('no')
      })
    ).toThrow('no')
    expect(() => store.nodes.update(node('missing'))).toThrow()
    const changes = store.takeChanges()
    expect(changes.records.size).toBe(0)
    expect(changes.nodes.touched.size).toBe(0)
  })
})
