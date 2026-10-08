import { formatTime, type Calendar, type Command, type SpatialNode, type ThemeSpan } from '@universe/core'
import { memo, useMemo, useState } from 'react'
import { useUi } from '../store'
import { useWorldThemes } from '../world/useThemeLook'
import { TimeScale, snap, type TimeRange } from './scale'
import { blendMask, packSpans } from './themeLayout'

const ROW_H = 16
/** Px at either end of a bar that resize it rather than move it. */
const EDGE_PX = 6

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

  const createAt = (x: number) => {
    const start = snap(scale.t(x), scale.secondsPerPx)
    const end = snap(start + (range.t1 - range.t0) / 4, scale.secondsPerPx)
    // The theme used last, or a first one from a preset.
    const latest = [...themes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    const rootId = useUi.getState().project?.rootId
    if (latest) return void execute({ type: 'themeSpan.create', payload: { ownerId: owner.id, themeId: latest.id, start, end } })
    if (!rootId) return
    const themeId = crypto.randomUUID()
    const commands: Command[] = [
      { type: 'theme.create', payload: { id: themeId, ownerId: rootId, preset: 'Golden Age' } },
      { type: 'themeSpan.create', payload: { ownerId: owner.id, themeId, start, end } }
    ]
    void execute({ type: 'batch', payload: { commands } })
  }

  return (
    <div className="tl-subrow tl-theme-row" style={{ height: rows * ROW_H + 6 }}>
      <div className="tl-corner tl-subrow-label muted small" style={{ width: labelWidth }}>
        Themes
      </div>
      <div
        className="tl-sky tl-themes"
        aria-label="Theme spans"
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
          const when = `${formatTime(s.start, 'year', cal)} – ${formatTime(s.end, 'year', cal)}`
          const { sky, land, water, accent } = theme.palette
          return (
            <button
              key={s.id}
              className={`tl-theme${selected ? ' selected' : ''}`}
              style={{
                left: x0,
                width: Math.max(8, x1 - x0),
                top: 3 + row * ROW_H,
                // A span that starts off to the left keeps its name in view.
                paddingLeft: Math.max(6, 6 - x0),
                background: `linear-gradient(90deg, ${sky}, ${land} 55%, ${water})`,
                maskImage: blendMask(s),
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
                if (drag?.id === s.id) setDrag({ ...drag, dt: snap((e.clientX - drag.x0) * scale.secondsPerPx, scale.secondsPerPx) })
                else e.currentTarget.style.cursor = edgeAt(e) ? 'ew-resize' : 'grab'
              }}
              onPointerUp={() => {
                if (drag?.id !== s.id) return
                setDrag(null)
                if (drag.dt === 0) return selectTimeline({ kind: 'themeSpan', ids: [s.id] })
                void execute({ type: 'themeSpan.update', payload: { id: s.id, patch: { start: s.start, end: s.end } } })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') selectTimeline({ kind: 'themeSpan', ids: [s.id] })
              }}
            >
              <span>
                {theme.name}
                {where}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
})

/** The end of a bar under the pointer, if it's on one; a bar too short to have a middle only moves. */
function edgeAt(e: React.PointerEvent<HTMLElement>): 'start' | 'end' | undefined {
  const rect = e.currentTarget.getBoundingClientRect()
  if (rect.width < EDGE_PX * 4) return undefined
  return e.clientX - rect.left < EDGE_PX ? 'start' : rect.right - e.clientX < EDGE_PX ? 'end' : undefined
}
