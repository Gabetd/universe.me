import { timelineOf, type Region, type TimelineEvent } from '@universe/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../store'
import { eventDates, locationLabel } from '../timeline/labels'
import { ArrowMarkers, LINK_STYLE } from '../timeline/linkStyle'
import { usePlayhead, useTimelineView } from '../timeline/timelineStore'
import { boxEdge, nodeDepth, project, type NodeDepth } from './canvasDepth'
import { goToEvent } from './goToEvent'

const NODE_W = 200
const NODE_H = 86
const GAP = 40
const COLUMNS = 4
const MIN_ZOOM = 0.3
const MAX_ZOOM = 2

type Point = { x: number; y: number }
interface View extends Point {
  zoom: number
}

/** Pan and zoom per world, kept while switching views. */
const views = new Map<string, View>()

type Drag =
  | { kind: 'pan'; start: Point; from: View }
  | { kind: 'node'; id: string; start: Point; from: Point; at: Point; scale: number; moved: boolean }
  | { kind: 'link'; fromId: string; to: Point }

/** A node's top-left on the canvas plane: where it was put, or its slot in time order. */
const homeOf = (e: TimelineEvent, slot: number): Point =>
  e.canvas ?? { x: (slot % COLUMNS) * (NODE_W + GAP), y: Math.floor(slot / COLUMNS) * (NODE_H + GAP) }

interface PlacedNode {
  event: TimelineEvent
  /** Top-left on the canvas plane. */
  at: Point
  /** Centre on screen, after pan, zoom and depth. */
  center: [number, number]
  /** Screen size multiplier: zoom × depth scale. */
  k: number
  depth: NodeDepth
}

/**
 * A world's canvas: every event on its timeline is a node here, laid out in
 * time order until moved. Nodes can be dragged, hidden, and linked by dragging
 * from one's handle to another. As the playhead moves on, finished events
 * recede into the distance. Clicking a node goes to when and where it happened.
 */
export function EventCanvas({ worldId, regions }: { worldId: string; regions: Region[] }) {
  const timeline = useUi((s) => s.timeline)
  const selection = useUi((s) => s.timelineSelection)
  const { execute, selectTimeline } = useUi.getState()
  const playhead = usePlayhead(worldId)
  const range = useTimelineView((s) => s.ranges[worldId])
  const [view, setViewState] = useState<View>(() => views.get(worldId) ?? { x: 40, y: 40, zoom: 1 })
  const [drag, setDrag] = useState<Drag | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const boardRef = useRef<HTMLDivElement>(null)
  const size = useSize(boardRef)

  const setView = (v: View) => {
    views.set(worldId, v)
    setViewState(v)
  }

  const own = useMemo(() => timelineOf(timeline, worldId), [timeline, worldId])
  const events = useMemo(() => [...own.events].sort((a, b) => a.start - b.start), [own])
  const hiddenCount = events.filter((e) => e.canvasHidden).length
  const arranged = events.filter((e) => e.canvas)
  const selectedIds = new Set(selection?.kind === 'event' ? selection.ids : [])
  const selectedLinkId = selection?.kind === 'link' ? selection.ids[0] : undefined
  const update = (e: TimelineEvent, patch: Partial<TimelineEvent>) => void execute({ type: 'event.update', payload: { id: e.id, patch } })

  // The past falls away over about the timeline's visible span (or the whole history if it hasn't been shown yet).
  const horizon = range ? range.t1 - range.t0 : events.length ? events[events.length - 1]!.start - events[0]!.start : 1

  const nodes = useMemo(() => {
    const placed = new Map<string, PlacedNode>()
    let slot = 0
    for (const event of events) {
      // Hidden nodes keep their slot, so showing one doesn't reshuffle the rest.
      const home = homeOf(event, slot)
      if (!event.canvas) slot++
      if (event.canvasHidden && !showHidden) continue
      const at = drag?.kind === 'node' && drag.id === event.id && drag.moved ? drag.at : home
      const depth = nodeDepth(event, playhead, horizon)
      const flat: [number, number] = [view.x + (at.x + NODE_W / 2) * view.zoom, view.y + (at.y + NODE_H / 2) * view.zoom]
      placed.set(event.id, { event, at, depth, k: view.zoom * depth.scale, center: project(...flat, size.w / 2, size.h / 2, depth.scale) })
    }
    return placed
  }, [events, showHidden, drag, playhead, horizon, view, size])

  const onWheel = (e: React.WheelEvent) => {
    const rect = boardRef.current!.getBoundingClientRect()
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * Math.exp(-e.deltaY * 0.001)))
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    // Zoom about the cursor.
    setView({ zoom, x: px - ((px - view.x) * zoom) / view.zoom, y: py - ((py - view.y) * zoom) / view.zoom })
  }

  const boardPoint = (e: React.PointerEvent): Point => {
    const rect = boardRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const capture = (e: React.PointerEvent) => boardRef.current!.setPointerCapture(e.pointerId)

  const onBoardPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    capture(e)
    setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, from: view })
  }

  const onNodePointerDown = (e: React.PointerEvent, node: PlacedNode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    capture(e)
    setDrag({ kind: 'node', id: node.event.id, start: { x: e.clientX, y: e.clientY }, from: node.at, at: node.at, scale: node.k, moved: false })
  }

  const onHandlePointerDown = (e: React.PointerEvent, node: PlacedNode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    capture(e)
    setDrag({ kind: 'link', fromId: node.event.id, to: boardPoint(e) })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    if (drag.kind === 'link') return setDrag({ ...drag, to: boardPoint(e) })
    const dx = e.clientX - drag.start.x
    const dy = e.clientY - drag.start.y
    if (drag.kind === 'pan') setView({ ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy })
    // A receded node is drawn smaller, so the same mouse move covers more of the plane.
    else if (drag.moved || Math.hypot(dx, dy) > 4) setDrag({ ...drag, moved: true, at: { x: drag.from.x + dx / drag.scale, y: drag.from.y + dy / drag.scale } })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (drag?.kind === 'node') {
      const node = nodes.get(drag.id)
      if (node && drag.moved) update(node.event, { canvas: { x: Math.round(drag.at.x), y: Math.round(drag.at.y) } })
      else if (node) goToEvent(node.event)
    } else if (drag?.kind === 'link') {
      const toId = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-event-id]')?.dataset.eventId
      if (toId && toId !== drag.fromId) void execute({ type: 'link.create', payload: { fromId: drag.fromId, toId } })
    }
    setDrag(null)
  }

  // Back to front, so nearer nodes are drawn (and clicked) over farther ones.
  const ordered = [...nodes.values()].sort((a, b) => b.depth.depth - a.depth.depth)
  const linkFrom = drag?.kind === 'link' ? nodes.get(drag.fromId) : undefined

  return (
    <div className="event-canvas">
      <div className="event-canvas-bar" role="toolbar" aria-label="Canvas">
        <span className="muted small">
          {events.length === 0
            ? 'Events on this world’s timeline show up here as nodes.'
            : 'Drag nodes to arrange them, or drag a node’s ● onto another to link them. Click a node to go to when and where it happened.'}
        </span>
        <button
          disabled={arranged.length === 0}
          title="Put every node back in time order"
          onClick={() => void execute({ type: 'batch', payload: { commands: arranged.map((ev) => ({ type: 'event.update', payload: { id: ev.id, patch: { canvas: null } } })) } })}
        >
          Arrange by time
        </button>
        <button aria-pressed={showHidden} disabled={hiddenCount === 0 && !showHidden} onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? 'Hide hidden nodes' : `Show hidden (${hiddenCount})`}
        </button>
      </div>
      <div
        ref={boardRef}
        className={`event-board${drag ? ' dragging' : ''}`}
        data-testid="event-canvas"
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${32 * view.zoom}px ${32 * view.zoom}px` }}
        onWheel={onWheel}
        onPointerDown={onBoardPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        <svg className="event-links" width={size.w} height={size.h}>
          <ArrowMarkers prefix="canvas-arrow" />
          {own.links.map((l) => {
            const a = nodes.get(l.fromId)
            const b = nodes.get(l.toId)
            if (!a || !b) return null
            const [x1, y1] = boxEdge(b.center, a.center, (NODE_W / 2) * a.k, (NODE_H / 2) * a.k)
            const [x2, y2] = boxEdge(a.center, b.center, (NODE_W / 2) * b.k, (NODE_H / 2) * b.k)
            const style = LINK_STYLE[l.type]
            const d = `M ${x1} ${y1} L ${x2} ${y2}`
            return (
              <g key={l.id} className={`canvas-link${l.id === selectedLinkId ? ' selected' : ''}`} data-link-id={l.id} style={{ opacity: 1 - 0.4 * Math.max(a.depth.depth, b.depth.depth) }}>
                <path d={d} className="canvas-link-hit" onPointerDown={(e) => (e.stopPropagation(), selectTimeline({ kind: 'link', ids: [l.id] }))} />
                <path d={d} stroke={style.color} strokeDasharray={style.dash} markerEnd={style.arrow ? `url(#canvas-arrow-${l.type})` : undefined} fill="none" />
              </g>
            )
          })}
          {linkFrom && drag?.kind === 'link' && <path d={`M ${linkFrom.center[0]} ${linkFrom.center[1]} L ${drag.to.x} ${drag.to.y}`} stroke="#fff" strokeDasharray="4 4" fill="none" />}
        </svg>

        {ordered.map((node) => {
          const { event: ev, k, depth } = node
          const dragging = drag?.kind === 'node' && drag.id === ev.id && drag.moved
          const classes = ['event-node', depth.when, selectedIds.has(ev.id) && 'selected', ev.canvasHidden && 'hidden-node', dragging && 'dragging']
          return (
            <div
              key={ev.id}
              data-event-id={ev.id}
              className={classes.filter(Boolean).join(' ')}
              role="button"
              aria-label={ev.title}
              title={depth.when === 'future' ? 'Hasn’t happened yet at the playhead' : undefined}
              style={{
                width: NODE_W,
                height: NODE_H,
                borderTopColor: ev.color,
                transform: `translate(${node.center[0] - (NODE_W / 2) * k}px, ${node.center[1] - (NODE_H / 2) * k}px) scale(${k})`,
                opacity: (ev.canvasHidden ? 0.4 : 1) * (depth.when === 'future' ? 0.6 : 1 - 0.35 * depth.depth),
                filter: depth.depth > 0.05 ? `brightness(${1 - 0.3 * depth.depth})` : undefined
              }}
              onPointerDown={(e) => onNodePointerDown(e, node)}
            >
              <div className="event-node-head">
                <b>{ev.title}</b>
                <button
                  className="link"
                  aria-label={ev.canvasHidden ? `Show ${ev.title}` : `Hide ${ev.title}`}
                  title={ev.canvasHidden ? 'Show on the canvas' : 'Hide from the canvas'}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => update(ev, { canvasHidden: !ev.canvasHidden })}
                >
                  {ev.canvasHidden ? '👁' : '✕'}
                </button>
              </div>
              <div className="muted small">{eventDates(ev)}</div>
              <div className="small event-node-place">{ev.locations.length ? ev.locations.map((l) => locationLabel(l, regions)).join(' · ') : <span className="muted">No place yet</span>}</div>
              <span className="event-node-handle" aria-label={`Link ${ev.title} to…`} title="Drag onto another node to link them" onPointerDown={(e) => onHandlePointerDown(e, node)}>
                ●
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

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
