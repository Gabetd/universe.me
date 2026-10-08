import { hexToRgb01, rgb01ToHex, type ThemeLook } from '@universe/core'

type Rgb = readonly [number, number, number]

const WHITE: Rgb = [1, 1, 1]
const mixRgb = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
const mix = (a: number, b: number, k: number) => a + (b - a) * k

/** Two colours multiplied, as a light of one on a surface of the other. */
export function multiply(a: string, b: string): string {
  const [x, y] = [hexToRgb01(a), hexToRgb01(b)]
  return rgb01ToHex([x[0] * y[0], x[1] * y[1], x[2] * y[2]])
}

/** How far a theme shown in full pulls each part of a view's own look toward its own: the world keeps some of its colours. */
const PULL = { sky: 0.85, water: 0.6, land: 0.4 }

/** The atmosphere a view's own fog and halo are drawn for; more is hazier, less clearer. */
const USUAL_AIR = 0.3

/**
 * What the theme in force does to a view's own look: colours and factors to
 * mix it with. With no theme everything is as the view has it (white lights,
 * factors of 1, colours unchanged).
 */
export interface ViewTheme {
  /** The dominant theme, for tests and tooltips; '' with none. */
  name: string
  /** The key light's colour, and how much stronger or weaker it is. */
  sun: string
  sunScale: number
  /** The light from the sky. */
  ambient: string
  ambientScale: number
  /** Multiplies the terrain's colours. */
  land: string
  /** How much hazier the air is: fog comes this many times nearer, a halo is this many times stronger. */
  haze: number
  /** For a flat view (the map), what to multiply it by for the theme's light and land; undefined with no theme. */
  shade: string | undefined
  /** A view's own sky colour, pulled toward the theme's. */
  sky(base: string): string
  /** A world's sea colour, pulled toward the theme's. */
  water(base: string): string
}

const unthemed: ViewTheme = {
  name: '',
  sun: '#ffffff',
  sunScale: 1,
  ambient: '#ffffff',
  ambientScale: 1,
  land: '#ffffff',
  haze: 1,
  shade: undefined,
  sky: (base) => base,
  water: (base) => base
}

/** A view's look under `look` (the blend in force at the playhead, see `themeAt`). */
export function viewTheme(look: ThemeLook | undefined): ViewTheme {
  if (!look) return unthemed
  const k = look.strength
  // The land's hue, at full brightness, so a theme tints the ground rather than darkening it (the light does that).
  const brightest = Math.max(...look.land, 1e-6)
  const land = mixRgb(WHITE, [look.land[0] / brightest, look.land[1] / brightest, look.land[2] / brightest], PULL.land * k)
  const sun = mixRgb(WHITE, look.sun, k)
  const sunScale = mix(1, look.sunIntensity, k)
  // Brightness follows the sun, but never quite to black: a night map is still a map.
  const level = Math.min(1, 0.45 + 0.55 * sunScale)
  const pull = (base: string, to: Rgb, amount: number) => rgb01ToHex(mixRgb(hexToRgb01(base), to, amount * k))
  return {
    name: look.dominant.name,
    sun: rgb01ToHex(sun),
    sunScale,
    ambient: rgb01ToHex(mixRgb(WHITE, look.ambient, k)),
    ambientScale: mix(1, look.ambientIntensity, k),
    land: rgb01ToHex(land),
    haze: mix(1, (0.5 * (look.atmosphere + USUAL_AIR)) / USUAL_AIR, k),
    shade: rgb01ToHex([sun[0] * land[0] * level, sun[1] * land[1] * level, sun[2] * land[2] * level]),
    sky: (base) => pull(base, look.sky, PULL.sky),
    water: (base) => pull(base, look.water, PULL.water)
  }
}
