import { derivedEvents, formatTime, type Calendar, type DerivedEvent, type SpatialNode } from '@universe/core'
import { useMemo } from 'react'
import { useUi } from '../store'
import { useConditionCurves } from '../world/useStructures'
import type { TimeScale } from './scale'

const VERB: Record<DerivedEvent['kind'], string> = { ruin: 'falls into ruin', eroded: 'erodes away' }

/**
 * A track of what weathering does by itself (PLAN.md §4.7, derived events):
 * when each structure left to weather falls into ruin and when it erodes
 * away. They follow every edit; click one to make it a real event (with its
 * own notes and links), placed at the structure.
 */
export function DerivedTrack({ owner, scale, cal, labelWidth }: { owner: SpatialNode; scale: TimeScale; cal: Calendar; labelWidth: number }) {
  const { world, curves } = useConditionCurves(owner.id)
  const execute = useUi((s) => s.execute)
  const events = useMemo(() => (owner.kind === 'world' ? derivedEvents(curves) : []), [curves, owner.kind])
  if (!events.length) return null
  const { t0, t1 } = scale.range
  const nameOf = (id: string) => world.data.structures.find((s) => s.id === id)
  const label = (e: DerivedEvent) => `${nameOf(e.structureId)?.name ?? 'A structure'} ${VERB[e.kind]}`
  const promote = (e: DerivedEvent) => {
    const s = nameOf(e.structureId)
    void execute({
      type: 'event.create',
      payload: { ownerId: owner.id, title: label(e), start: e.at, precision: 'year', color: e.kind === 'ruin' ? '#d9604f' : '#8c6f66', locations: s ? [{ kind: 'point', lat: s.lat, lon: s.lon }] : [] }
    })
  }
  return (
    <div className="tl-subrow">
      <div className="tl-corner tl-subrow-label muted small" style={{ width: labelWidth }}>
        Weathering
      </div>
      <div className="tl-sky" aria-label="Weathering">
        {events
          .filter((e) => e.at >= t0 && e.at <= t1)
          .map((e) => (
            <button
              key={`${e.structureId}:${e.kind}:${e.at}`}
              className={`tl-derived ${e.kind}`}
              style={{ left: scale.x(e.at) }}
              title={`${label(e)} · ${formatTime(e.at, 'year', cal)}\nWorked out from its materials and weather. Click to make it an event.`}
              aria-label={`${label(e)}, ${formatTime(e.at, 'year', cal)}`}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => promote(e)}
            />
          ))}
      </div>
    </div>
  )
}
