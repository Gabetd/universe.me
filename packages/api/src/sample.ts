import type { Project } from '@universe/db'
import { apiContext, runOperation } from './catalog'
import { projectHost } from './project-host'

/**
 * The sample universe the start screen offers: one world, Calder, with fifteen
 * centuries of history to look around in (eras, events and how they lead to
 * each other, regions, structures that weather and are fought over, people,
 * the look of each age, life, and its magic). It's written with the same
 * operations Claude uses, so it goes through the command bus like any edit;
 * tagged as the app's own ('system'), not the AI's.
 */

/** Where things are on Calder (its seed grows one great continent across the date line; every place here is on land: sample.test.ts). */
export const SAMPLE_PLACES = {
  harrowgate: { lat: 8, lon: -168 },
  castle: { lat: 4, lon: -160 },
  stones: { lat: 28, lon: -152 },
  bridge: { lat: 6, lon: -150 },
  mine: { lat: 12, lon: -132 },
  greywatch: { lat: 24, lon: -108 },
  eastwatch: { lat: 2, lon: -94 }
} as const

/** Builds the sample into a new, empty project. */
export async function buildSample(project: Project): Promise<void> {
  const ctx = apiContext(projectHost(project, undefined, 'system'))
  const call = async <T extends Record<string, string>>(name: string, input: object): Promise<T> => (await runOperation(ctx, name, input)) as T
  const P = SAMPLE_PLACES
  const rootId = project.info().rootId
  const [clusterId, galaxyId] = [crypto.randomUUID(), crypto.randomUUID()]
  await call('run_commands', {
    summary: 'The sample’s galaxy',
    commands: [
      { type: 'node.create', payload: { id: clusterId, parentId: rootId, kind: 'galaxy_cluster', name: 'The Hearth Cluster' } },
      { type: 'node.create', payload: { id: galaxyId, parentId: clusterId, kind: 'galaxy', name: 'The Spindle' } }
    ]
  })
  const { systemId } = await call<{ systemId: string }>('create_star_system', { galaxyId, name: 'Lumen', massSun: 1 })
  const { worldId } = await call<{ worldId: string }>('create_world', { systemId, name: 'Calder', seed: 'Calder' })
  const w = { worldId }

  await call('update_note', {
    id: worldId,
    text: 'A sample world to look around in. Scrub the playhead along the timeline below and watch the castle fall to ruin, the Long Winter come and go, and the lighthouse go dark and shine again.\n\n- Click an event, a region or a structure for its details.\n- Right-click anything for what you can do with it.\n- Everything here is yours to change, and undo.'
  })

  // Places.
  const region = async (name: string, points: [number, number][], notes: string) => (await call<{ regionId: string }>('create_region', { ...w, name, points: points.map(([lat, lon]) => ({ lat, lon })), notes })).regionId
  const varn = await region('Kingdom of Varn', [[13, -176], [13, -145], [-6, -145], [-6, -176]], 'The lowland kingdom between the western sea and the Spine, ruled from Varn Castle.')
  const spine = await region('The Spine', [[30, -142], [30, -126], [-2, -126], [-2, -140]], 'The mountains that wall Varn off from the east. Silver lies under them.')
  const greywood = await region('Greywood', [[34, -120], [34, -102], [16, -102], [16, -116]], 'Old oak forest past the Spine; its folk never quite took a king.')
  await region('The Ashen Reach', [[-14, -136], [-14, -110], [-32, -110], [-32, -136]], 'Dry hills to the south, where the ash fell thickest in 1180.')

  // Ages.
  const era = (name: string, start: string, end: string, color: string, notes: string) => call('create_era', { ...w, name, start, end, color, notes })
  await era('The Founding', '1', '420', '#8a9a5b', 'Settlers come over the western sea and build the first towns.')
  await era('The Kingdom of Varn', '420', '1180', '#c9a227', 'Seven centuries of kings, roads and bridges.')
  await era('The Long Winter', '1180', '1290', '#9fb8d0', 'Ash darkens the sky and the snow doesn’t leave for a hundred years.')
  await era('The Thaw', '1290', '1500', '#6fae7e', 'Spring comes back, and Varn rebuilds.')

  // What's built, and how it weathers.
  const build = async (name: string, blueprint: string, builtAt: string, place: { lat: number; lon: number }, notes: string, maintained?: boolean) =>
    (await call<{ structureId: string }>('create_structure', { ...w, name, blueprint, builtAt, place, notes, ...(maintained !== undefined && { maintained }) })).structureId
  await build('Harrowgate', 'Walled city (vast)', '112', P.harrowgate, 'The first city of the west, and still the largest.', true)
  const stones = await build('The Nine Maidens', 'Stone circle', '300', P.stones, 'Nobody remembers who raised them. Nobody tends them either.', false)
  const castle = await build('Varn Castle', 'Stone castle', '455', P.castle, 'Seat of the kings of Varn.', true)
  const bridge = await build('Kingsbridge', 'Stone bridge', '610', P.bridge, 'Carries the king’s road over the Varn river.', true)
  await build('Deepdelve', 'Mine', '702', P.mine, 'The silver mine that paid for the kingdom.', true)
  await build('Greywatch', 'Watchtower', '840', P.greywatch, 'Varn’s eye on the Greywood.', true)
  const light = await build('Eastwatch Light', 'Lighthouse', '760', P.eastwatch, 'Guides ships around the eastern cape.', true)

  // People.
  const person = (name: string, born: string, died: string, place: { lat: number; lon: number }, notes: string) => call('create_character', { ...w, name, born, died, place, notes })
  await person('Aldric of Varn', '390', '452', P.castle, 'First king of Varn. Built the castle his heirs lived in for eight centuries.')
  await person('Maelis Thorn', '952', '1021', P.greywatch, 'Led the Greywood against the crown, and then made the peace.')
  await person('Oda the Lampwright', '1371', '1440', P.eastwatch, 'Relit the Eastwatch Light after a hundred and twenty years of dark.')

  // History.
  const event = async (title: string, start: string, more: object = {}) => (await call<{ eventId: string }>('create_event', { ...w, title, start, ...more })).eventId
  await event('Harrowgate founded', '112', { places: [P.harrowgate], lane: 'Varn', notes: 'Settlers from over the western sea make landfall and stay.' })
  await event('The Nine Maidens raised', 'c. 300', { places: [P.stones], tags: ['mystery'] })
  const crowned = await event('Aldric crowned first king of Varn', '421', { regionIds: [varn], lane: 'Varn' })
  const silver = await event('Silver struck at Deepdelve', '702', { regionIds: [spine], lane: 'Varn' })
  const rebellion = await event('The Greywood Rebellion', '980', { end: '994', regionIds: [greywood], lane: 'Wars', notes: 'The Greywood refuses the king’s tax on timber.' })
  const battle = await event('Battle of Kingsbridge', '993', { places: [P.bridge], lane: 'Wars', notes: 'The rebels hold the bridge for a day, and half of it falls into the river.' })
  const peace = await event('Peace of Greywatch', '995', { places: [P.greywatch], lane: 'Wars' })
  const ash = await event('The sky darkens', '1180', { notes: 'A mountain far to the south bursts. Ash falls for a year, and the winters stop ending.' })
  const abandoned = await event('Varn Castle abandoned', '1215', { places: [P.castle], lane: 'Varn' })
  const thaw = await event('The first spring in a century', '1290')
  const relit = await event('Eastwatch Light relit', '1402', { places: [P.eastwatch] })

  const link = (fromId: string, toId: string, type: string) => call('link_events', { fromId, toId, type })
  await link(crowned, silver, 'precedes')
  await link(rebellion, battle, 'causes')
  await link(battle, peace, 'causes')
  await link(ash, abandoned, 'causes')
  await link(thaw, relit, 'enables')
  await call('group_events', { title: 'The Greywood War', eventIds: [rebellion, battle, peace] })

  // What events do to what's built.
  await call('add_event_effect', { eventId: battle, type: 'damage', structureIds: [bridge], amount: 45 })
  await call('set_maintenance', { structureId: light, at: '1180', maintained: false, causeEventId: ash })
  await call('set_maintenance', { structureId: castle, at: '1215', maintained: false, causeEventId: abandoned })
  await call('add_event_effect', { eventId: relit, type: 'repair', structureIds: [light], amount: 80 })
  await call('set_maintenance', { structureId: light, at: '1402', maintained: true, causeEventId: relit })
  await call('update_note', { id: stones, text: 'Left to weather since they were raised: by the Thaw only a few still stand.', mode: 'append' })

  // The look of each age.
  const theme = async (name: string, preset: string, style: string) => (await call<{ themeId: string }>('create_theme', { name, preset, style })).themeId
  const golden = await theme('The Bright Centuries', 'Golden Age', 'Warm and unhurried; long sentences, full of trade and song.')
  const war = await theme('The Greywood War', 'Age of War', 'Short and hard. Smoke, mud, iron.')
  const winter = await theme('The Long Winter', 'Ice Age', 'Cold, quiet sentences. Little colour, much white.')
  await call('assign_theme_span', { ...w, themeId: golden, start: '600', end: '980', fadeInYears: 40, fadeOutYears: 10 })
  await call('assign_theme_span', { ...w, themeId: war, start: '980', end: '995', regionId: greywood, priority: 5, fadeInYears: 2, fadeOutYears: 5 })
  await call('assign_theme_span', { ...w, themeId: winter, start: '1180', end: '1290', priority: 10, fadeInYears: 5, fadeOutYears: 30 })

  // Life.
  const species = async (name: string, kind: string, diet: string, biomes: string[], eats: string[] = []) => (await call<{ speciesId: string }>('create_species', { ...w, name, kind, diet, biomes, eats })).speciesId
  const oak = await species('Greyoak', 'flora', 'producer', ['Temperate forest'])
  const moss = await species('Frostmoss', 'flora', 'producer', ['Tundra', 'Taiga'])
  const deer = await species('Varn red deer', 'fauna', 'herbivore', ['Temperate forest', 'Grassland'], [oak, moss])
  await species('Ash wolf', 'fauna', 'carnivore', ['Temperate forest', 'Taiga'], [deer])
  const moth = await species('Lantern moth', 'fauna', 'herbivore', ['Temperate forest'])
  await call('link_species', { fromId: moth, toId: oak, type: 'pollinates' })

  // How magic works, and how the Winter changed it.
  const { systemId: lamplight } = await call<{ systemId: string }>('create_power_system', {
    ...w,
    kind: 'magic',
    name: 'The Lamplight',
    summary: 'Light kept and given: lampwrights store sunlight in glass and spend it.',
    always: {
      Source: 'Sunlight, caught in worked glass.',
      'How it’s worked': 'A lampwright breathes on the glass and speaks the light’s name.',
      'Costs & limits': 'What’s spent is gone; a lamp holds no more than a summer’s day.',
      'Who can use it': 'Anyone patient enough to learn glass. Few are.'
    }
  })
  await call('describe_power_age', { systemId: lamplight, era: 'The Long Winter', summary: 'With no sun to catch, the lamps gutter out one by one.', strength: 0.1 })
  await call('describe_power_age', { systemId: lamplight, era: 'The Kingdom of Varn', summary: 'Every hall has its lamp; the lampwrights’ guild sits beside the king.', strength: 0.8 })

  // Its present day, where the playhead starts: after the Thaw, with the light lit again.
  await call('run_commands', { summary: 'The sample’s present day', commands: [{ type: 'timeline.update', payload: { ownerId: worldId, patch: { now: ctx.models.when(worldId, '1450') } } }] })
}
