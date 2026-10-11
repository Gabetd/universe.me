import { z } from 'zod'
import { liveNode } from './command-kit'
import type { HandlerMap } from './commands'
import { CARD_DEFAULT_SIZE, CanvasCard, CanvasColor, CardKind, Connection } from './canvas'
import { endOf, liveTarget } from './canvas-validators'
import { ById, NewId, create, deleteWith, recordCrud, refsWhere } from './record-kit'
import { Id } from './schema'
import type { Store } from './store'

/** The canvas's cards and connections (canvas.ts), through the bus like every record. */

const CardFields = CanvasCard.pick({ kind: true, x: true, y: true, w: true, h: true, color: true, text: true, target: true, url: true, image: true })
export type CardPatch = Partial<z.infer<typeof CardFields>>
const ConnectionFields = Connection.pick({ fromSide: true, toSide: true, label: true, color: true, arrows: true })
export type ConnectionPatch = Partial<z.infer<typeof ConnectionFields>>

const cards = recordCrud('card', CardFields)
const connections = recordCrud('connection', ConnectionFields)

export const CANVAS_COMMANDS = [
  /** A card on a node's canvas (a world's), of its kind's size unless given one. */
  z.object({ type: z.literal('card.create'), payload: CardFields.partial().extend({ ...NewId, ownerId: Id, kind: CardKind, x: CanvasCard.shape.x, y: CanvasCard.shape.y }) }),
  cards.commands[0],
  z.object({ type: z.literal('card.delete'), payload: ById }),
  /** A connection from one card or event of a canvas to another. */
  z.object({ type: z.literal('connection.create'), payload: ConnectionFields.partial().extend({ ...NewId, fromId: Id, toId: Id, color: CanvasColor.optional() }) }),
  ...connections.commands
] as const

type CanvasCommand = z.infer<(typeof CANVAS_COMMANDS)[number]>

export const canvasHandlers: HandlerMap<CanvasCommand> = {
  'card.create': (store, { id, ownerId, kind, ...p }, ctx) => {
    liveNode(store, ownerId)
    if (p.target) liveTarget(store, p.target)
    const size = CARD_DEFAULT_SIZE[kind]
    return create(store, 'card', ctx, ownerId, id, { kind, x: p.x, y: p.y, w: p.w ?? size.w, h: p.h ?? size.h, color: p.color ?? null, text: p.text ?? '', target: p.target ?? null, url: p.url ?? null, image: p.image ?? null }, [ownerId])
  },
  'card.update': (store, payload, ctx, run) => {
    if (payload.patch.target) liveTarget(store, payload.patch.target)
    return cards.update(store, payload, ctx, run)
  },
  // Its connections go with it.
  'card.delete': (store, { id }, ctx, run) => deleteWith(store, ctx, run, { kind: 'card', id }, ({ ownerId }) => ({ remove: connectionsOf(store, ownerId, id) })),
  'connection.create': (store, { id, fromId, toId, ...p }, ctx) =>
    create(store, 'connection', ctx, endOf(store, fromId).ownerId, id, { fromId, toId, fromSide: p.fromSide ?? null, toSide: p.toSide ?? null, label: p.label ?? '', color: p.color ?? null, arrows: p.arrows ?? 'end' }),
  'connection.update': connections.update,
  'connection.delete': connections.delete
}

/** Refs to the connections to and from a card or event (which go when it does). */
export const connectionsOf = (store: Store, ownerId: string, id: string) => refsWhere(store, 'connection', ownerId, (c) => c.fromId === id || c.toId === id)
