import { formatTime, type Calendar, type SpatialNode } from '@universe/core'
import { skyEvents, type SkyEvent } from '@universe/sim'
import { useMemo } from 'react'
import { useUi } from '../store'
import { useSystem } from '../world/useSky'
import type { TimeScale } from './scale'

/** Moon phases and eclipses are only drawn while there's room for them. */
const MAX_EVENTS = 800
const MIN_PX_PER_MONTH = 6

const LABELS: Record<'solar-eclipse' | 'lunar-eclipse', string> = { 'solar-eclipse': 'solar eclipse', 'lunar-eclipse': 'lunar eclipse' }

export function eclipseTitle(e: SkyEvent): string {
  const kind = LABELS[e.kind as keyof typeof LABELS]
  return `${e.extent ? `${e.extent[0]!.toUpperCase()}${e.extent.slice(1)} ` : ''}${kind}`
}

/**
 * A track under the ruler with the moons' new and full moons and the
 * eclipses (PLAN.md §4.3), worked out for the visible stretch of time. An
 * eclipse can be turned into an event with a click.
 */
export function SkyTrack({ owner, scale, cal, labelWidth }: { owner: SpatialNode; scale: TimeScale; cal: Calendar; labelWidth: number }) {
  const system = useSystem(owner.id)
  const worlds = useUi((s) => s.worlds)
  const nodes = useUi((s) => s.nodes)
  const execute = useUi((s) => s.execute)
  const bodyId = owner.kind === 'world' ? owner.parentId : null
  const planet = bodyId ? system?.bodies.get(bodyId) : undefined
  const hasMoons = !!planet && !planet.parentBodyId && [...system!.bodies.values()].some((o) => o.parentBodyId === planet.bodyId)
  const { t0, t1 } = scale.range

  const events = useMemo(() => {
    if (!system || !planet || !hasMoons) return []
    const ownRadius = worlds.find((w) => w.id === owner.id)?.settings.radiusKm
    return skyEvents(system, planet.bodyId, t0, t1, (o) => (o.bodyId === planet.bodyId && ownRadius) || o.radiusKm, MAX_EVENTS)
  }, [system, planet, hasMoons, t0, t1, worlds, owner.id])

  if (!hasMoons) return null
  const news = events.filter((e) => e.kind === 'new-moon')
  // Zoomed out too far, phases would be a smear: show only eclipses, and say so if there are none either.
  const showPhases = news.length > 1 && (scale.x(news[1]!.at) - scale.x(news[0]!.at)) >= MIN_PX_PER_MONTH
  const eclipses = events.filter((e) => e.kind.endsWith('eclipse'))
  const moonName = (id: string) => nodes.find((n) => n.id === id)?.name ?? 'the moon'

  const addEvent = (e: SkyEvent) =>
    void execute({
      type: 'event.create',
      payload: { ownerId: owner.id, title: `${eclipseTitle(e)}${e.kind === 'lunar-eclipse' ? ` of ${moonName(e.moonId)}` : ''}`, start: e.at, precision: 'day', color: e.kind === 'solar-eclipse' ? '#f2b84b' : '#d9604f' }
    })

  return (
    <div className="tl-subrow">
      <div className="tl-corner tl-subrow-label muted small" style={{ width: labelWidth }}>
        Moons
      </div>
      <div className="tl-sky" aria-label="Moons and eclipses">
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
      {eclipses.map((e) => (
        <button
          key={`${e.moonId}:${e.kind}:${e.at}`}
          className={`tl-eclipse ${e.kind}`}
          style={{ left: scale.x(e.at) }}
          title={`${eclipseTitle(e)} · ${formatTime(e.at, 'day', cal)}\nClick to add it to the timeline as an event`}
          aria-label={`${eclipseTitle(e)}, ${formatTime(e.at, 'day', cal)}`}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={() => addEvent(e)}
        />
      ))}
      </div>
    </div>
  )
}
