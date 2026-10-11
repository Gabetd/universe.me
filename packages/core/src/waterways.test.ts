import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, createRootUniverse, waterwayId, waterwayKind, waterwayName, type Command } from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const make = (parentId: string, kind: string) => bus.execute({ type: 'node.create', payload: { parentId, kind } }).targetId!
  worldId = make(make(make(make(make(createRootUniverse(store, 'U').id, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body'), 'world')
})

const run = (type: string, payload: object) => bus.execute({ type, payload } as Command)
const own = () => store.records('waterway').all().find((w) => w.id === waterwayId(worldId, 'r123'))

describe('rivers and lakes the user names', () => {
  it('keep a name and notes of their own, by the hydrology’s id, a step of undo at a time', () => {
    run('waterway.set', { worldId, key: 'r123', patch: { name: 'The Silverrun' } })
    expect(own()).toMatchObject({ ownerId: worldId, key: 'r123', name: 'The Silverrun', notes: '' })
    run('waterway.set', { worldId, key: 'r123', patch: { notes: '<p>Wide and slow</p>' } })
    expect(own()).toMatchObject({ name: 'The Silverrun', notes: '<p>Wide and slow</p>' })
    bus.undo()
    expect(own()!.notes).toBe('')
    bus.undo()
    expect(own()).toBeUndefined()
    expect(waterwayName('Kavelor', own())).toBe('Kavelor')
    bus.redo()
    expect(waterwayName('Kavelor', own())).toBe('The Silverrun')
  })

  it('are a river or a lake by their id, and need a world and an id the hydrology could give', () => {
    expect(waterwayKind('r5')).toBe('river')
    expect(waterwayKind('l5')).toBe('lake')
    expect(() => run('waterway.set', { worldId, key: 'x1', patch: { name: 'No' } })).toThrow()
    expect(() => run('waterway.set', { worldId: 'nowhere', key: 'r1', patch: { name: 'No' } })).toThrow()
  })
})
