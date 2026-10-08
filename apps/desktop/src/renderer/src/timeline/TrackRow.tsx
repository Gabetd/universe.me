import type { MouseEvent, ReactNode } from 'react'

/** A thin row under the ruler (themes, moons, weathering), labelled in the lane column. */
export function TrackRow({
  label,
  ariaLabel,
  labelWidth,
  className,
  height,
  onDoubleClick,
  children
}: {
  label: string
  ariaLabel: string
  labelWidth: number
  className?: string
  height?: number
  onDoubleClick?(e: MouseEvent<HTMLDivElement>): void
  children: ReactNode
}) {
  return (
    <div className={className ? `tl-subrow ${className}` : 'tl-subrow'} style={height === undefined ? undefined : { height }}>
      <div className="tl-corner tl-subrow-label muted small" style={{ width: labelWidth }}>
        {label}
      </div>
      <div className="tl-sky" aria-label={ariaLabel} onDoubleClick={onDoubleClick}>
        {children}
      </div>
    </div>
  )
}

/** A marker in a track row; clicking it turns it into an event. Presses don't start a timeline pan. */
export function TrackMarker({ className, x, title, label, onClick }: { className: string; x: number; title: string; label: string; onClick(): void }) {
  return <button className={className} style={{ left: x }} title={title} aria-label={label} onPointerDown={(e) => e.stopPropagation()} onClick={onClick} />
}
