import type { LinkType } from '@universe/core'

/** How each kind of causal link is drawn, on the timeline and on the canvas. */
export const LINK_STYLE: Record<LinkType, { color: string; dash?: string; arrow: boolean }> = {
  causes: { color: '#7aa2ff', arrow: true },
  enables: { color: '#8bc34a', arrow: true },
  prevents: { color: '#ff7a8a', dash: '6 4', arrow: true },
  precedes: { color: '#8891ad', arrow: true },
  related: { color: '#8891ad', dash: '2 4', arrow: false }
}

export const WARN_COLOR = '#ffd27a'

/** Arrowhead markers for an SVG, one per link type plus "warn", with ids `${prefix}-${type}`. */
export function ArrowMarkers({ prefix }: { prefix: string }) {
  return (
    <defs>
      {[...Object.entries(LINK_STYLE), ['warn', { color: WARN_COLOR }] as const].map(([type, s]) => (
        <marker key={type} id={`${prefix}-${type}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={s.color} />
        </marker>
      ))}
    </defs>
  )
}
