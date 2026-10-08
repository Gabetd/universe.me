import { derivedEvents, formatTime, type Calendar, type DerivedEvent, type SpatialNode } from '@universe/core'
import { memo, useMemo } from 'react'
import { useUi } from '../store'
import { useConditionCurves } from '../world/useStructures'
import { TimeScale, type TimeRange } from './scale'
import { TrackMarker, TrackRow } from './TrackRow'

const VERB: Record<DerivedEvent['kind'], string> = { ruin: 'falls into ruin', eroded: 'erodes away' }

/**
 * A track of what weathering does by itself (PLAN.md §4.7, derived events):
 * when each structure left to weather falls into ruin and when it erodes
 * away. They follow every edit; click one to make it a real event (with its
 * own notes and links), placed at the structure.
 */
export const DerivedTrack = memo(function DerivedTrack({ owner, range, width, cal, labelWidth }: { owner: SpatialNode; range: TimeRange; width: number; cal: Calendar; labelWidth: number }) {
  const { world, curves } = useConditionCurves(owner.id)
  const execute = useUi((s) => s.execute)
  // Plain props, so playing the playhead doesn't redraw the track.
  const scale = new TimeScale(range, width)
  const events = useMemo(() => (owner.kind === 'world' ? derivedEvents(curves) : []), [curves, owner.kind])
  const structures = useMemo(() => new Map(world.data.structures.map((s) => [s.id, s])), [world])
  if (!events.length) return null
  const { t0, t1 } = scale.range
  const label = (e: DerivedEvent) => `${structures.get(e.structureId)?.name ?? 'A structure'} ${VERB[e.kind]}`
  const promote = (e: DerivedEvent) => {
    const s = structures.get(e.structureId)
    void execute({
      type: 'event.create',
      payload: { ownerId: owner.id, title: label(e), start: e.at, precision: 'year', color: e.kind === 'ruin' ? '#d9604f' : '#8c6f66', locations: s ? [{ kind: 'point', lat: s.lat, lon: s.lon }] : [] }
    })
  }
  return (
    <TrackRow label="Weathering" ariaLabel="Weathering" labelWidth={labelWidth}>
      {events
        .filter((e) => e.at >= t0 && e.at <= t1)
        .map((e) => {
          const when = formatTime(e.at, 'year', cal)
          return (
            <TrackMarker
              key={`${e.structureId}:${e.kind}:${e.at}`}
              className={`tl-derived ${e.kind}`}
              x={scale.x(e.at)}
              title={`${label(e)} · ${when}\nWorked out from its materials and weather. Click to make it an event.`}
              label={`${label(e)}, ${when}`}
              onClick={() => promote(e)}
            />
          )
        })}
    </TrackRow>
  )
})
