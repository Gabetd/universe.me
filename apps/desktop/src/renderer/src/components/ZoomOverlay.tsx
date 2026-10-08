import { useEffect, useRef, type ReactNode } from 'react'
import { useZoom } from './zoom'

const DURATION_MS = 480

/**
 * Plays a level change as one zoom: the still of the old view flies past
 * (going in) or falls away (going out) over the new view, which arrives from
 * the same point.
 */
export function ZoomStage({ children }: { children: ReactNode }) {
  const transition = useZoom((s) => s.transition)
  const count = useZoom((s) => s.count)
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!transition) return
    const timer = setTimeout(() => useZoom.getState().set(null), DURATION_MS)
    const still = transition.still
    host.current?.appendChild(still)
    return () => {
      clearTimeout(timer)
      still.remove()
    }
  }, [transition])

  const arriving = transition ? `zoom-arrive ${transition.direction}` : ''
  return (
    <div ref={host} className="zoom-stage">
      <div key={count} className={`zoom-view ${arriving}`} style={transition ? { transformOrigin: `${transition.x}px ${transition.y}px` } : undefined}>
        {children}
      </div>
    </div>
  )
}
