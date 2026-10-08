import {
  LIGHTING_PRESETS,
  THEME_PRESETS,
  TYPOGRAPHY,
  formatTime,
  rgb01ToHex,
  secondsPerYear,
  spanWeight,
  type Command,
  type LightingPreset,
  type SpatialNode,
  type Theme,
  type ThemePatch,
  type ThemeSpan,
  type ThemeSpanPatch,
  type Typography
} from '@universe/core'
import { useMemo, useState } from 'react'
import { useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'
import { useCalendar } from '../world/useSky'
import { useThemeLook, useWorldThemes } from '../world/useThemeLook'
import { ColorField, CommitSlider, NumberInput, TagsField, TextField, TimeField } from './fields'
import { NotesEditor } from './NotesEditor'

/**
 * Themes in the inspector (PLAN.md §4.5): the editor for a theme (its look,
 * lighting, air, type and tone), the editor for a span of one on a world's
 * timeline, and the world's themes section: what's in force at the
 * playhead, its spans, and the library.
 */

const LIGHTING_LABELS: Record<LightingPreset, string> = { day: 'Clear day', golden: 'Golden hour', overcast: 'Overcast', dusk: 'Dusk', night: 'Night', storm: 'Storm' }
const TYPE_LABELS: Record<Typography, string> = { serif: 'Serif (book)', sans: 'Sans (modern)', mono: 'Monospace (records)' }
/** Type that every computer has: nothing is downloaded. */
export const FONT_STACKS: Record<Typography, string> = {
  serif: 'Georgia, Cambria, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace'
}

const execute = (command: Command) => void useUi.getState().execute(command)

function Header({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="inspector-kind">
      {icon} {label}
      <button className="link close" aria-label={`Close ${label.toLowerCase()}`} onClick={() => useUi.getState().selectTimeline(null)}>
        ✕
      </button>
    </div>
  )
}

/** A plain multi-line text that saves when you leave it (re-created when the stored text changes, e.g. on undo). */
function TextAreaField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit(v: string): void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea key={value} rows={5} defaultValue={value} placeholder={placeholder} onBlur={(e) => e.target.value !== value && onCommit(e.target.value)} />
    </label>
  )
}

/** The palette as a strip, with a line in the theme's type and its mood. */
function ThemePreview({ theme }: { theme: Theme }) {
  const { sky, water, land, accent } = theme.palette
  return (
    <div className="theme-preview" style={{ ['--sky' as string]: sky, ['--water' as string]: water, ['--land' as string]: land, ['--c' as string]: accent }}>
      <div className="theme-preview-scene" aria-hidden />
      <p style={{ fontFamily: FONT_STACKS[theme.typography] }}>{theme.style.split(/(?<=[.!?])\s/)[0] || theme.name}</p>
      {theme.mood.length > 0 && <span className="muted small">{theme.mood.join(' · ')}</span>}
    </div>
  )
}

export function ThemePanel({ theme }: { theme: Theme }) {
  const spans = useUi((s) => s.timeline.themeSpans)
  const nodes = useUi((s) => s.nodes)
  const uses = useMemo(() => spans.filter((s) => s.themeId === theme.id), [spans, theme.id])
  const update = (patch: ThemePatch) => execute({ type: 'theme.update', payload: { id: theme.id, patch } })
  const setColour = (key: keyof Theme['palette']) => (colour: string) => update({ palette: { ...theme.palette, [key]: colour } })
  return (
    <section className="inspector-section" aria-label="Theme">
      <Header icon="🎨" label="Theme" />
      <ThemePreview theme={theme} />
      <TextField label="Theme name" value={theme.name} required onCommit={(name) => update({ name })} />
      <div className="field-pair">
        <ColorField label="Sky" value={theme.palette.sky} onCommit={setColour('sky')} />
        <ColorField label="Water" value={theme.palette.water} onCommit={setColour('water')} />
      </div>
      <div className="field-pair">
        <ColorField label="Land" value={theme.palette.land} onCommit={setColour('land')} />
        <ColorField label="Accent" value={theme.palette.accent} onCommit={setColour('accent')} />
      </div>
      <label className="field">
        <span>Lighting</span>
        <select value={theme.lighting} onChange={(e) => update({ lighting: e.target.value as LightingPreset })}>
          {LIGHTING_PRESETS.map((l) => (
            <option key={l} value={l}>
              {LIGHTING_LABELS[l]}
            </option>
          ))}
        </select>
      </label>
      <CommitSlider label="Haze" min={0} max={1} step={0.05} value={theme.atmosphere} onCommit={(atmosphere) => update({ atmosphere })} />
      <label className="field">
        <span>Type</span>
        <select value={theme.typography} onChange={(e) => update({ typography: e.target.value as Typography })}>
          {TYPOGRAPHY.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <TagsField label="Mood" tags={theme.mood} onCommit={(mood) => update({ mood })} />
      <TextAreaField
        label="Prose style guide"
        value={theme.style}
        placeholder="How to write about this time: voice, tense, words to use and avoid…"
        onCommit={(style) => update({ style })}
      />
      <TagsField label="Music and ambience" tags={theme.ambience} onCommit={(ambience) => update({ ambience })} />
      <div className="field">
        <span>Theme notes</span>
        <NotesEditor label="Theme notes" value={theme.notes} onCommit={(notes) => update({ notes })} />
      </div>
      <div className="field">
        <span>Used on</span>
        {uses.length ? (
          <ul className="region-list">
            {uses.map((s) => (
              <li key={s.id}>
                <button className="link region-row" onClick={() => useUi.getState().selectTimeline({ kind: 'themeSpan', ids: [s.id] })}>
                  <span className="swatch" style={{ background: theme.palette.accent }} />
                  {nodes.find((n) => n.id === s.ownerId)?.name ?? 'A world'}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted small">No world yet: add a span on a world's timeline.</span>
        )}
      </div>
      <button className="danger" onClick={() => execute({ type: 'theme.delete', payload: { id: theme.id } })}>
        Delete theme{uses.length ? ` and its ${uses.length} span${uses.length > 1 ? 's' : ''}` : ''}
      </button>
    </section>
  )
}

export function ThemeSpanPanel({ span }: { span: ThemeSpan }) {
  const themes = useUi((s) => s.timeline.themes)
  const regions = useUi((s) => s.regions)
  const cal = useCalendar(span.ownerId)
  const playhead = usePlayhead(span.ownerId)
  const theme = themes.find((t) => t.id === span.themeId)
  const year = secondsPerYear(cal)
  const length = (span.end - span.start) / year
  const update = (patch: ThemeSpanPatch) => execute({ type: 'themeSpan.update', payload: { id: span.id, patch } })
  const shown = Math.round(spanWeight(span, playhead) * 100)
  return (
    <section className="inspector-section" aria-label="Theme span">
      <Header icon="▬" label="Theme span" />
      <label className="field">
        <span>Theme</span>
        <select value={span.themeId} onChange={(e) => update({ themeId: e.target.value })}>
          {themes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {theme && (
        <button className="link" onClick={() => useUi.getState().selectTimeline({ kind: 'theme', ids: [theme.id] })}>
          Edit {theme.name}…
        </button>
      )}
      <div className="field-pair">
        <label className="field">
          <span>From</span>
          <TimeField label="Theme span start" value={span.start} precision="year" onCommit={(v) => v && update({ start: Math.min(v.t, span.end) })} />
        </label>
        <label className="field">
          <span>To</span>
          <TimeField label="Theme span end" value={span.end} precision="year" onCommit={(v) => v && update({ end: Math.max(v.t, span.start) })} />
        </label>
      </div>
      <div className="field-pair">
        <label className="field">
          <span>Fades in over (years)</span>
          <NumberInput value={round(span.blendIn / year)} min={0} max={Math.max(0, length)} onCommit={(v) => update({ blendIn: v * year })} />
        </label>
        <label className="field">
          <span>Fades out over (years)</span>
          <NumberInput value={round(span.blendOut / year)} min={0} max={Math.max(0, length)} onCommit={(v) => update({ blendOut: v * year })} />
        </label>
      </div>
      <label className="field">
        <span>Where</span>
        <select value={span.regionId ?? ''} onChange={(e) => update({ regionId: e.target.value || null })}>
          <option value="">The whole world</option>
          {regions
            .filter((r) => r.worldId === span.ownerId)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        <span>Priority (higher shows on top where spans overlap)</span>
        <NumberInput value={span.priority} min={-100} max={100} integer onCommit={(priority) => update({ priority })} />
      </label>
      <p className="muted small" aria-label="Theme span at the playhead">
        {shown > 0 ? `${shown}% showing at the playhead (${formatTime(playhead, 'year', cal)}).` : `Not showing at the playhead (${formatTime(playhead, 'year', cal)}).`}
      </p>
      <button className="danger" onClick={() => execute({ type: 'themeSpan.delete', payload: { id: span.id } })}>
        Delete theme span
      </button>
    </section>
  )
}

const round = (v: number) => Math.round(v * 100) / 100

/**
 * The world's themes in its inspector: what's in force at the playhead and
 * how to write it, its spans in time order, and the library to pick from or
 * start new themes in (from a preset).
 */
export function WorldThemes({ world }: { world: SpatialNode }) {
  const { spans, themes } = useWorldThemes(world.id)
  const look = useThemeLook(world.id)
  const cal = useCalendar(world.id)
  const rootId = useUi((s) => s.project?.rootId)
  const playhead = usePlayhead(world.id)
  const [preset, setPreset] = useState(Object.keys(THEME_PRESETS)[0]!)
  const themeById = new Map(themes.map((t) => [t.id, t]))
  const select = useUi.getState().selectTimeline
  const year = secondsPerYear(cal)

  const addSpan = (themeId: string) =>
    execute({ type: 'themeSpan.create', payload: { ownerId: world.id, themeId, start: playhead, end: playhead + 100 * year, blendIn: 10 * year, blendOut: 10 * year } })
  const newTheme = () => {
    if (!rootId) return
    const id = crypto.randomUUID()
    // A new theme from the preset, put on the world from the playhead for a century.
    execute({
      type: 'batch',
      payload: {
        commands: [
          { type: 'theme.create', payload: { id, ownerId: rootId, preset } },
          { type: 'themeSpan.create', payload: { ownerId: world.id, themeId: id, start: playhead, end: playhead + 100 * year, blendIn: 10 * year, blendOut: 10 * year } }
        ]
      }
    })
  }

  return (
    <section className="inspector-section world-themes" aria-label="Themes">
      <h3>Themes</h3>
      {look ? (
        <div className="theme-now" style={{ ['--c' as string]: rgb01ToHex(look.accent) }}>
          <b>{look.layers.map((l) => `${l.theme.name}${l.weight < 0.98 ? ` ${Math.round(l.weight * 100)}%` : ''}`).join(' + ')}</b>
          {look.dominant.mood.length > 0 && <span className="muted small">{look.dominant.mood.join(' · ')}</span>}
          {look.dominant.style && <p className="small" style={{ fontFamily: FONT_STACKS[look.dominant.typography] }}>{look.dominant.style}</p>}
        </div>
      ) : (
        <span className="muted small">No theme at the playhead.</span>
      )}
      {spans.length > 0 && (
        <ul className="region-list" aria-label="Theme spans on this world">
          {[...spans]
            .sort((a, b) => a.start - b.start)
            .map((s) => {
              const t = themeById.get(s.themeId)
              return (
                <li key={s.id}>
                  <button className="link region-row" onClick={() => select({ kind: 'themeSpan', ids: [s.id] })}>
                    <span className="swatch" style={{ background: t?.palette.accent }} />
                    {t?.name ?? 'Theme'} · {formatTime(s.start, 'year', cal)} – {formatTime(s.end, 'year', cal)}
                  </button>
                </li>
              )
            })}
        </ul>
      )}
      {themes.length > 0 && (
        <div className="theme-library" aria-label="Theme library">
          {themes.map((t) => (
            <span key={t.id} className="theme-chip">
              <button className="link" onClick={() => select({ kind: 'theme', ids: [t.id] })} title={`Edit ${t.name}`}>
                <span className="swatch" style={{ background: t.palette.accent }} />
                {t.name}
              </button>
              <button className="link small" onClick={() => addSpan(t.id)} title={`Use ${t.name} on this world from the playhead`} aria-label={`Use ${t.name} from the playhead`}>
                + span
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="field-row">
        <select aria-label="Start a theme from" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {Object.keys(THEME_PRESETS).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button onClick={newTheme}>New theme from the playhead</button>
      </div>
    </section>
  )
}

/** In a region's inspector: the theme in force there at the playhead, when it differs from the world's. */
export function RegionTheme({ worldId, regionId }: { worldId: string; regionId: string }) {
  const here = useThemeLook(worldId, [regionId])
  const world = useThemeLook(worldId)
  if (!here || here.dominant.id === world?.dominant.id) return null
  return (
    <p className="small" aria-label="Theme here">
      Theme here: <b>{here.dominant.name}</b>
      {here.dominant.mood.length > 0 && <span className="muted"> · {here.dominant.mood.join(' · ')}</span>}
    </p>
  )
}
