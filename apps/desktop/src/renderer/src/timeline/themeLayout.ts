import { hexToRgb01, spanWeight, type ThemeSpan } from '@universe/core'

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

/**
 * A span's bar fades as the span does at each point along it (eased, and
 * never fully in where its fades overlap), down to a faint 30%: a CSS mask
 * over its length, from the same weights the views blend by.
 */
export function blendMask(span: Pick<ThemeSpan, 'start' | 'end' | 'blendIn' | 'blendOut'>): string {
  const length = span.end - span.start
  if (length <= 0) return 'none'
  const at = new Set([0, 1])
  const fade = (from: number, to: number) => {
    for (let i = 0; i <= 6; i++) at.add(from + ((to - from) * i) / 6)
  }
  fade(0, Math.min(1, span.blendIn / length))
  fade(Math.max(0, 1 - span.blendOut / length), 1)
  const stops = [...at].sort((a, b) => a - b).map((f) => `rgba(0,0,0,${(0.3 + 0.7 * spanWeight(span, span.start + f * length)).toFixed(2)}) ${(f * 100).toFixed(1)}%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/** Whether a colour is dark enough to want light text on it (by its perceived brightness). */
export function isDark(hex: string): boolean {
  const [r, g, b] = hexToRgb01(hex)
  return 0.299 * r + 0.587 * g + 0.114 * b < 0.45
}
