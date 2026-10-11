import { describe, expect, it } from 'vitest'
import {
  CommandBus,
  MemoryStampTable,
  MemoryStore,
  StampedStore,
  SyncClock,
  bytesToBase64,
  createRootUniverse,
  emptyLayer,
  fromParts,
  parseRefKey,
  refKey,
  type Command,
  type Store
} from './index'

interface Device {
  store: StampedStore
  bus: CommandBus
  /** Where it last asked each other device from. */
  seen: Map<string, number>
  name: string
}

/** A device: its store, stamped, and its own clock (`time` moves every device's on). */
function device(name: string, time: { now: number }, from?: Device): Device {
  const inner = new MemoryStore()
  const store = new StampedStore(inner, new MemoryStampTable(), new SyncClock(name, () => time.now))
  let n = 0
  const bus = new CommandBus(store, { context: { newId: () => `${name}-${++n}`, randomSeed: () => 1 } })
  // A copy starts from everything the other has.
  if (from) pull(from, { store, bus, seen: new Map(), name })
  else createRootUniverse(store, 'Shared')
  return { store, bus, seen: new Map<string, number>(), name }
}

/** What `to` asks `from` for: every row stamped since the last it saw, merged, a page at a time. */
function pull(from: Device, to: Device): number {
  let merged = 0
  for (;;) {
    const { rows, upTo, more } = from.store.changesSince(to.seen.get(from.name) ?? 0, { limit: 3, from: to.name })
    if (rows.length) to.bus.merge({ type: 'sync.merge', payload: { rows } })
    to.seen.set(from.name, upTo)
    merged += rows.length
    if (!more) return merged
  }
}

const run = (d: Device, type: string, payload: object) => d.bus.execute({ type, payload } as Command)

/** Everything a device has, as comparable data (terrain as base64: comparing its bytes one by one takes about half a second a face). */
function contents(store: Store) {
  const kinds = ['event', 'era', 'power', 'powerAge', 'finding'] as const
  return {
    nodes: store.nodes.all().map((n) => [n.id, n.name, n.parentId, n.deletedAt]),
    regions: store.regions.all().map((r) => [r.id, r.name]),
    records: Object.fromEntries(kinds.map((k) => [k, store.records(k).all()])),
    height: bytesToBase64(store.worlds.getLayer('A-5', 'height', 2) ?? new Uint8Array())
  }
}

describe('sync', () => {
  it('stamps every write, in an order every device agrees on, never behind one it has seen', () => {
    const time = { now: 1000 }
    const a = new SyncClock('a', () => time.now)
    const b = new SyncClock('b', () => time.now - 500)
    const first = a.next()
    expect(a.next() > first).toBe(true)
    // b's clock is behind; once it has seen a's stamp, its own come after it.
    b.see(first)
    expect(b.next() > first).toBe(true)
    expect(() => new SyncClock('no spaces')).toThrow()
    const key = refKey({ t: 'record', kind: 'powerAge', id: 'powerAge:s:e' })
    expect(parseRefKey(key)).toEqual({ t: 'record', kind: 'powerAge', id: 'powerAge:s:e' })
    expect(() => parseRefKey('["record","nope","x"]')).toThrow()
  })

  it('copies a whole universe, then keeps two devices the same as both change it', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const a = device('A', time)
    const root = a.store.nodes.root()!.id
    const make = (d: Device, parentId: string, kind: string, name: string) => run(d, 'node.create', { parentId, kind, name }).targetId!
    const world = make(a, make(a, make(a, make(a, make(a, root, 'galaxy_cluster', 'Virgo'), 'galaxy', 'Milky Way'), 'star_system', 'Sol'), 'body', 'Terra'), 'world', 'Surface')
    expect(world).toBe('A-5')
    run(a, 'event.create', { ownerId: world, title: 'Founding', start: fromParts({ year: 1 }) })
    const heights = emptyLayer('height')
    heights[10] = 200
    a.store.transaction(() => a.store.worlds.putLayer(world, 'height', 2, heights))

    // B starts as a copy of A.
    time.now += 1000
    const b = device('B', time, a)
    expect(contents(b.store)).toEqual(contents(a.store))

    // Both change it apart, then meet.
    time.now += 1000
    run(a, 'era.create', { ownerId: world, name: 'Dawn', start: 0, end: fromParts({ year: 100 }) })
    run(b, 'region.create', { worldId: world, name: 'North', points: [{ lat: 50, lon: 0 }, { lat: 50, lon: 10 }, { lat: 60, lon: 5 }] })
    run(b, 'power.create', { pins: [world], template: 'magic' })
    pull(a, b)
    pull(b, a)
    expect(contents(b.store)).toEqual(contents(a.store))
    expect(contents(a.store).regions).toEqual([[expect.any(String), 'North']])
    // Nothing new: nothing to pull.
    expect(pull(a, b) + pull(b, a)).toBe(0)
  })

  it('keeps the later of two changes to the same thing, on both, whichever pulls first; and deletes too', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const a = device('A', time)
    const root = a.store.nodes.root()!.id
    const cluster = run(a, 'node.create', { parentId: root, kind: 'galaxy_cluster', name: 'Virgo' }).targetId!
    const b = device('B', time, a)

    time.now += 10
    run(b, 'node.update', { id: cluster, patch: { name: 'Virgo (B)' } })
    time.now += 10
    run(a, 'node.update', { id: cluster, patch: { name: 'Virgo (A, later)' } })
    pull(b, a)
    pull(a, b)
    expect(a.store.nodes.get(cluster)!.name).toBe('Virgo (A, later)')
    expect(b.store.nodes.get(cluster)!.name).toBe('Virgo (A, later)')

    time.now += 10
    run(b, 'node.delete', { id: cluster })
    pull(b, a)
    expect(a.store.nodes.get(cluster)!.deletedAt).not.toBeNull()
    expect(a.store.nodes.root()!.id).toBe(root)
  })

  it('passes on what it got from a third device, even with an older stamp than it has sent before', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const a = device('A', time)
    const root = a.store.nodes.root()!.id
    const b = device('B', time, a)
    const c = device('C', time, a)
    // C writes first (an older stamp), but B only hears of it after it has already pulled A's later write.
    time.now += 10
    run(c, 'node.create', { parentId: root, kind: 'galaxy_cluster', name: 'From C' })
    time.now += 10
    run(a, 'node.create', { parentId: root, kind: 'galaxy_cluster', name: 'From A' })
    pull(a, b)
    pull(c, a)
    pull(a, b)
    expect(b.store.nodes.children(root).map((n) => n.name).sort()).toEqual(['From A', 'From C'])
  })

  it('a merge isn’t undone with this device’s own changes', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const a = device('A', time)
    const root = a.store.nodes.root()!.id
    const b = device('B', time, a)
    time.now += 10
    run(b, 'node.create', { parentId: root, kind: 'galaxy_cluster', name: 'Mine' })
    time.now += 10
    run(a, 'node.create', { parentId: root, kind: 'galaxy_cluster', name: 'Theirs' })
    pull(a, b)
    expect(b.store.nodes.children(root).map((n) => n.name)).toEqual(['Mine', 'Theirs'])
    b.bus.undo()
    expect(b.store.nodes.children(root).map((n) => n.name)).toEqual(['Theirs'])
  })

  it('turns down rows that aren’t what they say', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const a = device('A', time)
    const b = device('B', time, a)
    const stamp = new SyncClock('X', () => time.now + 99).next()
    const merge = (rows: object[]) => () => b.bus.merge({ type: 'sync.merge', payload: { rows } })
    expect(merge([{ key: refKey({ t: 'node', id: 'n1' }), stamp, data: { id: 'n1', name: 'No kind' } }])).toThrow()
    expect(merge([{ key: refKey({ t: 'layer', id: 'w', layer: 'height', face: 0 }), stamp, data: 'AAAA' }])).toThrow(/face of a terrain layer/)
    expect(merge([{ key: '["node"]', stamp, data: null }])).toThrow()
    expect(merge([{ key: refKey({ t: 'node', id: 'n1' }), stamp: 'not a stamp', data: null }])).toThrow()
    expect(() => b.bus.merge({ type: 'node.delete', payload: { id: 'x' } })).toThrow(/Rows from another device/)
    // Only sync merges: no client can send rows with stamps of its choosing as a command.
    expect(() => b.bus.execute({ type: 'sync.merge', payload: { rows: [] } })).toThrow()
    expect(() => b.bus.execute({ type: 'batch', payload: { commands: [{ type: 'sync.merge', payload: { rows: [] } }] } })).toThrow()
  })

  it('pages what a device asks for by size, and leaves out its own rows without counting them', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const a = device('A', time)
    const b = device('B', time, a)
    const root = a.store.nodes.root()!.id
    for (let i = 0; i < 5; i++) a.bus.execute({ type: 'node.create', payload: { parentId: root, kind: 'galaxy_cluster', name: `C${i}` } })
    const theirs = a.store.changesSince(0, { from: 'B' })
    b.bus.merge({ type: 'sync.merge', payload: { rows: theirs.rows } })
    // A has nothing of B's own to send back, even counted a page at a time.
    const back = b.store.changesSince(0, { from: 'A', limit: 2 })
    expect(back).toEqual({ rows: [], upTo: b.store.changesSince(0).upTo, more: false })
    expect(b.store.changesSince(back.upTo, { from: 'A' }).rows).toEqual([])
  })
})
