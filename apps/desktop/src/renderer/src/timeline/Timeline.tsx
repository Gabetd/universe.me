import {
  type Calendar,
  causalChain,
  formatTime,
  timeTicks,
  timelineWarnings,
  type Command,
  type EventGroup,
  type EventLink,
  type Lane,
  type SpatialNode,
  type TimelineEvent
} from '@universe/core'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TimeField } from '../components/fields'
import { asCommand, updater, useOwnRecords, useTimelineOwner, useUi } from '../store'
import { ROW_H, laneAt, onScreen, packTimeline, packingFor, placeTimeline, type PlacedItem, type TimelineLayout } from './layout'
import { TimeScale, fitRange, panRange, snap, zoomRange, type TimeRange } from './scale'
import { effectIcons } from '../components/EventEffects'
import { ArrowMarkers, LINK_STYLE, WARN_COLOR } from './linkStyle'
import { playheadOf, useNow, usePlayhead, useTimelineView } from './timelineStore'
import { useCalendar } from '../world/useSky'
import { eventDates } from './labels'
import { SkyTrack } from './SkyTrack'
import { ThemeTrack } from './ThemeTrack'
import { DerivedTrack } from './DerivedTrack'

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

/** A function that keeps its identity but always runs the latest render's `fn`: a handler memoized children can take. */
function useStableHandler<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  return useCallback((...args: A) => latest.current(...args), [])
}

/**
 * One node's timeline. The playhead (its field, marker and line) is drawn by
 * components of its own, so moving or playing it doesn't re-render this.
 */
function OwnerTimeline({ owner }: { owner: SpatialNode }) {
  // Each kind on its own, so edits to other records (structures, species…) don't re-render the timeline.
  const events = useOwnRecords('events', owner.id)
  const links = useOwnRecords('links', owner.id)
  const changes = useOwnRecords('changes', owner.id)
  const eras = useOwnRecords('eras', owner.id)
  const themeSpans = useOwnRecords('themeSpans', owner.id)
  const groups = useOwnRecords('groups', owner.id)
  const lanes = useOwnRecords('lanes', owner.id)
  const effects = useOwnRecords('effects', owner.id)
  const regions = useUi((s) => s.regions)
  const selection = useUi((s) => s.timelineSelection)
  const selectedRegionId = useUi((s) => s.selectedRegionId)
  const { execute, selectTimeline } = useUi.getState()
  const warnings = useMemo(() => timelineWarnings({ events, links, changes }, regions), [events, links, changes, regions])
  const warnedLinks = useMemo(() => new Set(warnings.flatMap((w) => w.refs.filter((r) => r.kind === 'link').map((r) => r.id))), [warnings])
  const icons = useMemo(() => effectIcons(effects), [effects])

  const now = useNow(owner.id)
  const cal = useCalendar(owner.id)
  // Only this timeline's range: other timelines' view changes don't re-render it.
  const storedRange = useTimelineView((s) => s.ranges[owner.id])
  const view = useTimelineView.getState()
  const range = storedRange ?? initialRange(events, now)
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
    if (drag?.kind === 'move') return events.map((e) => (drag.ids.includes(e.id) ? moved(e, drag.dt, drag.ids.length === 1 ? drag.lane : undefined) : e))
    if (drag?.kind === 'resize') return events.map((e) => (e.id === drag.id ? resized(e, drag.edge, drag.t) : e))
    return events
  }, [events, drag])
  // Packed once per zoom level; panning only moves it sideways.
  const packing = packingFor(range, width)
  const packed = useMemo(() => packTimeline(shownEvents, groups, lanes, packing.secondsPerPx, packing.origin), [shownEvents, groups, lanes, packing.secondsPerPx, packing.origin])
  const layout = useMemo(() => placeTimeline(packed, range.t0), [packed, range.t0])

  const selectedEvents = useMemo(() => (selection?.kind === 'event' ? selection.ids : []), [selection])
  const emphasis = useMemo(() => emphasized({ events, links }, selectedEvents, selectedRegionId), [events, links, selectedEvents, selectedRegionId])

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
    const command = asCommand(commands)
    if (command) void execute(command)
  }

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    trackRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'pan', startX: e.clientX, range, moved: false })
  }

  // Stable, so the bars (memoized) don't re-render for every pointer move.
  const onEventPointerDown = useStableHandler((e: React.PointerEvent, ev: TimelineEvent) => {
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
  })

  const onHandlePointerDown = useStableHandler((e: React.PointerEvent, ev: TimelineEvent, edge: 'start' | 'end') => {
    e.stopPropagation()
    selectTimeline({ kind: 'event', ids: [ev.id] })
    trackRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'resize', id: ev.id, edge, t: edge === 'start' ? ev.start : (ev.end ?? ev.start) })
  })

  const onConnectorPointerDown = useStableHandler((e: React.PointerEvent, ev: TimelineEvent) => {
    e.stopPropagation()
    trackRef.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'link', fromId: ev.id, ...point(e) })
  })

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.startX
      if (Math.abs(dx) > 2 || drag.moved) {
        if (!drag.moved) setDrag({ ...drag, moved: true })
        setRange(panRange(drag.range, -dx * scale.secondsPerPx))
      }
    } else if (drag.kind === 'move') {
      const dx = e.clientX - drag.startX
      const movedEnough = drag.moved || Math.abs(dx) > 3 || Math.abs(e.clientY - drag.startY) > 6
      const first = events.find((x) => x.id === drag.ids[0])!
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
          const ev = events.find((x) => x.id === id)!
          const next = moved(ev, d.dt, d.ids.length === 1 ? d.lane : undefined)
          if (next.start === ev.start && next.laneId === ev.laneId) return []
          return [{ type: 'event.update', payload: { id, patch: { start: next.start, end: next.end, laneId: next.laneId } } }]
        })
      )
    }
    if (d.kind === 'resize') {
      const ev = events.find((x) => x.id === d.id)!
      const next = resized(ev, d.edge, d.t)
      if (next.start !== ev.start || next.end !== ev.end) updater('event', ev.id)({ start: next.start, end: next.end })
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
    const times = [...events.flatMap((e) => [e.start, e.end ?? e.start]), ...[...eras, ...themeSpans].flatMap((e) => [e.start, e.end])]
    setRange(times.length ? fitRange(Math.min(...times), Math.max(...times)) : fitRange(now, now))
  }

  const ticks = timeTicks(range.t0, range.t1, width, cal)
  const groupable = selectedEvents.length >= 2
  const precision = precisionFor(scale)

  return (
    <div className="timeline" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="timeline-toolbar" role="toolbar" aria-label="Timeline">
        <span className="timeline-title" title={owner.name}>
          Timeline · {owner.name}
        </span>
        <button onClick={() => run([{ type: 'event.create', payload: { ownerId: owner.id, start: playheadOf(owner.id), precision } }])}>+ Event</button>
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
        <PlayheadField ownerId={owner.id} now={now} precision={precision} range={range} onRange={setRange} />
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
          {eras.map((era) => {
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
                title={`${era.name}: ${formatTime(era.start, 'year', cal)} – ${formatTime(era.end, 'year', cal)}`}
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
          <PlayheadMarker ownerId={owner.id} scale={scale} precision={precision} cal={cal} />
        </div>
      </div>

      <ThemeTrack owner={owner} range={range} width={width} cal={cal} labelWidth={LABELS_W} />
      <SkyTrack owner={owner} range={range} width={width} cal={cal} labelWidth={LABELS_W} />
      <DerivedTrack owner={owner} range={range} width={width} cal={cal} labelWidth={LABELS_W} />

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
            {eras.map((era) => (
              <div key={era.id} className="tl-era" style={{ left: scale.x(era.start), width: Math.max(1, scale.x(era.end) - scale.x(era.start)), ['--c' as string]: era.color }} />
            ))}
            {ticks.map((t) => (
              <div key={t.t} className="tl-grid" style={{ left: scale.x(t.t) }} />
            ))}
            {layout.lanes.map((l) => (
              <div key={l.lane?.id ?? 'default'} className="tl-lane-bg" style={{ top: l.y, height: l.height }} />
            ))}
            <Arrows layout={layout} links={links} emphasis={emphasis} warned={warnedLinks} selectedLinkId={selection?.kind === 'link' ? selection.ids[0] : undefined} width={width} />
            {layout.groups.map((g) =>
              onScreen(g, width) ? <GroupBar key={g.item.id} placed={g} selected={selection?.kind === 'group' && selection.ids.includes(g.item.id)} /> : null
            )}
            {layout.lanes.flatMap((l) =>
              l.events.map((p) =>
                onScreen(p, width) ? (
                  <EventBar
                    cal={cal}
                    key={p.item.id}
                    placed={p}
                    icons={icons.get(p.item.id)}
                    selected={selectedEvents.includes(p.item.id)}
                    dimmed={!!emphasis && !emphasis.events.has(p.item.id)}
                    onPointerDown={onEventPointerDown}
                    onHandlePointerDown={onHandlePointerDown}
                    onConnectorPointerDown={onConnectorPointerDown}
                  />
                ) : null
              )
            )}
            {drag?.kind === 'link' && <LinkPreview layout={layout} fromId={drag.fromId} to={drag} />}
            <div className="tl-line now" style={{ left: scale.x(now) }} />
            <PlayheadLine ownerId={owner.id} scale={scale} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The playhead's box and "Set Now", in the toolbar. */
function PlayheadField({ ownerId, now, precision, range, onRange }: { ownerId: string; now: number; precision: TimelineEvent['precision']; range: TimeRange; onRange(r: TimeRange): void }) {
  const playhead = usePlayhead(ownerId)
  return (
    <>
      <label className="timeline-playhead-field">
        <span className="muted small">Playhead</span>
        <TimeField
          label="Playhead"
          value={playhead}
          precision={precision}
          onCommit={(v) => {
            if (!v) return
            useTimelineView.getState().setPlayhead(ownerId, v.t)
            if (v.t < range.t0 || v.t > range.t1) onRange(panRange(range, v.t - (range.t0 + range.t1) / 2))
          }}
        />
      </label>
      <button
        title="Make the playhead the story's present"
        disabled={playhead === now}
        onClick={() => void useUi.getState().execute({ type: 'timeline.update', payload: { ownerId, patch: { now: playhead } } })}
      >
        Set Now
      </button>
    </>
  )
}

/** The playhead on the ruler, with its date. */
function PlayheadMarker({ ownerId, scale, precision, cal }: { ownerId: string; scale: TimeScale; precision: TimelineEvent['precision']; cal: Calendar }) {
  const playhead = usePlayhead(ownerId)
  return <Marker className="tl-playhead-marker" x={scale.x(playhead)} label={formatTime(playhead, precision, cal)} />
}

/** The playhead's line down the track. */
function PlayheadLine({ ownerId, scale }: { ownerId: string; scale: TimeScale }) {
  const playhead = usePlayhead(ownerId)
  return <div className="tl-line playhead" style={{ left: scale.x(playhead) }} />
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
            if (name && name !== lane.name) updater('lane', lane.id)({ name })
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
  /** What it does to structures, one icon per kind of effect. */
  icons: string | undefined
  selected: boolean
  dimmed: boolean
  onPointerDown(e: React.PointerEvent, ev: TimelineEvent): void
  onHandlePointerDown(e: React.PointerEvent, ev: TimelineEvent, edge: 'start' | 'end'): void
  onConnectorPointerDown(e: React.PointerEvent, ev: TimelineEvent): void
  cal: Calendar
}

const EventBar = memo(function EventBar({ placed, icons, selected, dimmed, onPointerDown, onHandlePointerDown, onConnectorPointerDown, cal }: EventBarProps) {
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
      title={`${ev.title}\n${eventDates(ev, cal)}`}
      style={{ left: placed.x0, top: placed.y + 3, width: instant ? undefined : placed.x1 - placed.x0, ['--c' as string]: ev.color }}
      onPointerDown={(e) => onPointerDown(e, ev)}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {!instant && <span className="tl-handle start" onPointerDown={(e) => onHandlePointerDown(e, ev, 'start')} />}
      {instant && <span className="tl-diamond" />}
      <span className="tl-event-label">
        {ev.locations.length > 0 && '📍 '}
        {icons && <span className="tl-effect-icons" title="Effects on structures">{icons} </span>}
        {ev.title}
      </span>
      <span className="tl-handle end" title={instant ? 'Drag to give it a duration' : undefined} onPointerDown={(e) => onHandlePointerDown(e, ev, 'end')} />
      <span className="tl-connector" title="Drag onto another event to link them" onPointerDown={(e) => onConnectorPointerDown(e, ev)} />
    </div>
  )
})

const GroupBar = memo(function GroupBar({ placed, selected }: { placed: PlacedItem<EventGroup>; selected: boolean }) {
  const { selectTimeline } = useUi.getState()
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
        onClick={() => updater('group', g.id)({ collapsed: !g.collapsed })}
      >
        {g.collapsed ? '▸' : '▾'}
      </button>
      <span className="tl-event-label">{g.title}</span>
    </div>
  )
})

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

/** Whether a link can show in the track: its curve stays within 40 px (plus the arrowhead) of its ends, sideways. */
const linkOnScreen = (ends: { x1: number; x2: number }, width: number) => Math.max(ends.x1, ends.x2) + 50 >= 0 && Math.min(ends.x1, ends.x2) - 50 <= width

const Arrows = memo(function Arrows({ layout, links, emphasis, warned, selectedLinkId, width }: ArrowsProps) {
  const selectTimeline = useUi((s) => s.selectTimeline)
  return (
    <svg className="tl-arrows" width={width} height={layout.height}>
      <ArrowMarkers prefix="arrow" />
      {links.map((l) => {
        const ends = linkEnds(layout, l.fromId, l.toId)
        if (!ends || !linkOnScreen(ends, width)) return null
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
})

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
