import { ARROWS, CanvasCard, CanvasColor, CardTarget, CardUrl, SIDES, cardTitle, stripUndefined, type Command } from '@universe/core'
import { z } from 'zod'
import { refName } from './describe'
import { ApiError, findOr404 } from './host'
import type { ProjectModels, WorldView } from './model'
import { operation } from './operation'
import { waterwaysOf } from './waterways'
import { newId, write } from './writes'

/**
 * A world's canvas (PLAN.md §9, M17) for AI clients: what's on it, and
 * adding, changing and connecting its cards, as the app's canvas does.
 * Pictures come only from the user's own files, in the app.
 */

const CardId = z.string().describe('A card’s id (from get_canvas)')
const Color = CanvasColor.optional().describe('"1"–"6" for red, orange, yellow, green, cyan or purple, a #rrggbb colour, or null for none')
const Target = CardTarget.describe('What an element card shows: a node, region, event, era, character, faction, structure, species, waterway (a river or lake by its id from list_waterways), power or theme')
// Where a card is and how big, as the bus allows; a new card is its kind's size unless given one.
const Box = { x: CanvasCard.shape.x.optional(), y: CanvasCard.shape.y.optional(), w: CanvasCard.shape.w.optional(), h: CanvasCard.shape.h.optional() }

/** Names what element cards show on a world (a river or lake by the name the app gives it); undefined for what isn't there. */
async function targetNames(m: ProjectModels, view: WorldView, worldId: string, needsWater: boolean): Promise<(t: CardTarget) => string | undefined> {
  const water = needsWater ? await waterwaysOf(m, worldId) : undefined
  return (t) => (t.kind === 'waterway' ? water?.nameOf(t.id) : refName(m, view, t))
}

/** A card or event of the world's canvas by id, by name: a text card by its first line, a group by its label, a link card by its page. */
function nameOnCanvas(view: WorldView, id: string): string | undefined {
  const card = view.timeline.cards.find((c) => c.id === id)
  if (card) return (card.kind === 'text' ? cardTitle(card.text) : card.text || card.url) || `a ${card.kind} card`
  return view.timeline.events.find((e) => e.id === id)?.title
}

function describeCard(name: (t: CardTarget) => string | undefined, c: CanvasCard) {
  return {
    id: c.id,
    kind: c.kind,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    ...(c.color && { color: c.color }),
    ...(c.kind === 'text' && { text: c.text }),
    ...(c.kind === 'group' && { label: c.text }),
    ...(c.target && { shows: { ...c.target, name: name(c.target) ?? '(gone)' } }),
    ...(c.url && { url: c.url })
  }
}

/** For a card or event that isn't on the canvas. */
const notFound = (id: string): never => {
  throw new ApiError(404, `There is no card or event ${id} on this world’s canvas`)
}

export const CANVAS_OPERATIONS = [
  operation({
    name: 'get_canvas',
    title: 'Read a world’s canvas',
    description:
      'A world’s canvas, as Obsidian’s Canvas has it: its cards (text in Markdown, elements of the project, web links, pictures and groups, each with where it is and how big, in px), the events on it (each event is a card too, where it’s been put) and the connections between any two of them (a label, a colour, arrows). Add to it with add_canvas_card and connect_on_canvas.',
    input: z.object({ worldId: z.string() }),
    route: { method: 'GET', path: '/worlds/:worldId/canvas' },
    run: async ({ models: m }, { worldId }) => {
      const view = m.world(worldId)
      const t = view.timeline
      const names = await targetNames(m, view, worldId, t.cards.some((c) => c.target?.kind === 'waterway'))
      const name = (id: string) => nameOnCanvas(view, id)
      return {
        cards: t.cards.map((c) => describeCard(names, c)),
        // A hidden event (and its connections) is off the board in the app until it's shown again.
        events: t.events.map((e) => ({ id: e.id, title: e.title, ...(e.canvas && { x: e.canvas.x, y: e.canvas.y }), ...(e.canvasHidden && { hidden: true }) })),
        connections: t.connections.map((c) => ({ id: c.id, fromId: c.fromId, toId: c.toId, from: name(c.fromId), to: name(c.toId), ...(c.label && { label: c.label }), arrows: c.arrows, ...(c.color && { color: c.color }) }))
      }
    }
  }),
  operation({
    name: 'add_canvas_card',
    title: 'Add a card to a world’s canvas',
    description:
      'Adds a card to a world’s canvas: text (Markdown), an element of the project it shows (target), a web page (url) or a group (a labelled box; cards lying wholly inside it are in it). Where it goes is x and y (its top-left, in px); left out, it goes to the right of what’s there. Returns its id.',
    input: z.object({
      worldId: z.string(),
      kind: z.enum(['text', 'element', 'link', 'group']),
      text: z.string().max(200_000).optional().describe('A text card’s Markdown, or a group’s label'),
      target: Target.optional(),
      url: CardUrl.optional(),
      color: Color,
      ...Box
    }),
    route: { method: 'POST', path: '/worlds/:worldId/canvas/cards' },
    write: true,
    run: async (ctx, p) => {
      const view = ctx.models.world(p.worldId)
      if (p.target && (await targetNames(ctx.models, view, p.worldId, p.target.kind === 'waterway'))(p.target) === undefined) throw new ApiError(404, `There is no ${p.target.kind} ${p.target.id} to show`)
      // To the right of what's there, level with its top.
      const cards = view.timeline.cards
      const right = cards.length ? Math.max(...cards.map((c) => c.x + c.w)) + 40 : 0
      const top = cards.length ? Math.min(...cards.map((c) => c.y)) : 0
      const id = newId()
      const command: Command = {
        type: 'card.create',
        payload: {
          id,
          ownerId: p.worldId,
          kind: p.kind,
          x: p.x ?? right,
          y: p.y ?? top,
          ...stripUndefined({ w: p.w, h: p.h }),
          ...(p.text !== undefined && { text: p.text }),
          ...(p.target && { target: p.target }),
          ...(p.url && { url: p.url }),
          ...(p.color !== undefined && { color: p.color })
        }
      }
      return write(ctx, [command], `Added a ${p.kind} card to the canvas`, { cardId: id })
    }
  }),
  operation({
    name: 'update_canvas_card',
    title: 'Change a card on a canvas',
    description: 'Moves, resizes or recolours a card of a world’s canvas, or changes its text (Markdown, or a group’s label) or a link card’s url.',
    input: z.object({ cardId: CardId, text: z.string().max(200_000).optional(), url: CardUrl.optional(), color: Color, ...Box }),
    route: { method: 'POST', path: '/canvas/cards/:cardId' },
    write: true,
    run: (ctx, { cardId, ...p }) => {
      const card = findOr404(ctx.models.data().timeline.cards, cardId, 'card')
      const patch = stripUndefined(p)
      if (!Object.keys(patch).length) throw new ApiError(400, 'Nothing to change')
      return write(ctx, [{ type: 'card.update', payload: { id: card.id, patch } }], `Changed a ${card.kind} card on the canvas`)
    }
  }),
  operation({
    name: 'connect_on_canvas',
    title: 'Connect two things on a canvas',
    description:
      'Draws a connection on a world’s canvas between two of its cards or events (by id, from get_canvas): an arrow at the end by default (or at the start, both or none), with a label and a colour if given, from and to the sides asked for (else the sides facing each other). To say how two events relate in time (causes, enables…), use link_events instead.',
    input: z.object({
      fromId: z.string(),
      toId: z.string(),
      label: z.string().max(500).optional(),
      arrows: z.enum(ARROWS).optional(),
      color: Color,
      fromSide: z.enum(SIDES).optional(),
      toSide: z.enum(SIDES).optional()
    }),
    route: { method: 'POST', path: '/canvas/connections' },
    write: true,
    run: (ctx, p) => {
      const data = ctx.models.data()
      const owner = data.timeline.cards.find((c) => c.id === p.fromId)?.ownerId ?? data.timeline.events.find((e) => e.id === p.fromId)?.ownerId
      if (!owner) throw new ApiError(404, `There is no card or event ${p.fromId}`)
      const view = ctx.models.world(owner)
      const [from, to] = [p.fromId, p.toId].map((id) => nameOnCanvas(view, id) ?? notFound(id))
      const id = newId()
      return write(ctx, [{ type: 'connection.create', payload: { id, ...p } }], `Connected “${from}” to “${to}” on the canvas`, { connectionId: id })
    }
  })
]
