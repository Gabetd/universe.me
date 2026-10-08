import type { ReactNode } from 'react'

/** A thin row under the ruler (moons, weathering), labelled in the lane column. */
export function TrackRow({ label, ariaLabel, labelWidth, children }: { label: string; ariaLabel: string; labelWidth: number; children: ReactNode }) {
  return (
    <div className="tl-subrow">
      <div className="tl-corner tl-subrow-label muted small" style={{ width: labelWidth }}>
        {label}
      </div>
      <div className="tl-sky" aria-label={ariaLabel}>
        {children}
      </div>
    </div>
  )
}

/** A marker in a track row; clicking it turns it into an event. Presses don't start a timeline pan. */
export function TrackMarker({ className, x, title, label, onClick }: { className: string; x: number; title: string; label: string; onClick(): void }) {
  return <button className={className} style={{ left: x }} title={title} aria-label={label} onPointerDown={(e) => e.stopPropagation()} onClick={onClick} />
}
