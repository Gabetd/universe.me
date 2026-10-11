import { CARD_DEFAULT_SIZE, CARD_IMAGE_TYPES, CARD_SIZE, CardUrl, SIDES, canvasColor, inGroup, timelineOf, type CardKind, type CanvasCard, type CanvasColor, type Command, type Region, type Side, type TimelineEvent } from '@universe/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../store'
import { eventDates, locationLabel } from '../timeline/labels'
import { useCalendar } from './useSky'
import { LINK_STYLE } from '../timeline/linkStyle'
import { usePlayhead, useTimelineView } from '../timeline/timelineStore'
import { nodeDepth, project, type NodeDepth } from './canvasDepth'
import { goToEvent } from './goToEvent'
import { menuRef, useContextMenu, type MenuItem } from '../contextMenu'
import { align, arrowHead, bounds, boxBetween, connectionCurve, curveAt, curvePath, freeSpot, nearestSide, overlaps, SNAP_PX, snapBox, snapToGrid, type Box, type Curve, type Point } from './canvas/board'
import { addCard, addCardCommand, CLIPBOARD_TYPE, copyOf, deleteSelected, lastCopy, paste, readPicture, remember, runCommands, tell, toEvent, type Copied, type NewCard, type Selected } from './canvas/actions'
import { AddPalette, BoardControls, menuItems, SelectionBar, type SelectionActions } from './canvas/CanvasBars'
import { CardBody, GroupLabel, InlineEditor } from './canvas/CardView'
import { useCanvasSettings } from './canvas/canvasSettings'
import { ElementPicker, LinkDialog } from './canvas/dialogs'
import { openTarget } from './canvas/elements'

const NODE_W = 200
const NODE_H = 86
const GAP = 40
const COLUMNS = 4
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
/** Room round what a new group is put round, and above it for nothing to sit under its label. */
const GROUP_PAD = 30

interface View extends Point {
  zoom: number
}

/** Pan and zoom per world, kept while switching views. */
const views = new Map<string, View>()

/** Something on the board: an event or a card, where it is on the canvas plane. */
interface Item {
  id: string
  box: Box
  event?: TimelineEvent
  card?: CanvasCard
}

/** An item as drawn: where on screen, and how many screen px a canvas unit is there (zoom × an event's depth). */
interface Placed extends Item {
  screen: Box
  k: number
  depth?: NodeDepth
}

type Drag =
  | { kind: 'pan'; start: Point; from: View }
  | { kind: 'move'; start: Point; ids: string[]; lead: string; k: number; moved: boolean; delta: Point; guides: { x: number[]; y: number[] }; collapse: boolean; others: Box[] }
  | { kind: 'resize'; id: string; start: Point; from: Box; k: number; size: { w: number; h: number } }
  | { kind: 'marquee'; start: Point; to: Point; additive: boolean }
  | { kind: 'connect'; fromId: string; fromSide: Side; start: Point; to: Point }
  | { kind: 'link'; fromId: string; to: Point }

/** What's selected besides cards and events: a connection, or a timeline link between two events. */
type Edge = { kind: 'connection' | 'link'; id: string }

/** An event's place on the plane: where it was put, or its slot in time order; its size if it's been resized. */
const eventBox = (e: TimelineEvent, slot: number): Box => ({
  x: e.canvas?.x ?? (slot % COLUMNS) * (NODE_W + GAP),
  y: e.canvas?.y ?? Math.floor(slot / COLUMNS) * (NODE_H + GAP),
  w: e.canvas?.w ?? NODE_W,
  h: e.canvas?.h ?? NODE_H
})

/**
 * A world's canvas, as Obsidian's Canvas (PLAN.md §9, M17): every event on
 * its timeline as a card, laid out in time order until moved, receding into
 * the distance once it's over; and cards of its own (text, elements of the
 * project, pictures, web links and groups). Cards are selected (a click,
 * Shift-click or a box dragged round them), moved, resized, coloured,
 * connected by dragging from a side to another card, and deleted;
 * everything is one step to undo. Double-clicking an event goes to when and
 * where it happened.
 */
export function EventCanvas({ worldId, regions }: { worldId: string; regions: Region[] }) {
  const timeline = useUi((s) => s.timeline)
  const worldName = useUi((s) => s.nodes.find((n) => n.id === worldId)?.name ?? 'World')
  const cal = useCalendar(worldId)
  const { execute, selectTimeline } = useUi.getState()
  const playhead = usePlayhead(worldId)
  const range = useTimelineView((s) => s.ranges[worldId])
  const { snapGrid, snapObjects, readOnly } = useCanvasSettings()
  // Null until the board has a size: then it starts fitted to what's on it.
  const [savedView, setViewState] = useState<View | null>(() => views.get(worldId) ?? null)
  const [drag, setDragState] = useState<Drag | null>(null)
  // The drag as it is now, for the pointer's handlers: a quick drag can be let go before the board has drawn its last move.
  const dragNow = useRef<Drag | null>(null)
  const setDrag = (next: Drag | null) => {
    dragNow.current = next
    setDragState(next)
  }
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [edge, setEdge] = useState<Edge | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'link' | 'element'; at: Point } | null>(null)
  const [capturing, setCapturing] = useState(false)
  const boardRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /** Where a picture chosen from the file picker goes. */
  const pictureAt = useRef<Point>({ x: 0, y: 0 })
  /** The pointer on the canvas plane, for pasting there. */
  const pointer = useRef<Point | null>(null)
  const space = useRef(false)
  const size = useSize(boardRef)

  const setView = (v: View) => {
    views.set(worldId, v)
    setViewState(v)
  }

  const own = useMemo(() => timelineOf(timeline, worldId), [timeline, worldId])
  const events = useMemo(() => [...own.events].sort((a, b) => a.start - b.start), [own])
  const cards = own.cards
  const connections = own.connections
  const hiddenCount = events.filter((e) => e.canvasHidden).length
  const arranged = events.filter((e) => e.canvas)

  // The past falls away over about the timeline's visible span (or the whole history if it hasn't been shown yet).
  const horizon = range ? range.t1 - range.t0 : events.length ? events[events.length - 1]!.start - events[0]!.start : 1

  // Everything on the board, where it rests. Hidden events keep their slot, so showing one doesn't reshuffle the rest.
  const items = useMemo(() => {
    let slot = 0
    const list: Item[] = events.flatMap((event) => {
      const box = eventBox(event, slot)
      if (!event.canvas) slot++
      return event.canvasHidden && !showHidden ? [] : [{ id: event.id, box, event }]
    })
    return [...list, ...cards.map((card): Item => ({ id: card.id, box: { x: card.x, y: card.y, w: card.w, h: card.h }, card }))]
  }, [events, cards, showHidden])
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  /** The pan and zoom that show `box` (at most at 100%). */
  const viewOf = (box: Box | null): View => {
    const b = box ?? { x: 0, y: 0, w: NODE_W, h: NODE_H }
    const zoom = Math.max(MIN_ZOOM, Math.min(1, (size.w - 2 * GAP) / Math.max(1, b.w), (size.h - 2 * GAP) / Math.max(1, b.h)))
    return { zoom, x: (size.w - b.w * zoom) / 2 - b.x * zoom, y: (size.h - b.h * zoom) / 2 - b.y * zoom }
  }
  const fitted = () => viewOf(bounds(items.map((i) => i.box)))
  // It shows everything until it's first used, and stays put from then on: adding a card doesn't move the board under the pointer.
  const view = savedView ?? (size.w && size.h ? fitted() : null)
  const freeze = () => {
    if (!savedView && view) setView(view)
  }

  /** Where things are while being moved or resized: their resting place, or where the drag has them. */
  const moving = drag?.kind === 'move' && drag.moved ? new Set(drag.ids) : null
  const boxOf = (item: Item): Box => {
    if (moving?.has(item.id) && drag?.kind === 'move') return { ...item.box, x: item.box.x + drag.delta.x, y: item.box.y + drag.delta.y }
    if (drag?.kind === 'resize' && drag.id === item.id) return { ...item.box, ...drag.size }
    return item.box
  }

  const placed = useMemo(() => {
    const out = new Map<string, Placed>()
    if (!view) return out
    for (const item of items) {
      const box = boxOf(item)
      const flat = { x: view.x + box.x * view.zoom, y: view.y + box.y * view.zoom, w: box.w * view.zoom, h: box.h * view.zoom }
      if (!item.event) {
        out.set(item.id, { ...item, box, screen: flat, k: view.zoom })
        continue
      }
      // An event recedes toward the board's middle once it's over.
      const depth = nodeDepth(item.event, playhead, horizon)
      const k = view.zoom * depth.scale
      const [cx, cy] = project(flat.x + flat.w / 2, flat.y + flat.h / 2, size.w / 2, size.h / 2, depth.scale)
      out.set(item.id, { ...item, box, depth, k, screen: { x: cx - (box.w * k) / 2, y: cy - (box.h * k) / 2, w: box.w * k, h: box.h * k } })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `boxOf` reads `drag`
  }, [items, drag, playhead, horizon, view, size])

  const toPlane = (p: Point): Point => (view ? { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom } : p)
  const boardPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = boardRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const middle = () => toPlane({ x: size.w / 2, y: size.h / 2 })

  const selectedItems = [...selected].flatMap((id) => (placed.has(id) ? [placed.get(id)!] : []))
  const selectedCards = selectedItems.flatMap((i) => (i.card ? [i.card] : []))
  const selectedEvents = selectedItems.flatMap((i) => (i.event ? [i.event] : []))

  // The events selected are the timeline's selection too (the inspector shows one); a link likewise.
  useEffect(() => {
    if (selectedEvents.length) selectTimeline({ kind: 'event', ids: selectedEvents.map((e) => e.id) })
    else if (edge?.kind === 'link') selectTimeline({ kind: 'link', ids: [edge.id] })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the selection changes
  }, [selected, edge])

  const select = (ids: Iterable<string>) => {
    setSelected(new Set(ids))
    setEdge(null)
  }
  const clear = () => {
    select([])
    setEditing(null)
  }
  /** Selects a connection or a timeline link (and nothing else). */
  const selectEdge = (picked: Edge) => {
    setSelected(new Set())
    setEdge(picked)
  }
  // Stable, for the memoized cards.
  const stopEditing = useCallback(() => setEditing(null), [])

  /** What moves with the selection: it, and what lies inside the groups in it. */
  const withContents = (ids: Iterable<string>) => {
    const out = new Set(ids)
    for (const id of out) {
      const item = byId.get(id)
      if (item?.card?.kind === 'group') for (const inner of inGroup({ id, ...item.box }, items.map((i) => ({ id: i.id, ...i.box })))) out.add(inner.id)
    }
    return [...out]
  }

  // Changes, each one step to undo.
  const run = (commands: Command[]) => void runCommands(commands)
  /** Puts an item at a place on the plane and (resized) a size: an event keeps its place on the canvas, a card its own. */
  const boxCommand = (item: Item, patch: Partial<Box>): Command => {
    const rounded = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, Math.round(v)]))
    return item.event
      ? { type: 'event.update', payload: { id: item.id, patch: { canvas: { x: item.box.x, y: item.box.y, ...item.event.canvas, ...rounded } } } }
      : { type: 'card.update', payload: { id: item.id, patch: rounded } }
  }
  /** Deletes `what` and clears the selection. */
  const remove = (what: Partial<Selected>) => {
    deleteSelected({ cards: [], events: [], ...what })
    clear()
  }
  const recolor = (color: CanvasColor) =>
    run([
      ...selectedCards.map((c): Command => ({ type: 'card.update', payload: { id: c.id, patch: { color } } })),
      // An event's colour is the timeline's too, so always a colour.
      ...(color ? selectedEvents.map((e): Command => ({ type: 'event.update', payload: { id: e.id, patch: { color: canvasColor(color)! } } })) : [])
    ])

  const addAt = async (card: NewCard, at: Point, edit = false) => {
    const id = await addCard(worldId, card, at)
    if (!id) return
    select([id])
    if (edit) setEditing(id)
  }
  /** The middle of the view, or the nearest place to it not covered, for a card of `kind` added from the toolbar. */
  const freeMiddle = (kind: CardKind) => freeSpot(middle(), CARD_DEFAULT_SIZE[kind], items.map((i) => i.box))
  const startAdding = (kind: CardKind, at: Point = freeMiddle(kind)) => {
    if (kind === 'text') return void addAt({ kind: 'text', text: '' }, at, true)
    if (kind === 'image') {
      pictureAt.current = at
      return fileRef.current!.click()
    }
    if (kind === 'group') return groupSelection(at)
    setDialog({ kind, at })
  }
  /** A group round what's selected, or an empty one at `at`. */
  const groupSelection = (at: Point) => {
    const round = bounds(selectedItems.map((i) => i.box))
    if (!round) return void addAt({ kind: 'group', text: 'Group' }, at, true)
    const box = { x: round.x - GROUP_PAD, y: round.y - GROUP_PAD, w: round.w + 2 * GROUP_PAD, h: round.h + 2 * GROUP_PAD }
    void addAt({ kind: 'group', text: 'Group', w: box.w, h: box.h }, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, true)
  }
  const addPictures = async (files: File[], at: Point) => {
    const read = await Promise.all(files.map(readPicture))
    run(
      read.flatMap((picture, i) => {
        if (!('error' in picture)) return [addCardCommand(worldId, { kind: 'image', ...picture }, { x: at.x + i * 30, y: at.y + i * 30 }).command]
        tell(picture.error)
        return []
      })
    )
  }
  const duplicate = async () => {
    if (!selectedCards.length) return
    const corner = bounds(selectedCards)!
    const ids = await paste(worldId, copyOf(selectedCards, connections), { x: corner.x + 30, y: corner.y + 30 })
    if (ids.length) select(ids)
  }

  // Copying, cutting and pasting cards (Edit menu or keys), pictures and text from elsewhere, while the board has the keyboard.
  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    if (!selectedCards.length) return
    e.preventDefault()
    const copied = remember(copyOf(selectedCards, connections))
    e.clipboardData?.setData(CLIPBOARD_TYPE, JSON.stringify(copied))
    e.clipboardData?.setData('text/plain', selectedCards.map((c) => c.text || c.url || '').filter(Boolean).join('\n\n'))
    if (cut && !readOnly) deleteSelected({ cards: selectedCards, events: [] })
  }
  const onPaste = async (e: ClipboardEvent) => {
    if (readOnly) return
    e.preventDefault()
    freeze()
    const at = pointer.current ?? middle()
    const data = e.clipboardData
    const ours = data?.getData(CLIPBOARD_TYPE)
    const files = [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    const text = data?.getData('text/plain').trim()
    const copied = lastCopy()
    if (ours || (copied && !files.length && !text)) {
      const ids = await paste(worldId, ours ? (JSON.parse(ours) as Copied) : copied!, at)
      if (ids.length) select(ids)
    } else if (files.length) await addPictures(files, at)
    else if (text && CardUrl.safeParse(text).success) void addAt({ kind: 'link', url: text }, at)
    else if (text) void addAt({ kind: 'text', text }, at)
  }
  // Listened for once; the handlers of the latest render are the ones called.
  const clipboard = useRef({ onCopy, onPaste })
  useEffect(() => {
    clipboard.current = { onCopy, onPaste }
  })
  useEffect(() => {
    const focused = () => document.activeElement === boardRef.current
    const copy = (e: ClipboardEvent) => focused() && clipboard.current.onCopy(e, false)
    const cut = (e: ClipboardEvent) => focused() && clipboard.current.onCopy(e, true)
    const pasted = (e: ClipboardEvent) => focused() && void clipboard.current.onPaste(e)
    document.addEventListener('copy', copy)
    document.addEventListener('cut', cut)
    document.addEventListener('paste', pasted)
    return () => {
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', cut)
      document.removeEventListener('paste', pasted)
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Typing in a card or a label is the editor's.
    if (e.target !== boardRef.current) return
    const mod = e.ctrlKey || e.metaKey
    const handled = () => (e.preventDefault(), e.stopPropagation())
    if (e.key === ' ') return void ((space.current = true), handled())
    if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) {
      handled()
      return remove({ cards: selectedCards, events: selectedEvents, ...(edge?.kind === 'connection' ? { connectionId: edge.id } : edge ? { linkId: edge.id } : {}) })
    }
    if (e.key === 'Escape') return void (handled(), clear())
    if (mod && e.key.toLowerCase() === 'a') return void (handled(), select(placed.keys()))
    if (mod && e.key.toLowerCase() === 'd' && !readOnly) return void (handled(), void duplicate())
    if (e.shiftKey && e.code === 'Digit1') return void (handled(), setView(fitted()))
    if (e.shiftKey && e.code === 'Digit2' && selectedItems.length) return void (handled(), zoomToSelection())
    if (e.shiftKey && e.code === 'Digit0') return void (handled(), zoomAbout(1 / (view?.zoom ?? 1)))
  }

  const zoomAbout = (factor: number, at: Point = { x: size.w / 2, y: size.h / 2 }) => {
    if (!view) return
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor))
    setView({ zoom, x: at.x - ((at.x - view.x) * zoom) / view.zoom, y: at.y - ((at.y - view.y) * zoom) / view.zoom })
  }
  const zoomToSelection = () => setView(viewOf(bounds(selectedItems.map((i) => i.box))))

  const onWheel = (e: React.WheelEvent) => zoomAbout(Math.exp(-e.deltaY * 0.001), boardPoint(e))

  const capture = (e: React.PointerEvent) => {
    boardRef.current!.setPointerCapture(e.pointerId)
    boardRef.current!.focus({ preventScroll: true })
  }

  const onBoardPointerDown = (e: React.PointerEvent) => {
    if (!view) return
    const panning = e.button === 1 || (e.button === 0 && (space.current || e.pointerType === 'touch'))
    if (!panning && e.button !== 0) return
    capture(e)
    setEditing(null)
    if (panning) return setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, from: view })
    const p = boardPoint(e)
    setDrag({ kind: 'marquee', start: p, to: p, additive: e.shiftKey })
  }

  const onItemPointerDown = (e: React.PointerEvent, item: Placed) => {
    if (e.button !== 0) return
    e.stopPropagation()
    // The pointer is the board's only once the item is moved: a click or double-click stays the item's.
    boardRef.current!.focus({ preventScroll: true })
    if (space.current) return capture(e), setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, from: view! })
    setEdge(null)
    let ids = selected
    // A click on one of several selected keeps them all only if it drags them; a plain click selects just it.
    const collapse = !e.shiftKey && selected.has(item.id) && selected.size > 1
    if (e.shiftKey) {
      const next = new Set(selected)
      if (next.has(item.id)) {
        next.delete(item.id)
        return setSelected(next)
      }
      ids = next.add(item.id)
      setSelected(ids)
    } else if (!selected.has(item.id)) setSelected((ids = new Set([item.id])))
    if (readOnly || editing === item.id) return collapse ? void setSelected(new Set([item.id])) : undefined
    const moved = withContents(ids)
    // What it may snap to: everything not moving with it.
    const others = items.filter((i) => !moved.includes(i.id)).map((i) => i.box)
    setDrag({ kind: 'move', start: { x: e.clientX, y: e.clientY }, ids: moved, lead: item.id, k: item.k, moved: false, delta: { x: 0, y: 0 }, guides: { x: [], y: [] }, collapse, others })
  }

  /** A handle's drag (resizing, connecting, linking): the board's from the start. */
  const startDrag = (e: React.PointerEvent, make: (p: Point) => Drag) => {
    if (e.button !== 0 || readOnly) return
    e.stopPropagation()
    capture(e)
    setDrag(make(boardPoint(e)))
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = boardPoint(e)
    pointer.current = toPlane(p)
    const drag = dragNow.current
    if (!drag || !view) return
    // The button was let go where the board didn't hear it (a click on an item not yet dragged, let go off the window).
    if (e.buttons === 0 && e.pointerType === 'mouse') return setDrag(null)
    if (drag.kind === 'marquee' || drag.kind === 'connect' || drag.kind === 'link') return setDrag({ ...drag, to: p })
    // How far the pointer has gone since the drag began, on screen.
    const [dx, dy] = [e.clientX - drag.start.x, e.clientY - drag.start.y]
    switch (drag.kind) {
      case 'pan':
        return setView({ ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy })
      case 'resize': {
        const fit = (n: number) => Math.max(CARD_SIZE.min, snapGrid ? snapToGrid(n) : n)
        return setDrag({ ...drag, size: { w: fit(drag.from.w + dx / drag.k), h: fit(drag.from.h + dy / drag.k) } })
      }
      case 'move': {
        if (!drag.moved && Math.hypot(dx, dy) <= 4) return
        if (!drag.moved) boardRef.current!.setPointerCapture(e.pointerId)
        // A receded event is drawn smaller, so the same mouse move covers more of the plane.
        const lead = byId.get(drag.lead)!.box
        const want = { ...lead, x: lead.x + dx / drag.k, y: lead.y + dy / drag.k }
        const snapped = snapBox(want, drag.others, { grid: snapGrid, objects: snapObjects, slack: SNAP_PX / view.zoom })
        return setDrag({ ...drag, moved: true, delta: { x: snapped.at.x - lead.x, y: snapped.at.y - lead.y }, guides: snapped.guides })
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const p = boardPoint(e)
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-item-id]')?.dataset.itemId
    const drag = dragNow.current
    setDrag(null)
    if (!drag) return
    switch (drag.kind) {
      case 'move':
        if (!drag.moved && drag.collapse) return setSelected(new Set([drag.lead]))
        if (drag.moved)
          run(
            drag.ids.flatMap((id) => {
              const item = byId.get(id)
              return item ? [boxCommand(item, { x: item.box.x + drag.delta.x, y: item.box.y + drag.delta.y })] : []
            })
          )
        return
      case 'resize':
        return run([boxCommand(byId.get(drag.id)!, drag.size)])
      case 'marquee': {
        const box = boxBetween(drag.start, drag.to)
        if (box.w < 4 && box.h < 4) return clear()
        const hits = [...placed.values()].filter((i) => overlaps(i.screen, box)).map((i) => i.id)
        return select(drag.additive ? [...selected, ...hits] : hits)
      }
      case 'link':
        if (under && under !== drag.fromId && byId.get(under)?.event) run([{ type: 'link.create', payload: { fromId: drag.fromId, toId: under } }])
        return
      case 'connect': {
        const target = under && under !== drag.fromId ? placed.get(under) : undefined
        if (target) {
          return run([{ type: 'connection.create', payload: { fromId: drag.fromId, toId: target.id, fromSide: drag.fromSide, toSide: nearestSide(target.screen, p) } }])
        }
        // Dropped on the board: a new card there, connected, to write in (not for a handle only clicked).
        if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 20) return
        const { id, command } = addCardCommand(worldId, { kind: 'text', text: '' }, toPlane(p))
        const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const
        void execute({ type: 'batch', payload: { commands: [command, { type: 'connection.create', payload: { fromId: drag.fromId, toId: id, fromSide: drag.fromSide, toSide: opposite[drag.fromSide] } }] } }).then((ok) => {
          if (!ok) return
          select([id])
          setEditing(id)
        })
      }
    }
  }

  const onDoubleClickItem = (e: React.MouseEvent, item: Placed) => {
    e.stopPropagation()
    if (item.event) return goToEvent(item.event)
    const card = item.card!
    if (card.kind === 'element') return openTarget(card.target!)
    if (card.kind === 'link') return void window.open(card.url!, '_blank')
    if ((card.kind === 'text' || card.kind === 'group') && !readOnly) setEditing(card.id)
  }

  const onContextMenu = (e: React.MouseEvent) => {
    // An event's own menu is the app's (data-menu).
    if ((e.target as Element).closest('[data-menu]')) return
    e.preventDefault()
    const at = toPlane(boardPoint(e))
    const cardId = (e.target as Element).closest<HTMLElement>('[data-item-id]')?.dataset.itemId
    const card = cardId ? byId.get(cardId)?.card : undefined
    const open = (title: string, items: MenuItem[]) => useContextMenu.getState().open({ x: e.clientX, y: e.clientY, title, items })
    const connectionId = (e.target as Element).closest<SVGElement>('[data-connection-id]')?.dataset.connectionId
    if (connectionId) {
      const picked: Edge = { kind: 'connection', id: connectionId }
      selectEdge(picked)
      return open('Connection', menuItems(actionsFor([], [], picked)))
    }
    if (card) {
      if (!selected.has(card.id)) select([card.id])
      return open(card.kind === 'group' ? card.text || 'Group' : 'Card', menuItems(actionsFor([card], [], null)))
    }
    const adding: MenuItem[] = readOnly
      ? []
      : [
          { label: 'Add a card here', run: () => startAdding('text', at) },
          { label: 'Add an element here…', run: () => startAdding('element', at) },
          { label: 'Add a picture here…', run: () => startAdding('image', at) },
          { label: 'Add a web page here…', run: () => startAdding('link', at) },
          { label: 'Add a group here', run: () => void addAt({ kind: 'group', text: 'Group' }, at, true) },
          'separator'
        ]
    open('Canvas', [...adding, { label: 'Select all', run: () => select(placed.keys()) }, { label: 'Zoom to fit', run: () => setView(fitted()) }])
  }

  /** What can be done with a selection, for its bar and its right-click menu. */
  function actionsFor(cards: CanvasCard[], evs: TimelineEvent[], selectedEdge: Edge | null): SelectionActions {
    const writable = !readOnly
    if (selectedEdge?.kind === 'connection') {
      const c = connections.find((x) => x.id === selectedEdge.id)
      if (!c) return {}
      const set = (patch: object) => run([{ type: 'connection.update', payload: { id: c.id, patch } }])
      return writable
        ? { onEdit: () => setEditing(`label:${c.id}`), onColor: (color) => set({ color }), allowNone: true, arrows: c.arrows, onArrows: (arrows) => set({ arrows }), onDelete: () => remove({ connectionId: c.id }) }
        : {}
    }
    if (selectedEdge?.kind === 'link') return writable ? { onDelete: () => remove({ linkId: selectedEdge.id }) } : {}
    const count = cards.length + evs.length
    if (!count) return {}
    const one = count === 1 ? cards[0] : undefined
    const boxes = [...cards, ...evs].flatMap(({ id }) => (byId.has(id) ? [{ id, ...byId.get(id)!.box }] : []))
    return {
      onZoom: () => setView(viewOf(bounds(boxes))),
      ...(one?.kind === 'element' && { onOpen: () => openTarget(one.target!) }),
      ...(one?.kind === 'link' && { onBrowser: () => void window.open(one.url!, '_blank') }),
      ...(count === 1 && evs[0] && { onGoTo: () => goToEvent(evs[0]!) }),
      ...(writable && {
        onDelete: () => remove({ cards, events: evs }),
        onColor: recolor,
        allowNone: !evs.length,
        ...((one?.kind === 'text' || one?.kind === 'group') && { onEdit: () => setEditing(one.id) }),
        ...(one?.kind === 'text' && { onToEvent: () => void toEvent(one, connections, playhead).then(clear) }),
        ...(cards.length && !evs.length && { onDuplicate: () => void duplicate() }),
        ...(count > 1 && {
          onGroup: () => groupSelection(middle()),
          onAlign: (how) => {
            const to = align(boxes, how)
            run(boxes.map((b) => boxCommand(byId.get(b.id)!, to.get(b.id)!)))
          }
        })
      })
    }
  }

  // The connections as drawn: curves between the boxes on screen, from the sides they're given or that face each other.
  const curveOf = (fromId: string, toId: string, fromSide: Side | null, toSide: Side | null): Curve | null => {
    const a = placed.get(fromId)
    const b = placed.get(toId)
    return a && b ? connectionCurve(a.screen, b.screen, fromSide, toSide) : null
  }
  const drawn = connections.flatMap((c) => {
    const curve = curveOf(c.fromId, c.toId, c.fromSide, c.toSide)
    return curve ? [{ c, curve }] : []
  })
  const links = own.links.flatMap((l) => {
    const curve = curveOf(l.fromId, l.toId, null, null)
    if (!curve) return []
    const depth = Math.max(placed.get(l.fromId)!.depth?.depth ?? 0, placed.get(l.toId)!.depth?.depth ?? 0)
    return [{ l, curve, depth }]
  })

  // Groups at the back, the biggest first; then events (the farthest back first, so nearer ones are drawn and clicked over them) and cards.
  const ordered = [...placed.values()].sort((a, b) => rank(a) - rank(b))
  const selection = selectedItems.length ? bounds(selectedItems.map((i) => i.screen)) : null
  const edgeCurve = edge && (edge.kind === 'connection' ? drawn.find((d) => d.c.id === edge.id)?.curve : links.find((d) => d.l.id === edge.id)?.curve)
  const barAt = edgeCurve ? curveAt(edgeCurve, 0.5) : selection && { x: selection.x + selection.w / 2, y: selection.y }
  const actions = actionsFor(selectedCards, selectedEvents, edge)
  const marquee = drag?.kind === 'marquee' ? boxBetween(drag.start, drag.to) : null
  const draft = drag?.kind === 'connect' || drag?.kind === 'link' ? placed.get(drag.fromId) : undefined

  const exportImage = async () => {
    if (!size.w) return
    const before = view
    setCapturing(true)
    setView(fitted())
    // Once it's drawn there (events glide into place).
    await new Promise((done) => setTimeout(done, 400))
    const r = boardRef.current!.getBoundingClientRect()
    await useUi.getState().run(window.universe.exportImage({ x: r.left, y: r.top, width: r.width, height: r.height }, `${worldName} canvas`))
    if (before) setView(before)
    setCapturing(false)
  }

  return (
    // Anything done on it (a click, a key, a drop; a paste freezes it itself) keeps the view where it is from then on.
    <div className="event-canvas" onPointerDownCapture={freeze} onKeyDownCapture={freeze} onDropCapture={freeze}>
      <div className="event-canvas-bar" role="toolbar" aria-label="Canvas">
        {!readOnly && <AddPalette onAdd={(kind) => startAdding(kind)} />}
        <span className="canvas-bar-gap" />
        <button
          disabled={arranged.length === 0 || readOnly}
          title="Put every event back in time order"
          onClick={() => void execute({ type: 'batch', payload: { commands: arranged.map((ev) => ({ type: 'event.update', payload: { id: ev.id, patch: { canvas: null } } })) } })}
        >
          Arrange by time
        </button>
        <button aria-pressed={showHidden} disabled={hiddenCount === 0 && !showHidden} onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? 'Hide hidden nodes' : `Show hidden (${hiddenCount})`}
        </button>
        {view && <BoardControls zoom={view.zoom} onZoom={(f) => zoomAbout(f)} onReset={() => zoomAbout(1 / view.zoom)} onFit={() => setView(fitted())} onSelection={selectedItems.length ? zoomToSelection : undefined} onExport={() => void exportImage()} />}
      </div>
      <div
        ref={boardRef}
        tabIndex={0}
        aria-label={`${worldName}’s canvas`}
        className={`event-board${drag ? ' dragging' : ''}${capturing ? ' capturing' : ''}${readOnly ? ' read-only' : ''}`}
        data-testid="event-canvas"
        style={view ? { backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${32 * view.zoom}px ${32 * view.zoom}px` } : undefined}
        onWheel={onWheel}
        onPointerDown={onBoardPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.key === ' ' && (space.current = false)}
        onBlur={() => (space.current = false)}
        onDoubleClick={(e) => !readOnly && e.target === boardRef.current && void addAt({ kind: 'text', text: '' }, toPlane(boardPoint(e)), true)}
        onContextMenu={onContextMenu}
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          if (!readOnly) void addPictures([...e.dataTransfer.files], toPlane(boardPoint(e)))
        }}
      >
        {ordered.filter((i) => i.card?.kind === 'group').map((item) => renderItem(item))}

        <svg className="event-links" width={size.w} height={size.h}>
          {links.map(({ l, curve, depth }) => {
            const style = LINK_STYLE[l.type]
            const d = curvePath(curve)
            return (
              <g key={l.id} className={`canvas-link${edge?.id === l.id ? ' selected' : ''}`} data-link-id={l.id} style={{ opacity: 1 - 0.4 * depth }}>
                <path d={d} className="canvas-link-hit" data-menu={menuRef('link', l.id)} onPointerDown={(e) => (e.stopPropagation(), selectEdge({ kind: 'link', id: l.id }))} />
                <path d={d} stroke={style.color} strokeDasharray={style.dash} fill="none" />
                {style.arrow && <polygon points={arrowHead(curve, true, 10)} fill={style.color} />}
              </g>
            )
          })}
          {drawn.map(({ c, curve }) => {
            const color = canvasColor(c.color) ?? '#aab4d0'
            const d = curvePath(curve)
            return (
              <g key={c.id} className={`canvas-link canvas-connection${edge?.id === c.id ? ' selected' : ''}`} data-connection-id={c.id}>
                <path
                  d={d}
                  className="canvas-link-hit"
                  aria-label={c.label || 'Connection'}
                  onPointerDown={(e) => (e.stopPropagation(), boardRef.current!.focus({ preventScroll: true }), selectEdge({ kind: 'connection', id: c.id }))}
                  onDoubleClick={(e) => (e.stopPropagation(), !readOnly && setEditing(`label:${c.id}`))}
                />
                <path d={d} stroke={color} fill="none" />
                {(c.arrows === 'end' || c.arrows === 'both') && <polygon points={arrowHead(curve, true, 12)} fill={color} />}
                {(c.arrows === 'start' || c.arrows === 'both') && <polygon points={arrowHead(curve, false, 12)} fill={color} />}
              </g>
            )
          })}
          {draft && drag && 'to' in drag && <path d={`M ${draft.screen.x + draft.screen.w / 2} ${draft.screen.y + draft.screen.h / 2} L ${drag.to.x} ${drag.to.y}`} stroke="#fff" strokeDasharray="4 4" fill="none" />}
          {drag?.kind === 'move' && drag.moved && view && (
            <g className="canvas-guides">
              {drag.guides.x.map((x) => (
                <line key={`x${x}`} x1={view.x + x * view.zoom} x2={view.x + x * view.zoom} y1={0} y2={size.h} />
              ))}
              {drag.guides.y.map((y) => (
                <line key={`y${y}`} y1={view.y + y * view.zoom} y2={view.y + y * view.zoom} x1={0} x2={size.w} />
              ))}
            </g>
          )}
        </svg>

        {drawn.map(({ c, curve }) => {
          const at = curveAt(curve, 0.5)
          if (editing === `label:${c.id}`)
            return (
              <InlineEditor
                key={c.id}
                label="Connection label"
                className="canvas-edge-label editing"
                style={{ left: at.x, top: at.y }}
                value={c.label}
                onDone={(text) => {
                  const label = text.trim()
                  setEditing(null)
                  if (label !== c.label) run([{ type: 'connection.update', payload: { id: c.id, patch: { label } } }])
                }}
              />
            )
          return c.label ? (
            <div key={c.id} className="canvas-edge-label" style={{ left: at.x, top: at.y }} onDoubleClick={() => !readOnly && setEditing(`label:${c.id}`)} onPointerDown={(e) => (e.stopPropagation(), selectEdge({ kind: 'connection', id: c.id }))}>
              {c.label}
            </div>
          ) : null
        })}

        {ordered.filter((i) => i.card?.kind !== 'group').map((item) => renderItem(item))}

        {marquee && <div className="canvas-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        {barAt && !drag && !editing && !capturing && Object.keys(actions).length > 0 && <SelectionBar at={{ x: barAt.x, y: Math.max(8, barAt.y - 52) }} actions={actions} />}
        {items.length === 0 && (
          <p className="canvas-empty muted">
            The world’s events show up here, beside cards of your own: double-click to write one, or add one from the toolbar. Drag to select, Space-drag to pan, scroll to zoom; drag from a card’s side onto another to connect them.
          </p>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={CARD_IMAGE_TYPES.join(',')}
        multiple
        hidden
        aria-label="Picture for the canvas"
        onChange={(e) => {
          void addPictures([...(e.target.files ?? [])], pictureAt.current)
          e.target.value = ''
        }}
      />
      {dialog?.kind === 'link' && <LinkDialog onClose={() => setDialog(null)} onAdd={(url) => (setDialog(null), void addAt({ kind: 'link', url }, dialog.at))} />}
      {dialog?.kind === 'element' && <ElementPicker worldId={worldId} onClose={() => setDialog(null)} onPick={(target) => (setDialog(null), void addAt({ kind: 'element', target }, dialog.at))} />}
    </div>
  )

  function renderItem(item: Placed) {
    const isSelected = selected.has(item.id)
    const dragging = moving?.has(item.id) ?? false
    const handles = !readOnly && !capturing && (
      <>
        {SIDES.map((side) => (
          <span key={side} className={`side-handle ${side}`} title="Drag onto another card to connect them" aria-label={`Connect from the ${side}`} onPointerDown={(e) => startDrag(e, (p) => ({ kind: 'connect', fromId: item.id, fromSide: side, start: p, to: p }))} />
        ))}
        <span className="resize-handle" title="Drag to resize" aria-label="Resize" onPointerDown={(e) => startDrag(e, () => ({ kind: 'resize', id: item.id, start: { x: e.clientX, y: e.clientY }, from: item.box, k: item.k, size: { w: item.box.w, h: item.box.h } }))} />
      </>
    )
    if (item.event) {
      const ev = item.event
      const depth = item.depth!
      const classes = ['event-node', 'canvas-item', depth.when, isSelected && 'selected', ev.canvasHidden && 'hidden-node', dragging && 'dragging']
      return (
        <div
          key={ev.id}
          data-event-id={ev.id}
          data-item-id={ev.id}
          data-menu={menuRef('event', ev.id)}
          className={classes.filter(Boolean).join(' ')}
          role="button"
          aria-label={ev.title}
          aria-pressed={isSelected}
          title={depth.when === 'future' ? 'Hasn’t happened yet at the playhead' : undefined}
          style={{
            width: item.box.w,
            height: item.box.h,
            borderTopColor: ev.color,
            transform: `translate(${item.screen.x}px, ${item.screen.y}px) scale(${item.k})`,
            opacity: (ev.canvasHidden ? 0.4 : 1) * (depth.when === 'future' ? 0.6 : 1 - 0.35 * depth.depth),
            filter: depth.depth > 0.05 ? `brightness(${1 - 0.3 * depth.depth})` : undefined
          }}
          onPointerDown={(e) => onItemPointerDown(e, item)}
          onDoubleClick={(e) => onDoubleClickItem(e, item)}
        >
          <div className="event-node-head">
            <b>{ev.title}</b>
            <button
              className="link"
              aria-label={ev.canvasHidden ? `Show ${ev.title}` : `Hide ${ev.title}`}
              title={ev.canvasHidden ? 'Show on the canvas' : 'Hide from the canvas'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => run([{ type: 'event.update', payload: { id: ev.id, patch: { canvasHidden: !ev.canvasHidden } } }])}
            >
              {ev.canvasHidden ? '👁' : '✕'}
            </button>
          </div>
          <div className="muted small">{eventDates(ev, cal)}</div>
          <div className="small event-node-place">{ev.locations.length ? ev.locations.map((l) => locationLabel(l, regions)).join(' · ') : <span className="muted">No place yet</span>}</div>
          {!readOnly && (
            <span className="event-node-handle" aria-label={`Link ${ev.title} to…`} title="Drag onto another node to link them" onPointerDown={(e) => startDrag(e, (p) => ({ kind: 'link', fromId: item.id, to: p }))}>
              ●
            </span>
          )}
          {handles}
        </div>
      )
    }
    const card = item.card!
    const color = canvasColor(card.color)
    const editingThis = editing === card.id
    return (
      <div
        key={card.id}
        data-item-id={card.id}
        className={['canvas-card', 'canvas-item', `card-${card.kind}`, isSelected && 'selected', dragging && 'dragging', editingThis && 'editing'].filter(Boolean).join(' ')}
        role="group"
        aria-label={card.kind === 'group' ? `Group ${card.text}` : `${card.kind} card`}
        style={{
          width: item.box.w,
          height: item.box.h,
          transform: `translate(${item.screen.x}px, ${item.screen.y}px) scale(${item.k})`,
          ...(color && ({ borderColor: color, '--card-color': color } as React.CSSProperties))
        }}
        onPointerDown={(e) => onItemPointerDown(e, item)}
        onDoubleClick={(e) => onDoubleClickItem(e, item)}
      >
        {card.kind === 'group' ? <GroupLabel card={card} editing={editingThis} onDone={stopEditing} /> : <CardBody card={card} editing={editingThis} onDone={stopEditing} />}
        {handles}
      </div>
    )
  }
}

/** Groups first (the biggest at the back), then events (the farthest back first), then cards. */
const rank = (i: Placed) => (i.card?.kind === 'group' ? -1e12 + 1 / Math.max(1, i.box.w * i.box.h) : i.event ? (i.depth?.depth ?? 0) * -1 : 1)

/** The element's size in CSS pixels, kept current. */
function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current!
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}
