/** Placeholder for the M2 timeline: shows the past ← now → future layout it will fill. */
export function TimelineBar() {
  const ticks = Array.from({ length: 21 }, (_, i) => i)
  return (
    <div className="timeline">
      <div className="timeline-header">
        <span>Timeline</span>
        <span className="muted small">Events, causes, and themes arrive in M2</span>
      </div>
      <div className="timeline-track">
        <span className="timeline-end">◄ Past</span>
        <div className="timeline-ruler">
          {ticks.map((i) => (
            <span key={i} className={`tick${i % 5 === 0 ? ' major' : ''}`} style={{ left: `${(i / 20) * 100}%` }} />
          ))}
          <span className="timeline-now" style={{ left: '50%' }}>
            <span>Now</span>
          </span>
        </div>
        <span className="timeline-end">Future ►</span>
      </div>
    </div>
  )
}
