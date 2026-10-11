/**
 * A Universe plugin (see README.md): each generator, exporter and name
 * generator in plugin.json is a function here, named by its id, given what
 * it runs on and its options, and `universe`, its way into the app.
 */

// Sounds for names, by style.
const SOUNDS = {
  Northern: { start: ['Bjor', 'Ha', 'Sig', 'Ul', 'Thor', 'Ey', 'Kal', 'Ra', 'Ste', 'Gun'], end: ['nar', 'vik', 'dis', 'mund', 'ulf', 'heim', 'gard', 'ra', 'stad', 'by'] },
  Southern: { start: ['Al', 'Ca', 'Ma', 'Sa', 'Te', 'Ve', 'Lu', 'Or', 'Pa', 'Ri'], end: ['nza', 'rino', 'lea', 'sso', 'vara', 'mira', 'tello', 'dora', 'zio', 'nna'] },
  Elvish: { start: ['Ae', 'Ela', 'Fin', 'Gal', 'Ith', 'Lae', 'Mir', 'Nim', 'Syl', 'Thal'], end: ['ndil', 'riel', 'wen', 'thas', 'lor', 'mir', 'ion', 'dhel', 'las', 'nor'] }
}

/** A name from two or three sounds of a style. */
function makeName(random, style) {
  const { start, end } = SOUNDS[style] ?? SOUNDS.Northern
  const pick = (list) => list[Math.floor(random() * list.length)]
  const middle = random() < 0.3 ? pick(end).slice(0, 2) : ''
  return pick(start) + middle + pick(end)
}

/** Generators: what they change is one step to undo, and if one fails, nothing it did is kept. */
export const generators = {
  async villages({ worldId, options, seed }, universe) {
    const random = universe.random(seed)
    // Places to try (away from the poles), and what the land is like at each.
    const tries = Array.from({ length: options.count * 25 }, () => ({ lat: (random() * 2 - 1) * 60, lon: random() * 360 - 180 }))
    const { places } = await universe.call('get_terrain_at', { worldId, places: tries })
    const sites = places.filter((p) => p.surface === 'land' && p.elevationM <= options.highest).slice(0, options.count)
    const made = []
    for (const site of sites) {
      const name = makeName(random, options.style)
      await universe.call('create_structure', {
        worldId,
        name,
        blueprint: 'Village',
        builtAt: options.founded,
        place: { lat: site.lat, lon: site.lon },
        maintained: true,
        notes: `A village in the ${site.biome.toLowerCase()}${site.regions ? `, in ${site.regions.join(' and ')}` : ''}, ${site.elevationM} m above the sea.`
      })
      made.push(name)
    }
    universe.log(`Tried ${tries.length} places; ${sites.length} were dry land low enough.`)
    // What it says it did (shown in the app, and as the step to undo).
    return made.length ? `Founded ${made.length} villages: ${made.join(', ')}` : 'There was no land low enough for a village'
  }
}

/** Name generators: a list of names (as many as `count`), offered for the thing being named. */
export const names = {
  people({ count, seed, options }, universe) {
    const random = universe.random(seed)
    return Array.from({ length: count }, () => makeName(random, options.style))
  }
}

/** Exporters: files ({ name, text } or { name, bytes }), saved where the user says. */
export const exporters = {
  async wiki({ worldId }, universe) {
    const bible = await universe.call('export_world_bible', { worldId, format: 'json' })
    const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page'
    const link = (dir, name) => `[${name}](${dir}/${slug(name)}.md)`
    const page = (title, ...parts) => [`# ${title}`, '', ...parts.filter(Boolean)].join('\n\n') + '\n'
    const files = [
      {
        name: 'index.md',
        text: page(
          bible.world,
          `*${bible.path}*, as of ${bible.now}.`,
          bible.notes,
          bible.regions.length && `## Regions\n\n${bible.regions.map((r) => `- ${link('regions', r.name)}`).join('\n')}`,
          bible.structures.length && `## Places\n\n${bible.structures.map((s) => `- ${link('places', s.name)}`).join('\n')}`,
          bible.factions.length && `## Factions\n\n${bible.factions.map((f) => `- ${link('factions', f.name)}`).join('\n')}`,
          bible.characters.length && `## Characters\n\n${bible.characters.map((c) => `- ${link('characters', c.name)}`).join('\n')}`,
          bible.history.length && `## History\n\n${bible.history.map((e) => `- **${e.when}**: ${e.title}`).join('\n')}`
        )
      },
      ...bible.regions.map((r) => ({ name: `regions/${slug(r.name)}.md`, text: page(r.name, r.notes, '[Back to the world](../index.md)') })),
      ...bible.structures.map((s) => ({ name: `places/${slug(s.name)}.md`, text: page(s.name, `*${s.blueprint}, built ${s.built}${s.region ? `, in ${s.region}` : ''}.*`, s.notes, '[Back to the world](../index.md)') })),
      ...bible.factions.map((f) => ({ name: `factions/${slug(f.name)}.md`, text: page(f.name, `*${f.kind}${f.partOf ? ` of ${f.partOf}` : ''}*`, f.summary, f.notes, '[Back to the world](../index.md)') })),
      ...bible.characters.map((c) => ({ name: `characters/${slug(c.name)}.md`, text: page(c.name, `*Born ${c.born}${c.died ? `, died ${c.died}` : ''}*`, c.notes, '[Back to the world](../index.md)') }))
    ]
    universe.log(`${files.length} pages`)
    return files
  },

  async map({ worldId, options }, universe) {
    const map = await universe.call('get_world_map', { worldId, width: Number(options.width) })
    const png = await universe.png(map.width, map.height, universe.fromBase64(map.rgba))
    return [{ name: 'map.png', bytes: png }]
  }
}
