import { formatTime, type Calendar, type SpatialNode } from '@universe/core'
import { moonsOf, skyEvents, type SkyEvent } from '@universe/sim'
import { memo, useMemo } from 'react'
import { useUi } from '../store'
import { useSystem } from '../world/useSky'
import { TimeScale, type TimeRange } from './scale'
import { TrackMarker, TrackRow } from './TrackRow'

/** Moon phases and eclipses are only drawn while there's room for them. */
const MAX_EVENTS = 800
const MIN_PX_PER_MONTH = 6

const KIND: Record<'solar-eclipse' | 'lunar-eclipse', string> = { 'solar-eclipse': 'solar eclipse', 'lunar-eclipse': 'lunar eclipse' }

function eclipseTitle(e: SkyEvent): string {
  const kind = KIND[e.kind as keyof typeof KIND]
  return `${e.extent ? `${e.extent[0]!.toUpperCase()}${e.extent.slice(1)} ` : ''}${kind}`
}

/**
 * The window events are worked out for: the visible span snapped outward to
 * whole spans, so panning and zooming within it don't redo the orbits.
 */
function paddedWindow(t0: number, t1: number): [number, number] {
  const span = Math.max(1, t1 - t0)
  const step = 2 ** Math.ceil(Math.log2(span))
  return [Math.floor(t0 / step) * step - step, Math.ceil(t1 / step) * step + step]
}

/**
 * A track under the ruler with the moons' new and full moons and the
 * eclipses (PLAN.md §4.3), worked out for the visible stretch of time. An
 * eclipse can be turned into an event with a click.
 */
export const SkyTrack = memo(function SkyTrack({ owner, range, width, cal, labelWidth }: { owner: SpatialNode; range: TimeRange; width: number; cal: Calendar; labelWidth: number }) {
  const system = useSystem(owner.id)
  const nodes = useUi((s) => s.nodes)
  const execute = useUi((s) => s.execute)
  // Plain props, so playing the playhead doesn't redraw the track.
  const scale = new TimeScale(range, width)
  const planet = owner.kind === 'world' && owner.parentId ? system?.bodies.get(owner.parentId) : undefined
  const moons = planet && !planet.parentBodyId ? moonsOf(system!, planet.bodyId) : []
  const [w0, w1] = paddedWindow(scale.range.t0, scale.range.t1)

  const all = useMemo(() => (system && planet && moons.length ? skyEvents(system, planet.bodyId, w0, w1, MAX_EVENTS * 3) : []), [system, planet, moons.length, w0, w1])
  const names = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes])
  if (!moons.length) return null

  const { t0, t1 } = scale.range
  const events = all.length >= MAX_EVENTS * 3 ? [] : all.filter((e) => e.at >= t0 && e.at <= t1)
  const news = events.filter((e) => e.kind === 'new-moon')
  // Zoomed out too far, phases would be a smear: show only eclipses.
  const showPhases = news.length > 1 && scale.x(news[1]!.at) - scale.x(news[0]!.at) >= MIN_PX_PER_MONTH
  const moonName = (id: string) => names.get(id) ?? 'the moon'

  const addEvent = (e: SkyEvent) =>
    void execute({
      type: 'event.create',
      payload: { ownerId: owner.id, title: `${eclipseTitle(e)}${e.kind === 'lunar-eclipse' ? ` of ${moonName(e.moonId)}` : ''}`, start: e.at, precision: 'day', color: e.kind === 'solar-eclipse' ? '#f2b84b' : '#d9604f' }
    })

  return (
    <TrackRow label="Moons" ariaLabel="Moons and eclipses" labelWidth={labelWidth}>
      {events.length === 0 && <span className="muted small tl-sky-note">Zoom in to see moon phases</span>}
      {showPhases &&
        events
          .filter((e) => e.kind === 'new-moon' || e.kind === 'full-moon')
          .map((e) => (
            <span
              key={`${e.moonId}:${e.kind}:${e.at}`}
              className={`tl-moon ${e.kind}`}
              style={{ left: scale.x(e.at) }}
              title={`${e.kind === 'new-moon' ? 'New' : 'Full'} ${moonName(e.moonId)} · ${formatTime(e.at, 'day', cal)}`}
            />
          ))}
      {events
        .filter((e) => e.kind.endsWith('eclipse'))
        .map((e) => {
          const when = formatTime(e.at, 'day', cal)
          return (
            <TrackMarker
              key={`${e.moonId}:${e.kind}:${e.at}`}
              className={`tl-eclipse ${e.kind}`}
              x={scale.x(e.at)}
              title={`${eclipseTitle(e)} · ${when}\nClick to add it to the timeline as an event`}
              label={`${eclipseTitle(e)}, ${when}`}
              onClick={() => addEvent(e)}
            />
          )
        })}
    </TrackRow>
  )
})
