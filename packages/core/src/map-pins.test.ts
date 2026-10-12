import { describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, createRootUniverse, type Command } from './index'

describe('pins on a world’s surface', () => {
  it('are made at a point with a name, renamed, moved and deleted, each undoable, and only on a world', () => {
    const store = new MemoryStore()
    let n = 0
    const bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
    const run = (type: string, payload: object) => bus.execute({ type, payload } as Command)
    let parent = createRootUniverse(store, 'U').id
    for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world']) parent = run('node.create', { parentId: parent, kind, name: kind }).targetId!
    const id = run('mapPin.create', { ownerId: parent, name: 'Old well', lat: 12.5, lon: -40 }).targetId!
    expect(store.records('mapPin').get(id)).toMatchObject({ name: 'Old well', lat: 12.5, lon: -40, color: '#e8524a', notes: '' })
    run('mapPin.update', { id, patch: { name: 'The old well', lat: 13 } })
    expect(store.records('mapPin').get(id)).toMatchObject({ name: 'The old well', lat: 13 })
    bus.undo()
    expect(store.records('mapPin').get(id)!.name).toBe('Old well')
    run('mapPin.delete', { id })
    expect(store.records('mapPin').all()).toEqual([])
    expect(() => run('mapPin.create', { ownerId: parent, name: '', lat: 0, lon: 0 })).toThrow()
    expect(() => run('mapPin.create', { ownerId: parent, name: 'Off', lat: 91, lon: 0 })).toThrow()
    expect(() => run('mapPin.create', { ownerId: store.nodes.root()!.id, name: 'Nowhere', lat: 0, lon: 0 })).toThrow()
  })
})
