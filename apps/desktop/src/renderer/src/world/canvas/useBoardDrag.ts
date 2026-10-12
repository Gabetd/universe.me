import { CARD_SIZE, type Side } from '@universe/core'
import { useRef, useState, type RefObject } from 'react'
import { boxBetween, nearestSide, overlaps, SNAP_PX, snapBox, snapToGrid, type Box, type Point } from './board'

/** The board's pan and zoom. */
export interface BoardView extends Point {
  zoom: number
}

/** Something on the board, where it rests on the plane. */
export interface BoardItem {
  id: string
  box: Box
}

/** An item as drawn: where on screen, and how many screen px a canvas unit is there. */
export interface PlacedItem extends BoardItem {
  screen: Box
  k: number
}

/** A drag on the board: panning it, moving or resizing what's on it, a box drawn round things, or a line drawn from one thing to another. */
export type Drag =
  | { kind: 'pan'; start: Point; from: BoardView }
  | { kind: 'move'; start: Point; ids: string[]; lead: string; k: number; moved: boolean; delta: Point; guides: { x: number[]; y: number[] }; collapse: boolean; others: Box[] }
  | { kind: 'resize'; id: string; start: Point; from: Box; k: number; size: { w: number; h: number } }
  | { kind: 'marquee'; start: Point; to: Point; additive: boolean }
  | { kind: 'connect'; fromId: string; fromSide: Side; start: Point; to: Point }
  | { kind: 'link'; fromId: string; to: Point }

/** What a drag reads of the board as it is now. */
export interface BoardNow {
  view: BoardView | null
  items: readonly BoardItem[]
  byId: ReadonlyMap<string, BoardItem>
  placed: ReadonlyMap<string, PlacedItem>
  selected: ReadonlySet<string>
  editing: string | null
  readOnly: boolean
  snap: { grid: boolean; objects: boolean }
}

/** What a drag does to the board as it goes and when it's let go. */
export interface BoardDragActions {
  setView(view: BoardView): void
  setSelected(ids: ReadonlySet<string>): void
  select(ids: Iterable<string>): void
  clear(): void
  setEditing(id: string | null): void
  /** What moves with these: them, and what lies in the groups among them. */
  withContents(ids: Iterable<string>): string[]
  moved(ids: readonly string[], delta: Point): void
  resized(id: string, size: { w: number; h: number }): void
  linked(fromId: string, toId: string): void
  /** A line drawn from a side of one thing, let go over another (`toId`, the side it's nearest) or over the board (at `at`, on screen). */
  connected(fromId: string, fromSide: Side, to: { toId: string; toSide: Side } | { at: Point; start: Point }): void
}

/**
 * The canvas's drags (PLAN.md §9, M21), one at a time: panning (the middle
 * button, Space or a finger), moving what's selected (with what's in its
 * groups, snapping to the grid and to other things' edges), resizing, a box
 * drawn to select, and lines drawn to connect or link. `now` reads the
 * board as it is when a handler runs.
 */
export function useBoardDrag(boardRef: RefObject<HTMLDivElement | null>, space: RefObject<boolean>, now: () => BoardNow, act: BoardDragActions) {
  const [drag, setDragState] = useState<Drag | null>(null)
  // The drag as it is now, for the pointer's handlers: a quick drag can be let go before the board has drawn its last move.
  const dragNow = useRef<Drag | null>(null)
  const setDrag = (next: Drag | null) => {
    dragNow.current = next
    setDragState(next)
  }

  const boardPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = boardRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const capture = (e: React.PointerEvent) => {
    boardRef.current!.setPointerCapture(e.pointerId)
    boardRef.current!.focus({ preventScroll: true })
  }

  /** What's being moved, once it has moved. */
  const moving = drag?.kind === 'move' && drag.moved ? new Set(drag.ids) : null
  /** Where an item is while being moved or resized: its resting place, or where the drag has it. */
  const boxOf = (item: BoardItem): Box => {
    if (moving?.has(item.id) && drag?.kind === 'move') return { ...item.box, x: item.box.x + drag.delta.x, y: item.box.y + drag.delta.y }
    if (drag?.kind === 'resize' && drag.id === item.id) return { ...item.box, ...drag.size }
    return item.box
  }

  const onBoardPointerDown = (e: React.PointerEvent) => {
    const { view } = now()
    if (!view) return
    const panning = e.button === 1 || (e.button === 0 && (space.current || e.pointerType === 'touch'))
    if (!panning && e.button !== 0) return
    capture(e)
    act.setEditing(null)
    if (panning) return setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, from: view })
    const p = boardPoint(e)
    setDrag({ kind: 'marquee', start: p, to: p, additive: e.shiftKey })
  }

  const onItemPointerDown = (e: React.PointerEvent, item: PlacedItem) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const { selected, readOnly, editing, items, view } = now()
    // The pointer is the board's only once the item is moved: a click or double-click stays the item's.
    boardRef.current!.focus({ preventScroll: true })
    if (space.current) return capture(e), setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, from: view! })
    let ids = selected
    // A click on one of several selected keeps them all only if it drags them; a plain click selects just it.
    const collapse = !e.shiftKey && selected.has(item.id) && selected.size > 1
    if (e.shiftKey) {
      const next = new Set(selected)
      if (next.has(item.id)) {
        next.delete(item.id)
        return act.setSelected(next)
      }
      ids = next.add(item.id)
      act.setSelected(ids)
    } else if (!selected.has(item.id)) act.setSelected((ids = new Set([item.id])))
    if (readOnly || editing === item.id) return collapse ? void act.setSelected(new Set([item.id])) : undefined
    const moved = act.withContents(ids)
    // What it may snap to: everything not moving with it.
    const others = items.filter((i) => !moved.includes(i.id)).map((i) => i.box)
    setDrag({ kind: 'move', start: { x: e.clientX, y: e.clientY }, ids: moved, lead: item.id, k: item.k, moved: false, delta: { x: 0, y: 0 }, guides: { x: [], y: [] }, collapse, others })
    // Let go where the board doesn't hear it (off the window, before the move made the pointer the board's), the move ends all the same.
    window.addEventListener('pointerup', () => dragNow.current?.kind === 'move' && setDrag(null), { once: true })
  }

  /** A handle's drag (resizing, connecting, linking): the board's from the start. */
  const startDrag = (e: React.PointerEvent, make: (p: Point) => Drag) => {
    if (e.button !== 0 || now().readOnly) return
    e.stopPropagation()
    capture(e)
    setDrag(make(boardPoint(e)))
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragNow.current
    const { view, byId, snap } = now()
    if (!drag || !view) return
    if (drag.kind === 'marquee' || drag.kind === 'connect' || drag.kind === 'link') return setDrag({ ...drag, to: boardPoint(e) })
    // How far the pointer has gone since the drag began, on screen.
    const [dx, dy] = [e.clientX - drag.start.x, e.clientY - drag.start.y]
    switch (drag.kind) {
      case 'pan':
        return act.setView({ ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy })
      case 'resize': {
        const fit = (n: number) => Math.max(CARD_SIZE.min, snap.grid ? snapToGrid(n) : n)
        return setDrag({ ...drag, size: { w: fit(drag.from.w + dx / drag.k), h: fit(drag.from.h + dy / drag.k) } })
      }
      case 'move': {
        if (!drag.moved && Math.hypot(dx, dy) <= 4) return
        if (!drag.moved) boardRef.current!.setPointerCapture(e.pointerId)
        // A receded event is drawn smaller, so the same mouse move covers more of the plane.
        const lead = byId.get(drag.lead)!.box
        const want = { ...lead, x: lead.x + dx / drag.k, y: lead.y + dy / drag.k }
        const snapped = snapBox(want, drag.others, { grid: snap.grid, objects: snap.objects, slack: SNAP_PX / view.zoom })
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
    const { placed, selected } = now()
    switch (drag.kind) {
      case 'move':
        if (!drag.moved && drag.collapse) return act.setSelected(new Set([drag.lead]))
        if (drag.moved) act.moved(drag.ids, drag.delta)
        return
      case 'resize':
        return act.resized(drag.id, drag.size)
      case 'marquee': {
        const box = boxBetween(drag.start, drag.to)
        if (box.w < 4 && box.h < 4) return act.clear()
        const hits = [...placed.values()].filter((i) => overlaps(i.screen, box)).map((i) => i.id)
        return act.select(drag.additive ? [...selected, ...hits] : hits)
      }
      case 'link':
        if (under && under !== drag.fromId) act.linked(drag.fromId, under)
        return
      case 'connect': {
        const target = under && under !== drag.fromId ? placed.get(under) : undefined
        return act.connected(drag.fromId, drag.fromSide, target ? { toId: target.id, toSide: nearestSide(target.screen, p) } : { at: p, start: drag.start })
      }
    }
  }

  return { drag, moving, boxOf, boardPoint, onBoardPointerDown, onItemPointerDown, startDrag, onPointerMove, onPointerUp, cancel: () => setDrag(null) }
}
