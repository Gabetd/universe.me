import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, createRootUniverse, fromParts, lawSpan, lawStatus, lawWarnings, lawsOver, type Law } from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string
const year = (y: number) => fromParts({ year: y })
const run = (type: string, payload: object) => bus.execute({ type, payload } as never)
const law = (id: string) => store.records('law').get(id)!
const live = <K extends 'law' | 'era' | 'faction' | 'membership' | 'event'>(kind: K) => store.records(kind).all()
const context = () => ({ eras: live('era'), factions: live('faction'), memberships: live('membership'), events: live('event') })

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const make = (parentId: string, kind: string) => run('node.create', { parentId, kind }).targetId!
  worldId = make(make(make(make(make(createRootUniverse(store, 'U').id, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body'), 'world')
})

describe('laws of eras and factions', () => {
  it('are in force within their era or faction, from enactment until repeal', () => {
    const era = run('era.create', { ownerId: worldId, name: 'Age of Iron', start: year(1000), end: year(1200) }).targetId!
    const kingdom = run('faction.create', { ownerId: worldId, name: 'Arn', kind: 'kingdom', start: year(1050), end: year(1300) }).targetId!
    const curfew = run('law.create', { scope: { kind: 'era', eraId: era }, name: 'The iron curfew', kind: 'custom' }).targetId!
    const tithe = run('law.create', { scope: { kind: 'faction', factionId: kingdom }, name: 'The tithe', kind: 'trade', start: year(1100), end: year(1150), penalty: 'A tenth more' }).targetId!
    expect(law(curfew)).toMatchObject({ ownerId: worldId, kind: 'custom', start: null, end: null, summary: '', penalty: '' })
    expect(law(tithe)).toMatchObject({ ownerId: worldId, penalty: 'A tenth more' })

    // Open-ended, an era's law lasts as long as the era; a faction's own dates hold inside the faction's.
    expect(lawSpan(law(curfew), context())).toEqual({ start: year(1000), end: year(1200) })
    expect(lawSpan(law(tithe), context())).toEqual({ start: year(1100), end: year(1150) })
    expect(lawStatus(law(curfew), year(999), context())).toBe('not yet')
    expect(lawStatus(law(curfew), year(1100), context())).toBe('in force')
    expect(lawStatus(law(curfew), year(1250), context())).toBe('repealed')
    expect(lawStatus(law(tithe), year(1149), context())).toBe('in force')
    expect(lawStatus(law(tithe), year(1150), context())).toBe('repealed')

    run('law.update', { id: tithe, patch: { end: null } })
    expect(lawSpan(law(tithe), context()).end).toBe(year(1300))
    bus.undo()
    expect(law(tithe).end).toBe(year(1150))
    expect(() => run('law.update', { id: tithe, patch: { end: year(1000) } })).toThrow(/repealed before it’s enacted/)
    expect(() => run('law.create', { scope: { kind: 'faction', factionId: 'nobody' }, name: 'X' })).toThrow()
  })

  it('reach a character through every faction they’re in, and the factions those are part of', () => {
    const era = run('era.create', { ownerId: worldId, name: 'Age of Iron', start: year(1000), end: year(1200) }).targetId!
    const kingdom = run('faction.create', { ownerId: worldId, name: 'Arn', kind: 'kingdom' }).targetId!
    const house = run('faction.create', { ownerId: worldId, name: 'House Vell', kind: 'house', parentId: kingdom }).targetId!
    const guild = run('faction.create', { ownerId: worldId, name: 'Smiths', kind: 'guild' }).targetId!
    const ada = run('character.create', { ownerId: worldId, name: 'Ada', born: year(1080) }).targetId!
    run('membership.create', { factionId: house, characterId: ada, start: year(1100) })
    run('law.create', { scope: { kind: 'era', eraId: era }, name: 'The iron curfew' })
    run('law.create', { scope: { kind: 'faction', factionId: kingdom }, name: 'The king’s peace' })
    run('law.create', { scope: { kind: 'faction', factionId: guild }, name: 'The guild mark' })
    const over = (t: number) => lawsOver({ id: ada }, t, live('law'), context()).map(({ law, from }) => `${law.name} (${from.name})`)
    expect(over(year(1090))).toEqual(['The iron curfew (Age of Iron)'])
    expect(over(year(1110))).toEqual(['The iron curfew (Age of Iron)', 'The king’s peace (Arn)'])
  })

  it('go with their era or faction, and lose a deleted event as their cause', () => {
    const era = run('era.create', { ownerId: worldId, name: 'Age of Iron', start: year(1000), end: year(1200) }).targetId!
    const kingdom = run('faction.create', { ownerId: worldId, name: 'Arn' }).targetId!
    const decree = run('event.create', { ownerId: worldId, title: 'The decree', start: year(1100) }).targetId!
    const curfew = run('law.create', { scope: { kind: 'era', eraId: era }, name: 'The iron curfew', start: year(1100), startEventId: decree }).targetId!
    run('law.create', { scope: { kind: 'faction', factionId: kingdom }, name: 'The king’s peace' })
    run('event.delete', { id: decree })
    expect(law(curfew).startEventId).toBeNull()
    bus.undo()
    expect(law(curfew).startEventId).toBe(decree)
    run('era.delete', { id: era })
    run('faction.delete', { id: kingdom })
    expect(live('law')).toEqual([])
    bus.undo()
    bus.undo()
    expect(live('law').map((l: Law) => l.name).sort()).toEqual(['The iron curfew', 'The king’s peace'])
  })

  it('are flagged when enacted outside their era or faction, or away from the event said to enact them', () => {
    const era = run('era.create', { ownerId: worldId, name: 'Age of Iron', start: year(1000), end: year(1200) }).targetId!
    const kingdom = run('faction.create', { ownerId: worldId, name: 'Arn', start: year(1050) }).targetId!
    const decree = run('event.create', { ownerId: worldId, title: 'The decree', start: year(1100) }).targetId!
    run('law.create', { scope: { kind: 'era', eraId: era }, name: 'The old oath', start: year(900) })
    run('law.create', { scope: { kind: 'faction', factionId: kingdom }, name: 'The tithe', start: year(1040) })
    run('law.create', { scope: { kind: 'era', eraId: era }, name: 'The curfew', start: year(1120), startEventId: decree })
    run('law.create', { scope: { kind: 'era', eraId: era }, name: 'The good law', start: year(1100), startEventId: decree })
    expect(lawWarnings(live('law'), context()).map((w) => w.message)).toEqual([
      'The old oath is enacted before the Age of Iron begins',
      'The tithe is enacted before Arn begins',
      'The curfew is enacted outside the time of “The decree”, its cause'
    ])
  })
})
