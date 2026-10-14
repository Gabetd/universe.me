import { languageAt, languageAtPoint, nameIn, type Language, type LanguagePlace, type LanguageUse, type NamedKind, type Region, type SpatialNode } from '@universe/core'
import { namedWater } from '@universe/procgen'
import { useMemo } from 'react'
import { useUi } from './store'

/**
 * The languages spoken in the project (core languages.ts), as the app uses
 * them: the one in force at a node or a region, names in it for new things,
 * and a world's rivers and lakes named in the languages where they run.
 */

/** What a language is looked up in: the project's languages, where each is spoken, and the tree of nodes. */
interface Speech {
  languages: readonly Language[]
  uses: readonly LanguageUse[]
  nodes: readonly SpatialNode[]
}

const parentsOf = (nodes: readonly SpatialNode[]) => {
  const parents = new Map(nodes.map((n) => [n.id, n.parentId]))
  return (id: string) => parents.get(id)
}

const speechNow = (): Speech => {
  const { timeline, nodes } = useUi.getState()
  return { languages: timeline.languages, uses: timeline.languageUses, nodes }
}

/** The language spoken at a place now (a node, or regions of a world), if one is. */
export const languageNow = (place: LanguagePlace, speech: Speech = speechNow()): Language | undefined =>
  languageAt(place, speech.uses, speech.languages, parentsOf(speech.nodes))

/** The language spoken at a place, followed as languages and where they're spoken change. */
export function useLanguageAt(nodeId: string, regionId?: string): Language | undefined {
  const languages = useUi((s) => s.timeline.languages)
  const uses = useUi((s) => s.timeline.languageUses)
  const nodes = useUi((s) => s.nodes)
  return useMemo(() => languageNow({ nodeId, regionIds: regionId ? [regionId] : [] }, { languages, uses, nodes }), [nodeId, regionId, languages, uses, nodes])
}

/** A new name for a thing of `kind` at a place, in the language spoken there: undefined where none is (the thing is named as it always was). */
export function nameInPlace(kind: NamedKind, place: LanguagePlace, kindWord?: string): string | undefined {
  const language = languageNow(place)
  return language && nameIn(language, kind, crypto.randomUUID(), kindWord)
}

/** A world's water named in the languages spoken where it runs, worked out once for each water, languages, uses, regions and nodes. */
const named = new WeakMap<object, { from: unknown[]; water: object }>()

export function waterInLanguages<W extends Parameters<typeof namedWater>[0]>(worldId: string, water: W, regions: readonly Region[], speech: Speech = speechNow()): W {
  const from = [speech.languages, speech.uses, speech.nodes, regions]
  const kept = named.get(water)
  if (kept && kept.from.every((k, i) => k === from[i])) return kept.water as W
  const parentOf = parentsOf(speech.nodes)
  const out = speech.uses.length ? namedWater(water, (p) => languageAtPoint(worldId, p, regions, speech.uses, speech.languages, parentOf)) : water
  named.set(water, { from, water: out })
  return out
}

/** The same, followed as they change. */
export function useWaterInLanguages<W extends Parameters<typeof namedWater>[0]>(worldId: string, water: W | undefined): W | undefined {
  const languages = useUi((s) => s.timeline.languages)
  const uses = useUi((s) => s.timeline.languageUses)
  const nodes = useUi((s) => s.nodes)
  const regions = useUi((s) => s.regions)
  return useMemo(() => water && waterInLanguages(worldId, water, regions, { languages, uses, nodes }), [worldId, water, regions, languages, uses, nodes])
}
