import { MATERIAL_INFO, STAGES, erodesAt, formatTime, ruinAt, secondsPerYear, stageOf, stateAt, type Calendar, type ConditionCurve, type Material } from '@universe/core'
import { useMemo } from 'react'
import { useTimelineView } from '../timeline/timelineStore'
import { STAGE_COLORS } from '../world/structureLook'

const W = 300
const H = 64
const SAMPLES = 160

/**
 * A structure's condition over its life (PLAN.md §4.7, the condition
 * sparkline): from when it's built to when it will erode away if left alone,
 * with what happened to it marked (click one to go there), and the playhead.
 */
export function ConditionChart({ curve, builtAt, playhead, ownerId, cal }: { curve: ConditionCurve; builtAt: number; playhead: number; ownerId: string; cal: Calendar }) {
  // From the build to its erosion if left alone after everything that's planned for it, or a century past the last of that.
  const century = 100 * secondsPerYear(cal)
  const from = Math.max(playhead, curve.steps.at(-1)?.at ?? builtAt)
  const eroded = erodesAt(curve, from)
  const t0 = builtAt
  const end = t0 + Math.max(eroded !== undefined ? eroded - t0 : from - t0 + century, century) * 1.05
  const x = (t: number) => ((t - t0) / (end - t0)) * W
  const y = (c: number) => H - 4 - (c / 100) * (H - 8)
  // The line only changes with the curve and the span shown, not with every move of the playhead.
  const points = useMemo(
    () =>
      Array.from({ length: SAMPLES + 1 }, (_, k) => {
        const t = t0 + ((end - t0) * k) / SAMPLES
        return `${((k / SAMPLES) * W).toFixed(1)},${(H - 4 - (stateAt(curve, t).condition / 100) * (H - 8)).toFixed(1)}`
      }).join(' '),
    [curve, t0, end]
  )
  const ruin = useMemo(() => ruinAt(curve, playhead), [curve, playhead])
  const setPlayhead = (t: number) => useTimelineView.getState().setPlayhead(ownerId, t)

  return (
    <figure className="condition-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Condition over time">
        {STAGES.slice(1).map((s) => (
          <line key={s.stage} x1={0} x2={W} y1={y(s.from)} y2={y(s.from)} className="condition-chart-grid" />
        ))}
        <polyline points={points} className="condition-chart-line" />
        <line x1={x(playhead)} x2={x(playhead)} y1={0} y2={H} className="condition-chart-playhead" />
        {curve.steps
          .filter((s) => s.kind !== 'build' || s.at !== builtAt)
          .map((s, i) => (
            <circle key={i} cx={x(s.at)} cy={y(stateAt(curve, s.at).condition)} r={3.5} className={`condition-chart-step ${s.kind}`} onClick={() => setPlayhead(s.at)}>
              <title>
                {formatTime(s.at, 'year', cal)}: {s.kind}
              </title>
            </circle>
          ))}
      </svg>
      <figcaption className="small muted">
        {formatTime(t0, 'year', cal)} → {formatTime(end, 'year', cal)}
        {ruin !== undefined && <> · a ruin by {formatTime(ruin, 'year', cal)}</>}
        {eroded !== undefined && <> · gone by {formatTime(eroded, 'year', cal)}</>}
      </figcaption>
    </figure>
  )
}

/** How each of its materials is holding up at the playhead. */
export function MaterialConditions({ materials }: { materials: Partial<Record<Material, number>> }) {
  const list = Object.entries(materials) as [Material, number][]
  if (list.length < 2) return null
  return (
    <ul className="material-conditions small" aria-label="Materials">
      {list
        .sort((a, b) => a[1] - b[1])
        .map(([m, c]) => (
          <li key={m}>
            <span>{MATERIAL_INFO[m].label}</span>
            <span className="condition-bar">
              <span style={{ width: `${c}%`, background: STAGE_COLORS[stageOf(c)] }} />
            </span>
            <span className="muted">{Math.round(c)}</span>
          </li>
        ))}
    </ul>
  )
}
