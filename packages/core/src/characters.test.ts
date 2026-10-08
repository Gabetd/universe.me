import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, ageAt, characterAt, createRootUniverse, fromParts, walkingTime, type Character } from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string
const year = (y: number) => fromParts({ year: y })
const run = (type: string, payload: object) => bus.execute({ type, payload } as never)
const character = (id: string) => store.records('character').get(id)!

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const make = (parentId: string, kind: string) => run('node.create', { parentId, kind }).targetId!
  worldId = make(make(make(make(make(createRootUniverse(store, 'U').id, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body'), 'world')
})

describe('characters', () => {
  it('have a lifespan, and are nowhere outside it', () => {
    const id = run('character.create', { ownerId: worldId, name: 'Ada', born: year(1000), died: year(1070), stops: [{ at: year(1000), lat: 0, lon: 0, travel: 0, eventId: null }] }).targetId!
    const c = character(id)
    expect(characterAt(c, year(999))).toBeUndefined()
    expect(characterAt(c, year(1030))).toMatchObject({ lat: 0, lon: 0, travelling: false })
    expect(characterAt(c, year(1071))).toBeUndefined()
    expect(ageAt(c, year(1030))).toBe(30)
    expect(ageAt(c, year(2000))).toBe(70)
    expect(() => run('character.update', { id, patch: { died: year(900) } })).toThrow(/before they are born/)
  })

  it('travel between stops, staying put in between', () => {
    const id = run('character.create', { ownerId: worldId, born: year(1000), stops: [{ at: year(1000), lat: 0, lon: 0, travel: 0, eventId: null }] }).targetId!
    const there = { lat: 0, lon: 10 }
    const travel = walkingTime({ lat: 0, lon: 0 }, there, 6371)
    expect(travel / 86400).toBe(37) // ~1,112 km at 30 km a day
    // Added out of order: kept sorted.
    run('character.travel', { id, stop: { at: year(1020), lat: 0, lon: 20, travel: 0, eventId: null } })
    run('character.travel', { id, stop: { at: year(1010), ...there, travel, eventId: null } })
    const c: Character = character(id)
    expect(c.stops.map((s) => s.lon)).toEqual([0, 10, 20])
    expect(characterAt(c, year(1005))).toMatchObject({ lon: 0, travelling: false })
    const half = characterAt(c, year(1010) - travel / 2)!
    expect(half.travelling).toBe(true)
    expect(half.lon).toBeCloseTo(5, 3)
    expect(characterAt(c, year(1015))).toMatchObject({ lon: 10, travelling: false, stop: 1 })
    // No travel time: there from the moment of arrival.
    expect(characterAt(c, year(1020))).toMatchObject({ lon: 20, travelling: false })
    bus.undo()
    expect(character(id).stops).toHaveLength(2)
  })

  it('lose a stop’s event link when the event is deleted, and get it back on undo', () => {
    const eventId = run('event.create', { ownerId: worldId, start: year(1010) }).targetId!
    const id = run('character.create', { ownerId: worldId, born: year(1000), stops: [{ at: year(1010), lat: 1, lon: 1, travel: 0, eventId }] }).targetId!
    run('event.delete', { id: eventId })
    expect(character(id).stops[0]!.eventId).toBeNull()
    bus.undo()
    expect(character(id).stops[0]!.eventId).toBe(eventId)
  })

  it('only live on worlds', () => {
    expect(() => run('character.create', { ownerId: 'nope', born: 0 })).toThrow()
  })
})
