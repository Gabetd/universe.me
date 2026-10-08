import { THEME_PRESETS, themeAt, type Theme, type ThemeSpan } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { multiply, viewTheme } from './viewTheme'

const meta = { ownerId: 'w', createdAt: '', updatedAt: '', deletedAt: null }
const theme = (id: string, preset: string) => ({ id, ...meta, ...THEME_PRESETS[preset]! }) as Theme
const span = (id: string, themeId: string, start: number, end: number, blend = 0) =>
  ({ id, ...meta, themeId, start, end, regionId: null, priority: 0, blendIn: blend, blendOut: blend }) as ThemeSpan

const themes = [theme('golden', 'Golden Age'), theme('war', 'Age of War')]
const lookAt = (t: number, spans: ThemeSpan[]) => viewTheme(themeAt(spans, themes, t))

describe("a view's theme", () => {
  it('leaves the view as it is with no theme in force', () => {
    const v = viewTheme(undefined)
    expect([v.name, v.sun, v.ambient, v.land, v.sunScale, v.ambientScale, v.haze, v.shade]).toEqual(['', '#ffffff', '#ffffff', '#ffffff', 1, 1, 1, undefined])
    expect(v.sky('#a9cdea')).toBe('#a9cdea')
    expect(v.water('#1f5f8b')).toBe('#1f5f8b')
  })

  it("takes on a theme's light, air and colours, keeping some of the world's own", () => {
    const v = lookAt(50, [span('a', 'war', 0, 100)])
    expect(v.name).toBe('Age of War')
    // A storm: a weaker grey sun, hazier air, a darker map.
    expect(v.sunScale).toBeCloseTo(0.45)
    expect(v.haze).toBeGreaterThan(1)
    expect(v.shade).not.toBe('#ffffff')
    // The sky is pulled most of the way to the theme's, not all of it.
    expect(v.sky('#a9cdea')).not.toBe('#a9cdea')
    expect(v.sky('#a9cdea')).not.toBe(THEME_PRESETS['Age of War']!.palette.sky)
    // The land is tinted, not darkened: its brightest channel stays full.
    expect(v.land.slice(1, 3)).toBe('ff')
  })

  it('eases in over a blend: halfway through it shows partly', () => {
    const spans = [span('a', 'war', 0, 100, 20)]
    const start = lookAt(1, spans)
    const half = lookAt(10, spans)
    const full = lookAt(50, spans)
    expect(start.sunScale).toBeGreaterThan(half.sunScale)
    expect(half.sunScale).toBeGreaterThan(full.sunScale)
  })

  it('multiplies colours like light on a surface', () => {
    expect(multiply('#ffffff', '#336699')).toBe('#336699')
    expect(multiply('#808080', '#ff0000')).toBe('#800000')
  })
})
