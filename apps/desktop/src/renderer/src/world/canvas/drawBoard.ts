import { canvasColor, type CanvasCard } from '@universe/core'
import { arrowHead, bounds, type Box, type Curve } from './board'
import { elementSummary } from './elements'

/**
 * Export as image (PLAN.md §9, M21): the board drawn from what's on it,
 * not captured from the window, so it's the whole board at full size
 * whatever the view (and nothing over it, such as a menu, gets in): events as
 * they're laid out, cards with their text, pictures and labels, groups, and
 * the lines between them.
 */

/** Something on the board as it's drawn into the picture: an event's card, or a card of the canvas's own. */
export type Drawn =
  | { box: Box; event: { title: string; dates: string; place: string; color: string } }
  | { box: Box; card: CanvasCard }

/** A line between two things: a connection (its colour, label and arrows) or a timeline link (its style). */
export interface DrawnLine {
  curve: Curve
  color: string
  dash?: number[]
  arrows: { start: boolean; end: boolean }
  label?: string
}

/** Room round what's on the board, in px. */
const PAD = 40
/** Pixels per px of the board: crisp on a high-density screen. */
const SCALE = 2
/** A side of the picture at most (canvases are limited), in pixels. */
const MAX_SIDE = 16_000

/** The app's colours, as its stylesheet has them now (themes change them). */
function colours() {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return { bg: read('--bg', '#0b0e17'), panel: read('--panel-2', '#161c30'), border: read('--border', '#232b45'), text: read('--text', '#dde3f5'), muted: read('--muted', '#8891ad') }
}

/** The board as a PNG: what's on it, its lines below its cards, groups at the back. */
export async function drawBoard(items: readonly Drawn[], lines: readonly DrawnLine[]): Promise<Uint8Array> {
  const area = bounds(items.map((i) => i.box)) ?? { x: 0, y: 0, w: 200, h: 100 }
  const [w, h] = [area.w + 2 * PAD, area.h + 2 * PAD]
  const scale = Math.min(SCALE, MAX_SIDE / w, MAX_SIDE / h)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(w * scale)
  canvas.height = Math.ceil(h * scale)
  const c = canvas.getContext('2d')!
  const col = colours()
  c.scale(scale, scale)
  c.translate(PAD - area.x, PAD - area.y)
  c.fillStyle = col.bg
  c.fillRect(area.x - PAD, area.y - PAD, w, h)
  const pictures = await loadPictures(items)
  const groups = items.filter((i) => 'card' in i && i.card.kind === 'group').sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
  for (const item of groups) drawItem(c, item, col, pictures)
  for (const line of lines) drawLine(c, line, col)
  for (const item of items) if (!groups.includes(item)) drawItem(c, item, col, pictures)
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
  if (!blob) throw new Error('The picture of the board couldn’t be made')
  return new Uint8Array(await blob.arrayBuffer())
}

/** The pictures of the board's picture cards, loaded (one that won't load is left out). */
async function loadPictures(items: readonly Drawn[]): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>()
  await Promise.all(
    items.flatMap((i) => {
      if (!('card' in i) || i.card.kind !== 'image' || !i.card.image) return []
      const img = new Image()
      img.src = i.card.image
      return [img.decode().then(() => void out.set(i.card.id, img), () => {})]
    })
  )
  return out
}

type Colours = ReturnType<typeof colours>

function drawItem(c: CanvasRenderingContext2D, item: Drawn, col: Colours, pictures: Map<string, HTMLImageElement>): void {
  const { x, y, w, h } = item.box
  if ('event' in item) {
    box(c, item.box, col.panel, col.border)
    c.fillStyle = item.event.color
    c.fillRect(x, y, w, 3)
    text(c, [{ text: item.event.title, font: 'bold 13px', color: col.text }, { text: item.event.dates, font: '11px', color: col.muted }, { text: item.event.place, font: '11px', color: col.text }], x + 10, y + 12, w - 20, h - 16)
    return
  }
  const { card } = item
  const color = canvasColor(card.color)
  if (card.kind === 'group') {
    box(c, item.box, color ? `${color}22` : 'rgba(255,255,255,0.03)', color ?? col.border)
    text(c, [{ text: card.text || 'Group', font: 'bold 13px', color: col.text }], x + 4, y - 22, w, 20)
    return
  }
  box(c, item.box, col.panel, color ?? col.border)
  const picture = pictures.get(card.id)
  if (picture) {
    const k = Math.min(w / picture.naturalWidth, h / picture.naturalHeight)
    c.drawImage(picture, x + (w - picture.naturalWidth * k) / 2, y + (h - picture.naturalHeight * k) / 2, picture.naturalWidth * k, picture.naturalHeight * k)
    return
  }
  if (card.kind === 'element' && card.target) {
    const { name, kind, notes } = elementSummary(card.target)
    return text(c, [{ text: kind, font: '11px', color: col.muted }, { text: name, font: 'bold 13px', color: col.text }, { text: notes, font: '12px', color: col.muted }], x + 12, y + 10, w - 24, h - 16)
  }
  if (card.kind === 'link') return text(c, [{ text: `🔗 ${card.url ?? ''}`, font: '12px', color: col.text }], x + 12, y + 10, w - 24, h - 16)
  text(c, markdownLines(card.text).map((l) => ({ ...l, color: col.text })), x + 12, y + 10, w - 24, h - 16)
}

/** A rounded box, filled and outlined. */
function box(c: CanvasRenderingContext2D, { x, y, w, h }: Box, fill: string, stroke: string): void {
  c.beginPath()
  c.roundRect(x, y, w, h, 8)
  c.fillStyle = fill
  c.fill()
  c.lineWidth = 1.5
  c.strokeStyle = stroke
  c.stroke()
}

/** A Markdown card's text as lines to draw: headings bold, list items with a bullet, the marks taken out. */
export function markdownLines(markdown: string): { text: string; font: string }[] {
  return markdown.split('\n').map((line) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const plain = (heading ? heading[2]! : line)
      .replace(/^\s*[-*+]\s+/, '• ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    return { text: plain, font: heading ? `bold ${Math.max(13, 20 - heading[1]!.length * 2)}px` : '13px' }
  })
}

/** Lines of text in a box, each wrapped to its width, as many as fit. */
function text(c: CanvasRenderingContext2D, parts: { text: string; font: string; color: string }[], x: number, y: number, width: number, height: number): void {
  c.save()
  c.beginPath()
  c.rect(x, y, width, height)
  c.clip()
  c.textBaseline = 'top'
  let at = y
  for (const part of parts) {
    c.font = `${part.font} system-ui, sans-serif`
    c.fillStyle = part.color
    const size = parseInt(/(\d+)px/.exec(part.font)?.[1] ?? '13', 10)
    for (const line of wrap(c, part.text, width)) {
      if (at > y + height) break
      c.fillText(line, x, at)
      at += size * 1.35
    }
  }
  c.restore()
}

/** A text broken into lines no wider than `width` (at the context's font), at spaces where it can be. */
function wrap(c: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (c.measureText(next).width <= width || !line) line = next
    else {
      out.push(line)
      line = word
    }
  }
  if (line || !out.length) out.push(line)
  return out
}

/** A line between two things, with its arrowheads and label. */
function drawLine(c: CanvasRenderingContext2D, line: DrawnLine, col: Colours): void {
  const { from, c1, c2, to } = line.curve
  c.beginPath()
  c.moveTo(from.x, from.y)
  c.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y)
  c.setLineDash(line.dash ?? [])
  c.lineWidth = 2.5
  c.strokeStyle = line.color
  c.stroke()
  c.setLineDash([])
  for (const atEnd of [true, false]) {
    if (!(atEnd ? line.arrows.end : line.arrows.start)) continue
    const points = arrowHead(line.curve, atEnd, 12)
      .split(' ')
      .map((p) => p.split(',').map(Number) as [number, number])
    c.beginPath()
    points.forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)))
    c.closePath()
    c.fillStyle = line.color
    c.fill()
  }
  if (line.label) {
    const mid = { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 }
    c.font = '12px system-ui, sans-serif'
    const width = c.measureText(line.label).width + 12
    box(c, { x: mid.x - width / 2, y: mid.y - 11, w: width, h: 22 }, col.bg, col.border)
    c.fillStyle = col.text
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText(line.label, mid.x, mid.y)
    c.textAlign = 'start'
  }
}
