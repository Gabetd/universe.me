import { formatTime } from '@universe/core'
import { DAY_S, YEAR_S, moonPhase, moonsOf, type SystemModel } from '@universe/sim'
import { useEffect, useState } from 'react'
import { usePlayhead, useTimelineView } from '../timeline/timelineStore'
import { useCalendar } from '../world/useSky'
import { useUi } from '../store'

/** Timeline seconds per second of watching. */
const SPEEDS = [
  { label: '1 day/s', perSecond: DAY_S },
  { label: '1 month/s', perSecond: 30 * DAY_S },
  { label: '1 year/s', perSecond: YEAR_S }
]

/**
 * Plays time forward in the orbit views (moving the timeline's playhead, so
 * everything else follows), and says what's in the sky then.
 */
export function SkyControls({ ownerId, system, centerId }: { ownerId: string; system: SystemModel; centerId: string | null }) {
  const [speed, setSpeed] = useState<number | null>(null)
  const playhead = usePlayhead(ownerId)
  const calendar = useCalendar(ownerId)
  const names = useUi((s) => s.nodes)

  useEffect(() => {
    if (speed === null) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const view = useTimelineView.getState()
      const t = view.playheads[ownerId] ?? playhead
      view.setPlayhead(ownerId, t + ((now - last) / 1000) * SPEEDS[speed]!.perSecond)
      last = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the loop reads the live playhead itself
  }, [speed, ownerId])

  const star = system.star
  const moons = centerId ? moonsOf(system, centerId) : []
  const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? ''
  return (
    <div className="viewport-overlay sky-controls" role="group" aria-label="Sky">
      <div className="segmented" role="group" aria-label="Play">
        <button aria-pressed={speed === null} aria-label="Pause" title="Pause" onClick={() => setSpeed(null)}>
          ⏸
        </button>
        {SPEEDS.map((s, i) => (
          <button key={s.label} aria-pressed={speed === i} onClick={() => setSpeed(i)}>
            ▶ {s.label}
          </button>
        ))}
      </div>
      <div className="small sky-readout" data-testid="sky-readout">
        <div>{formatTime(playhead, 'day', calendar)}</div>
        {centerId ? (
          moons.map((m) => {
            const phase = moonPhase(system, m, playhead)
            return (
              <div key={m.bodyId}>
                {nameOf(m.bodyId)}: {phase.name.toLowerCase()} ({Math.round(phase.illumination * 100)}% lit)
              </div>
            )
          })
        ) : (
          <div className="muted">
            Star: {star.massSun.toFixed(2)} M☉ · {star.luminositySun.toFixed(2)} L☉ · {Math.round(star.temperatureK).toLocaleString()} K · habitable {star.habitableAu[0].toFixed(2)}–
            {star.habitableAu[1].toFixed(2)} AU
          </div>
        )}
      </div>
    </div>
  )
}
