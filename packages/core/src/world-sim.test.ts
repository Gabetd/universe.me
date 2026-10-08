import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, createRootUniverse, ecosystemWarnings, orbitId, type OrbitFields } from './index'

let store: MemoryStore
let bus: CommandBus
let systemId: string
let planetId: string
let worldId: string
const run = (type: string, payload: object) => bus.execute({ type, payload } as never)

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const make = (parentId: string, kind: string) => run('node.create', { parentId, kind }).targetId!
  systemId = make(make(make(createRootUniverse(store, 'U').id, 'galaxy_cluster'), 'galaxy'), 'star_system')
  planetId = make(systemId, 'body')
  worldId = make(planetId, 'world')
})

const earth: OrbitFields = {
  semiMajorAxisKm: 149_597_870, eccentricity: 0.0167, inclinationDeg: 0, phaseDeg: 0, rotationHours: 23.934, axialTiltDeg: 23.44, massEarth: 1, radiusKm: 6371, monthNames: null
}

describe('stars and orbits', () => {
  it('are set once per owner, replaced in place, reset and restored with undo', () => {
    run('orbit.set', { bodyId: planetId, orbit: earth })
    run('orbit.set', { bodyId: planetId, orbit: { ...earth, axialTiltDeg: 40 } })
    expect(store.records('orbit').all()).toHaveLength(1)
    expect(store.records('orbit').get(orbitId(planetId))!.axialTiltDeg).toBe(40)
    bus.undo()
    expect(store.records('orbit').get(orbitId(planetId))!.axialTiltDeg).toBe(23.44)
    run('orbit.reset', { bodyId: planetId })
    expect(store.records('orbit').all()).toHaveLength(0)
    run('orbit.set', { bodyId: planetId, orbit: { ...earth, eccentricity: 0.2 } })
    expect(store.records('orbit').all()[0]!.eccentricity).toBe(0.2)
    bus.undo()
    expect(store.records('orbit').all()).toHaveLength(0)
    bus.undo()
    bus.undo()
    expect(store.records('orbit').all()).toHaveLength(0)
  })

  it('belong to the right kinds of node', () => {
    expect(() => run('orbit.set', { bodyId: worldId, orbit: earth })).toThrow(/planets and moons/)
    expect(() => run('star.set', { systemId: planetId, star: { massSun: 1, luminositySun: null } })).toThrow(/star system/)
    run('star.set', { systemId, star: { massSun: 2, luminositySun: null } })
    expect(store.records('star').all()[0]!.massSun).toBe(2)
  })
})

describe('species', () => {
  it('form a food web; deleting one takes its links, undo brings both back', () => {
    const grass = run('species.create', { ownerId: worldId, name: 'Grass', kind: 'flora', biomes: [5] }).targetId!
    const deer = run('species.create', { ownerId: worldId, name: 'Deer', biomes: [4] }).targetId!
    const wolf = run('species.create', { ownerId: worldId, name: 'Wolf', diet: 'carnivore', biomes: [4] }).targetId!
    expect(store.records('lifeform').get(grass)!.diet).toBe('producer')
    run('ecolink.create', { fromId: deer, toId: grass })
    run('ecolink.create', { fromId: wolf, toId: deer })
    expect(() => run('ecolink.create', { fromId: wolf, toId: deer })).toThrow(/already linked/)
    expect(() => run('ecolink.create', { fromId: wolf, toId: wolf })).toThrow(/itself/)
    const warnings = ecosystemWarnings(store.records('lifeform').all(), store.records('ecolink').all())
    expect(warnings.map((w) => w.message)).toEqual(['Deer eats Grass, but they never live in the same biome'])
    run('species.delete', { id: deer })
    expect(store.records('ecolink').all()).toHaveLength(0)
    bus.undo()
    expect(store.records('ecolink').all()).toHaveLength(2)
  })
})

describe('species catalogue', async () => {
  const { SPECIES_CATALOG, catalogFor } = await import('./index')
  it('only eats what it has, in a biome it shares', () => {
    const byName = new Map(SPECIES_CATALOG.map((s) => [s.name, s]))
    expect(byName.size).toBe(SPECIES_CATALOG.length)
    for (const s of SPECIES_CATALOG) {
      for (const food of s.eats) {
        const prey = byName.get(food)
        expect(prey, `${s.name} eats ${food}`).toBeDefined()
        expect(prey!.biomes.some((b) => s.biomes.includes(b)), `${s.name} meets ${food}`).toBe(true)
      }
    }
    expect(catalogFor([7]).map((s) => s.name)).toContain('Camel')
  })
})
