import {
  causalChain,
  formatTime,
  timeTicks,
  timelineOf,
  timelineWarnings,
  type Command,
  type EventGroup,
  type EventLink,
  type Lane,
  type SpatialNode,
  type TimelineEvent
} from '@universe/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TimeField } from '../components/fields'
import { useTimelineOwner, useUi } from '../store'
import { ROW_H, laneAt, layoutTimeline, type PlacedItem, type TimelineLayout } from './layout'
import { TimeScale, fitRange, panRange, snap, zoomRange, type TimeRange } from './scale'
import { ArrowMarkers, LINK_STYLE, WARN_COLOR } from './linkStyle'
import { useNow, usePlayhead, useTimelineView } from './timelineStore'

const LABELS_W = 132

type Drag =
  | { kind: 'pan'; startX: number; range: TimeRange; moved: boolean }
  | { kind: 'move'; ids: string[]; startX: number; startY: number; dt: number; lane: Lane | null | undefined; moved: boolean }
  | { kind: 'resize'; id: string; edge: 'start' | 'end'; t: number }
  | { kind: 'link'; fromId: string; x: number; y: number }
  | { kind: 'playhead' }

/** The timeline panel for whatever is selected: a world's (or its planet's) history, or a node's own. */
export function Timeline() {
  const owner = useTimelineOwner()
  if (!owner) return <div className="timeline muted pad">Select something to see its timeline.</div>
  return <OwnerTimeline key={owner.id} owner={owner} />
}

function OwnerTimeline({ owner }: { owner: SpatialNode }) {
  const data = useUi((s) => s.timeline)
  const regions = useUi((s) => s.regions)
  const selection = useUi((s) => s.timelineSelection)
  const selectedRegionId = useUi((s) => s.selectedRegionId)
  const { execute, selectTimeline } = useUi.getState()
  const own = useMemo(() => timelineOf(data, owner.id), [data, owner.id])
  const warnings = useMemo(() => timelineWarnings(own, regions), [own, regions])
  const warnedLinks = useMemo(() => new Set(warnings.flatMap((w) => w.refs.filter((r) => r.kind === 'link').map((r) => r.id))), [warnings])

  const now = useNow(owner.id)
  const playhead = usePlayhead(owner.id)
  // Only this timeline's range: other timelines' view changes don't re-render it.
  const storedRange = useTimelineView((s) => s.ranges[owner.id])
  const view = useTimelineView.getState()
  const range = storedRange ?? initialRange(own.events, now)
  const setRange = (r: TimeRange) => view.setRange(owner.id, r)
  // Remember the first view, so zooming and panning have something to start from.
  useEffect(() => {
    if (!storedRange) view.setRange(owner.id, range)
  })

  const trackRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = trackRef.current!
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const scale = new TimeScale(range, width)

  const [drag, setDrag] = useState<Drag | null>(null)
  const [showWarnings, setShowWarnings] = useState(false)

  // While dragging events, lay them out where they'd land.
  const shownEvents = useMemo(() => {
    if (drag?.kind === 'move') return own.events.map((e) => (drag.ids.includes(e.id) ? moved(e, drag.dt, drag.ids.length === 1 ? drag.lane : undefined) : e))
    if (drag?.kind === 'resize') return own.events.map((e) => (e.id === drag.id ? resized(e, drag.edge, drag.t) : e))
    return own.events
  }, [own.events, drag])
  const layout = useMemo(() => layoutTimeline(shownEvents, own.groups, own.lanes, scale), [shownEvents, own.groups, own.lanes, range.t0, range.t1, width]) // eslint-disable-line react-hooks/exhaustive-deps -- scale is derived from range and width

  const selectedEvents = useMemo(() => (selection?.kind === 'event' ? selection.ids : []), [selection])
  const emphasis = useMemo(() => emphasized(own, selectedEvents, selectedRegionId), [own, selectedEvents, selectedRegionId])

  // Zoom with the wheel (around the pointer); sideways scrolling pans; Alt+wheel scrolls the lanes.
  useEffect(() => {
    const el = trackRef.current!.closest('.timeline')! as HTMLElement
    const onWheel = (e: WheelEvent) => {
      const current = useTimelineView.getState().ranges[owner.id]
      if (!current || e.altKey || !(e.target instanceof Element) || !e.target.closest('.tl-track, .tl-ruler')) return
      e.preventDefault()
      const set = (r: TimeRange) => useTimelineView.getState().setRange(owner.id, r)
      const s = new TimeScale(current, trackRef.current!.clientWidth)
      const x = e.clientX - trackRef.current!.getBoundingClientRect().left
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) set(panRange(current, e.deltaX * s.secondsPerPx))
      else set(zoomRange(current, s.t(x), Math.exp(e.deltaY * 0.0015)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [owner.id])

  const point = (e: { clientX: number; clientY: number }) => {
    const rect = trackRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const run = (commands: Command[]) => {
    if (commands.length) void execute(commands.length === 1 ? commands[0]! : { type: 'batch', payload: { commands } })
  }

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    trackRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'pan', startX: e.clientX, range, moved: false })
  }

  const onEventPointerDown = (e: React.PointerEvent, ev: TimelineEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const toggle = e.shiftKey || e.metaKey || e.ctrlKey
    let ids = selectedEvents.includes(ev.id) ? selectedEvents : [ev.id]
    if (toggle) {
      ids = selectedEvents.includes(ev.id) ? selectedEvents.filter((id) => id !== ev.id) : [...selectedEvents, ev.id]
      selectTimeline(ids.length ? { kind: 'event', ids } : null)
      return
    }
    selectTimeline({ kind: 'event', ids })
    trackRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'move', ids, startX: e.clientX, startY: e.clientY, dt: 0, lane: undefined, moved: false })
  }

  const onHandlePointerDown = (e: React.PointerEvent, ev: TimelineEvent, edge: 'start' | 'end') => {
    e.stopPropagation()
    selectTimeline({ kind: 'event', ids: [ev.id] })
    trackRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'resize', id: ev.id, edge, t: edge === 'start' ? ev.start : (ev.end ?? ev.start) })
  }

  const onConnectorPointerDown = (e: React.PointerEvent, ev: TimelineEvent) => {
    e.stopPropagation()
    trackRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'link', fromId: ev.id, ...point(e) })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.startX
      if (Math.abs(dx) > 2 || drag.moved) {
        setDrag({ ...drag, moved: true })
        setRange(panRange(drag.range, -dx * scale.secondsPerPx))
      }
    } else if (drag.kind === 'move') {
      const dx = e.clientX - drag.startX
      const movedEnough = drag.moved || Math.abs(dx) > 3 || Math.abs(e.clientY - drag.startY) > 6
      const first = own.events.find((x) => x.id === drag.ids[0])!
      const dt = snap(first.start + dx * scale.secondsPerPx, scale.secondsPerPx) - first.start
      setDrag({ ...drag, dt: movedEnough ? dt : 0, lane: movedEnough ? laneAt(layout, point(e).y) : undefined, moved: movedEnough })
    } else if (drag.kind === 'resize') {
      setDrag({ ...drag, t: snap(scale.t(point(e).x), scale.secondsPerPx) })
    } else if (drag.kind === 'link') {
      setDrag({ ...drag, ...point(e) })
    } else {
      view.setPlayhead(owner.id, snap(scale.t(point(e).x), scale.secondsPerPx))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag
    setDrag(null)
    if (!d) return
    if (d.kind === 'pan' && !d.moved) selectTimeline(null)
    if (d.kind === 'move' && d.moved) {
      run(
        d.ids.flatMap((id) => {
          const ev = own.events.find((x) => x.id === id)!
          const next = moved(ev, d.dt, d.ids.length === 1 ? d.lane : undefined)
          if (next.start === ev.start && next.laneId === ev.laneId) return []
          return [{ type: 'event.update', payload: { id, patch: { start: next.start, end: next.end, laneId: next.laneId } } }]
        })
      )
    }
    if (d.kind === 'resize') {
      const ev = own.events.find((x) => x.id === d.id)!
      const next = resized(ev, d.edge, d.t)
      if (next.start !== ev.start || next.end !== ev.end) run([{ type: 'event.update', payload: { id: ev.id, patch: { start: next.start, end: next.end } } }])
    }
    if (d.kind === 'link') {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-event-id]')?.dataset.eventId
      if (target && target !== d.fromId) run([{ type: 'link.create', payload: { fromId: d.fromId, toId: target } }])
    }
  }

  const onTrackDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = point(e)
    const lane = laneAt(layout, y)
    run([{ type: 'event.create', payload: { ownerId: owner.id, start: snap(scale.t(x), scale.secondsPerPx), precision: precisionFor(scale), laneId: lane?.id ?? null } }])
  }

  const startPlayheadDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    view.setPlayhead(owner.id, snap(scale.t(e.clientX - trackRef.current!.getBoundingClientRect().left), scale.secondsPerPx))
    setDrag({ kind: 'playhead' })
  }

  const fit = () => {
    const times = [...own.events.flatMap((e) => [e.start, e.end ?? e.start]), ...own.eras.flatMap((e) => [e.start, e.end])]
    setRange(times.length ? fitRange(Math.min(...times), Math.max(...times)) : fitRange(now, now))
  }

  const ticks = timeTicks(range.t0, range.t1, width)
  const groupable = selectedEvents.length >= 2

  return (
    <div className="timeline" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="timeline-toolbar" role="toolbar" aria-label="Timeline">
        <span className="timeline-title" title={owner.name}>
          Timeline · {owner.name}
        </span>
        <button onClick={() => run([{ type: 'event.create', payload: { ownerId: owner.id, start: playhead, precision: precisionFor(scale) } }])}>+ Event</button>
        <button onClick={() => run([{ type: 'lane.create', payload: { ownerId: owner.id } }])}>+ Lane</button>
        <button
          onClick={() => {
            const span = range.t1 - range.t0
            run([{ type: 'era.create', payload: { ownerId: owner.id, start: snap(range.t0 + span / 3, scale.secondsPerPx), end: snap(range.t0 + (2 * span) / 3, scale.secondsPerPx) } }])
          }}
        >
          + Era
        </button>
        <button disabled={!groupable} title="Select two or more events (Shift-click), then group them" onClick={() => run([{ type: 'group.create', payload: { ownerId: owner.id, eventIds: selectedEvents } }])}>
          Group
        </button>
        <button onClick={fit} title="Show everything on this timeline">
          Fit
        </button>
        <span className="toolbar-sep" />
        <label className="timeline-playhead-field">
          <span className="muted small">Playhead</span>
          <TimeField
            label="Playhead"
            value={playhead}
            precision={precisionFor(scale)}
            onCommit={(v) => {
              if (!v) return
              view.setPlayhead(owner.id, v.t)
              if (v.t < range.t0 || v.t > range.t1) setRange(panRange(range, v.t - (range.t0 + range.t1) / 2))
            }}
          />
        </label>
        <button title="Make the playhead the story's present" disabled={playhead === now} onClick={() => run([{ type: 'timeline.update', payload: { ownerId: owner.id, patch: { now: playhead } } }])}>
          Set Now
        </button>
        <span className="toolbar-sep" />
        {warnings.length > 0 && (
          <button className="warning-button" aria-expanded={showWarnings} onClick={() => setShowWarnings(!showWarnings)}>
            ⚠ {warnings.length}
          </button>
        )}
        <span className="muted small timeline-hint">Scroll to zoom · drag to pan · double-click to add · drag ● to link</span>
      </div>

      {showWarnings && warnings.length > 0 && (
        <ul className="warning-list" aria-label="Timeline warnings">
          {warnings.map((w, i) => (
            <li key={i}>
              <button
                className="link"
                onClick={() => {
                  // Every warning names an event or a region; select it so it can be fixed.
                  const ref = w.refs.find((r) => r.kind === 'event') ?? w.refs.find((r) => r.kind === 'region')
                  if (ref?.kind === 'event') selectTimeline({ kind: 'event', ids: [ref.id] })
                  else if (ref) useUi.getState().selectRegion(ref.id)
                }}
              >
                {w.message}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="tl-head">
        <div className="tl-corner" style={{ width: LABELS_W }} />
        <div className="tl-ruler" onPointerDown={startPlayheadDrag}>
          {own.eras.map((era) => {
            const x0 = scale.x(era.start)
            const x1 = scale.x(era.end)
            if (x1 < 0 || x0 > width) return null
            const selected = selection?.kind === 'era' && selection.ids.includes(era.id)
            return (
              <button
                key={era.id}
                className={`tl-era-chip${selected ? ' selected' : ''}`}
                style={{ left: Math.max(0, x0), width: Math.max(12, Math.min(width, x1) - Math.max(0, x0)), ['--c' as string]: era.color }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => selectTimeline({ kind: 'era', ids: [era.id] })}
                title={`${era.name}: ${formatTime(era.start, 'year')} – ${formatTime(era.end, 'year')}`}
              >
                {era.name}
              </button>
            )
          })}
          {ticks.map((t) => (
            <span key={t.t} className="tl-tick" style={{ left: scale.x(t.t) }}>
              {t.label}
            </span>
          ))}
          <Marker className="tl-now-marker" x={scale.x(now)} label="Now" />
          <Marker className="tl-playhead-marker" x={scale.x(playhead)} label={formatTime(playhead, precisionFor(scale))} />
        </div>
      </div>

      <div className="tl-scroll">
        <div className="tl-rows" style={{ height: Math.max(layout.height + ROW_H, 0) }}>
          <div className="tl-labels" style={{ width: LABELS_W }}>
            {layout.groupsHeight > 0 && (
              <div className="tl-lane-label muted" style={{ top: 0, height: layout.groupsHeight }}>
                Groups
              </div>
            )}
            {layout.lanes.map((l) => (
              <LaneLabel key={l.lane?.id ?? 'default'} lane={l.lane} y={l.y} height={l.height} />
            ))}
          </div>
          <div
            ref={trackRef}
            className={`tl-track${drag?.kind === 'pan' && drag.moved ? ' panning' : ''}`}
            data-testid="timeline-track"
            onPointerDown={onTrackPointerDown}
            onDoubleClick={onTrackDoubleClick}
          >
            {own.eras.map((era) => (
              <div key={era.id} className="tl-era" style={{ left: scale.x(era.start), width: Math.max(1, scale.x(era.end) - scale.x(era.start)), ['--c' as string]: era.color }} />
            ))}
            {ticks.map((t) => (
              <div key={t.t} className="tl-grid" style={{ left: scale.x(t.t) }} />
            ))}
            {layout.lanes.map((l) => (
              <div key={l.lane?.id ?? 'default'} className="tl-lane-bg" style={{ top: l.y, height: l.height }} />
            ))}
            <Arrows layout={layout} links={own.links} emphasis={emphasis} warned={warnedLinks} selectedLinkId={selection?.kind === 'link' ? selection.ids[0] : undefined} width={width} />
            {layout.groups.map((g) => (
              <GroupBar key={g.item.id} placed={g} selected={selection?.kind === 'group' && selection.ids.includes(g.item.id)} />
            ))}
            {layout.lanes.flatMap((l) =>
              l.events.map((p) => (
                <EventBar
                  key={p.item.id}
                  placed={p}
                  selected={selectedEvents.includes(p.item.id)}
                  dimmed={!!emphasis && !emphasis.events.has(p.item.id)}
                  onPointerDown={onEventPointerDown}
                  onHandlePointerDown={onHandlePointerDown}
                  onConnectorPointerDown={onConnectorPointerDown}
                />
              ))
            )}
            {drag?.kind === 'link' && <LinkPreview layout={layout} fromId={drag.fromId} to={drag} />}
            <div className="tl-line now" style={{ left: scale.x(now) }} />
            <div className="tl-line playhead" style={{ left: scale.x(playhead) }} />
          </div>
        </div>
      </div>
    </div>
  )
}

function Marker({ className, x, label }: { className: string; x: number; label: string }) {
  return (
    <span className={`tl-marker ${className}`} style={{ left: x }}>
      <span>{label}</span>
    </span>
  )
}

function LaneLabel({ lane, y, height }: { lane: Lane | null; y: number; height: number }) {
  const execute = useUi((s) => s.execute)
  const [editing, setEditing] = useState(false)
  if (!lane) {
    return (
      <div className="tl-lane-label" style={{ top: y, height }}>
        Events
      </div>
    )
  }
  return (
    <div className="tl-lane-label" style={{ top: y, height }} onDoubleClick={() => setEditing(true)} title="Double-click to rename">
      {editing ? (
        <input
          autoFocus
          aria-label="Lane name"
          defaultValue={lane.name}
          onBlur={(e) => {
            setEditing(false)
            const name = e.target.value.trim()
            if (name && name !== lane.name) void execute({ type: 'lane.update', payload: { id: lane.id, patch: { name } } })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <>
          <span className="tl-lane-name">{lane.name}</span>
          <button className="link tl-lane-delete" aria-label={`Delete lane ${lane.name}`} onClick={() => void execute({ type: 'lane.delete', payload: { id: lane.id } })}>
            ✕
          </button>
        </>
      )}
    </div>
  )
}

interface EventBarProps {
  placed: PlacedItem<TimelineEvent>
  selected: boolean
  dimmed: boolean
  onPointerDown(e: React.PointerEvent, ev: TimelineEvent): void
  onHandlePointerDown(e: React.PointerEvent, ev: TimelineEvent, edge: 'start' | 'end'): void
  onConnectorPointerDown(e: React.PointerEvent, ev: TimelineEvent): void
}

function EventBar({ placed, selected, dimmed, onPointerDown, onHandlePointerDown, onConnectorPointerDown }: EventBarProps) {
  const ev = placed.item
  const instant = ev.end === null
  const fuzzy = ev.precision === 'approx' || ev.precision === 'century'
  const classes = ['tl-event', instant ? 'instant' : 'span', selected && 'selected', dimmed && 'dimmed', fuzzy && 'fuzzy'].filter(Boolean).join(' ')
  return (
    <div
      className={classes}
      data-event-id={ev.id}
      role="button"
      aria-label={ev.title}
      aria-pressed={selected}
      title={`${ev.title}\n${formatTime(ev.start, ev.precision)}${ev.end !== null ? ` – ${formatTime(ev.end, ev.precision)}` : ''}`}
      style={{ left: placed.x0, top: placed.y + 3, width: instant ? undefined : placed.x1 - placed.x0, ['--c' as string]: ev.color }}
      onPointerDown={(e) => onPointerDown(e, ev)}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {!instant && <span className="tl-handle start" onPointerDown={(e) => onHandlePointerDown(e, ev, 'start')} />}
      {instant && <span className="tl-diamond" />}
      <span className="tl-event-label">
        {ev.locations.length > 0 && '📍 '}
        {ev.title}
      </span>
      <span className="tl-handle end" title={instant ? 'Drag to give it a duration' : undefined} onPointerDown={(e) => onHandlePointerDown(e, ev, 'end')} />
      <span className="tl-connector" title="Drag onto another event to link them" onPointerDown={(e) => onConnectorPointerDown(e, ev)} />
    </div>
  )
}

function GroupBar({ placed, selected }: { placed: PlacedItem<EventGroup>; selected: boolean }) {
  const { execute, selectTimeline } = useUi.getState()
  const g = placed.item
  return (
    <div
      className={`tl-group${selected ? ' selected' : ''}${g.collapsed ? ' collapsed' : ''}`}
      data-group-id={g.id}
      style={{ left: placed.x0, top: placed.y + 3, width: placed.x1 - placed.x0, ['--c' as string]: g.color }}
      onPointerDown={(e) => {
        e.stopPropagation()
        selectTimeline({ kind: 'group', ids: [g.id] })
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        className="link tl-group-toggle"
        aria-label={g.collapsed ? `Expand ${g.title}` : `Collapse ${g.title}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void execute({ type: 'group.update', payload: { id: g.id, patch: { collapsed: !g.collapsed } } })}
      >
        {g.collapsed ? '▸' : '▾'}
      </button>
      <span className="tl-event-label">{g.title}</span>
    </div>
  )
}

/** Endpoints of a link: the right end of its cause and the left end of its effect (or their group bars). */
function linkEnds(layout: TimelineLayout, fromId: string, toId: string) {
  const a = layout.anchors.get(fromId)
  const b = layout.anchors.get(toId)
  if (!a || !b || a === b) return undefined
  return { x1: a.x1 + (a.x1 === a.x0 ? 6 : 0), y1: a.y + ROW_H / 2, x2: b.x0 - (b.x1 === b.x0 ? 6 : 0), y2: b.y + ROW_H / 2 }
}

/** An S-curve from a cause to its effect; a link pointing back in time loops below the bars instead of over them. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x2 < x1 - 20) {
    const dip = Math.max(y1, y2) + ROW_H * 0.75
    return `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x1 + 40} ${dip}, ${x1} ${dip} L ${x2} ${dip} C ${x2 - 40} ${dip}, ${x2 - 40} ${y2}, ${x2} ${y2}`
  }
  const dx = Math.max(30, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

interface ArrowsProps {
  layout: TimelineLayout
  links: EventLink[]
  emphasis: Emphasis | undefined
  /** Links a consistency warning is about, drawn in amber. */
  warned: Set<string>
  selectedLinkId?: string
  width: number
}

function Arrows({ layout, links, emphasis, warned, selectedLinkId, width }: ArrowsProps) {
  const selectTimeline = useUi((s) => s.selectTimeline)
  return (
    <svg className="tl-arrows" width={width} height={layout.height}>
      <ArrowMarkers prefix="arrow" />
      {links.map((l) => {
        const ends = linkEnds(layout, l.fromId, l.toId)
        if (!ends) return null
        const style = warned.has(l.id) ? { ...LINK_STYLE[l.type], color: WARN_COLOR } : LINK_STYLE[l.type]
        const d = curve(ends.x1, ends.y1, ends.x2, ends.y2)
        const strong = l.id === selectedLinkId || emphasis?.links.has(l.id)
        return (
          <g key={l.id} className={`tl-link${strong ? ' strong' : ''}${emphasis && !strong ? ' dimmed' : ''}`} data-link-id={l.id}>
            <path d={d} className="tl-link-hit" onPointerDown={(e) => (e.stopPropagation(), selectTimeline({ kind: 'link', ids: [l.id] }))} />
            <path d={d} stroke={style.color} strokeDasharray={style.dash} markerEnd={style.arrow ? `url(#arrow-${warned.has(l.id) ? 'warn' : l.type})` : undefined} fill="none" />
          </g>
        )
      })}
    </svg>
  )
}

function LinkPreview({ layout, fromId, to }: { layout: TimelineLayout; fromId: string; to: { x: number; y: number } }) {
  const a = layout.anchors.get(fromId)
  if (!a) return null
  return (
    <svg className="tl-arrows" width="100%" height={layout.height + ROW_H}>
      <path d={curve(a.x1 + 6, a.y + ROW_H / 2, to.x, to.y)} stroke="#ffffff" strokeDasharray="4 4" fill="none" />
    </svg>
  )
}

interface Emphasis {
  events: Set<string>
  links: Set<string>
}

/**
 * What to highlight: the selected event's whole causal chain, or the events
 * located in the selected region. Undefined when nothing calls for it.
 */
function emphasized(own: { events: TimelineEvent[]; links: EventLink[] }, selectedEvents: string[], regionId: string | null): Emphasis | undefined {
  if (selectedEvents.length === 1) {
    const id = selectedEvents[0]!
    const chain = new Set([id, ...causalChain(own.links, id, 'up'), ...causalChain(own.links, id, 'down')])
    if (chain.size === 1) return undefined
    return { events: chain, links: new Set(own.links.filter((l) => chain.has(l.fromId) && chain.has(l.toId)).map((l) => l.id)) }
  }
  if (regionId) {
    const here = own.events.filter((e) => e.locations.some((loc) => loc.kind === 'region' && loc.regionId === regionId))
    if (here.length) return { events: new Set(here.map((e) => e.id)), links: new Set() }
  }
  return undefined
}

function moved(e: TimelineEvent, dt: number, lane: Lane | null | undefined): TimelineEvent {
  return { ...e, start: e.start + dt, end: e.end === null ? null : e.end + dt, laneId: lane === undefined ? e.laneId : (lane?.id ?? null) }
}

function resized(e: TimelineEvent, edge: 'start' | 'end', t: number): TimelineEvent {
  if (edge === 'start') return { ...e, start: Math.min(t, e.end ?? e.start) }
  // Dragging an instant's end gives it a duration; dragging it back to the start makes it an instant again.
  const end = Math.max(t, e.start)
  return { ...e, end: end === e.start ? null : end }
}

/** Precision for a new event: as fine as the current zoom can show. */
function precisionFor(scale: TimeScale): TimelineEvent['precision'] {
  const s = scale.secondsPerPx
  return s < 600 ? 'exact' : s < 86400 * 10 ? 'day' : 'year'
}

function initialRange(events: TimelineEvent[], now: number): TimeRange {
  if (!events.length) return fitRange(now, now)
  const times = events.flatMap((e) => [e.start, e.end ?? e.start])
  return fitRange(Math.min(...times), Math.max(...times))
}
