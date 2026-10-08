import type { Calendar, SpatialNode, ThemeSpan } from '@universe/core'
import { memo, useMemo, useState } from 'react'
import { updater, useUi } from '../store'
import { useWorldThemes } from '../world/useThemeLook'
import { spanDates } from './labels'
import { TimeScale, snap, type TimeRange } from './scale'
import { lastUsedTheme, themeSpanCommand } from './themeCommands'
import { blendMask, isDark, packSpans } from './themeLayout'
import { TrackRow } from './TrackRow'

const ROW_H = 16
/** Px at either end of a bar that resize it rather than move it. */
const EDGE_PX = 6
/** Px a press has to move before it's a drag, not a click. */
const DRAG_PX = 3

/** A bar being dragged: moved whole, or by one end. */
interface Drag {
  id: string
  mode: 'move' | 'start' | 'end'
  x0: number
  dt: number
}

/**
 * The theme band (PLAN.md §5.4): each of the world's theme spans as a bar
 * in its theme's colours above the lanes, fading at either end over its blend
 * times. Overlapping spans stack, higher priorities on top. Click a bar to
 * select it, drag it to move, drag an end to resize; double-click the band to
 * put a theme on from there.
 */
export const ThemeTrack = memo(function ThemeTrack({ owner, range, width, cal, labelWidth }: { owner: SpatialNode; range: TimeRange; width: number; cal: Calendar; labelWidth: number }) {
  const { spans, themes } = useWorldThemes(owner.id)
  const regions = useUi((s) => s.regions)
  const selection = useUi((s) => s.timelineSelection)
  const placed = useMemo(() => packSpans(spans), [spans])
  const themeById = useMemo(() => new Map(themes.map((t) => [t.id, t])), [themes])
  const regionName = useMemo(() => new Map(regions.map((r) => [r.id, r.name])), [regions])
  const [drag, setDrag] = useState<Drag | null>(null)
  if (owner.kind !== 'world') return null

  const scale = new TimeScale(range, width)
  const rows = Math.max(1, ...placed.map((p) => p.row + 1))
  const { execute, selectTimeline } = useUi.getState()
  // Where a span is drawn, following a drag in progress.
  const moved = (s: ThemeSpan) => {
    if (drag?.id !== s.id) return s
    const start = drag.mode === 'end' ? s.start : Math.min(s.start + drag.dt, drag.mode === 'start' ? s.end : Infinity)
    const end = drag.mode === 'start' ? s.end : Math.max(s.end + drag.dt, drag.mode === 'end' ? s.start : -Infinity)
    return { ...s, start, end }
  }

  // A quarter of the view from there: the theme put on last, or a first one from a preset.
  const createAt = (x: number) => {
    const start = snap(scale.t(x), scale.secondsPerPx)
    const end = snap(start + (range.t1 - range.t0) / 4, scale.secondsPerPx)
    const themeId = lastUsedTheme()
    const command = themeSpanCommand(owner.id, start, end, themeId ? { themeId } : { preset: 'Golden Age' })
    if (command) void execute(command)
  }

  return (
    <TrackRow
      label="Themes"
      ariaLabel="Theme spans"
      labelWidth={labelWidth}
      className="tl-theme-row"
      height={rows * ROW_H + 6}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) createAt(e.clientX - e.currentTarget.getBoundingClientRect().left)
      }}
    >
        {!spans.length && <span className="tl-sky-note muted small">Double-click to give the world a theme from here</span>}
        {placed.map(({ span: stored, row }) => {
          const theme = themeById.get(stored.themeId)
          if (!theme) return null
          const s = moved(stored)
          const x0 = scale.x(s.start)
          const x1 = scale.x(s.end)
          if (x1 < 0 || x0 > width) return null
          const selected = selection?.kind === 'themeSpan' && selection.ids.includes(s.id)
          const where = s.regionId ? ` · ${regionName.get(s.regionId) ?? 'a region'}` : ''
          const when = spanDates(s, cal)
          const { sky, land, water, accent } = theme.palette
          return (
            <button
              key={s.id}
              className={`tl-theme${selected ? ' selected' : ''}${isDark(land) ? ' light-ink' : ''}`}
              style={{
                left: x0,
                width: Math.max(8, x1 - x0),
                top: 3 + row * ROW_H,
                // A span that starts off to the left keeps its name in view.
                paddingLeft: Math.max(6, 6 - x0),
                ['--c' as string]: accent
              }}
              title={`${theme.name}${where}: ${when}`}
              aria-label={`Theme span ${theme.name}${where}, ${when}`}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                e.currentTarget.setPointerCapture(e.pointerId)
                setDrag({ id: s.id, mode: edgeAt(e) ?? 'move', x0: e.clientX, dt: 0 })
              }}
              onPointerMove={(e) => {
                if (drag?.id !== s.id) return void (e.currentTarget.style.cursor = edgeAt(e) ? 'ew-resize' : 'grab')
                // Where the dragged edge (or the start, moving it whole) lands, on the grid like events.
                const dx = e.clientX - drag.x0
                const edge = drag.mode === 'end' ? stored.end : stored.start
                setDrag({ ...drag, dt: Math.abs(dx) < DRAG_PX ? 0 : snap(edge + dx * scale.secondsPerPx, scale.secondsPerPx) - edge })
              }}
              onPointerUp={() => {
                if (drag?.id !== s.id) return
                setDrag(null)
                if (drag.dt === 0) return selectTimeline({ kind: 'themeSpan', ids: [s.id] })
                updater('themeSpan', s.id)({ start: s.start, end: s.end })
              }}
              // A drag the system takes away (a window switch, a touch cancelled) leaves the span as it was.
              onPointerCancel={() => setDrag(null)}
              onLostPointerCapture={() => setDrag((d) => (d?.id === s.id ? null : d))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') selectTimeline({ kind: 'themeSpan', ids: [s.id] })
              }}
            >
              {/* The palette fades in and out with the span; the name stays readable. */}
              <span className="tl-theme-fill" style={{ background: `linear-gradient(90deg, ${sky}, ${land} 55%, ${water})`, maskImage: blendMask(s) }} />
              <span className="tl-theme-name">
                {theme.name}
                {where}
              </span>
            </button>
          )
        })}
    </TrackRow>
  )
})

/** The end of a bar under the pointer, if it's on one; a bar too short to have a middle only moves. */
function edgeAt(e: React.PointerEvent<HTMLElement>): 'start' | 'end' | undefined {
  const rect = e.currentTarget.getBoundingClientRect()
  if (rect.width < EDGE_PX * 4) return undefined
  return e.clientX - rect.left < EDGE_PX ? 'start' : rect.right - e.clientX < EDGE_PX ? 'end' : undefined
}
