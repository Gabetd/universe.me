import { beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_BLUEPRINTS, CommandBus, MemoryStore, RECORD_KINDS, conditionCurves, createRootUniverse, fromParts, scarReach, scarStep, scarWeight, stateAt, type Scar, type StructureWorld, type TimelineData } from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string
const year = (y: number) => fromParts({ year: y })
const YEAR = year(1) - year(0)
const run = (type: string, payload: object) => bus.execute({ type, payload } as never)

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const make = (parentId: string, kind: string) => run('node.create', { parentId, kind }).targetId!
  worldId = make(make(make(make(make(createRootUniverse(store, 'U').id, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body'), 'world')
})

const scar = (id: string) => store.records('scar').get(id)!

function world(): StructureWorld {
  const data = Object.fromEntries(RECORD_KINDS.map((k) => [`${k}s`, store.records(k).all().filter((r) => !r.deletedAt)])) as unknown as TimelineData
  return { data, regions: store.regions.all().filter((r) => !r.deletedAt), radiusKm: 6371, erosionSpeed: 1, blueprint: (id) => BUILTIN_BLUEPRINTS.find((b) => b.id === id) }
}

describe('scars on the land', () => {
  it('are made as their kind has them unless told otherwise: a blast over in a moment and never healing, a war going on until given an end', () => {
    const crater = run('scar.create', { ownerId: worldId, kind: 'crater', lat: 10, lon: 20, start: year(1200) }).targetId!
    expect(scar(crater)).toMatchObject({ kind: 'crater', name: '', radiusKm: 0.5, end: year(1200), recoverYears: 0, strength: 1, regionId: null, eventId: null })
    const war = run('scar.create', { ownerId: worldId, kind: 'war', lat: 10, lon: 20, start: year(1200), radiusKm: 12 }).targetId!
    expect(scar(war)).toMatchObject({ radiusKm: 12, end: null, recoverYears: 40 })
    run('scar.update', { id: war, patch: { end: year(1210) } })
    expect(scar(war).end).toBe(year(1210))
    bus.undo()
    expect(scar(war).end).toBeNull()
    expect(() => run('scar.update', { id: war, patch: { end: year(1100) } })).toThrow(/before it comes/)
    expect(() => run('scar.create', { ownerId: store.nodes.root()!.id, kind: 'crater', lat: 0, lon: 0, start: 0 })).toThrow()
    expect(() => run('scar.create', { ownerId: worldId, kind: 'flood', lat: 0, lon: 0, start: 0 })).toThrow()
  })

  it('come at their start, last to their end, then heal over their recovery; one that never ends or heals stays', () => {
    const s = { start: year(100), end: year(110), recoverYears: 20, strength: 0.8 } satisfies Partial<Scar>
    expect(scarWeight(s, year(99), YEAR)).toBe(0)
    expect(scarWeight(s, year(105), YEAR)).toBe(0.8)
    expect(scarWeight(s, year(120), YEAR)).toBeCloseTo(0.4)
    expect(scarWeight(s, year(131), YEAR)).toBe(0)
    expect(scarWeight({ ...s, recoverYears: 0 }, year(5000), YEAR)).toBe(0.8)
    expect(scarWeight({ ...s, end: null }, year(5000), YEAR)).toBe(0.8)
    expect(scarStep(0.47)).toBe(0.5)
    expect(scarReach(0.5)).toBe(1)
    expect(scarReach(0.85)).toBeCloseTo(0.5)
    expect(scarReach(1.2)).toBe(0)
  })

  it('stay when the event that made them is deleted, no longer its, and come back to it on undo', () => {
    const event = run('event.create', { ownerId: worldId, start: year(1200), title: 'The fall of the star' }).targetId!
    const id = run('scar.create', { ownerId: worldId, kind: 'crater', lat: 0, lon: 0, start: year(1200), eventId: event }).targetId!
    run('event.delete', { id: event })
    expect(scar(id)).toMatchObject({ eventId: null, deletedAt: null })
    bus.undo()
    expect(scar(id).eventId).toBe(event)
  })

  it('a blast destroys what stands at its heart and damages what’s near its edge; drought harms nothing built', () => {
    const place = (lat: number) => run('structure.create', { ownerId: worldId, blueprintId: 'builtin:castle', lat, lon: 20, builtAt: year(1000) }).targetId!
    const [heart, edge, far] = [place(10), place(10 + 4.5 / 111.2), place(11)]
    run('scar.create', { ownerId: worldId, kind: 'crater', lat: 10, lon: 20, radiusKm: 5, start: year(1200) })
    run('scar.create', { ownerId: worldId, kind: 'drought', lat: 11, lon: 20, start: year(1200) })
    const curves = conditionCurves(world())
    expect(stateAt(curves.get(heart)!, year(1199)).exists).toBe(true)
    expect(stateAt(curves.get(heart)!, year(1200)).exists).toBe(false)
    const hurt = stateAt(curves.get(edge)!, year(1200))
    expect(hurt.exists).toBe(true)
    expect(hurt.condition).toBeLessThan(90)
    expect(stateAt(curves.get(far)!, year(1200)).condition).toBeGreaterThan(95)
  })
})
