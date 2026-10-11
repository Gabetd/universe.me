import { ARROWS, CARD_DEFAULT_SIZE, CARD_TARGET_KINDS, CanvasColor, CardUrl, SIDES, type CanvasCard, type CardTarget, type Command } from '@universe/core'
import { z } from 'zod'
import { ApiError, findOr404 } from './host'
import type { ProjectModels, WorldView } from './model'
import { operation } from './operation'
import { write } from './writes'

/**
 * A world's canvas (PLAN.md §9, M17) for AI clients: what's on it, and
 * adding, changing and connecting its cards, as the app's canvas does.
 * Pictures come only from the user's own files, in the app.
 */

const newId = () => crypto.randomUUID()
const CardId = z.string().describe('A card’s id (from get_canvas)')
const Color = CanvasColor.optional().describe('"1"–"6" for red, orange, yellow, green, cyan or purple, a #rrggbb colour, or null for none')
const Target = z.object({ kind: z.enum(CARD_TARGET_KINDS), id: z.string() }).describe('What an element card shows: a node, region, event, era, character, faction, structure, lifeform (species), waterway (a river or lake by its id from list_waterways), power or theme')
const Box = { x: z.number().optional(), y: z.number().optional(), w: z.number().min(40).max(20_000).optional(), h: z.number().min(40).max(20_000).optional() }

/** What an element card shows, by name; undefined if it's gone. */
function targetName(m: ProjectModels, view: WorldView, { kind, id }: CardTarget): string | undefined {
  const t = view.timeline
  const find = <T extends { id: string; name?: string; title?: string }>(list: readonly T[]) => {
    const r = list.find((x) => x.id === id)
    return r && (r.name ?? r.title)
  }
  switch (kind) {
    case 'node':
      return find(m.data().nodes)
    case 'region':
      return find(view.regions)
    case 'waterway':
      return t.waterways.find((w) => w.key === id)?.name || id
    case 'lifeform':
      return find(t.lifeforms)
    default:
      return find(t[`${kind}s`] as readonly { id: string; name?: string; title?: string }[])
  }
}

function describeCard(m: ProjectModels, view: WorldView, c: CanvasCard) {
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
    ...(c.target && { shows: { ...c.target, name: targetName(m, view, c.target) ?? '(gone)' } }),
    ...(c.url && { url: c.url })
  }
}

/** A card or event of the world's canvas by id, for connecting. */
function endOf(view: WorldView, id: string): { id: string; name: string } {
  const card = view.timeline.cards.find((c) => c.id === id)
  if (card) return { id, name: card.kind === 'text' ? card.text.split('\n')[0]!.slice(0, 60) || 'a card' : card.text || card.url || card.kind }
  const event = view.timeline.events.find((e) => e.id === id)
  if (event) return { id, name: event.title }
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
    run: ({ models: m }, { worldId }) => {
      const view = m.world(worldId)
      const t = view.timeline
      const name = (id: string) => t.cards.find((c) => c.id === id)?.kind ?? t.events.find((e) => e.id === id)?.title
      return {
        cards: t.cards.map((c) => describeCard(m, view, c)),
        events: t.events.filter((e) => !e.canvasHidden).map((e) => ({ id: e.id, title: e.title, ...(e.canvas && { x: e.canvas.x, y: e.canvas.y }) })),
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
    run: (ctx, p) => {
      const view = ctx.models.world(p.worldId)
      if (p.kind === 'element' && !p.target) throw new ApiError(400, 'An element card needs a target')
      if (p.kind === 'link' && !p.url) throw new ApiError(400, 'A link card needs a url')
      if (p.target && targetName(ctx.models, view, p.target) === undefined) throw new ApiError(404, `There is no ${p.target.kind} ${p.target.id} to show`)
      // To the right of what's there, level with its top.
      const cards = view.timeline.cards
      const right = cards.length ? Math.max(...cards.map((c) => c.x + c.w)) + 40 : 0
      const top = cards.length ? Math.min(...cards.map((c) => c.y)) : 0
      const id = newId()
      const size = CARD_DEFAULT_SIZE[p.kind]
      const command: Command = {
        type: 'card.create',
        payload: {
          id,
          ownerId: p.worldId,
          kind: p.kind,
          x: p.x ?? right,
          y: p.y ?? top,
          w: p.w ?? size.w,
          h: p.h ?? size.h,
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
      const patch = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))
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
      const [from, to] = [endOf(view, p.fromId), endOf(view, p.toId)]
      const id = newId()
      return write(ctx, [{ type: 'connection.create', payload: { id, ...p } }], `Connected “${from.name}” to “${to.name}” on the canvas`, { connectionId: id })
    }
  })
]
