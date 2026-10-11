import { z } from 'zod'
import { Id, RecordMeta } from './schema'
import { HexColor } from './world'

/**
 * A world's canvas (PLAN.md §9, M17), as Obsidian's Canvas has it: beside
 * the world's events, cards of its own (text, an element of the project, a
 * picture, a web link, a group round others), and connections between any
 * two of them or the events, each with a label, a colour and its arrows.
 * Where a card is and how big are its own; what's in a group is what lies
 * inside it.
 */

export const CARD_KINDS = ['text', 'element', 'image', 'link', 'group'] as const
export const CardKind = z.enum(CARD_KINDS)
export type CardKind = z.infer<typeof CardKind>

/** Obsidian's six colours (red, orange, yellow, green, cyan, purple), by number, or any colour. */
export const CANVAS_COLORS = { '1': '#e5484d', '2': '#f76b15', '3': '#ffc53d', '4': '#46a758', '5': '#0eb5c9', '6': '#8e4ec6' } as const
export const CanvasColor = z.union([z.enum(Object.keys(CANVAS_COLORS) as [keyof typeof CANVAS_COLORS]), HexColor]).nullable()
export type CanvasColor = z.infer<typeof CanvasColor>

/** A canvas colour as CSS: a numbered one's, or the colour itself; null for none. */
export const canvasColor = (color: CanvasColor | undefined): string | null => (color ? (CANVAS_COLORS[color as keyof typeof CANVAS_COLORS] ?? color) : null)

/** What an element card can show: a place in the universe tree, a region, or one of these records. */
export const CARD_TARGET_KINDS = ['node', 'region', 'event', 'era', 'character', 'faction', 'structure', 'lifeform', 'waterway', 'power', 'theme'] as const
export const CardTarget = z.object({ kind: z.enum(CARD_TARGET_KINDS), id: Id })
export type CardTarget = z.infer<typeof CardTarget>

/** A picture kept in the card: a PNG, JPEG, GIF or WebP as a data URL, up to about 4 MB. */
export const CardImage = z
  .string()
  .max(6_000_000)
  .regex(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/)
/** A web page, opened in the browser. */
export const CardUrl = z.string().max(4000).regex(/^https?:\/\/\S+$/i)

/** Sizes on the canvas plane, in px at 100%. */
export const CARD_SIZE = { min: 40, max: 20_000 } as const
const Size = z.number().min(CARD_SIZE.min).max(CARD_SIZE.max)
const Coord = z.number().min(-1e7).max(1e7)

export const CanvasCard = z.object({
  ...RecordMeta,
  kind: CardKind,
  x: Coord,
  y: Coord,
  w: Size,
  h: Size,
  color: CanvasColor,
  /** A text card's Markdown, or a group's label. */
  text: z.string().max(200_000),
  /** What an element card shows. */
  target: CardTarget.nullable(),
  /** A link card's page. */
  url: CardUrl.nullable(),
  /** A picture card's picture. */
  image: CardImage.nullable()
})
export type CanvasCard = z.infer<typeof CanvasCard>

/** How big a new card of each kind is. */
export const CARD_DEFAULT_SIZE: Record<CardKind, { w: number; h: number }> = {
  text: { w: 260, h: 140 },
  element: { w: 260, h: 120 },
  image: { w: 320, h: 240 },
  link: { w: 300, h: 90 },
  group: { w: 520, h: 360 }
}

export const SIDES = ['top', 'right', 'bottom', 'left'] as const
export const Side = z.enum(SIDES)
export type Side = z.infer<typeof Side>

/** Where a connection's arrows are: at its end (the default), its start, both or neither. */
export const ARROWS = ['end', 'start', 'both', 'none'] as const
export const Arrows = z.enum(ARROWS)
export type Arrows = z.infer<typeof Arrows>

/** A connection between two cards or events of a canvas (between two events, a timeline link is the other kind). */
export const Connection = z.object({
  ...RecordMeta,
  fromId: Id,
  toId: Id,
  /** The sides it leaves and reaches; null for the nearest. */
  fromSide: Side.nullable(),
  toSide: Side.nullable(),
  label: z.string().max(500),
  color: CanvasColor,
  arrows: Arrows
})
export type Connection = z.infer<typeof Connection>

/** The cards inside a group: those lying wholly within it (as Obsidian has it), the group itself aside. */
export function inGroup<C extends Pick<CanvasCard, 'id' | 'x' | 'y' | 'w' | 'h'>>(group: C, cards: readonly C[]): C[] {
  return cards.filter((c) => c.id !== group.id && c.x >= group.x && c.y >= group.y && c.x + c.w <= group.x + group.w && c.y + c.h <= group.y + group.h)
}
