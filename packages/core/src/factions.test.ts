import { beforeEach, describe, expect, it } from 'vitest'
import {
  CommandBus, MemoryStore, createRootUniverse, factionWarnings, factionsOf, fromParts, holdersAt, holdsAt, membersAt, relationLabel, relationshipsAt, territoryAt, type Command
} from './index'

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
const faction = (name: string, extra: object = {}) => run('faction.create', { ownerId: worldId, name, ...extra }).targetId!
const person = (name: string, born = 0) => run('character.create', { ownerId: worldId, name, born: year(born) }).targetId!
const region = (name: string) =>
  run('region.create', { worldId, name, points: [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, { lat: 1, lon: 1 }] }).targetId!
const event = (title: string, at: number) => run('event.create', { ownerId: worldId, title, start: year(at) }).targetId!
const all = <K extends 'faction' | 'membership' | 'holding' | 'relationship'>(kind: K) => store.records(kind).all()

describe('factions', () => {
  it('are created on a world, with a span from founding to dissolution, and undo', () => {
    const varn = faction('Varn', { kind: 'kingdom', start: year(400), end: year(1300) })
    expect(store.records('faction').get(varn)).toMatchObject({ name: 'Varn', kind: 'kingdom', parentId: null, emblem: '' })
    expect(holdsAt(store.records('faction').get(varn)!, year(399))).toBe(false)
    expect(holdsAt(store.records('faction').get(varn)!, year(1299))).toBe(true)
    expect(holdsAt(store.records('faction').get(varn)!, year(1300))).toBe(false)
    expect(() => faction('Backwards', { start: year(10), end: year(5) })).toThrow(/dissolved before/)
    expect(() => run('faction.create', { ownerId: store.nodes.get(worldId)!.parentId })).toThrow(/not a world/)
    bus.undo()
    expect(all('faction')).toHaveLength(0)
  })

  it('can be part of another, but never of themselves', () => {
    const kingdom = faction('Varn')
    const house = faction('House Aldric', { parentId: kingdom })
    expect(() => run('faction.update', { id: kingdom, patch: { parentId: house } })).toThrow(/already part/)
    expect(() => run('faction.update', { id: kingdom, patch: { parentId: kingdom } })).toThrow(/part of itself/)
    run('faction.delete', { id: kingdom })
    expect(store.records('faction').get(house)!.parentId).toBeNull()
    bus.undo()
    expect(store.records('faction').get(house)!.parentId).toBe(kingdom)
  })

  it('have members over time, and a character the factions they belong to', () => {
    const varn = faction('Varn', { start: year(400) })
    const guild = faction('Lamplighters')
    const aldric = person('Aldric', 380)
    run('membership.create', { factionId: varn, characterId: aldric, role: 'king', start: year(410), end: year(460) })
    run('membership.create', { factionId: guild, characterId: aldric })
    const fs = all('faction')
    const ms = all('membership')
    expect(membersAt(fs.find((f) => f.id === varn)!, ms, year(420)).map((m) => m.role)).toEqual(['king'])
    expect(membersAt(fs.find((f) => f.id === varn)!, ms, year(470))).toEqual([])
    expect(factionsOf(aldric, fs, ms, year(420)).map((f) => f.name)).toEqual(['Varn', 'Lamplighters'])
    expect(factionsOf(aldric, fs, ms, year(390)).map((f) => f.name)).toEqual(['Lamplighters'])
    expect(() => run('membership.create', { factionId: varn, characterId: aldric, start: year(5), end: year(1) })).toThrow(/end before/)
  })

  it('hold regions: the most specific holder wins, then the latest', () => {
    const varn = faction('Varn')
    const house = faction('House Aldric', { parentId: varn })
    const greywood = faction('Greywood clans')
    const north = region('North')
    const south = region('South')
    run('holding.create', { factionId: varn, regionId: north })
    run('holding.create', { factionId: varn, regionId: south, end: year(1200) })
    run('holding.create', { factionId: greywood, regionId: south, start: year(1200) })
    run('holding.create', { factionId: house, regionId: north, start: year(900) })
    const fs = all('faction')
    const hs = all('holding')
    const at = (y: number) => Object.fromEntries([...holdersAt(fs, hs, year(y))].map(([r, f]) => [r, f.name]))
    expect(at(800)).toEqual({ [north]: 'Varn', [south]: 'Varn' })
    expect(at(1000)).toEqual({ [north]: 'House Aldric', [south]: 'Varn' })
    expect(at(1200)).toEqual({ [north]: 'House Aldric', [south]: 'Greywood clans' })
    const varnAt = (y: number) => territoryAt(fs.find((f) => f.id === varn)!, fs, hs, year(y)).sort()
    expect(varnAt(1000)).toEqual([north, south].sort())
    expect(varnAt(1300)).toEqual([north])
  })

  it('relate characters and factions, read from either side', () => {
    const mother = person('Isolde')
    const son = person('Aldric', 380)
    const varn = faction('Varn')
    const clans = faction('Greywood clans')
    const birth = run('relationship.create', { ownerId: worldId, from: { kind: 'character', id: mother }, to: { kind: 'character', id: son }, type: 'parent' }).targetId!
    run('relationship.create', { ownerId: worldId, from: { kind: 'faction', id: varn }, to: { kind: 'faction', id: clans }, type: 'enemy', start: year(1100), end: year(1250) })
    const rel = store.records('relationship').get(birth)!
    expect(relationLabel(rel, { kind: 'character', id: mother })).toBe('Child')
    expect(relationLabel(rel, { kind: 'character', id: son })).toBe('Parent')
    expect(relationLabel({ ...rel, label: 'Foster mother' }, { kind: 'character', id: son })).toBe('Foster mother')
    expect(relationshipsAt(all('relationship'), year(1000)).map((r) => r.type)).toEqual(['parent'])
    expect(relationshipsAt(all('relationship'), year(1200), { kind: 'faction', id: clans }).map((r) => r.type)).toEqual(['enemy'])
    expect(() => run('relationship.create', { ownerId: worldId, from: { kind: 'character', id: son }, to: { kind: 'character', id: son }, type: 'friend' })).toThrow(/two sides/)
    expect(() => run('relationship.create', { ownerId: worldId, from: { kind: 'character', id: son }, to: { kind: 'faction', id: 'missing' }, type: 'ally' })).toThrow()
  })

  it('go with what they’re about: a deleted character or faction takes its memberships, holdings, relationships and part in events, and undo brings them back', () => {
    const varn = faction('Varn')
    const aldric = person('Aldric')
    const isolde = person('Isolde')
    const north = region('North')
    run('membership.create', { factionId: varn, characterId: aldric })
    run('holding.create', { factionId: varn, regionId: north })
    run('relationship.create', { ownerId: worldId, from: { kind: 'character', id: isolde }, to: { kind: 'character', id: aldric }, type: 'parent' })
    run('relationship.create', { ownerId: worldId, from: { kind: 'faction', id: varn }, to: { kind: 'character', id: isolde }, type: 'liege' })
    const crowning = event('Crowning', 410)
    run('event.update', { id: crowning, patch: { participants: [{ kind: 'character', id: aldric }, { kind: 'faction', id: varn }] } })

    run('character.delete', { id: aldric })
    expect([all('membership').length, all('relationship').length]).toEqual([0, 1])
    expect(store.records('event').get(crowning)!.participants).toEqual([{ kind: 'faction', id: varn }])
    bus.undo()
    expect([all('membership').length, all('relationship').length]).toEqual([1, 2])
    expect(store.records('event').get(crowning)!.participants).toHaveLength(2)

    run('faction.delete', { id: varn })
    expect([all('membership').length, all('holding').length, all('relationship').length]).toEqual([0, 0, 1])
    expect(store.records('event').get(crowning)!.participants).toEqual([{ kind: 'character', id: aldric }])
    bus.undo()
    expect([all('membership').length, all('holding').length, all('relationship').length]).toEqual([1, 1, 2])
  })

  it('name the events that began and ended them, forgotten when an event goes', () => {
    const war = event('The Greywood War', 1100)
    const peace = event('The Peace of Kingsbridge', 1250)
    const varn = faction('Varn', { start: year(400), startEventId: war })
    const clans = faction('Greywood clans')
    const enmity = run('relationship.create', {
      ownerId: worldId, from: { kind: 'faction', id: varn }, to: { kind: 'faction', id: clans }, type: 'enemy', start: year(1100), end: year(1250), startEventId: war, endEventId: peace
    }).targetId!
    run('event.delete', { id: war })
    expect(store.records('relationship').get(enmity)).toMatchObject({ startEventId: null, endEventId: peace })
    expect(store.records('faction').get(varn)!.startEventId).toBeNull()
    bus.undo()
    expect(store.records('relationship').get(enmity)!.startEventId).toBe(war)
    expect(() => run('faction.update', { id: varn, patch: { endEventId: 'missing' } })).toThrow()
  })

  it('only take part in events, join factions and relate on their own world', () => {
    const elsewhere = bus.execute({ type: 'node.create', payload: { parentId: store.nodes.get(worldId)!.parentId!, kind: 'body' } }).targetId!
    const far = bus.execute({ type: 'node.create', payload: { parentId: elsewhere, kind: 'world' } }).targetId!
    const stranger = run('character.create', { ownerId: far, name: 'Stranger', born: 0 }).targetId!
    const varn = faction('Varn')
    expect(() => run('membership.create', { factionId: varn, characterId: stranger })).toThrow(/another world/)
    expect(() => run('relationship.create', { ownerId: worldId, from: { kind: 'faction', id: varn }, to: { kind: 'character', id: stranger }, type: 'ally' })).toThrow(/another world/)
    const e = event('Feast', 1)
    expect(() => run('event.update', { id: e, patch: { participants: [{ kind: 'character', id: stranger }] } })).toThrow(/another world/)
  })

  it('warn of what can’t be: a member before they’re born or before the faction’s founded, a region held twice, friends who are enemies, a span off its cause', () => {
    const varn = faction('Varn', { start: year(400) })
    const clans = faction('Greywood clans')
    const house = faction('House Aldric', { parentId: varn })
    const aldric = person('Aldric', 380)
    const north = region('North')
    const crowning = event('Crowning', 410)
    run('membership.create', { factionId: varn, characterId: aldric, start: year(370) })
    run('membership.create', { factionId: clans, characterId: aldric, start: year(390) })
    run('holding.create', { factionId: varn, regionId: north })
    run('holding.create', { factionId: house, regionId: north })
    run('holding.create', { factionId: clans, regionId: north, start: year(1000) })
    const party = (id: string) => ({ kind: 'faction', id })
    run('relationship.create', { ownerId: worldId, from: party(varn), to: party(clans), type: 'ally', start: year(900), end: year(1100) })
    run('relationship.create', { ownerId: worldId, from: party(clans), to: party(varn), type: 'enemy', start: year(1050) })
    run('faction.update', { id: varn, patch: { startEventId: crowning } })
    const messages = factionWarnings(
      { factions: all('faction'), memberships: all('membership'), holdings: all('holding'), relationships: all('relationship'), characters: store.records('character').all(), events: store.records('event').all() },
      store.regions.all()
    ).map((w) => w.message)
    expect(messages).toEqual([
      'Aldric joins Varn before they’re born',
      'Aldric is in Varn before it’s founded',
      'North is held by both Varn and Greywood clans at once',
      'North is held by both House Aldric and Greywood clans at once',
      'Varn and Greywood clans are allies and enemies at once',
      'Varn begins outside the time of “Crowning”, its cause'
    ])
  })
})
