import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, createRootUniverse, flaggedIds, sameFinding, type Command } from './index'

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
const findings = () => store.records('finding').all()

describe('findings', () => {
  it('are kept with a world, open until resolved or dismissed, and undo like any record', () => {
    const id = run('finding.create', { ownerId: worldId, severity: 'contradiction', title: 'Two places at once', refs: [{ kind: 'character', id: 'c1' }], reporter: 'Claude' }).targetId!
    expect(findings()[0]).toMatchObject({ status: 'open', explanation: '', suggestion: '', note: '' })
    expect([...flaggedIds(findings())]).toEqual(['c1'])
    run('finding.update', { id, patch: { status: 'dismissed', note: 'She has a twin' } })
    expect(flaggedIds(findings()).size).toBe(0)
    bus.undo()
    expect(findings()[0]!.status).toBe('open')
    expect(() => run('finding.create', { ownerId: store.nodes.get(worldId)!.parentId, severity: 'question', title: 'x' })).toThrow(/not a world/)
  })

  it('know one already raised: open or dismissed, by title', () => {
    const id = run('finding.create', { ownerId: worldId, severity: 'unlikely', title: 'Snow in the desert' }).targetId!
    expect(sameFinding(findings(), ' snow in the DESERT ')?.id).toBe(id)
    run('finding.update', { id, patch: { status: 'dismissed' } })
    expect(sameFinding(findings(), 'Snow in the desert')?.id).toBe(id)
    run('finding.update', { id, patch: { status: 'resolved' } })
    expect(sameFinding(findings(), 'Snow in the desert')).toBeUndefined()
  })
})
