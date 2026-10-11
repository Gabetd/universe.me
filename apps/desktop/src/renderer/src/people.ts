import type { SpatialNode } from '@universe/core'
import { hueOf, seedNumber } from '@universe/procgen'
import type { PersonIn, Where } from '../../shared/api'
import type { EditorView } from './world/editorStore'

/**
 * Other people in the universe (PLAN.md §6.7, with other people), as the
 * window shows them: a round mark with their initials in a colour of their
 * own, and where they are in words.
 */

/** A world's views as someone else reads them: "Terra, the map". */
const VIEW_WORDS: Record<EditorView, string> = {
  globe: 'the globe',
  map: 'the map',
  ground: 'the ground',
  canvas: 'the canvas',
  species: 'its species',
  powers: 'its power systems',
  factions: 'its factions',
  warnings: 'its warnings'
}

/** The view anything but a world is shown in: its place in space. */
const SPACE = 'space'

/** As long as a label may be (main turns down a longer one). */
const MAX_LABEL = 200

/** Whether a view is one of a world's (which `openView` can show). */
export const isWorldView = (view: string): view is EditorView => Object.hasOwn(VIEW_WORDS, view)

/** Where the user is, for the others: the node selected and, on a world, the view it's shown in. */
export function whereOn(node: SpatialNode | undefined, view: EditorView, universe: string): Where {
  if (!node) return { nodeId: null, view: SPACE, label: universe.slice(0, MAX_LABEL) }
  if (node.kind !== 'world') return { nodeId: node.id, view: SPACE, label: node.name.slice(0, MAX_LABEL) }
  const words = `, ${VIEW_WORDS[view]}`
  return { nodeId: node.id, view, label: `${node.name.slice(0, MAX_LABEL - words.length)}${words}` }
}

/** Someone and where they are, as their mark's tooltip says it: "Ana, on Terra, the map". */
export const personLine = ({ name, where }: PersonIn) => (where ? `${name}, on ${where.label}` : `${name}, just in`)

/** Up to two letters for someone's mark: their first and last names' first letters, or their name's first. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : words.slice(0, 1)
  return letters.map((w) => [...w][0]!.toUpperCase()).join('') || '?'
}

/** Someone's colour, the same on every computer: a hue from their login. */
export const personHue = (login: string) => hueOf(seedNumber(login))

/** The people on each node, by its id. */
export function peopleByNode(here: readonly PersonIn[]): Map<string, PersonIn[]> {
  const byNode = new Map<string, PersonIn[]>()
  for (const person of here) {
    const id = person.where?.nodeId
    if (id) byNode.set(id, [...(byNode.get(id) ?? []), person])
  }
  return byNode
}
