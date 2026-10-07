import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, createRootUniverse, eventPlace, fromParts, regionAt, timelineWarnings, causalChain, timelineOwner } from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string
let planetId: string
const year = (y: number) => fromParts({ year: y })

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const root = createRootUniverse(store, 'U').id
  const make = (parentId: string, kind: string) => bus.execute({ type: 'node.create', payload: { parentId, kind } }).targetId!
  planetId = make(make(make(make(root, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body')
  worldId = make(planetId, 'world')
})

const event = (title: string, start: number, end: number | null = null, extra: object = {}) =>
  bus.execute({ type: 'event.create', payload: { ownerId: worldId, title, start, end, ...extra } }).targetId!
const events = () => store.records('event').all()
const links = () => store.records('link').all()

describe('events', () => {
  it('creates, edits, deletes and restores with undo/redo', () => {
    const id = event('Founding of Aster', year(1204))
    expect(store.records('event').get(id)).toMatchObject({ title: 'Founding of Aster', end: null, precision: 'year', laneId: null })

    bus.execute({ type: 'event.update', payload: { id, patch: { title: 'Aster founded', end: year(1210) } } })
    bus.undo()
    expect(store.records('event').get(id)).toMatchObject({ title: 'Founding of Aster', end: null })

    bus.execute({ type: 'event.delete', payload: { id } })
    expect(events()).toHaveLength(0)
    bus.undo()
    expect(events()).toHaveLength(1)
    bus.redo()
    expect(events()).toHaveLength(0)
  })

  it('rejects impossible events', () => {
    expect(() => event('Backwards', year(10), year(5))).toThrow(/end before it starts/)
    expect(() => event('Lost', year(1), null, { laneId: 'nope' })).toThrow(/does not exist/)
    expect(() =>
      bus.execute({ type: 'event.create', payload: { ownerId: planetId, start: 0, locations: [{ kind: 'point', lat: 0, lon: 0 }] } })
    ).toThrow(/world surface/)
  })

  it('moves and hides its canvas card, undoably, including on events saved before the canvas existed', () => {
    const id = event('Old', 0)
    const { canvas: _c, canvasHidden: _h, ...legacy } = store.records('event').get(id)!
    store.records('event').update(legacy)
    bus.execute({ type: 'event.update', payload: { id, patch: { canvas: { x: 40, y: -20 }, canvasHidden: true } } })
    expect(store.records('event').get(id)).toMatchObject({ canvas: { x: 40, y: -20 }, canvasHidden: true })
    bus.undo()
    expect(store.records('event').get(id)).toMatchObject({ canvas: null, canvasHidden: null })
  })

  it('knows where it happened: a point, or the middle of a region', () => {
    const at = (locations: object[]) => store.records('event').get(event('E', 0, null, { locations }))!
    expect(eventPlace(at([]), [])).toBeUndefined()
    expect(eventPlace(at([{ kind: 'point', lat: 10, lon: 20 }]), [])).toEqual({ lat: 10, lon: 20 })
    const regionId = bus.execute({
      type: 'region.create',
      payload: { worldId, name: 'Strait', points: [{ lat: 0, lon: 170 }, { lat: 0, lon: -170 }, { lat: 10, lon: 180 }] }
    }).targetId!
    const place = eventPlace(at([{ kind: 'region', regionId }]), store.regions.all())!
    expect(place.lat).toBeCloseTo(3.33, 1)
    expect(Math.abs(place.lon)).toBeCloseTo(180, 5)
  })

  it('marks the owning world as changed', () => {
    store.nodes.update({ ...store.nodes.get(worldId)!, updatedAt: 'before' })
    event('Something', 0)
    expect(store.nodes.get(worldId)!.updatedAt).not.toBe('before')
  })
})

describe('links', () => {
  it('links events and removes links with their events, restoring both on undo', () => {
    const war = event('War', year(100), year(110))
    const famine = event('Famine', year(111))
    bus.execute({ type: 'link.create', payload: { fromId: war, toId: famine } })
    expect(links()).toEqual([expect.objectContaining({ fromId: war, toId: famine, type: 'causes', ownerId: worldId })])
    expect(() => bus.execute({ type: 'link.create', payload: { fromId: war, toId: famine } })).toThrow(/already linked/)
    expect(() => bus.execute({ type: 'link.create', payload: { fromId: war, toId: war } })).toThrow(/itself/)

    bus.execute({ type: 'event.delete', payload: { id: war } })
    expect(links()).toHaveLength(0)
    bus.undo()
    expect(links()).toHaveLength(1)
    expect(events()).toHaveLength(2)
  })

  it('finds causal chains in both directions', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((t, i) => event(t, year(i)))
    bus.execute({ type: 'link.create', payload: { fromId: a!, toId: b! } })
    bus.execute({ type: 'link.create', payload: { fromId: b!, toId: c! } })
    expect([...causalChain(links(), a!, 'down')]).toEqual([b, c])
    expect([...causalChain(links(), c!, 'up')].sort()).toEqual([a, b].sort())
  })
})

describe('groups and lanes', () => {
  it('groups events in one undoable step and ungroups them when deleted', () => {
    const ids = ['Battle 1', 'Battle 2'].map((t, i) => event(t, year(i)))
    const groupId = bus.execute({ type: 'group.create', payload: { ownerId: worldId, title: 'The War', eventIds: ids } }).targetId!
    expect(events().every((e) => e.groupId === groupId)).toBe(true)
    bus.undo()
    expect(events().every((e) => e.groupId === null)).toBe(true)
    expect(store.records('group').all()).toHaveLength(0)
    bus.redo()
    expect(events().every((e) => e.groupId === groupId)).toBe(true)

    bus.execute({ type: 'group.delete', payload: { id: groupId } })
    expect(events().every((e) => e.groupId === null)).toBe(true)
    bus.undo()
    expect(events().every((e) => e.groupId === groupId)).toBe(true)
  })

  it('moves events to the default lane when their lane is deleted', () => {
    const lane = bus.execute({ type: 'lane.create', payload: { ownerId: worldId, name: 'Politics' } }).targetId!
    const id = event('Election', 0, null, { laneId: lane })
    bus.execute({ type: 'lane.delete', payload: { id: lane } })
    expect(store.records('event').get(id)!.laneId).toBeNull()
    bus.undo()
    expect(store.records('event').get(id)!.laneId).toBe(lane)
  })

  it('applies a batch as one undo step, and none of it if any part fails', () => {
    const a = event('A', 0)
    bus.execute({
      type: 'batch',
      payload: { commands: [{ type: 'event.update', payload: { id: a, patch: { title: 'A2' } } }, { type: 'era.create', payload: { ownerId: worldId, start: 0, end: 10 } }] }
    })
    expect(store.records('era').all()).toHaveLength(1)
    bus.undo()
    expect(store.records('era').all()).toHaveLength(0)
    expect(store.records('event').get(a)!.title).toBe('A')

    expect(() =>
      bus.execute({ type: 'batch', payload: { commands: [{ type: 'event.update', payload: { id: a, patch: { title: 'A3' } } }, { type: 'event.delete', payload: { id: 'missing' } }] } })
    ).toThrow()
    expect(store.records('event').get(a)!.title).toBe('A')
  })
})

describe('time-aware regions', () => {
  const triangle = [
    { lat: 10, lon: 10 },
    { lat: 20, lon: 15 },
    { lat: 10, lon: 20 }
  ]

  it('founds, renames and dissolves a region over time', () => {
    const regionId = bus.execute({ type: 'region.create', payload: { worldId, points: triangle, name: 'Aster' } }).targetId!
    const founding = event('Founding', year(1200))
    const change = (at: number, kind: 'appear' | 'vanish' | 'update', extra: object = {}) =>
      bus.execute({ type: 'change.create', payload: { ownerId: worldId, entityKind: 'region', entityId: regionId, at, change: kind, ...extra } })
    change(year(1200), 'appear', { causeEventId: founding })
    change(year(1300), 'update', { patch: { name: 'Greater Aster' } })
    change(year(1400), 'vanish')
    const region = store.regions.get(regionId)!
    const changes = store.records('change').all()

    expect(regionAt(region, changes, year(1100))).toBeUndefined()
    expect(regionAt(region, changes, year(1250))?.name).toBe('Aster')
    expect(regionAt(region, changes, year(1350))?.name).toBe('Greater Aster')
    expect(regionAt(region, changes, year(1500))).toBeUndefined()
    expect(() => change(0, 'update')).toThrow(/something to change/)
  })
})

describe('warnings', () => {
  it('flags effects before causes, causal loops, and misplaced changes', () => {
    const late = event('Cause', year(100))
    const early = event('Effect', year(50))
    const c = event('C', year(200))
    bus.execute({ type: 'link.create', payload: { fromId: late, toId: early } })
    bus.execute({ type: 'link.create', payload: { fromId: early, toId: c } })
    bus.execute({ type: 'link.create', payload: { fromId: c, toId: late } })
    const data = { events: events(), links: links(), changes: [] }
    const messages = timelineWarnings(data, []).map((w) => w.message)
    expect(messages).toContain('“Effect” starts before “Cause”, which causes it')
    expect(messages.some((m) => m.startsWith('Causal loop'))).toBe(true)
  })
})

describe('timeline owner and settings', () => {
  it('shares a planet’s timeline with its world surface', () => {
    const nodes = store.nodes.all()
    expect(timelineOwner(nodes, planetId)?.id).toBe(worldId)
    expect(timelineOwner(nodes, worldId)?.id).toBe(worldId)
  })

  it('sets “now” undoably', () => {
    bus.execute({ type: 'timeline.update', payload: { ownerId: worldId, patch: { now: year(1500) } } })
    expect(store.records('timeline').get(worldId)!.now).toBe(year(1500))
    bus.undo()
    expect(store.records('timeline').get(worldId)!.now).toBe(0)
  })
})
