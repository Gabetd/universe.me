import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    const json = await p.call<{ history: object[] }>('export_world_bible', { worldId, format: 'json' })
    expect(json.history).toHaveLength(2)
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
