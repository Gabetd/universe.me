import { describe, expect, it } from 'vitest'
import { CommandBus, LANGUAGE_PRESETS, MemoryStore, createRootUniverse, languageAt, nameIn, wordIn, type Command } from './index'

const common = LANGUAGE_PRESETS.Common!
const desert = LANGUAGE_PRESETS.Desert!

describe('a language’s words', () => {
  it('are the same every time for the same thing, differ from thing to thing, and use only the language’s sounds', () => {
    expect(wordIn(common, 'river-1')).toBe(wordIn(common, 'river-1'))
    const words = new Set(Array.from({ length: 40 }, (_, i) => wordIn(common, `thing-${i}`)))
    expect(words.size).toBeGreaterThan(30)
    for (const w of words) expect(w[0]).toBe(w[0]!.toUpperCase())
    // A language of only "t" and "a" makes words of only those.
    const tiny = { ...common, consonants: ['t'], vowels: ['a'], syllables: ['CV'], endings: [] }
    for (let i = 0; i < 20; i++) expect(wordIn(tiny, `x${i}`).toLowerCase()).toMatch(/^[ta]+$/)
  })

  it('name each kind of thing by its rule', () => {
    expect(nameIn(desert, 'river', 'r1')).toMatch(/^Wadi \S+$/)
    expect(nameIn(desert, 'faction', 'f1')).toMatch(/^Banu \S+$/)
    expect(nameIn(common, 'faction', 'f1', 'Guild')).toMatch(/^The \S+ Guild$/)
    expect(nameIn(common, 'lake', 'l1')).toMatch(/^Lake \S+$/)
    // The same thing named as a river and as a lake gets different words.
    expect(nameIn(common, 'river', 'x').split(' ')[0]).not.toBe(nameIn(common, 'lake', 'x').split(' ')[1])
  })
})

describe('languages in a project', () => {
  const setup = () => {
    const store = new MemoryStore()
    let n = 0
    const bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
    const run = (type: string, payload: object) => bus.execute({ type, payload } as Command)
    const root = createRootUniverse(store, 'U').id
    const ids: Record<string, string> = { universe: root }
    let parent = root
    for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world']) parent = ids[kind] = run('node.create', { parentId: parent, kind, name: kind }).targetId!
    return { store, bus, run, root, ids }
  }

  it('are made from presets, spoken by nodes and regions, and the one in force is the nearest: a region’s, else the node’s or its parents’', () => {
    const { store, run, root, ids } = setup()
    const elvish = run('language.create', { ownerId: root, preset: 'Elvish' }).targetId!
    const dwarvish = run('language.create', { ownerId: root, preset: 'Dwarvish', name: 'Under-tongue' }).targetId!
    expect(store.records('language').get(dwarvish)).toMatchObject({ name: 'Under-tongue', rules: LANGUAGE_PRESETS.Dwarvish!.rules })
    const world = ids.world!
    const region = run('region.create', { worldId: world, name: 'Deeps', color: '#555555', points: [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 5 }] }).targetId!
    run('languageUse.create', { ownerId: ids.galaxy, languageId: elvish })
    run('languageUse.create', { ownerId: world, regionId: region, languageId: dwarvish })
    const at = (nodeId: string, regionIds: string[] = []) =>
      languageAt({ nodeId, regionIds }, store.records('languageUse').all(), store.records('language').all(), (id) => store.nodes.get(id)?.parentId)?.name
    expect(at(world)).toBe('Elvish')
    expect(at(world, [region])).toBe('Under-tongue')
    expect(at(ids.body!)).toBe('Elvish')
    expect(at(root)).toBeUndefined()
    // One a place: another there is refused; changing it is an update.
    expect(() => run('languageUse.create', { ownerId: ids.galaxy, languageId: dwarvish })).toThrow(/already spoken/)
    // A region's language is only a world's.
    expect(() => run('languageUse.create', { ownerId: ids.body, regionId: region, languageId: dwarvish })).toThrow()
  })

  it('take their uses with them when deleted, and come back with them on undo', () => {
    const { store, bus, run, root, ids } = setup()
    const lang = run('language.create', { ownerId: root, preset: 'Northern' }).targetId!
    run('languageUse.create', { ownerId: ids.world, languageId: lang })
    run('language.delete', { id: lang })
    expect(store.records('languageUse').all()).toEqual([])
    bus.undo()
    expect(store.records('languageUse').all()).toHaveLength(1)
    expect(() => run('language.create', { ownerId: root, preset: 'Klingon' })).toThrow(/no Klingon/)
    expect(() => run('language.update', { id: lang, patch: { rules: { ...LANGUAGE_PRESETS.Common!.rules, river: 'River' } } })).toThrow()
  })
})
