import { beforeEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_BLUEPRINTS,
  CommandBus,
  MemoryStore,
  RECORD_KINDS,
  conditionCurves,
  createRootUniverse,
  erodesAt,
  ruinAt,
  derivedEvents,
  weatherFactor,
  type Exposure,
  structureWarnings,
  fromParts,
  stateAt,
  type StructureWorld,
  type TimelineData
} from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string
let rootId: string
const year = (y: number) => fromParts({ year: y })
const run = (type: string, payload: object) => bus.execute({ type, payload } as never)

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  rootId = createRootUniverse(store, 'U').id
  const make = (parentId: string, kind: string) => run('node.create', { parentId, kind }).targetId!
  worldId = make(make(make(make(make(rootId, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body'), 'world')
})

const place = (blueprintId: string, extra: object = {}) => run('structure.create', { ownerId: worldId, blueprintId, lat: 10, lon: 20, builtAt: year(1000), ...extra }).targetId!
const event = (start: number, extra: object = {}) => run('event.create', { ownerId: worldId, start, ...extra }).targetId!

function world(erosionSpeed = 1): StructureWorld {
  const data = Object.fromEntries(RECORD_KINDS.map((k) => [`${k}s`, store.records(k).all().filter((r) => !r.deletedAt)])) as unknown as TimelineData
  return {
    data,
    regions: store.regions.all().filter((r) => !r.deletedAt),
    radiusKm: 6371,
    erosionSpeed,
    blueprint: (id) => BUILTIN_BLUEPRINTS.find((b) => b.id === id) ?? data.blueprints.find((b) => b.id === id)
  }
}
const at = (id: string, t: number, w = world()) => stateAt(conditionCurves(w).get(id)!, t)

describe('condition over time', () => {
  it('does not exist before it is built, and starts pristine', () => {
    const id = place('builtin:castle')
    expect(at(id, year(999)).exists).toBe(false)
    expect(at(id, year(1000))).toMatchObject({ exists: true, condition: 100, stage: 'pristine', maintained: true })
  })

  it('a maintained structure never erodes; a weathered one always does, at the projected time', () => {
    const kept = place('builtin:house')
    const left = place('builtin:house', { maintained: false })
    expect(at(kept, year(50_000)).condition).toBe(100)
    const curve = conditionCurves(world()).get(left)!
    expect(stateAt(curve, year(1100)).stage).not.toBe('pristine')
    const gone = erodesAt(curve, year(1000))!
    expect(gone).toBeGreaterThan(year(1100))
    expect(stateAt(curve, gone - year(1)).exists).toBe(true)
    expect(stateAt(curve, gone + year(1))).toMatchObject({ exists: false, stage: 'destroyed' })
  })

  it('erodes at material speed: a wooden house long before a stone castle; never-decays holds', () => {
    const house = place('builtin:house', { maintained: false })
    const castle = place('builtin:castle', { maintained: false })
    const stone = place('builtin:standing-stone', { neverDecays: true })
    const w = world()
    const curves = conditionCurves(w)
    expect(ruinAt(curves.get(house)!, year(1000))! - year(1000)).toBeLessThan(year(400))
    expect(ruinAt(curves.get(castle)!, year(1000))! - year(1000)).toBeGreaterThan(year(2000))
    expect(stateAt(curves.get(stone)!, year(90_000)).condition).toBe(100)
    // A faster erosion speed brings it forward.
    expect(erodesAt(conditionCurves(world(3)).get(house)!, year(1000))!).toBeLessThan(erodesAt(curves.get(house)!, year(1000))!)
  })

  it('decays part by part: a house’s thatch and wood go long before its stone chimney', () => {
    const house = place('builtin:house', { maintained: false })
    const curve = conditionCurves(world()).get(house)!
    const later = stateAt(curve, year(1300))
    expect(later.materials.thatch!).toBeLessThan(5)
    expect(later.materials.stone!).toBeGreaterThan(70)
    // Gone only when the last material is.
    expect(erodesAt(curve, year(1000))! - year(1000)).toBeGreaterThan(year(3000))
  })

  it('wears faster where the weather is hard on its materials', () => {
    const rainforest: Exposure = { moisture: 1, freezeThaw: 0, heat: 0.7, salt: 0, growth: 1 }
    const desert: Exposure = { moisture: 0.05, freezeThaw: 0.2, heat: 1, salt: 0, growth: 0.05 }
    expect(weatherFactor('wood', rainforest)).toBeGreaterThan(1.3)
    expect(weatherFactor('wood', desert)).toBeLessThan(0.7)
    expect(weatherFactor('iron', { ...desert, salt: 1 })).toBeGreaterThan(weatherFactor('iron', desert))
    const house = place('builtin:house', { maintained: false })
    const wet = conditionCurves({ ...world(), exposure: () => rainforest }).get(house)!
    const dry = conditionCurves({ ...world(), exposure: () => desert }).get(house)!
    expect(ruinAt(wet, year(1000))!).toBeLessThan(ruinAt(dry, year(1000))!)
  })

  it('derives when weathering brings a structure to ruin and erodes it away, unless something stops it', () => {
    const left = place('builtin:tower', { maintained: false })
    const saved = place('builtin:tower', { maintained: false })
    const curvesBefore = conditionCurves(world())
    const ruin = ruinAt(curvesBefore.get(saved)!, year(1000))!
    // Maintained again before it would fall into ruin: no derived ruin for that one.
    run('maintenance.set', { structureId: saved, at: ruin - year(5), maintained: true })
    const events = derivedEvents(conditionCurves(world()))
    expect(events.filter((e) => e.structureId === left).map((e) => e.kind)).toEqual(['ruin', 'eroded'])
    expect(events.filter((e) => e.structureId === saved)).toEqual([])
  })

  it('is continuous when maintenance is switched off, then recovers once it is switched back on', () => {
    const id = place('builtin:house')
    run('maintenance.set', { structureId: id, at: year(1100), maintained: false })
    run('maintenance.set', { structureId: id, at: year(1150), maintained: true })
    const before = at(id, year(1100) - 1).condition
    const after = at(id, year(1100) + 1).condition
    expect(Math.abs(before - after)).toBeLessThan(0.01)
    const abandoned = at(id, year(1150)).condition
    expect(abandoned).toBeLessThan(80)
    expect(at(id, year(1200)).condition).toBeGreaterThan(abandoned)
  })

  it('event effects: damage, repair, destroy and rebuild, at the event time', () => {
    const id = place('builtin:castle')
    const siege = event(year(1200))
    run('effect.create', { eventId: siege, type: 'damage', amount: 60, target: { kind: 'structures', ids: [id] } })
    expect(at(id, year(1200) - 1).condition).toBe(100)
    expect(at(id, year(1200)).condition).toBeCloseTo(40, 5)
    const fire = event(year(1300))
    run('effect.create', { eventId: fire, type: 'destroy', target: { kind: 'structures', ids: [id] } })
    const rebuilt = event(year(1400))
    run('effect.create', { eventId: rebuilt, type: 'build', target: { kind: 'structures', ids: [id] } })
    expect(at(id, year(1350)).exists).toBe(false)
    expect(at(id, year(1400))).toMatchObject({ exists: true, condition: 100 })

    // Moving the siege moves the damage; deleting it removes it (and its effects), undoably.
    run('event.update', { id: siege, patch: { start: year(1250) } })
    expect(at(id, year(1200)).condition).toBe(100)
    run('event.delete', { id: siege })
    expect(store.records('effect').all().filter((e) => !e.deletedAt)).toHaveLength(2)
    expect(at(id, year(1250)).condition).toBe(100)
    bus.undo()
    expect(at(id, year(1250)).condition).toBeCloseTo(40, 5)
  })

  it('reaches structures by radius with falloff, by region, and by tag or material', () => {
    const near = place('builtin:house', { lat: 0, lon: 0 })
    const far = place('builtin:house', { lat: 0, lon: 3 })
    const tower = place('builtin:tower', { lat: 0, lon: 1 })
    const quake = event(year(1100), { locations: [{ kind: 'point', lat: 0, lon: 0 }] })
    run('effect.create', { eventId: quake, type: 'damage', amount: 50, target: { kind: 'radius', km: 250, falloff: true } })
    // ~111 km per degree: the tower is ~45% of the way out, the far house outside.
    expect(at(near, year(1100)).condition).toBeCloseTo(50, 1)
    expect(at(tower, year(1100)).condition).toBeGreaterThan(70)
    expect(at(far, year(1100)).condition).toBe(100)

    const regionId = run('region.create', { worldId, name: 'Shire', points: [{ lat: -1, lon: -1 }, { lat: -1, lon: 2 }, { lat: 1, lon: 2 }, { lat: 1, lon: -1 }] }).targetId!
    const fire = event(year(1200))
    run('effect.create', { eventId: fire, type: 'destroy', target: { kind: 'region', regionId }, filter: { tags: [], materials: ['thatch'] } })
    expect(at(near, year(1200)).exists).toBe(false)
    expect(at(tower, year(1200)).exists).toBe(true)
    expect(at(far, year(1200)).exists).toBe(true)
  })

  it('renames and changes blueprint over time; abandons structures through events', () => {
    const id = place('builtin:tower')
    const e = event(year(1500))
    run('effect.create', { eventId: e, type: 'modify', rename: 'Old Tower', blueprintId: 'builtin:lighthouse', target: { kind: 'structures', ids: [id] } })
    run('effect.create', { eventId: e, type: 'set_maintenance', maintained: false, target: { kind: 'structures', ids: [id] } })
    expect(at(id, year(1499))).toMatchObject({ name: 'Watchtower', blueprintId: 'builtin:tower', maintained: true })
    expect(at(id, year(1500))).toMatchObject({ name: 'Old Tower', blueprintId: 'builtin:lighthouse', maintained: false })
    expect(() => run('effect.create', { eventId: e, type: 'modify', target: { kind: 'structures', ids: [id] } })).toThrow(/new name or blueprint/)
  })

  it('gives the same answer for the same inputs', () => {
    const id = place('builtin:castle', { maintained: false })
    run('effect.create', { eventId: event(year(1300)), type: 'damage', amount: 30, target: { kind: 'structures', ids: [id] } })
    expect(at(id, year(2500)).condition).toBe(at(id, year(2500)).condition)
  })
})

describe('structure warnings', () => {
  it('flags effects that reach nothing, repairs of ruins already gone, and maintenance before building', () => {
    const id = place('builtin:house')
    run('effect.create', { eventId: event(year(1100), { title: 'Fire' }), type: 'destroy', target: { kind: 'structures', ids: [id] } })
    run('effect.create', { eventId: event(year(1200), { title: 'Repairs' }), type: 'repair', target: { kind: 'structures', ids: [id] } })
    run('effect.create', { eventId: event(year(1300), { title: 'Quake' }), type: 'damage', target: { kind: 'radius', km: 10, falloff: false } })
    run('maintenance.set', { structureId: id, at: year(900), maintained: false })
    const w = world()
    const messages = structureWarnings(w, conditionCurves(w)).map((x) => x.message)
    expect(messages).toEqual([
      '“Repairs” repairs House, which is already gone then. Rebuild it instead?',
      '“Quake” damage effect reaches no structures (the event has no place yet)',
      "House's maintenance changes before it is built"
    ])
  })
})

describe('structure commands', () => {
  it('deleting a structure takes its maintenance history and un-targets it, undoably', () => {
    const id = place('builtin:house')
    run('maintenance.set', { structureId: id, at: year(1100), maintained: false })
    const e = event(year(1200))
    const effectId = run('effect.create', { eventId: e, type: 'damage', target: { kind: 'structures', ids: [id] } }).targetId!
    run('structure.delete', { id })
    expect(store.records('maintenance').all().filter((m) => !m.deletedAt)).toHaveLength(0)
    expect(store.records('effect').get(effectId)!.target).toEqual({ kind: 'structures', ids: [] })
    bus.undo()
    expect(store.records('maintenance').all().filter((m) => !m.deletedAt)).toHaveLength(1)
    expect(store.records('effect').get(effectId)!.target).toEqual({ kind: 'structures', ids: [id] })
  })

  it('maintenance.set replaces a change at the same moment instead of stacking', () => {
    const id = place('builtin:house')
    run('maintenance.set', { structureId: id, at: year(1100), maintained: false })
    run('maintenance.set', { structureId: id, at: year(1100), maintained: true })
    expect(store.records('maintenance').all()).toHaveLength(1)
  })

  it('keeps a blueprint in use, and takes defaults from it', () => {
    const bp = run('blueprint.create', { ownerId: rootId, name: 'Hut', parts: [BUILTIN_BLUEPRINTS[2]!.parts[0]], maintainedByDefault: false, tags: ['hut'] }).targetId!
    const id = place(bp)
    expect(store.records('structure').get(id)).toMatchObject({ name: 'Hut', maintained: false, tags: ['hut'] })
    expect(() => run('blueprint.delete', { id: bp })).toThrow(/uses this blueprint/)
    expect(() => place('nope')).toThrow(/does not exist/)
    expect(() => run('blueprint.create', { ownerId: rootId, name: 'Empty' })).toThrow(/at least one part/)
  })
})

describe('built-in blueprints', () => {
  it('are valid, detailed, and the same every time', async () => {
    const { Blueprint } = await import('./structures')
    const { BUILTIN_BLUEPRINTS: again } = await import('./builtin-blueprints')
    for (const b of BUILTIN_BLUEPRINTS) {
      expect(() => Blueprint.parse(b), b.name).not.toThrow()
      expect(b.parts.every((p) => p.size.every((v) => v > 0 && Number.isFinite(v)) && p.at.every(Number.isFinite)), b.name).toBe(true)
    }
    const count = (id: string) => BUILTIN_BLUEPRINTS.find((b) => b.id === `builtin:${id}`)!.parts.length
    expect(count('castle')).toBeGreaterThan(80)
    expect(count('city')).toBeGreaterThan(500)
    expect(count('slum')).toBeGreaterThan(200)
    expect(new Set(BUILTIN_BLUEPRINTS.map((b) => b.id)).size).toBe(BUILTIN_BLUEPRINTS.length)
    expect(again).toBe(BUILTIN_BLUEPRINTS)
  })
})
