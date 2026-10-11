import { KIND_LABELS, type CardTarget } from '@universe/core'
import { nameOf, openElement, type ElementRef } from '../../contextMenu'
import { kindLabel } from '../../kinds'
import { useUi } from '../../store'

/** What an element card shows, as the rest of the app knows it (the kinds are the same). */
const elementRef = (target: CardTarget): ElementRef => target

/** What each kind of thing an element card shows is called. */
export const TARGET_LABELS: Record<CardTarget['kind'], string> = {
  node: 'Place',
  region: 'Region',
  event: 'Event',
  era: 'Era',
  character: 'Character',
  faction: 'Faction',
  structure: 'Structure',
  species: 'Species',
  waterway: 'River or lake',
  power: 'Power',
  theme: 'Theme'
}

/** An element card's title, what it is and a little of its notes; `missing` once it's gone. */
export function elementSummary(target: CardTarget): { name: string; kind: string; notes: string; missing: boolean } {
  const s = useUi.getState()
  const name = nameOf(elementRef(target))
  const node = target.kind === 'node' ? s.nodes.find((n) => n.id === target.id) : undefined
  const kind = node ? kindLabel(node, s.nodes) || KIND_LABELS[node.kind] : TARGET_LABELS[target.kind]
  return { name: name ?? 'Gone', kind, notes: plain(notesOf(target)), missing: name === undefined }
}

/** An element's notes (HTML), where it has any. */
function notesOf({ kind, id }: CardTarget): string {
  const s = useUi.getState()
  const t = s.timeline
  const lists: Partial<Record<CardTarget['kind'], { id: string; notes?: string }[]>> = {
    node: s.nodes,
    region: s.regions,
    event: t.events,
    era: t.eras,
    character: t.characters,
    faction: t.factions,
    structure: t.structures,
    species: t.lifeforms,
    power: t.powers,
    theme: t.themes
  }
  return lists[kind]?.find((r) => r.id === id)?.notes ?? ''
}

/** Notes as plain text, shortened, for a card. */
const plain = (html: string) => {
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  return text.length > 280 ? `${text.slice(0, 280)}…` : text
}

/** Opens what an element card shows, as clicking it anywhere else would. */
export const openTarget = (target: CardTarget) => openElement(elementRef(target))
