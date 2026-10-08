import type { ThemeSpan } from '@universe/core'

/** Spans on rows of the theme band so overlapping ones don't cover each other, higher priorities on the top rows. */
export function packSpans(spans: readonly ThemeSpan[]): { span: ThemeSpan; row: number }[] {
  const rows: ThemeSpan[][] = []
  return [...spans]
    .sort((a, b) => b.priority - a.priority || a.start - b.start)
    .map((span) => {
      let row = rows.findIndex((r) => r.every((o) => o.end <= span.start || o.start >= span.end))
      if (row < 0) row = rows.push([]) - 1
      rows[row]!.push(span)
      return { span, row }
    })
}

/** A span's bar fades where it blends in and out: a CSS mask over its length. */
export function blendMask(span: Pick<ThemeSpan, 'start' | 'end' | 'blendIn' | 'blendOut'>): string {
  const length = Math.max(1e-9, span.end - span.start)
  const inPct = Math.min(100, (span.blendIn / length) * 100)
  const outPct = Math.max(inPct, 100 - (span.blendOut / length) * 100)
  return `linear-gradient(90deg, rgba(0,0,0,0.3) 0%, #000 ${inPct.toFixed(1)}%, #000 ${outPct.toFixed(1)}%, rgba(0,0,0,0.3) 100%)`
}
