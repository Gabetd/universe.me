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
  planMerge,
  refKey,
  type Command,
  type Store,
  type SyncRef
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
  const bus = new CommandBus(store, { context: { now: () => new Date(time.now).toISOString(), newId: () => `${name}-${++n}`, randomSeed: () => 1 } })
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

/** Pulls every way round until no device has anything new, and says how many rounds that took: a merge that changes nothing isn't sent on. */
function settle(...devices: Device[]): number {
  for (let round = 1; round <= 5; round++) {
    let merged = 0
    for (const from of devices) for (const to of devices) if (from !== to) merged += pull(from, to)
    if (!merged) return round
  }
  throw new Error('The devices still had rows for each other after 5 rounds')
}

/** A device with a world (of its own universe's), and an event on it, and copies of it on others. */
function withEvent(time: { now: number }, ...others: string[]) {
  const a = device('A', time)
  let parent = a.store.nodes.root()!.id
  for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world']) parent = run(a, 'node.create', { parentId: parent, kind, name: kind }).targetId!
  const event = run(a, 'event.create', { ownerId: parent, title: 'Founding', start: fromParts({ year: 1 }) }).targetId!
  return { a, world: parent, event, copies: others.map((name) => device(name, time, a)) }
}

/** A row as a device sends it now. */
const sent = (d: Device, ref: SyncRef) => d.store.changesSince(0, { limit: 1000 }).rows.find((r) => r.key === refKey(ref))!

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

  it('stamps the fields a write changes, the others keeping theirs, and doesn’t stamp a write that changes nothing', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const a = device('A', time)
    const cluster = run(a, 'node.create', { parentId: a.store.nodes.root()!.id, kind: 'galaxy_cluster', name: 'Virgo' }).targetId!
    const ref: SyncRef = { t: 'node', id: cluster }
    const created = sent(a, ref)
    // A new row's fields are all at its stamp.
    expect(created.fields).toBeUndefined()

    time.now += 10
    run(a, 'node.update', { id: cluster, patch: { name: 'Virgo II', position: { x: 1, y: 0, z: 0 } } })
    const edited = sent(a, ref)
    expect(edited.stamp > created.stamp).toBe(true)
    // What it changed is at the new stamp (so not listed); the rest, down into the position, keeps the first.
    const unchanged = ['/id', '/parentId', '/kind', '/seed', '/position/y', '/position/z', '/notes', '/tags', '/createdAt', '/deletedAt']
    expect(edited.fields).toEqual(Object.fromEntries(unchanged.map((path) => [path, created.stamp])))

    time.now += 10
    a.store.transaction(() => a.store.nodes.update({ ...a.store.nodes.get(cluster)! }))
    expect(sent(a, ref)).toEqual(edited)
  })

  it('keeps both of two changes to different fields of one row, an event’s or a world’s sliders, and the later of two to the same', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, world, event, copies: [b] } = withEvent(time, 'B')
    time.now += 10
    run(a, 'event.update', { id: event, patch: { title: 'The Founding' } })
    run(a, 'world.update', { id: world, patch: { seaLevel: 10, terrain: { water: 0.4 } } })
    time.now += 10
    run(b!, 'event.update', { id: event, patch: { notes: 'In the rain.' } })
    run(b!, 'world.update', { id: world, patch: { seaLevel: 20, terrain: { roughness: 0.9 } } })
    pull(b!, a)
    pull(a, b!)
    for (const d of [a, b!]) {
      expect(d.store.records('event').get(event)).toMatchObject({ title: 'The Founding', notes: 'In the rain.' })
      expect(d.store.worlds.getSettings(world)).toMatchObject({ seaLevel: 20, terrain: { water: 0.4, roughness: 0.9 } })
    }
    expect(contents(b!.store)).toEqual(contents(a.store))
    // B took A's merge whole, so neither sends it on again.
    expect(settle(a, b!)).toBe(1)
  })

  it('brings three devices to the same row, each having changed a field of its own, and then stops', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, event, copies: [b, c] } = withEvent(time, 'B', 'C')
    time.now += 10
    run(a, 'event.update', { id: event, patch: { title: 'The Founding' } })
    time.now += 10
    run(b!, 'event.update', { id: event, patch: { notes: 'In the rain.' } })
    time.now += 10
    run(c!, 'event.update', { id: event, patch: { tags: ['wet'] } })
    expect(settle(a, b!, c!)).toBeLessThanOrEqual(3)
    for (const d of [a, b!, c!]) expect(d.store.records('event').get(event)).toMatchObject({ title: 'The Founding', notes: 'In the rain.', tags: ['wet'] })
    expect(sent(b!, { t: 'record', kind: 'event', id: event })).toEqual(sent(a, { t: 'record', kind: 'event', id: event }))
  })

  it('takes a row from a copy from before field stamps as all at its stamp', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, event, copies: [b] } = withEvent(time, 'B')
    const ref: SyncRef = { t: 'record', kind: 'event', id: event }
    const old = (stamp: string, title: string) => b!.bus.merge({ type: 'sync.merge', payload: { rows: [{ key: refKey(ref), stamp, data: { ...a.store.records('event').get(event)!, title } }] } })
    time.now += 10
    const earlier = new SyncClock('Old', () => time.now).next()
    time.now += 10
    run(b!, 'event.update', { id: event, patch: { notes: 'In the rain.' } })
    // Its title is later than B's (the one it was made with), its notes earlier.
    old(earlier, 'Old title')
    expect(b!.store.records('event').get(event)).toMatchObject({ title: 'Old title', notes: 'In the rain.' })
    // One later than everything wins every field.
    time.now += 10
    old(new SyncClock('Old', () => time.now).next(), 'Older still')
    expect(b!.store.records('event').get(event)).toMatchObject({ title: 'Older still', notes: '' })
  })

  it('falls back to the later row, whole, when the fields merged aren’t a row', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, event, copies: [b] } = withEvent(time, 'B')
    const canvas = (d: Device, at: { x: number; y: number } | null) => run(d, 'event.update', { id: event, patch: { canvas: at } })
    time.now += 10
    canvas(b!, { x: 1, y: 2 })
    pull(b!, a)
    time.now += 10
    canvas(a, null)
    time.now += 10
    canvas(b!, { x: 5, y: 2 })
    // B's x is later than A's taking the card off, but A's took y out after B put it there: a card at x alone isn't one.
    settle(a, b!)
    for (const d of [a, b!]) expect(d.store.records('event').get(event)!.canvas).toEqual({ x: 5, y: 2 })
  })

  it('keeps a delete and another device’s change to the same row at once, for when it’s brought back', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, event, copies: [b] } = withEvent(time, 'B')
    time.now += 10
    run(a, 'event.delete', { id: event })
    time.now += 10
    run(b!, 'event.update', { id: event, patch: { title: 'The Founding' } })
    settle(a, b!)
    for (const d of [a, b!]) expect(d.store.records('event').get(event)).toMatchObject({ title: 'The Founding', deletedAt: expect.any(String) })
    a.bus.undo()
    expect(a.store.records('event').get(event)).toMatchObject({ title: 'The Founding', deletedAt: null })
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

  it('undoes only what nobody has changed since: a field another device changed after stays as they left it', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, world, event, copies: [b] } = withEvent(time, 'B')
    const get = (d: Device) => d.store.records('event').get(event)!
    time.now += 10
    run(a, 'event.update', { id: event, patch: { title: 'Mine', notes: 'My notes' } })
    run(a, 'world.update', { id: world, patch: { terrain: { water: 0.4, roughness: 0.9 } } })
    pull(a, b!)
    time.now += 10
    run(b!, 'event.update', { id: event, patch: { title: 'Theirs' } })
    run(b!, 'world.update', { id: world, patch: { terrain: { water: 0.2 } } })
    pull(b!, a)

    a.bus.undo()
    a.bus.undo()
    expect(get(a)).toMatchObject({ title: 'Theirs', notes: '' })
    expect(a.store.worlds.getSettings(world)!.terrain).toMatchObject({ water: 0.2, roughness: 0.5 })
    a.bus.redo()
    a.bus.redo()
    expect(get(a)).toMatchObject({ title: 'Theirs', notes: 'My notes' })
    expect(a.store.worlds.getSettings(world)!.terrain).toMatchObject({ water: 0.2, roughness: 0.9 })

    // A step with nothing left to undo is taken off the stack, and changes nothing.
    time.now += 10
    run(a, 'node.update', { id: world, patch: { name: 'Mine' } })
    pull(a, b!)
    time.now += 10
    run(b!, 'node.update', { id: world, patch: { name: 'Theirs' } })
    pull(b!, a)
    const before = sent(a, { t: 'node', id: world })
    expect(a.bus.undo()).toBeDefined()
    expect(a.store.nodes.get(world)!.name).toBe('Theirs')
    expect(sent(a, { t: 'node', id: world })).toEqual(before)
    a.bus.redo()
    expect(a.store.nodes.get(world)!.name).toBe('Theirs')
  })

  it('undoes creates, deletes and terrain per person too: what someone else changed since stays as they left it', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, world, copies: [b] } = withEvent(time, 'B')
    // A makes an era, which B deletes: undoing A's create leaves B's delete, and redoing it doesn't bring the era back over it.
    time.now += 10
    const era = run(a, 'era.create', { ownerId: world, name: 'Dawn', start: 0, end: fromParts({ year: 100 }) }).targetId!
    pull(a, b!)
    time.now += 10
    run(b!, 'era.delete', { id: era })
    pull(b!, a)
    a.bus.undo()
    a.bus.redo()
    expect(a.store.records('era').get(era)!.deletedAt).not.toBeNull()

    // A sculpts two cells of a face; B sculpts one of them after: undoing A's stroke takes back only the other.
    const cell = (d: Device, at: number) => (d.store.worlds.getLayer(world, 'height', 2) ?? emptyLayer('height'))[at * 2 + 1]!
    const stroke = (d: Device, at: number, value: number) =>
      run(d, 'terrain.patch', { worldId: world, layer: 'height', patches: [{ face: 2, x: at, y: 0, w: 1, h: 1, data: bytesToBase64(new Uint8Array([0, value])) }] })
    time.now += 10
    a.bus.execute({ type: 'batch', payload: { commands: [10, 20].map((at) => ({ type: 'terrain.patch', payload: { worldId: world, layer: 'height', patches: [{ face: 2, x: at, y: 0, w: 1, h: 1, data: bytesToBase64(new Uint8Array([0, 50])) }] } })) } } as Command)
    pull(a, b!)
    time.now += 10
    stroke(b!, 20, 90)
    pull(b!, a)
    a.bus.undo()
    expect([cell(a, 10), cell(a, 20)]).toEqual([0, 90])
    a.bus.redo()
    expect([cell(a, 10), cell(a, 20)]).toEqual([50, 90])
  })

  it('works a merge out apart from writing it (as a worker does), and works a row out again if it changed here in between', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, event, copies: [b] } = withEvent(time, 'B')
    time.now += 10
    run(b!, 'event.update', { id: event, patch: { title: 'The Founding' } })
    const rows = b!.store.changesSince(0, { from: 'A' }).rows
    const plans = planMerge(structuredClone(a.bus.gather(rows)))
    time.now += 10
    run(a, 'event.update', { id: event, patch: { notes: 'Written meanwhile.' } })
    a.bus.land(rows, plans)
    expect(a.store.records('event').get(event)).toMatchObject({ title: 'The Founding', notes: 'Written meanwhile.' })
  })

  it('undoes a step that changed a field twice back to where it began', () => {
    const time = { now: Date.UTC(2026, 0, 1) }
    const { a, event } = withEvent(time)
    const title = (t: string) => ({ type: 'event.update', payload: { id: event, patch: { title: t } } })
    a.bus.execute({ type: 'batch', payload: { commands: [title('Second'), title('Third')] } })
    a.bus.undo()
    expect(a.store.records('event').get(event)!.title).toBe('Founding')
    a.bus.redo()
    expect(a.store.records('event').get(event)!.title).toBe('Third')
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

  describe('changes made apart (M20)', () => {
    const conflicts = (d: Device) => d.store.records('conflict').all().filter((c) => !c.deletedAt)

    it('keeps the later of two changes made apart and the earlier as a conflict note, the same on both, which can be put back and undone', () => {
      const time = { now: Date.UTC(2026, 0, 1) }
      const { a, event, copies: [b] } = withEvent(time, 'B')
      time.now += 10
      run(a, 'event.update', { id: event, patch: { title: 'Mine' } })
      time.now += 10
      run(b!, 'event.update', { id: event, patch: { title: 'Theirs' } })
      settle(a, b!)
      for (const d of [a, b!]) {
        expect(d.store.records('event').get(event)!.title).toBe('Theirs')
        expect(conflicts(d)).toEqual([expect.objectContaining({ path: '/title', value: 'Mine', removed: false })])
      }
      expect(conflicts(a)[0]!.id).toBe(conflicts(b!)[0]!.id)
      const id = conflicts(a)[0]!.id
      run(a, 'conflict.use', { id })
      expect(a.store.records('event').get(event)!.title).toBe('Mine')
      expect(conflicts(a)).toEqual([])
      a.bus.undo()
      expect(a.store.records('event').get(event)!.title).toBe('Theirs')
      expect(conflicts(a).map((c) => c.id)).toEqual([id])
      // Dismissing it is removing it, and it goes for both.
      time.now += 10
      run(b!, 'record.remove', { refs: [{ kind: 'conflict', id }] })
      settle(a, b!)
      expect(conflicts(a)).toEqual([])
    })

    it('makes no note for a change made on top of another, however many came between', () => {
      const time = { now: Date.UTC(2026, 0, 1) }
      const { a, event, copies: [b, c] } = withEvent(time, 'B', 'C')
      for (const title of ['One', 'Two', 'Three']) {
        time.now += 10
        run(a, 'event.update', { id: event, patch: { title } })
      }
      pull(a, b!)
      time.now += 10
      run(b!, 'event.update', { id: event, patch: { title: 'Four' } })
      // C still has the first title: B's comes after it.
      settle(a, b!, c!)
      for (const d of [a, b!, c!]) {
        expect(d.store.records('event').get(event)!.title).toBe('Four')
        expect(conflicts(d)).toEqual([])
      }
    })

    it('merges notes changed apart line by line, and keeps a note where both changed the same line', () => {
      const time = { now: Date.UTC(2026, 0, 1) }
      const { a, event, copies: [b] } = withEvent(time, 'B')
      const notes = (d: Device, text: string) => run(d, 'event.update', { id: event, patch: { notes: text } })
      time.now += 10
      notes(a, '<p>One</p><p>Two</p><p>Three</p>')
      settle(a, b!)
      time.now += 10
      notes(a, '<p>One, said A</p><p>Two</p><p>Three</p>')
      time.now += 10
      notes(b!, '<p>One</p><p>Two</p><p>Three, said B</p>')
      settle(a, b!)
      for (const d of [a, b!]) {
        expect(d.store.records('event').get(event)!.notes).toBe('<p>One, said A</p><p>Two</p><p>Three, said B</p>')
        expect(conflicts(d)).toEqual([])
      }
      expect(sent(a, { t: 'record', kind: 'event', id: event })).toEqual(sent(b!, { t: 'record', kind: 'event', id: event }))

      time.now += 10
      notes(a, '<p>One, said A</p><p>Two by A</p><p>Three, said B</p>')
      time.now += 10
      notes(b!, '<p>One, said A</p><p>Two by B</p><p>Three, said B</p><p>Four</p>')
      settle(a, b!)
      for (const d of [a, b!]) {
        expect(d.store.records('event').get(event)!.notes).toBe('<p>One, said A</p><p>Two by B</p><p>Three, said B</p><p>Four</p>')
        expect(conflicts(d)).toEqual([expect.objectContaining({ path: '/notes', value: '<p>One, said A</p><p>Two by A</p><p>Three, said B</p>' })])
      }
    })

    it('merges a record made apart with the same id field by field: each side’s choices, the defaults losing', () => {
      const time = { now: Date.UTC(2026, 0, 1) }
      const { a, world, copies: [b] } = withEvent(time, 'B')
      time.now += 10
      run(a, 'waterway.set', { worldId: world, key: 'r1', patch: { name: 'The Silverrun' } })
      time.now += 10
      run(b!, 'waterway.set', { worldId: world, key: 'r1', patch: { notes: '<p>Wide and slow</p>' } })
      settle(a, b!)
      for (const d of [a, b!]) {
        expect(d.store.records('waterway').all()).toEqual([expect.objectContaining({ name: 'The Silverrun', notes: '<p>Wide and slow</p>' })])
        expect(conflicts(d)).toEqual([])
      }
    })

    it('merges a face of terrain sculpted apart cell by cell', () => {
      const time = { now: Date.UTC(2026, 0, 1) }
      const { a, world, copies: [b] } = withEvent(time, 'B')
      const sculpt = (d: Device, cell: number, height: number) => {
        const bytes = (d.store.worlds.getLayer(world, 'height', 2) ?? emptyLayer('height')).slice()
        bytes[cell] = height
        d.store.transaction(() => d.store.worlds.putLayer(world, 'height', 2, bytes))
      }
      time.now += 10
      sculpt(a, 10, 50)
      settle(a, b!)
      time.now += 10
      sculpt(a, 20, 60)
      time.now += 10
      sculpt(b!, 30, 70)
      sculpt(b!, 10, 80)
      settle(a, b!)
      for (const d of [a, b!]) {
        const bytes = d.store.worlds.getLayer(world, 'height', 2)!
        expect([bytes[10], bytes[20], bytes[30]]).toEqual([80, 60, 70])
      }
      expect(contents(a.store).height).toBe(contents(b!.store).height)
    })

    it('makes no notes from a device from before lineage', () => {
      const time = { now: Date.UTC(2026, 0, 1) }
      const { a, event, copies: [b] } = withEvent(time, 'B')
      time.now += 10
      run(b!, 'event.update', { id: event, patch: { title: 'Mine' } })
      time.now += 10
      const { lineage: _, ...old } = { ...sent(a, { t: 'record', kind: 'event', id: event }), stamp: new SyncClock('Old', () => time.now).next() }
      b!.bus.merge({ type: 'sync.merge', payload: { rows: [{ ...old, data: { ...a.store.records('event').get(event)!, title: 'Old' } }] } })
      expect(b!.store.records('event').get(event)!.title).toBe('Old')
      expect(conflicts(b!)).toEqual([])
    })
  })
})
