import { z } from 'zod'
import { Id, Notes, RecordMeta } from './schema'
import { cyrb53 } from './hash'
import { insidePolygon } from './geo'
import type { LatLon, Region } from './world'

/**
 * Languages (PLAN.md §9, M24): how the names of a place sound, and its naming
 * rules. A language, kept in the project's library, has its sounds (the
 * consonants and vowels it uses, the shapes its syllables take, how long its
 * words run and the endings they like) and a rule for each kind of thing it
 * names ("{name} River", "House {name}"). A node of the universe speaks one
 * (and what's under it does too, unless it speaks its own), and so can a
 * region of a world: rivers and lakes are named in the language where they
 * run, species and factions in their world's, and planets, moons, stars and
 * galaxies in the one where they are.
 */

/** The kinds of thing a language names, each by its own rule. */
export const NAMED_KINDS = ['river', 'lake', 'species', 'faction', 'planet'] as const
export const NamedKind = z.enum(NAMED_KINDS)
export type NamedKind = z.infer<typeof NamedKind>

export const NAMED_KIND_LABELS: Record<NamedKind, string> = {
  river: 'Rivers',
  lake: 'Lakes',
  species: 'Species',
  faction: 'Factions',
  planet: 'Planets, moons and stars'
}

/** A sound: a letter or a few ("th", "ae"). */
const Sound = z.string().min(1).max(4)
/** A syllable's shape: C for a consonant, V for a vowel ("CV", "CVC", "V"). */
const SyllableShape = z.string().regex(/^[CV]{1,6}$/, 'A syllable shape is C (a consonant) and V (a vowel), as in CVC')
/** A naming rule: what a thing is called, with {name} where the word goes ({kind} for a faction's kind). */
const NamingRule = z.string().min(1).max(80).includes('{name}', { message: 'A naming rule needs {name} where the word goes' })

export const NamingRules = z.object(Object.fromEntries(NAMED_KINDS.map((k) => [k, NamingRule])) as Record<NamedKind, typeof NamingRule>)
export type NamingRules = z.infer<typeof NamingRules>

export const Language = z.object({
  ...RecordMeta,
  name: z.string().min(1).max(200),
  consonants: z.array(Sound).min(1).max(40),
  vowels: z.array(Sound).min(1).max(20),
  syllables: z.array(SyllableShape).min(1).max(12),
  /** How many syllables a word has, at least and at most. */
  minSyllables: z.number().int().min(1).max(5),
  maxSyllables: z.number().int().min(1).max(6),
  /** Endings words often take ("ia", "or"); none, and they end as they fall. */
  endings: z.array(z.string().min(1).max(6)).max(12),
  rules: NamingRules,
  notes: Notes
})
export type Language = z.infer<typeof Language>
export type LanguageFields = Omit<Language, keyof typeof RecordMeta>

/** A language spoken at a node (its owner: a world, a planet, a star system, a galaxy…) and what's under it, or in one region of a world (`regionId`). */
export const LanguageUse = z.object({
  ...RecordMeta,
  languageId: Id,
  regionId: Id.nullable()
})
export type LanguageUse = z.infer<typeof LanguageUse>

const PLAIN_RULES: NamingRules = { river: '{name} River', lake: 'Lake {name}', species: '{name}', faction: 'The {name} {kind}', planet: '{name}' }

/** Languages to start from: each sounds its own way and names things its own way. */
export const LANGUAGE_PRESETS: Record<string, Omit<LanguageFields, 'notes'>> = {
  Common: {
    name: 'Common',
    consonants: ['k', 'r', 'v', 'n', 't', 'm', 's', 'd', 'l', 'z', 'th', 'b', 'g', 'qu'],
    vowels: ['a', 'o', 'e', 'i', 'ae', 'ia'],
    syllables: ['CV', 'CVC', 'V', 'CV'],
    minSyllables: 2,
    maxSyllables: 3,
    endings: [],
    rules: PLAIN_RULES
  },
  Elvish: {
    name: 'Elvish',
    consonants: ['l', 'r', 'n', 'th', 's', 'v', 'm', 'nd', 'lw', 'f', 'g'],
    vowels: ['a', 'e', 'i', 'ae', 'ie', 'o', 'ë'],
    syllables: ['CV', 'V', 'CVC', 'CV'],
    minSyllables: 2,
    maxSyllables: 4,
    endings: ['iel', 'wen', 'ion', 'dil', 'riel'],
    rules: { river: '{name}', lake: 'Nen {name}', species: '{name}', faction: 'The {name}', planet: '{name}' }
  },
  Dwarvish: {
    name: 'Dwarvish',
    consonants: ['k', 'g', 'd', 'b', 'r', 'z', 'kh', 'th', 'n', 'm', 'gr', 'dr'],
    vowels: ['a', 'u', 'o', 'i', 'ú', 'â'],
    syllables: ['CVC', 'CV', 'CVCC'],
    minSyllables: 1,
    maxSyllables: 2,
    endings: ['dûm', 'ak', 'grim', 'or'],
    rules: { river: '{name} Water', lake: '{name} Mere', species: '{name}', faction: 'Clan {name}', planet: '{name}' }
  },
  Desert: {
    name: 'Desert',
    consonants: ['q', 'r', 's', 'h', 'kh', 'z', 'm', 'n', 'd', 'b', 'sh', 'f', 'j'],
    vowels: ['a', 'i', 'u', 'aa', 'ai'],
    syllables: ['CV', 'CVC', 'CVV'],
    minSyllables: 2,
    maxSyllables: 3,
    endings: ['ah', 'im', 'an', 'iya'],
    rules: { river: 'Wadi {name}', lake: 'Bahr {name}', species: '{name}', faction: 'Banu {name}', planet: '{name}' }
  },
  Northern: {
    name: 'Northern',
    consonants: ['k', 'r', 'v', 'f', 'h', 'g', 'sk', 'st', 'th', 'd', 'l', 'n', 'j'],
    vowels: ['a', 'e', 'i', 'o', 'u', 'ø', 'å', 'ei'],
    syllables: ['CVC', 'CV', 'CVCC'],
    minSyllables: 1,
    maxSyllables: 2,
    endings: ['heim', 'vik', 'dal', 'gard', 'fjord'],
    rules: { river: '{name} Elv', lake: '{name} Vatn', species: '{name}', faction: 'The {name}ings', planet: '{name}' }
  }
}

/** The language used where none is spoken: the preset Common. */
export const DEFAULT_LANGUAGE: Omit<LanguageFields, 'notes'> = LANGUAGE_PRESETS.Common!

/** A little random number source from a string, the same every time. */
function randomFrom(key: string): () => number {
  let state = cyrb53(key) % 2147483647 || 1
  return () => (state = (state * 48271) % 2147483647) / 2147483647
}

const pick = <T>(list: readonly T[], r: () => number): T => list[Math.floor(r() * list.length)]!
const isVowel = (c: string) => /[aeiouyäëïöüâêîôûàèìòùáéíóúåøæœ]/i.test(c)

/** Leaves out letters that would run three of a kind (vowels or consonants) together, and the same letter twice over a join. */
function join(parts: string[]): string {
  let out = ''
  for (const part of parts) {
    if (!out) {
      out = part
      continue
    }
    const tail = out.slice(-2)
    const head = part[0]!
    // A third vowel or consonant in a row reads badly: skip this sound's first letter where it would make one.
    const run = [...tail].every((c) => isVowel(c) === isVowel(head))
    const same = out.at(-1)!.toLowerCase() === head.toLowerCase()
    out += run || same ? part.slice(1) : part
  }
  return out
}

/** A word in a language, the same every time for the same `key`: a few syllables of its shapes, and sometimes one of its endings. */
export function wordIn(language: Pick<Language, 'consonants' | 'vowels' | 'syllables' | 'minSyllables' | 'maxSyllables' | 'endings'>, key: string): string {
  const r = randomFrom(`${key}|${language.consonants.join()}|${language.vowels.join()}`)
  const [lo, hi] = [Math.min(language.minSyllables, language.maxSyllables), Math.max(language.minSyllables, language.maxSyllables)]
  const count = lo + Math.floor(r() * (hi - lo + 1))
  const parts: string[] = []
  for (let s = 0; s < count; s++) for (const slot of pick(language.syllables, r)) parts.push(slot === 'C' ? pick(language.consonants, r) : pick(language.vowels, r))
  if (language.endings.length && r() < 0.45) parts.push(pick(language.endings, r))
  const word = join(parts) || pick(language.vowels, r)
  return word[0]!.toUpperCase() + word.slice(1)
}

/** What a thing of `kind` is called in a language (by its rule), from `key` (its id, say): the same every time. `kindWord` fills a rule's {kind} (a faction's kind). */
export function nameIn(language: Pick<Language, 'consonants' | 'vowels' | 'syllables' | 'minSyllables' | 'maxSyllables' | 'endings' | 'rules'>, kind: NamedKind, key: string, kindWord = ''): string {
  const word = wordIn(language, `${kind}:${key}`)
  return language.rules[kind].replaceAll('{name}', word).replaceAll('{kind}', kindWord).replace(/\s+/g, ' ').trim()
}

/** Where a language is looked for: the node and its parents, for a world the regions a place lies in too. */
export interface LanguagePlace {
  nodeId: string
  /** Regions of that node (a world) the thing lies in, the first one's language winning. */
  regionIds?: readonly string[]
}

/**
 * The language spoken at a place: a region's own (the first of `regionIds`
 * that has one), else the node's, else its parent's and so on up; undefined
 * where none is.
 */
export function languageAt(
  place: LanguagePlace,
  uses: readonly LanguageUse[],
  languages: readonly Language[],
  parentOf: (nodeId: string) => string | null | undefined
): Language | undefined {
  const byId = new Map(languages.filter((l) => !l.deletedAt).map((l) => [l.id, l]))
  const live = uses.filter((u) => !u.deletedAt && byId.has(u.languageId))
  for (const regionId of place.regionIds ?? []) {
    const use = live.find((u) => u.ownerId === place.nodeId && u.regionId === regionId)
    if (use) return byId.get(use.languageId)
  }
  const seen = new Set<string>()
  for (let id: string | null | undefined = place.nodeId; id && !seen.has(id); id = parentOf(id)) {
    seen.add(id)
    const use = live.find((u) => u.ownerId === id && u.regionId === null)
    if (use) return byId.get(use.languageId)
  }
  return undefined
}

/** The use that says what's spoken at a node (`regionId` null) or in a region of it, if one does. */
export const languageUseOf = (uses: readonly LanguageUse[], nodeId: string, regionId: string | null): LanguageUse | undefined =>
  uses.find((u) => !u.deletedAt && u.ownerId === nodeId && u.regionId === regionId)

/** The language spoken at a point of a world: the first region it lies in that speaks one, else the world's (or what it's under). */
export function languageAtPoint(
  worldId: string,
  p: LatLon,
  regions: readonly Pick<Region, 'id' | 'worldId' | 'points' | 'deletedAt'>[],
  uses: readonly LanguageUse[],
  languages: readonly Language[],
  parentOf: (nodeId: string) => string | null | undefined
): Language | undefined {
  const regionIds = regions.filter((r) => r.worldId === worldId && !r.deletedAt && insidePolygon(p, r.points)).map((r) => r.id)
  return languageAt({ nodeId: worldId, regionIds }, uses, languages, parentOf)
}
