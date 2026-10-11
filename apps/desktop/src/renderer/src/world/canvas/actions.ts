import { CARD_DEFAULT_SIZE, CARD_IMAGE_MAX, CARD_IMAGE_TYPES, cardTitle, type CanvasCard, type CardKind, type CardPatch, type Command, type Connection, type TimelineEvent } from '@universe/core'
import { newId } from '../../components/ClaimPlanets'
import { asCommand, useUi } from '../../store'
import { bounds, type Point } from './board'
import { markdownToHtml } from './markdown'

/**
 * What the canvas does with its cards, as commands through the bus: adding
 * them, deleting what's selected, copying, pasting and duplicating cards
 * (with the connections between them), turning a text card into an event,
 * and reading a picture for a card. Each is one step to undo.
 */

/** Runs commands as one step to undo; resolves to the new state, or undefined if there was nothing to do or it was turned down. */
export const runCommands = async (commands: Command[]) => {
  const command = asCommand(commands)
  return command && useUi.getState().execute(command)
}

/** A new card's fields: its kind and whatever else it's given (its size is its kind's unless given). */
export type NewCard = Omit<CardPatch, 'kind' | 'x' | 'y'> & { kind: CardKind }

/** The command adding a card centred on `at`, with its id. */
export function addCardCommand(ownerId: string, card: NewCard, at: Point): { id: string; command: Command } {
  const id = newId()
  const w = card.w ?? CARD_DEFAULT_SIZE[card.kind].w
  const h = card.h ?? CARD_DEFAULT_SIZE[card.kind].h
  return { id, command: { type: 'card.create', payload: { ...card, id, ownerId, w, h, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2) } } }
}

/** Adds a card centred on `at`; its id once it's there. */
export async function addCard(ownerId: string, card: NewCard, at: Point): Promise<string | undefined> {
  const { id, command } = addCardCommand(ownerId, card, at)
  return (await runCommands([command])) ? id : undefined
}

/** What's selected on the canvas: cards and events by id, and a connection or a timeline link. */
export interface Selected {
  cards: CanvasCard[]
  events: TimelineEvent[]
  connectionId?: string
  linkId?: string
}

/** Deletes what's selected: cards and connections go, timeline links too, and events are taken off the canvas (they stay on the timeline). */
export function deleteSelected({ cards, events, connectionId, linkId }: Selected): void {
  const commands: Command[] = [
    ...cards.map((c): Command => ({ type: 'card.delete', payload: { id: c.id } })),
    ...events.map((e): Command => ({ type: 'event.update', payload: { id: e.id, patch: { canvasHidden: true } } })),
    ...(connectionId ? [{ type: 'connection.delete', payload: { id: connectionId } } as Command] : []),
    ...(linkId ? [{ type: 'link.delete', payload: { id: linkId } } as Command] : [])
  ]
  void runCommands(commands)
}

/** Cards copied (where they are from the first one's corner) and the connections between them, by their place in the list. */
export interface Copied {
  cards: (Omit<NewCard, 'x' | 'y'> & { dx: number; dy: number; w: number; h: number })[]
  connections: (Pick<Connection, 'fromSide' | 'toSide' | 'label' | 'color' | 'arrows'> & { from: number; to: number })[]
}

/** The clipboard's type for cards copied from the canvas. */
export const CLIPBOARD_TYPE = 'application/x-universe-canvas'

/** Cards copied last, for pasting within the app when the clipboard can't hold them. */
let lastCopied: Copied | null = null
export const remember = (copied: Copied) => (lastCopied = copied)
export const lastCopy = () => lastCopied

export function copyOf(cards: readonly CanvasCard[], connections: readonly Connection[]): Copied {
  const corner = bounds(cards)!
  const index = new Map(cards.map((c, i) => [c.id, i]))
  return {
    cards: cards.map(({ kind, w, h, color, text, target, url, image, x, y }) => ({ kind, w, h, color, text, target, url, image, dx: x - corner.x, dy: y - corner.y })),
    connections: connections.flatMap(({ fromId, toId, fromSide, toSide, label, color, arrows }) => {
      const [from, to] = [index.get(fromId), index.get(toId)]
      return from === undefined || to === undefined ? [] : [{ from, to, fromSide, toSide, label, color, arrows }]
    })
  }
}

/** Puts copied cards back with their connections, their corner at `at`; one step to undo. The new cards' ids. */
export async function paste(ownerId: string, copied: Copied, at: Point): Promise<string[]> {
  const ids = copied.cards.map(() => newId())
  const commands: Command[] = [
    ...copied.cards.map(({ dx, dy, ...card }, i): Command => ({ type: 'card.create', payload: { ...card, id: ids[i], ownerId, x: Math.round(at.x + dx), y: Math.round(at.y + dy) } })),
    ...copied.connections.map(({ from, to, ...c }): Command => ({ type: 'connection.create', payload: { ...c, fromId: ids[from]!, toId: ids[to]! } }))
  ]
  return (await runCommands(commands)) ? ids : []
}

/**
 * Turns a text card into an event at `start`, where the card was and its
 * size: its first line the title, the rest its notes; its connections go to
 * the event instead. One step to undo.
 */
export async function toEvent(card: CanvasCard, connections: readonly Connection[], start: number): Promise<void> {
  const id = newId()
  const [, ...rest] = card.text.split('\n')
  const swap = (end: string) => (end === card.id ? id : end)
  await runCommands([
      { type: 'event.create', payload: { id, ownerId: card.ownerId, title: cardTitle(card.text) || 'New event', start, notes: markdownToHtml(rest.join('\n')), canvas: { x: card.x, y: card.y, w: card.w, h: card.h } } },
      ...connections
        .filter((c) => c.fromId === card.id || c.toId === card.id)
        .map(({ fromId, toId, fromSide, toSide, label, color, arrows }): Command => ({ type: 'connection.create', payload: { fromId: swap(fromId), toId: swap(toId), fromSide, toSide, label, color, arrows } })),
      { type: 'card.delete', payload: { id: card.id } }
  ])
}

/** How wide a new picture card is at most, keeping its picture's shape; the picture kept is twice that at most (sharp on a high-density screen), so a photo isn't kept, sent and saved at full size with every change. */
const PICTURE_W = 420

/** A picture file read for a card: shrunk to keep (WebP), with a card size of its shape; or why it can't be. */
export async function readPicture(file: File): Promise<{ image: string; w: number; h: number } | { error: string }> {
  if (!(CARD_IMAGE_TYPES as readonly string[]).includes(file.type)) return { error: `${file.name} isn’t a PNG, JPEG, GIF or WebP picture` }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { error: `${file.name} couldn’t be read as a picture` }
  }
  const scale = Math.min(1, (2 * PICTURE_W) / bitmap.width)
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const [width, height] = [bitmap.width, bitmap.height]
  bitmap.close()
  const image = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 }))
  if (image.length > CARD_IMAGE_MAX) return { error: `${file.name} is too big for a card` }
  const w = Math.max(80, Math.min(PICTURE_W, width))
  return { image, w: Math.round(w), h: Math.round(Math.max(40, (w * height) / Math.max(1, width))) }
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

/** Shows why something couldn't be done, in the app's error banner. */
export const tell = (error: string) => useUi.setState({ error })
