import { beforeEach, describe, expect, it } from 'vitest'
import {
  CommandBus,
  LINK_TYPES,
  MemoryStore,
  ORDERED_LINKS,
  createRootUniverse,
  eventPlace,
  fromParts,
  groupSpan,
  groupSpans,
  indexChanges,
  regionAt,
  timelineWarnings,
  causalChain,
  timelineOwner,
  type EntityChange,
  type EventGroup,
  type EventLink,
  type TimelineEvent
} from './index'

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

  it('won’t bring back a link that one made since duplicates; edits keep a link’s ends', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((t, i) => event(t, year(i)))
    const first = bus.execute({ type: 'link.create', payload: { fromId: a!, toId: b! } }).targetId!
    bus.execute({ type: 'link.create', payload: { fromId: b!, toId: c! } })
    bus.execute({ type: 'link.delete', payload: { id: first } })
    const second = bus.execute({ type: 'link.create', payload: { fromId: a!, toId: b!, type: 'enables' } }).targetId!
    expect(() => bus.execute({ type: 'record.restore', payload: { refs: [{ kind: 'link', id: first }] } })).toThrow(/already linked/)
    bus.execute({ type: 'link.update', payload: { id: second, patch: { type: 'precedes', note: 'Then' } } })
    expect(store.records('link').get(second)).toMatchObject({ fromId: a, toId: b, type: 'precedes', note: 'Then' })
    // Deleting an event takes both of its links, and undo brings them back together.
    bus.execute({ type: 'event.delete', payload: { id: b! } })
    expect(links()).toHaveLength(0)
    bus.undo()
    expect(links().map((l) => l.toId).sort()).toEqual([b, c].sort())
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

  it('finds the same causal loops, in the same order, as walking back from every event', () => {
    // The first way of finding loops: an event is in one if a walk downstream from it comes back.
    const chainOf = (links: EventLink[], id: string) => {
      const next = new Map<string, string[]>()
      for (const l of links) next.set(l.fromId, [...(next.get(l.fromId) ?? []), l.toId])
      const seen = new Set<string>()
      const stack = [id]
      while (stack.length) {
        for (const x of next.get(stack.pop()!) ?? []) {
          if (seen.has(x)) continue
          seen.add(x)
          if (x !== id) stack.push(x)
        }
      }
      return seen
    }
    const expected = (events: TimelineEvent[], links: EventLink[]) => {
      const ordered = links.filter((l) => ORDERED_LINKS.includes(l.type))
      const reported = new Set<string>()
      const loops: string[][] = []
      for (const e of events) {
        if (reported.has(e.id) || !chainOf(ordered, e.id).has(e.id)) continue
        const loop = [e.id, ...[...chainOf(ordered, e.id)].filter((id) => id !== e.id && chainOf(ordered, id).has(e.id))]
        loop.forEach((id) => reported.add(id))
        loops.push(loop)
      }
      return loops
    }
    let seed = 3
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % n
    for (const [count, linkCount] of [[300, 200], [300, 330], [200, 600]] as const) {
      const evs = Array.from({ length: count }, (_, i): TimelineEvent => ({
        id: `e${i}`, ownerId: worldId, title: `E${i}`, start: random(1000), end: null, precision: 'year', laneId: null, groupId: null, color: '#ffffff', notes: '', tags: [], locations: [], createdAt: '', updatedAt: '', deletedAt: null
      }))
      const lnks = Array.from({ length: linkCount }, (_, i): EventLink => ({
        id: `l${i}`, ownerId: worldId, fromId: `e${random(count)}`, toId: `e${random(count)}`, type: LINK_TYPES[random(LINK_TYPES.length)]!, note: '', createdAt: '', updatedAt: '', deletedAt: null
      }))
      const loops = timelineWarnings({ events: evs, links: lnks, changes: [] }, [])
        .filter((w) => w.message.startsWith('Causal loop'))
        .map((w) => w.refs.map((r) => r.id))
      const want = expected(evs, lnks)
      expect(want.length).toBeGreaterThan(0)
      expect(loops).toEqual(want)
    }
  })
})

describe('indexed queries', () => {
  const ev = (id: string, start: number, end: number | null, groupId: string | null) => ({ id, start, end, groupId }) as TimelineEvent
  const change = (id: string, entityId: string, at: number, change: 'appear' | 'vanish') => ({ id, entityId, at, change, patch: {} }) as unknown as EntityChange

  it('spans every group in one pass', () => {
    const events = [ev('a', 5, 9, 'g'), ev('b', 1, null, 'g'), ev('c', 20, 30, 'h'), ev('d', 0, 100, null)]
    expect(groupSpans(events)).toEqual(new Map([['g', [1, 9]], ['h', [20, 30]]]))
    expect(groupSpan({ id: 'g' } as EventGroup, events)).toEqual([1, 9])
    expect(groupSpan({ id: 'empty' } as EventGroup, events)).toBeUndefined()
  })

  it('sorts each entity’s changes once per list, keeping equal times in their order', () => {
    const changes = [change('3', 'r', 30, 'vanish'), change('1', 's', 10, 'appear'), change('2a', 'r', 10, 'appear'), change('2b', 'r', 10, 'vanish')]
    expect(indexChanges(changes).get('r')!.map((c) => c.id)).toEqual(['2a', '2b', '3'])
    expect(indexChanges(changes)).toBe(indexChanges(changes))
    expect(indexChanges(changes).get('nothing')).toBeUndefined()
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
    bus.execute({ type: 'timeline.update', payload: { ownerId: worldId, patch: { now: year(1600) } } })
    expect(bus.undo()?.command).toEqual({ type: 'timeline.update', payload: { ownerId: worldId, patch: { now: year(1500) } } })
    // The first change undoes to the default, keeping the record.
    expect(bus.undo()?.command).toEqual({ type: 'timeline.update', payload: { ownerId: worldId, patch: { now: 0 } } })
    expect(store.records('timeline').get(worldId)!.now).toBe(0)
  })
})
