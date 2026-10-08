import type { ThemeSpan } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { blendMask, isDark, packSpans } from './themeLayout'

const span = (id: string, start: number, end: number, priority = 0) =>
  ({ id, ownerId: 'w', themeId: 't', start, end, regionId: null, priority, blendIn: 0, blendOut: 0, createdAt: '', updatedAt: '', deletedAt: null }) as ThemeSpan

describe('the theme band', () => {
  it('stacks overlapping spans, higher priorities on top, and lets the rest share a row', () => {
    const rows = packSpans([span('a', 0, 10), span('b', 5, 15, 2), span('c', 10, 20), span('d', 30, 40)])
    const row = (id: string) => rows.find((r) => r.span.id === id)!.row
    expect(row('b')).toBe(0)
    expect(row('a')).toBe(1)
    expect(row('c')).toBe(1)
    expect(row('d')).toBe(0)
  })

  it('fades a bar as the span fades: full between its blend times, faint at its ends', () => {
    const mask = blendMask({ start: 0, end: 100, blendIn: 25, blendOut: 10 })
    expect(mask).toContain('rgba(0,0,0,0.30) 0.0%')
    expect(mask).toContain('rgba(0,0,0,1.00) 25.0%')
    expect(mask).toContain('rgba(0,0,0,1.00) 90.0%')
    expect(mask).toContain('rgba(0,0,0,0.30) 100.0%')
  })

  it('never shows a bar in full where its fades overlap, as the views never show the span in full', () => {
    const alphas = [...blendMask({ start: 0, end: 100, blendIn: 80, blendOut: 80 }).matchAll(/rgba\(0,0,0,([\d.]+)\)/g)].map((m) => Number(m[1]))
    expect(Math.max(...alphas)).toBeLessThan(1)
  })

  it('names a bar in light type on a dark palette', () => {
    expect(isDark('#6d5c3e')).toBe(true)
    expect(isDark('#c9d6df')).toBe(false)
  })
})
