import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fromParts } from '@universe/core'
import { OPERATIONS } from './index'
import { testProject } from './test-project'

let p: ReturnType<typeof testProject>
beforeEach(() => (p = testProject()))
afterEach(() => p.close())

describe('the operations', () => {
  it('have unique names, a route each, and only POST routes write', () => {
    expect(new Set(OPERATIONS.map((o) => o.name)).size).toBe(OPERATIONS.length)
    expect(new Set(OPERATIONS.map((o) => `${o.route.method} ${o.route.path}`)).size).toBe(OPERATIONS.length)
    for (const o of OPERATIONS) {
      expect(o.route.method === 'POST', o.name).toBe(!!o.write)
      for (const param of o.route.path.matchAll(/:(\w+)/g)) expect(Object.keys(o.input.shape), `${o.name} :${param[1]}`).toContain(param[1])
    }
  })

  it('list worlds and the universe tree', async () => {
    const { worlds, project } = await p.call<{ worlds: { id: string; path: string }[]; project: string }>('list_worlds')
    expect(project).toBe('Test')
    expect(worlds).toEqual([expect.objectContaining({ id: p.worldId, path: 'Virgo › Milky Way › Sol › Terra › Terra Surface', now: '0' })])
    const tree = await p.call<{ children: { name: string }[] }>('get_tree', { depth: 2 })
    expect(tree.children[0]!.name).toBe('Virgo')
  })

  it('write a history in readable dates: events, links, groups and the chain they make', async () => {
    const fall = await p.call<{ status: string; eventId: string }>('create_event', { worldId: p.worldId, title: 'The fall of Tarn', start: '1204', notes: 'The walls gave way.\n\nNo one returned.', tags: ['war'] })
    expect(fall.status).toBe('applied')
    const flight = await p.call<{ eventId: string }>('create_event', { worldId: p.worldId, title: 'The flight north', start: '1205', end: 1210, lane: 'Peoples' })
    await p.call('link_events', { fromId: fall.eventId, toId: flight.eventId, type: 'causes' })
    await p.call('group_events', { title: 'The Tarn War', eventIds: [fall.eventId, flight.eventId] })

    const { events } = await p.call<{ events: { title: string; when: string; group?: string; lane?: string }[] }>('list_events', { worldId: p.worldId, from: '1200', to: '1300' })
    expect(events.map((e) => [e.title, e.when, e.group])).toEqual([
      ['The fall of Tarn', '1204', 'The Tarn War'],
      ['The flight north', '1205 – 1210', 'The Tarn War']
    ])
    expect(events[1]!.lane).toBe('Peoples')
    const event = await p.call<{ notes: string; links: object[] }>('get_event', { eventId: fall.eventId })
    expect(event.notes).toBe('The walls gave way.\n\nNo one returned.')
    expect(event.links).toEqual([expect.objectContaining({ this: 'causes', event: 'The flight north' })])
    const chain = await p.call<{ chain: { title: string }[] }>('get_event_chain', { eventId: fall.eventId })
    expect(chain.chain.map((e) => e.title)).toEqual(['The flight north'])
    // Every write is the AI's, and undoes in one step.
    p.project.bus.undo()
    expect(p.project.snapshot().timeline.groups).toHaveLength(0)
    expect((await p.call<{ count: number }>('search', { q: 'walls' })).count).toBe(1)
  })

  it('build, weather and project the decay of structures', async () => {
    const { structureId } = await p.call<{ structureId: string }>('create_structure', {
      worldId: p.worldId,
      name: 'The Old Keep',
      blueprint: 'stone castle',
      builtAt: '1000',
      place: { lat: 10, lon: 20 },
      maintained: true
    })
    const burn = await p.call<{ eventId: string }>('create_event', { worldId: p.worldId, title: 'The keep burns', start: '1300', places: [{ lat: 10, lon: 20 }] })
    await p.call('add_event_effect', { eventId: burn.eventId, type: 'damage', amount: 40, radiusKm: 5, falloff: false })
    await p.call('set_maintenance', { structureId, at: '1300', maintained: false, causeEventId: burn.eventId })

    const at1200 = await p.call<{ structures: { name: string; stage: string; maintained: boolean }[] }>('list_structures', { worldId: p.worldId, at: '1200' })
    expect(at1200.structures).toEqual([expect.objectContaining({ name: 'The Old Keep', stage: 'Pristine', maintained: true })])
    const condition = await p.call<{ condition: number; history: { what: string; because?: string }[] }>('get_structure_condition', { structureId, at: '1301' })
    expect(condition.condition).toBeLessThan(70)
    // Both happen in 1300, in the engine's order.
    expect(condition.history.map((h) => h.what).sort()).toEqual(['build', 'damage', 'left to weather from then on'])
    expect(condition.history.find((h) => h.what === 'damage')!.because).toBe('The keep burns')
    const decay = await p.call<{ ruin: string; erodedAway: string }>('project_decay', { structureId, from: '1301' })
    expect(Number(decay.ruin)).toBeGreaterThan(1301)
    expect(Number(decay.erodedAway)).toBeGreaterThan(Number(decay.ruin))
    const snapshot = await p.call<{ structures: { name: string }[]; date: string }>('get_world_snapshot', { worldId: p.worldId, at: '1250' })
    expect(snapshot.structures.map((s) => s.name)).toEqual(['The Old Keep'])
  })

  it('know the world’s ages: themes in force, characters alive, species and their food web', async () => {
    const { themeId } = await p.call<{ themeId: string }>('create_theme', { name: 'The Long Winter', preset: 'Ice Age', style: 'Short, cold sentences.' })
    await p.call('assign_theme_span', { worldId: p.worldId, themeId, start: '900', end: '1100', fadeInYears: 10 })
    const theme = await p.call<{ theme: { dominant: { name: string; style: string } } }>('get_theme_at', { worldId: p.worldId, at: '1000' })
    expect(theme.theme.dominant).toMatchObject({ name: 'The Long Winter', style: 'Short, cold sentences.' })
    expect((await p.call<{ theme: unknown }>('get_theme_at', { worldId: p.worldId, at: '1200' })).theme).toBeNull()

    await p.call('create_character', { worldId: p.worldId, name: 'Ilse', born: '980', died: '1040', place: { lat: 0, lon: 0 } })
    const { characters } = await p.call<{ characters: { name: string; age: number; alive: boolean }[] }>('list_characters', { worldId: p.worldId, at: '1000' })
    expect(characters).toEqual([expect.objectContaining({ name: 'Ilse', alive: true, age: 20 })])

    const grass = await p.call<{ speciesId: string }>('create_species', { worldId: p.worldId, name: 'Frostgrass', kind: 'flora', diet: 'producer', biomes: ['Tundra'] })
    await p.call('create_species', { worldId: p.worldId, name: 'Snow hare', kind: 'fauna', diet: 'herbivore', biomes: ['Tundra'], eats: [grass.speciesId] })
    const eco = await p.call<{ links: object[]; species: { biomes: string[] }[] }>('get_ecosystem', { worldId: p.worldId, biome: 'tundra' })
    expect(eco.species[0]!.biomes).toEqual(['Tundra'])
    expect(eco.links).toEqual([{ id: expect.any(String), from: 'Snow hare', type: 'eats', to: 'Frostgrass' }])
    await expect(p.call('create_species', { worldId: p.worldId, name: 'X', kind: 'flora', diet: 'producer', biomes: ['Moon'] })).rejects.toThrow(/no biome “Moon”/)
  })

  it('make star systems and worlds, read their sky, and write a world bible', async () => {
    const { systemId } = await p.call<{ systemId: string }>('create_star_system', { galaxyId: p.galaxyId, name: 'Vega', massSun: 2 })
    const { worldId } = await p.call<{ worldId: string }>('create_world', { systemId, name: 'Arda', distanceAu: 4, seed: 'arda' })
    const sys = await p.call<{ star: { massSun: number }; bodies: { name: string; world?: { id: string } }[] }>('get_star_system', { nodeId: worldId })
    expect(sys.star.massSun).toBe(2)
    expect(sys.bodies.map((b) => [b.name, b.world?.id])).toEqual([['Arda', worldId]])
    const world = await p.call<{ surface: { seed: string }; climate: { distanceAu: number } }>('get_world', { worldId })
    expect(world.surface.seed).toBe('arda')
    expect(world.climate.distanceAu).toBe(4)

    await p.call('create_event', { worldId, title: 'First light', start: '1' })
    await p.call('update_note', { id: worldId, text: 'A cold world.' })
    await p.call('update_note', { id: worldId, text: 'Its people live underground.', mode: 'append' })
    const md = await p.call<string>('export_world_bible', { worldId })
    expect(md).toContain('# Arda Surface')
    expect(md).toContain('A cold world.\n\nIts people live underground.')
    expect(md).toContain('### 1: First light')
    await p.call('create_event', { worldId, title: 'The *star*\nfalls', start: '2' })
    expect(await p.call<string>('export_world_bible', { worldId })).toContain('### 2: The \\*star\\* falls')
    // The bible goes into wikis and editors that render HTML: what's in a note is text there, never HTML, a link or a heading of its own.
    await p.call('update_note', { id: worldId, text: '<img src=x onerror=alert(1)> [x](javascript:alert(1))\n\n# Not a heading', mode: 'append' })
    const safe = await p.call<string>('export_world_bible', { worldId })
    expect(safe).toContain('\\<img src=x onerror=alert(1)\\> \\[x\\](javascript:alert(1))')
    expect(safe).toContain('\n\\# Not a heading')
    expect(safe).not.toMatch(/(^|[^\\])<img/)
    const json = await p.call<{ history: object[] }>('export_world_bible', { worldId, format: 'json' })
    expect(json.history).toHaveLength(2)
  })

  it('describe how a world’s powers work, age by age, in the snapshot and the bible too', async () => {
    const era = (name: string, start: number, end: number) => p.project.bus.execute({ type: 'era.create', payload: { ownerId: p.worldId, name, start: fromParts({ year: start }), end: fromParts({ year: end }) } })
    era('Age of Wonders', 0, 500)
    era('Age of Silence', 500, 1000)
    const { systemId } = await p.call<{ systemId: string }>('create_power_system', {
      worldId: p.worldId,
      kind: 'magic',
      name: 'The Weave',
      summary: 'Song made into force',
      always: { source: 'Starlight', 'Price paid': 'A year of life per great working' }
    })
    // The age by name, a question it didn't ask yet, and what's left unsaid stays.
    await p.call('describe_power_age', { systemId, era: 'age of silence', strength: 0.1, changes: { Rules: 'Only the dying can weave', Omens: 'Silver rain' } })
    await p.call('describe_power_age', { systemId, era: 'Age of Silence', summary: 'Almost forgotten' })
    await expect(p.call('describe_power_age', { systemId, era: 'Age of Iron' })).rejects.toThrow(/its eras: Age of Wonders, Age of Silence/)

    const { systems } = await p.call<{ systems: { name: string; questions: string[]; always: object; ages: object[]; atThatMoment: object }[] }>('list_power_systems', { worldId: p.worldId, at: '700' })
    const weave = systems[0]!
    expect(weave.questions).toEqual(expect.arrayContaining(['Source', 'Rules', 'Price paid', 'Omens']))
    expect(weave.always).toEqual({ Source: 'Starlight', 'Price paid': 'A year of life per great working' })
    expect(weave.ages).toEqual([{ era: 'Age of Silence', eraId: expect.any(String), when: '500 – 1000', summary: 'Almost forgotten', strength: 0.1, changes: { Rules: 'Only the dying can weave', Omens: 'Silver rain' } }])
    expect(weave.atThatMoment).toMatchObject({ age: 'Age of Silence', strength: 0.1, howItWorks: { Source: 'Starlight', Rules: 'Only the dying can weave' } })

    await p.call('update_power_system', { systemId, always: { Source: 'Moonlight', 'Price paid': '' } })
    const snapshot = await p.call<{ powers: { howItWorks: Record<string, string> }[] }>('get_world_snapshot', { worldId: p.worldId, at: '100' })
    expect(snapshot.powers[0]!.howItWorks).toEqual({ Source: 'Moonlight' })
    const md = await p.call<string>('export_world_bible', { worldId: p.worldId })
    expect(md).toContain('## Power systems\n\n### The Weave\n\n*Song made into force*\n\n**Source:** Moonlight')
    expect(md).toContain('#### In Age of Silence (500 – 1000), 10% strength\n\n*Almost forgotten*\n\n**Rules:** Only the dying can weave')
  })

  it('found factions, give them members and land, relate people and factions, and read it all at a moment and in the bible', async () => {
    const w = { worldId: p.worldId }
    const person = async (name: string, born: string) => (await p.call<{ characterId: string }>('create_character', { ...w, name, born, place: { lat: 0, lon: 0 } })).characterId
    const [aldric, edda, maelis] = [await person('Aldric', '390'), await person('Edda', '424'), await person('Maelis', '950')]
    const { regionId } = await p.call<{ regionId: string }>('create_region', { ...w, name: 'Varn', points: [{ lat: 0, lon: 0 }, { lat: 5, lon: 0 }, { lat: 5, lon: 5 }] })
    const { eventId: crowned } = await p.call<{ eventId: string }>('create_event', { ...w, title: 'The crowning', start: '421' })
    const { factionId: kingdom } = await p.call<{ factionId: string }>('create_faction', { ...w, name: 'Varn', kind: 'kingdom', foundedBy: crowned, emblem: '👑' })
    const { factionId: house } = await p.call<{ factionId: string }>('create_faction', { ...w, name: 'House Aldric', kind: 'house', partOf: 'varn' })
    const { factionId: clans } = await p.call<{ factionId: string }>('create_faction', { ...w, name: 'Greywood', kind: 'clan' })
    await p.call('hold_region', { factionId: house, regionId, from: '430' })
    await p.call('add_member', { factionId: house, characterId: aldric, role: 'king', fromEventId: crowned, until: '452' })
    await p.call('set_relationship', { fromId: aldric, toId: edda, type: 'parent' })
    await p.call('set_relationship', { fromId: kingdom, toId: clans, type: 'enemy', from: '980', until: '995' })
    await p.call('update_event', { eventId: crowned, who: [aldric, kingdom] })

    type Faction = { name: string; exists: boolean; founded?: string; partOf?: string; members?: { name: string; role?: string }[]; territory?: string[]; relationships?: { with: string; is: string }[] }
    const at = async (when: string) => (await p.call<{ factions: Faction[] }>('list_factions', { ...w, at: when })).factions
    expect((await at('400')).find((f) => f.name === 'Varn')).toMatchObject({ exists: false, founded: '421' })
    const in440 = await at('440')
    expect(in440.find((f) => f.name === 'House Aldric')).toMatchObject({ partOf: 'Varn', members: [{ name: 'Aldric', role: 'king' }], territory: ['Varn'] })
    // A kingdom holds what its houses hold.
    expect(in440.find((f) => f.name === 'Varn')!.territory).toEqual(['Varn'])
    expect((await at('990')).find((f) => f.name === 'Varn')!.relationships).toEqual([expect.objectContaining({ with: 'Greywood', is: 'Enemy' })])
    const { relationships } = await p.call<{ relationships: { with: string; is: string }[] }>('get_relationships', { ...w, at: '500', of: edda })
    expect(relationships).toEqual([expect.objectContaining({ with: 'Aldric', is: 'Parent' })])
    const snapshot = await p.call<{ factions: { name: string }[]; happening: object[] }>('get_world_snapshot', { ...w, at: '440' })
    expect(snapshot.factions.map((f) => f.name).sort()).toEqual(['Greywood', 'House Aldric', 'Varn'])
    const { events } = await p.call<{ events: { title: string; who?: string[] }[] }>('list_events', { ...w, from: '400', to: '500' })
    expect(events[0]!.who).toEqual(['Aldric', 'Varn'])
    const bible = await p.call<string>('export_world_bible', w)
    expect(bible).toContain('## Factions')
    expect(bible).toContain('**Members:** Aldric, king (421–452)')
    expect(bible).toContain('- Aldric and Edda: Parent of')

    // The app's own checks catch what can't be.
    await p.call('add_member', { factionId: clans, characterId: maelis, from: '900' })
    const checks = await p.call<{ warnings: { area: string; message: string }[] }>('check_consistency', w)
    expect(checks.warnings).toContainEqual(expect.objectContaining({ area: 'factions', message: 'Maelis joins Greywood before they’re born' }))
    await expect(p.call('set_relationship', { fromId: aldric, toId: 'nobody', type: 'ally' })).rejects.toThrow(/no character or faction/)
  })

  it('report inconsistencies, once each, about what is really there, and resolve or dismiss them', async () => {
    const { eventId } = await p.call<{ eventId: string }>('create_event', { worldId: p.worldId, title: 'Mira crowned in Tarn', start: '1204' })
    const report = { worldId: p.worldId, severity: 'contradiction', title: 'Mira in two places', explanation: 'She is crowned in Tarn while at sea.', about: [{ kind: 'event', id: eventId }], suggestion: 'Move the crowning a year later.' }
    await expect(p.call('report_inconsistency', { ...report, about: [{ kind: 'character', id: 'nobody' }] })).rejects.toThrow(/Nothing on that world is character nobody/)
    const { findingId, status } = await p.call<{ findingId: string; status: string }>('report_inconsistency', report)
    expect(status).toBe('applied')
    expect((await p.call<{ status: string }>('report_inconsistency', { ...report, title: 'mira in two places ' })).status).toBe('already reported')
    const { findings } = await p.call<{ findings: { about: object[]; status: string; reportedBy: string; suggestion: string }[] }>('list_inconsistencies', { worldId: p.worldId })
    expect(findings).toEqual([expect.objectContaining({ status: 'open', reportedBy: 'Claude', suggestion: 'Move the crowning a year later.', about: [{ kind: 'event', id: eventId, name: 'Mira crowned in Tarn' }] })])

    // Dismissed, it isn't raised again; resolved, it can be.
    await p.call('resolve_inconsistency', { findingId, status: 'dismissed', note: 'She has a double' })
    expect((await p.call<{ findingStatus: string }>('report_inconsistency', report)).findingStatus).toBe('dismissed')
    await p.call('resolve_inconsistency', { findingId, status: 'resolved' })
    expect((await p.call<{ status: string }>('report_inconsistency', report)).status).toBe('applied')
    expect((await p.call<{ findings: object[] }>('list_inconsistencies', { worldId: p.worldId, status: 'open' })).findings).toHaveLength(1)
  })

  it('run any command as one undoable step, and say clearly what’s wrong', async () => {
    const renamed = await p.call<{ summary: string }>('run_commands', { commands: [{ type: 'node.update', payload: { id: p.worldId, patch: { name: 'Gaia' } } }], summary: 'Renamed the world' })
    // What the commands are, not only what the client says: what a reviewer decides on.
    expect(renamed.summary).toBe('Renamed the world [node.update]')
    expect(p.project.snapshot().nodes.find((n) => n.id === p.worldId)!.name).toBe('Gaia')
    const types = await p.call<{ types: string[] }>('describe_commands')
    expect(types.types).toContain('event.create')
    expect(await p.call('describe_commands', { type: 'node.update' })).toHaveProperty('properties')
    await expect(p.call('create_event', { worldId: p.worldId, title: 'X', start: 'the day after tomorrow' })).rejects.toThrow(/is not a date/)
    await expect(p.call('get_world', { worldId: 'nope' })).rejects.toThrow(/no world nope/)
  })

  it('find what’s inconsistent', async () => {
    const a = await p.call<{ eventId: string }>('create_event', { worldId: p.worldId, title: 'The cause', start: '1300' })
    const b = await p.call<{ eventId: string }>('create_event', { worldId: p.worldId, title: 'The effect', start: '1200' })
    await p.call('link_events', { fromId: a.eventId, toId: b.eventId, type: 'causes' })
    const report = await p.call<{ ok: boolean; warnings: { message: string }[] }>('check_consistency', { worldId: p.worldId })
    expect(report.ok).toBe(false)
    expect(report.warnings[0]!.message).toContain('starts before “The cause”')
  })
})
