import { LANGUAGE_PRESETS, NAMED_KINDS, languageAt, nameIn, speakCommands, stripUndefined, type Language } from '@universe/core'
import { z } from 'zod'
import { findOr404 } from './host'
import { operation } from './operation'
import { newId, write } from './writes'

/**
 * Languages (core languages.ts) for AI clients: the project's languages,
 * where each is spoken, making and changing them, and names in the one
 * spoken at a place, as the app's language panels do.
 */

const Sounds = {
  consonants: z.array(z.string().min(1).max(4)).min(1).max(40).optional().describe('Consonant sounds, as ["k", "th", "r"]'),
  vowels: z.array(z.string().min(1).max(4)).min(1).max(20).optional().describe('Vowel sounds, as ["a", "ae", "i"]'),
  syllables: z.array(z.string().regex(/^[CV]{1,6}$/)).min(1).max(12).optional().describe('Syllable shapes: C a consonant, V a vowel, as ["CV", "CVC", "V"]'),
  minSyllables: z.number().int().min(1).max(5).optional(),
  maxSyllables: z.number().int().min(1).max(6).optional(),
  endings: z.array(z.string().min(1).max(6)).max(12).optional().describe('Endings words often take, as ["ia", "or"]'),
  rules: z
    .object(Object.fromEntries(NAMED_KINDS.map((k) => [k, z.string().min(1).max(80).optional()])) as Record<(typeof NAMED_KINDS)[number], z.ZodOptional<z.ZodString>>)
    .optional()
    .describe('Naming rules by kind (river, lake, species, faction, planet): a pattern with {name} where the word goes, as "{name} River" or "House {name}" ({kind} is a faction’s kind)')
}

const describeLanguage = (l: Language) => ({
  id: l.id,
  name: l.name,
  consonants: l.consonants,
  vowels: l.vowels,
  syllables: l.syllables,
  minSyllables: l.minSyllables,
  maxSyllables: l.maxSyllables,
  endings: l.endings,
  rules: l.rules
})

export const LANGUAGE_OPERATIONS = [
  operation({
    name: 'list_languages',
    title: 'List the languages',
    description:
      'The project’s languages: each one’s sounds (consonants, vowels, syllable shapes, word length, endings) and naming rules for rivers, lakes, species, factions and planets, and where it’s spoken (nodes, and regions of worlds). Names of things there follow the language spoken: a region’s own, else its world’s, else what the world is under (its planet, star system, galaxy…).',
    input: z.object({}),
    route: { method: 'GET', path: '/languages' },
    run: ({ models: m }) => {
      const { nodes, regions, timeline } = m.data()
      const nameOfNode = (id: string) => nodes.find((n) => n.id === id)?.name
      return {
        languages: timeline.languages.map((l) => ({
          ...describeLanguage(l),
          spokenAt: timeline.languageUses
            .filter((u) => u.languageId === l.id)
            .map((u) => ({ nodeId: u.ownerId, node: nameOfNode(u.ownerId), ...(u.regionId && { regionId: u.regionId, region: regions.find((r) => r.id === u.regionId)?.name }) }))
        })),
        presets: Object.keys(LANGUAGE_PRESETS)
      }
    }
  }),
  operation({
    name: 'add_language',
    title: 'Make a language',
    description: `Makes a language: from a preset (${Object.keys(LANGUAGE_PRESETS).join(', ')}) if named, with any sounds and naming rules given in place of the preset’s. Returns its id; speak_language puts it to use.`,
    input: z.object({ name: z.string().min(1).max(200).optional(), preset: z.string().optional(), ...Sounds }),
    route: { method: 'POST', path: '/languages' },
    write: true,
    run: (ctx, { rules, ...p }) => {
      const id = newId()
      const base = LANGUAGE_PRESETS[p.preset ?? 'Common']
      const payload = { id, ownerId: ctx.models.project().rootId, ...stripUndefined(p), ...(rules && { rules: { ...(base?.rules ?? LANGUAGE_PRESETS.Common!.rules), ...stripUndefined(rules) } }) }
      return write(ctx, [{ type: 'language.create', payload }], `Made the language ${p.name ?? p.preset ?? 'New language'}`, { languageId: id })
    }
  }),
  operation({
    name: 'update_language',
    title: 'Change a language',
    description: 'Changes a language (by its id from list_languages): its name, sounds or naming rules; what isn’t given stays. The names it gives change with it.',
    input: z.object({ languageId: z.string(), name: z.string().min(1).max(200).optional(), ...Sounds }),
    route: { method: 'POST', path: '/languages/:languageId' },
    write: true,
    run: (ctx, { languageId, rules, ...p }) => {
      const language = findOr404(ctx.models.data().timeline.languages, languageId, 'language')
      const patch = { ...stripUndefined(p), ...(rules && { rules: { ...language.rules, ...stripUndefined(rules) } }) }
      return write(ctx, [{ type: 'language.update', payload: { id: languageId, patch } }], `Changed the language ${p.name ?? language.name}`)
    }
  }),
  operation({
    name: 'speak_language',
    title: 'Say what language is spoken where',
    description:
      'Makes a node (a world, planet, star system, galaxy…, and what’s under it) or a region of a world speak a language, or (languageId null) speak what’s around it again. Rivers and lakes there are named in it, and new things named after it.',
    input: z.object({ nodeId: z.string(), regionId: z.string().optional().describe('A region of the world nodeId'), languageId: z.string().nullable() }),
    route: { method: 'POST', path: '/nodes/:nodeId/language' },
    write: true,
    run: (ctx, { nodeId, regionId, languageId }) => {
      const node = ctx.models.node(nodeId)
      if (regionId) ctx.models.region(nodeId, regionId)
      const language = languageId ? findOr404(ctx.models.data().timeline.languages, languageId, 'language') : undefined
      const commands = speakCommands(ctx.models.data().timeline.languageUses, nodeId, regionId ?? null, languageId)
      return write(ctx, commands, language ? `${node.name} speaks ${language.name}` : `${node.name} speaks what’s around it`)
    }
  }),
  operation({
    name: 'name_in_language',
    title: 'Names in a place’s language',
    description:
      'Names for a kind of thing (river, lake, species, faction, planet) in the language spoken at a node (or a region of a world), by that language’s naming rule: as many as asked, each different. For naming what you make so it fits where it is.',
    input: z.object({
      nodeId: z.string(),
      regionId: z.string().optional(),
      kind: z.enum(NAMED_KINDS),
      count: z.number().int().min(1).max(50).default(5),
      factionKind: z.string().max(40).optional().describe('What a faction is ("Guild"), for a rule with {kind}')
    }),
    route: { method: 'GET', path: '/nodes/:nodeId/names' },
    run: ({ models: m }, { nodeId, regionId, kind, count, factionKind }) => {
      const { nodes, timeline } = m.data()
      m.node(nodeId)
      const parents = new Map(nodes.map((n) => [n.id, n.parentId]))
      const language = languageAt({ nodeId, regionIds: regionId ? [regionId] : [] }, timeline.languageUses, timeline.languages, (id) => parents.get(id))
      if (!language) return { language: null, names: [], note: 'No language is spoken there: speak_language gives it one.' }
      const salt = newId()
      return { language: language.name, names: Array.from({ length: count }, (_, i) => nameIn(language, kind, `${salt}:${i}`, factionKind)) }
    }
  })
]
