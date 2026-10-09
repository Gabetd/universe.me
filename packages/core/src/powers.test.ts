import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, POWER_TEMPLATE_INFO, aspectId, createRootUniverse, eraAt, erasInOrder, fromParts, powerAgeId, powerAt, type Command } from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string
const year = (y: number) => fromParts({ year: y })

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const make = (parentId: string, kind: string) => bus.execute({ type: 'node.create', payload: { parentId, kind } }).targetId!
  worldId = make(make(make(make(make(createRootUniverse(store, 'U').id, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body'), 'world')
})

const run = (type: string, payload: object) => bus.execute({ type, payload } as Command)
const era = (name: string, start: number, end: number, ownerId = worldId) => run('era.create', { ownerId, name, start: year(start), end: year(end) }).targetId!
const system = (extra: object = {}) => run('power.create', { ownerId: worldId, template: 'magic', ...extra }).targetId!
const ages = () => store.records('powerAge').all()

describe('power systems', () => {
  it('start from a template, and edit like any record', () => {
    const id = system()
    expect(store.records('power').get(id)).toMatchObject({ name: 'Magic', template: 'magic', aspects: POWER_TEMPLATE_INFO.magic.aspects, values: {} })
    run('power.update', { id, patch: { name: 'The Weave', values: { source: 'Starlight' } } })
    expect(store.records('power').get(id)).toMatchObject({ name: 'The Weave', values: { source: 'Starlight' } })
    bus.undo()
    expect(store.records('power').get(id)!.name).toBe('Magic')
    const plain = run('power.create', { ownerId: worldId }).targetId!
    expect(store.records('power').get(plain)).toMatchObject({ template: 'other', name: 'Power system' })
  })

  it('live on a world, with aspects of their own', () => {
    expect(() => run('power.create', { ownerId: store.nodes.get(worldId)!.parentId })).toThrow(/not a world/)
    const id = system()
    expect(() => run('power.update', { id, patch: { aspects: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] } })).toThrow(/same id/)
  })

  it('describe each age, one entry per era, merged as it changes and undone a step at a time', () => {
    const id = system()
    const dawn = era('Dawn', 0, 100)
    run('powerAge.set', { systemId: id, eraId: dawn, patch: { strength: 0.2, values: { source: 'Wild springs' } } })
    run('powerAge.set', { systemId: id, eraId: dawn, patch: { summary: 'Rare and feared' } })
    expect(ages()).toEqual([expect.objectContaining({ id: powerAgeId(id, dawn), strength: 0.2, summary: 'Rare and feared', values: { source: 'Wild springs' } })])
    bus.undo()
    expect(ages()[0]).toMatchObject({ summary: '', strength: 0.2 })
    bus.undo()
    expect(ages()).toHaveLength(0)
    bus.redo()
    expect(ages()).toHaveLength(1)
  })

  it('only describe eras of their own world', () => {
    const id = system()
    const otherWorld = bus.execute({ type: 'node.create', payload: { parentId: store.nodes.get(worldId)!.parentId!, kind: 'body' } }).targetId!
    const elsewhere = era('Elsewhere', 0, 10, otherWorld)
    expect(() => run('powerAge.set', { systemId: id, eraId: elsewhere, patch: {} })).toThrow(/another world/)
    expect(() => run('powerAge.set', { systemId: id, eraId: 'missing', patch: {} })).toThrow()
  })

  it('take their age entries when deleted, and so does an era; undo brings them back', () => {
    const id = system()
    const [a, b] = [era('A', 0, 10), era('B', 10, 20)]
    run('powerAge.set', { systemId: id, eraId: a, patch: { strength: 1 } })
    run('powerAge.set', { systemId: id, eraId: b, patch: { strength: 0 } })
    run('era.delete', { id: a })
    expect(ages().map((x) => x.eraId)).toEqual([b])
    bus.undo()
    expect(ages()).toHaveLength(2)
    run('power.delete', { id })
    expect(ages()).toHaveLength(0)
    bus.undo()
    expect(ages()).toHaveLength(2)
  })

  it('read at a moment: the era in force, its answers over the always-true ones', () => {
    const id = system({ summary: 'The Weave', values: { source: 'Starlight', rules: 'Words of power' } })
    const [old, late, inner] = [era('Old Age', 0, 500), era('Late Age', 500, 1000), era('Silence', 200, 300)]
    run('powerAge.set', { systemId: id, eraId: late, patch: { strength: 0.9, summary: 'Everywhere', values: { source: '  ', rules: 'Anyone may speak them' } } })
    run('powerAge.set', { systemId: id, eraId: inner, patch: { strength: 0 } })
    const s = store.records('power').get(id)!
    const eras = store.records('era').all()
    const at = (y: number) => powerAt(s, ages(), eras, year(y))
    expect(at(100)).toMatchObject({ era: { id: old }, age: undefined, summary: 'The Weave', strength: null })
    expect(at(250).era!.id).toBe(inner)
    expect(at(250).strength).toBe(0)
    const lateAge = at(700)
    expect(lateAge).toMatchObject({ summary: 'Everywhere', strength: 0.9 })
    // A blank answer for an age keeps the always-true one.
    expect(lateAge.aspects.find((x) => x.id === 'source')).toMatchObject({ value: 'Starlight', fromAge: false })
    expect(lateAge.aspects.find((x) => x.id === 'rules')).toMatchObject({ value: 'Anyone may speak them', fromAge: true })
    expect(at(2000).era).toBeUndefined()
    expect(erasInOrder(eras).map((e) => e.name)).toEqual(['Old Age', 'Silence', 'Late Age'])
    expect(eraAt(eras, year(500))!.id).toBe(late)
  })

  it('make aspect ids from labels that stay unique', () => {
    expect(aspectId('Costs & limits')).toBe('costs-limits')
    expect(aspectId('Source', ['source', 'source-2'])).toBe('source-3')
    expect(aspectId('???')).toBe('aspect')
  })
})
