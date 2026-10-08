import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, CommandError, MemoryStore, buildTree, createRootUniverse, ancestry, type HistoryRecord } from './index'

let store: MemoryStore
let bus: CommandBus
let log: HistoryRecord[]
let rootId: string

beforeEach(() => {
  store = new MemoryStore()
  log = []
  let n = 0
  bus = new CommandBus(store, {
    log: { append: (r) => log.push(r) },
    context: { newId: () => `id-${++n}`, randomSeed: () => 42, now: () => `2026-01-01T00:00:${String(n).padStart(2, '0')}Z` }
  })
  rootId = createRootUniverse(store, 'Test Universe').id
})

const create = (parentId: string, kind: string, name?: string) =>
  bus.execute({ type: 'node.create', payload: { parentId, kind, name } }).targetId!

describe('node.create', () => {
  it('creates a node with defaults', () => {
    const id = create(rootId, 'galaxy_cluster')
    expect(store.nodes.get(id)).toMatchObject({ name: 'New Galaxy Cluster', seed: 42, parentId: rootId, deletedAt: null })
  })

  it('enforces the zoom hierarchy', () => {
    expect(() => create(rootId, 'star_system')).toThrow(/cannot be placed inside a Universe/)
  })

  it('lands a batch on its focus, or else on what its last command made', () => {
    const cluster = create(rootId, 'galaxy_cluster')
    const galaxies = (a: string, b: string, focusId?: string) => ({
      type: 'batch' as const,
      payload: { commands: [a, b].map((id) => ({ type: 'node.create', payload: { id, parentId: cluster, kind: 'galaxy' } })), focusId }
    })
    expect(bus.execute(galaxies('g1', 'g2')).targetId).toBe('g2')
    expect(bus.execute(galaxies('g3', 'g4', 'g3')).targetId).toBe('g3')
  })

  it('allows one world per body', () => {
    const cluster = create(rootId, 'galaxy_cluster')
    const galaxy = create(cluster, 'galaxy')
    const system = create(galaxy, 'star_system')
    const planet = create(system, 'body', 'Aerth')
    create(planet, 'body', 'Moon')
    create(planet, 'world')
    expect(() => create(planet, 'world')).toThrow(/already has a world/)
  })

  it('rejects malformed commands', () => {
    expect(() => bus.execute({ type: 'node.create', payload: { parentId: rootId, kind: 'nebula' } })).toThrow(CommandError)
    expect(() => bus.execute({ type: 'node.explode', payload: {} })).toThrow(CommandError)
  })
})

describe('undo/redo', () => {
  it('undoes and redoes a create, keeping the same id', () => {
    const id = create(rootId, 'galaxy_cluster')
    bus.undo()
    expect(store.nodes.all().map((n) => n.id)).toEqual([rootId])
    bus.redo()
    expect(store.nodes.get(id)?.deletedAt).toBeNull()
    expect(bus.canRedo).toBe(false)
  })

  it('restores previous values on update undo', () => {
    const id = create(rootId, 'galaxy_cluster', 'Virgo')
    bus.execute({ type: 'node.update', payload: { id, patch: { name: 'Laniakea', tags: ['home'] } } })
    bus.undo()
    expect(store.nodes.get(id)).toMatchObject({ name: 'Virgo', tags: [] })
    bus.redo()
    expect(store.nodes.get(id)).toMatchObject({ name: 'Laniakea', tags: ['home'] })
  })

  it('deletes a subtree and restores exactly that subtree', () => {
    const cluster = create(rootId, 'galaxy_cluster')
    const galaxyA = create(cluster, 'galaxy', 'A')
    const galaxyB = create(cluster, 'galaxy', 'B')
    bus.execute({ type: 'node.delete', payload: { id: galaxyB } }) // deleted earlier, separately
    bus.execute({ type: 'node.delete', payload: { id: cluster } })
    expect(store.nodes.all()).toHaveLength(1)
    bus.undo()
    expect(store.nodes.get(galaxyA)?.deletedAt).toBeNull()
    expect(store.nodes.get(galaxyB)?.deletedAt).not.toBeNull()
  })

  it('refuses to delete the root', () => {
    expect(() => bus.execute({ type: 'node.delete', payload: { id: rootId } })).toThrow(/cannot be deleted/)
  })

  it('a new command clears the redo stack', () => {
    create(rootId, 'galaxy_cluster')
    bus.undo()
    create(rootId, 'galaxy_cluster')
    expect(bus.canRedo).toBe(false)
  })

  it('rolls back partial writes when a command fails', () => {
    const before = store.nodes.all().length
    expect(() => bus.execute({ type: 'node.update', payload: { id: 'missing', patch: { name: 'x' } } })).toThrow()
    expect(store.nodes.all()).toHaveLength(before)
    expect(log).toHaveLength(0)
  })

  it('logs every applied action with its source', () => {
    bus.execute({ type: 'node.create', payload: { parentId: rootId, kind: 'galaxy_cluster' } }, 'ai')
    bus.undo()
    bus.redo()
    expect(log.map((r) => [r.action, r.source, r.command.type])).toEqual([
      ['do', 'ai', 'node.create'],
      ['undo', 'ai', 'node.delete'],
      ['redo', 'ai', 'node.restore']
    ])
  })
})

describe('queries', () => {
  it('builds the tree and ancestry', () => {
    const cluster = create(rootId, 'galaxy_cluster')
    const galaxy = create(cluster, 'galaxy', 'Milky Way')
    const tree = buildTree(store.nodes.all())
    expect(tree?.children[0]?.children[0]?.name).toBe('Milky Way')
    expect(ancestry(store.nodes.all(), galaxy).map((n) => n.kind)).toEqual(['universe', 'galaxy_cluster', 'galaxy'])
  })
})

describe('changes by source', () => {
  it('counts the latest changes from one source, one after another', () => {
    const add = (source: 'user' | 'ai') => bus.execute({ type: 'node.create', payload: { parentId: rootId, kind: 'galaxy_cluster' } }, source)
    add('ai')
    add('user')
    add('ai')
    add('ai')
    expect(bus.latestFrom('ai')).toBe(2)
    expect(bus.latestFrom('user')).toBe(0)
    bus.undo()
    expect(bus.latestFrom('ai')).toBe(1)
    // A redo keeps its source.
    bus.redo()
    expect(bus.latestFrom('ai')).toBe(2)
    expect(log.at(-1)!.source).toBe('ai')
  })
})
