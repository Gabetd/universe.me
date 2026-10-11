import { CommandError, liveNode, liveRecord, liveRegion, type Check } from './command-kit'
import type { CanvasCard, CardTarget, Connection } from './canvas'
import type { Store } from './store'

/** The checks on the canvas's cards and connections, run on every create, update and restore (record-kit.ts). */

/** A connection's end: a live card or event. */
export const endOf = (store: Store, id: string) => liveRecord(store, store.records('card').get(id) ? 'card' : 'event', id)

/** Checks what an element card shows is there (a river or lake comes from the terrain's hydrology, so only its id's form is checked, by the schema). */
export function liveTarget(store: Store, { kind, id }: CardTarget): void {
  if (kind === 'node') liveNode(store, id)
  else if (kind === 'region') liveRegion(store, id)
  else if (kind !== 'waterway') liveRecord(store, kind === 'species' ? 'lifeform' : kind, id)
}

/** Checks a card: an element card shows something, a link card has its page, a picture card its picture. */
function checkCard(store: Store, card: CanvasCard, { verified }: Check<'card'>): void {
  if (!verified.has(card.ownerId)) liveNode(store, card.ownerId)
  if (card.kind === 'element' && !card.target) throw new CommandError('An element card needs something to show')
  if (card.kind === 'link' && !card.url) throw new CommandError('A link card needs a web address')
  if (card.kind === 'image' && !card.image) throw new CommandError('A picture card needs a picture')
}

/** Checks a connection: it joins two different cards or events of its own canvas. */
function checkConnection(store: Store, c: Connection): void {
  if (c.fromId === c.toId) throw new CommandError('A card cannot be connected to itself')
  for (const end of [c.fromId, c.toId]) if (endOf(store, end).ownerId !== c.ownerId) throw new CommandError('Those are on different canvases')
}

export const canvasValidators = { card: checkCard, connection: checkConnection }
