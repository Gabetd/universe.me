import { z } from 'zod'
import { Id, Notes, RecordMeta } from './schema'
import { Time } from './time'
import { byId } from './util'
import { HexColor } from './world'

/**
 * Themes (PLAN.md §4.5): a look and a tone (palette, lighting, air, type,
 * mood words and a prose style guide for whoever writes about it), kept in
 * the project's library, and spans that put one on a world for a stretch of
 * its history, optionally in one region. As the playhead moves, the spans in
 * force blend: each fades in and out over its own blend times, higher
 * priorities on top.
 */

export const LIGHTING_PRESETS = ['day', 'golden', 'overcast', 'dusk', 'night', 'storm'] as const
export const LightingPreset = z.enum(LIGHTING_PRESETS)
export type LightingPreset = z.infer<typeof LightingPreset>

export const TYPOGRAPHY = ['serif', 'sans', 'mono'] as const
export const Typography = z.enum(TYPOGRAPHY)
export type Typography = z.infer<typeof Typography>

export const ThemePalette = z.object({ sky: HexColor, water: HexColor, land: HexColor, accent: HexColor })
export type ThemePalette = z.infer<typeof ThemePalette>

export const Theme = z.object({
  ...RecordMeta,
  name: z.string().min(1).max(200),
  palette: ThemePalette,
  lighting: LightingPreset,
  /** How thick the air looks: 0 clear, 1 a heavy haze. */
  atmosphere: z.number().min(0).max(1),
  typography: Typography,
  /** A few words for the feel of it ("hopeful", "gilded"). */
  mood: z.array(z.string().min(1).max(60)).max(20),
  /** How to write about this time and place: voice, tense, vocabulary, what to avoid. */
  style: z.string().max(20_000),
  /** Music or soundscape tags, for whoever scores it. */
  ambience: z.array(z.string().min(1).max(60)).max(20),
  notes: Notes
})
export type Theme = z.infer<typeof Theme>

/** A theme on a world (its owner) from `start` to `end`, fading in over `blendIn` and out over `blendOut` (seconds), in one region or everywhere. */
export const ThemeSpan = z.object({
  ...RecordMeta,
  themeId: Id,
  start: Time,
  end: Time,
  regionId: Id.nullable(),
  /** Overlapping spans: higher ones show on top. */
  priority: z.number().int().min(-100).max(100),
  blendIn: z.number().min(0).finite(),
  blendOut: z.number().min(0).finite()
})
export type ThemeSpan = z.infer<typeof ThemeSpan>

export type ThemeFields = Omit<Theme, keyof typeof RecordMeta>

/** Themes to start from: change anything. */
export const THEME_PRESETS: Record<string, ThemeFields> = {
  'Golden Age': {
    name: 'Golden Age',
    palette: { sky: '#f3d9a4', water: '#2e7d9a', land: '#b5a642', accent: '#e0a526' },
    lighting: 'golden',
    atmosphere: 0.25,
    typography: 'serif',
    mood: ['prosperous', 'confident', 'gilded'],
    style: 'Warm, expansive prose. Long sentences full of trade, music and building. Even the poor have hope; trouble is distant and rumoured.',
    ambience: ['lutes', 'market crowds'],
    notes: ''
  },
  'Plague Years': {
    name: 'Plague Years',
    palette: { sky: '#8c8f7a', water: '#3d4f4a', land: '#6b6a45', accent: '#9c3d2e' },
    lighting: 'overcast',
    atmosphere: 0.7,
    typography: 'serif',
    mood: ['fearful', 'grim', 'quiet'],
    style: 'Short, close sentences. Smell and sound before sight. Names are lost; people are counted. Avoid heroics.',
    ambience: ['bells', 'rain', 'silence'],
    notes: ''
  },
  'Ice Age': {
    name: 'Ice Age',
    palette: { sky: '#d6e4ee', water: '#3b6e8f', land: '#c9d6df', accent: '#5fa8d3' },
    lighting: 'day',
    atmosphere: 0.45,
    typography: 'sans',
    mood: ['harsh', 'still', 'enduring'],
    style: 'Spare and plain. Cold as a constant presence; every journey is measured against the weather.',
    ambience: ['wind', 'cracking ice'],
    notes: ''
  },
  Twilight: {
    name: 'Twilight',
    palette: { sky: '#4a3b6b', water: '#22304f', land: '#4f5d4a', accent: '#c77dff' },
    lighting: 'dusk',
    atmosphere: 0.4,
    typography: 'serif',
    mood: ['melancholy', 'mysterious', 'ending'],
    style: 'Elegiac and lyrical. Things are seen as they fade. Hint more than tell.',
    ambience: ['strings', 'night birds'],
    notes: ''
  },
  'Age of War': {
    name: 'Age of War',
    palette: { sky: '#6e5a52', water: '#33414e', land: '#6d5c3e', accent: '#d1495b' },
    lighting: 'storm',
    atmosphere: 0.55,
    typography: 'sans',
    mood: ['tense', 'brutal', 'loyal'],
    style: 'Hard, active verbs. Orders, numbers and distances. Keep the cost of each fight in view.',
    ambience: ['drums', 'distant thunder'],
    notes: ''
  },
  Verdant: {
    name: 'Verdant',
    palette: { sky: '#bfe3d0', water: '#1f7a8c', land: '#4c9a2a', accent: '#7cb518' },
    lighting: 'day',
    atmosphere: 0.3,
    typography: 'sans',
    mood: ['lush', 'alive', 'gentle'],
    style: 'Sensory and generous: growth, water, insects, the slow work of seasons.',
    ambience: ['birdsong', 'streams'],
    notes: ''
  }
}

/** What each lighting preset means for a scene: the sun's colour and strength, and the light from the sky. */
export const LIGHTING: Record<LightingPreset, { sun: string; sunIntensity: number; ambient: string; ambientIntensity: number }> = {
  day: { sun: '#fff8ec', sunIntensity: 1, ambient: '#dbe7ff', ambientIntensity: 1 },
  golden: { sun: '#ffd08a', sunIntensity: 1.05, ambient: '#ffe6c4', ambientIntensity: 0.9 },
  overcast: { sun: '#e4e6ea', sunIntensity: 0.55, ambient: '#d5d9df', ambientIntensity: 1.15 },
  dusk: { sun: '#ff9a6b', sunIntensity: 0.6, ambient: '#8f7fb8', ambientIntensity: 0.75 },
  night: { sun: '#9fb4ff', sunIntensity: 0.25, ambient: '#4a5a8c', ambientIntensity: 0.55 },
  storm: { sun: '#c2c8d6', sunIntensity: 0.45, ambient: '#7d8799', ambientIntensity: 0.85 }
}

/** How much of a span shows at `t`, 0–1: rising over its blend-in from its start, falling over its blend-out to its end, eased. */
export function spanWeight(span: Pick<ThemeSpan, 'start' | 'end' | 'blendIn' | 'blendOut'>, t: number): number {
  if (t < span.start || t > span.end) return 0
  const rise = span.blendIn > 0 ? (t - span.start) / span.blendIn : 1
  const fall = span.blendOut > 0 ? (span.end - t) / span.blendOut : 1
  const w = Math.max(0, Math.min(1, rise, fall))
  return w * w * (3 - 2 * w)
}

/** A colour as red, green and blue, 0–1 each. */
export type Rgb = [number, number, number]

/** `a` mixed toward `b` by `k` (0–1). */
export const mixRgb = (a: Readonly<Rgb>, b: Readonly<Rgb>, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

/** The look and tone in force at a time and place: what the renderer and writers use. */
export interface ThemeLook {
  /** How much of the themes shows over the world's own look, 0–1. */
  strength: number
  /** The palette, lighting and air of the themes in force, blended (as if fully shown: renderers mix it in by `strength`). */
  sky: Rgb
  water: Rgb
  land: Rgb
  accent: Rgb
  sun: Rgb
  sunIntensity: number
  ambient: Rgb
  ambientIntensity: number
  atmosphere: number
  /** The theme that shows most, for what can't be blended: its name, type, mood and style guide. */
  dominant: Theme
  /** Each theme in force and how much it shows, most first. */
  layers: { theme: Theme; span: ThemeSpan; weight: number }[]
}

export const hexToRgb01 = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255]
export const rgb01ToHex = (c: Readonly<Rgb>): string => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`

/**
 * The themes in force on a world at `t` (its live spans, the live theme library), in
 * a place lying in `regionIds` (spans for other regions don't apply; spans
 * for no region apply everywhere), composited like layers of paint: each span
 * covers what's under it by its weight, lowest priority first. Undefined when
 * no theme shows.
 */
export function themeAt(spans: readonly ThemeSpan[], themes: readonly Theme[], t: number, regionIds: readonly string[] = []): ThemeLook | undefined {
  const themeOf = byId(themes)
  const active = spans
    .filter((s) => s.regionId === null || regionIds.includes(s.regionId))
    .map((span) => ({ span, theme: themeOf.get(span.themeId), weight: spanWeight(span, t) }))
    .filter((l): l is { span: ThemeSpan; theme: Theme; weight: number } => !!l.theme && l.weight > 0)
    .sort((a, b) => a.span.priority - b.span.priority || a.span.start - b.span.start)
  if (!active.length) return undefined
  // Premultiplied: each value is the sum of what shows of it; dividing by the total coverage gives the blend.
  const sum: Record<(typeof COLOURS)[number], Rgb> & Record<(typeof AMOUNTS)[number], number> = {
    sky: [0, 0, 0],
    water: [0, 0, 0],
    land: [0, 0, 0],
    accent: [0, 0, 0],
    sun: [0, 0, 0],
    ambient: [0, 0, 0],
    sunIntensity: 0,
    ambientIntensity: 0,
    atmosphere: 0
  }
  let coverage = 0
  const shown: number[] = []
  for (const { theme, weight } of active) {
    const light = LIGHTING[theme.lighting]
    const colours = { ...theme.palette, sun: light.sun, ambient: light.ambient }
    const amounts = { sunIntensity: light.sunIntensity, ambientIntensity: light.ambientIntensity, atmosphere: theme.atmosphere }
    // This layer covers what's under it by its weight.
    for (const f of COLOURS) sum[f] = mixRgb(sum[f], hexToRgb01(colours[f]), weight)
    for (const f of AMOUNTS) sum[f] += (amounts[f] - sum[f]) * weight
    for (let i = 0; i < shown.length; i++) shown[i] = shown[i]! * (1 - weight)
    shown.push(weight)
    coverage += (1 - coverage) * weight
  }
  const unmix = (c: Rgb): Rgb => [c[0] / coverage, c[1] / coverage, c[2] / coverage]
  const layers = active.map((l, i) => ({ ...l, weight: shown[i]! })).sort((a, b) => b.weight - a.weight)
  return {
    strength: coverage,
    sky: unmix(sum.sky),
    water: unmix(sum.water),
    land: unmix(sum.land),
    accent: unmix(sum.accent),
    sun: unmix(sum.sun),
    ambient: unmix(sum.ambient),
    sunIntensity: sum.sunIntensity / coverage,
    ambientIntensity: sum.ambientIntensity / coverage,
    atmosphere: sum.atmosphere / coverage,
    dominant: layers[0]!.theme,
    layers
  }
}

/** What a look blends: colours, and amounts. */
const COLOURS = ['sky', 'water', 'land', 'accent', 'sun', 'ambient'] as const
const AMOUNTS = ['sunIntensity', 'ambientIntensity', 'atmosphere'] as const
