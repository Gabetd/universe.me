import { THEME_PRESETS, formatTime, rgb01ToHex, secondsPerYear, spanWeight, type Command, type LightingPreset, type SpatialNode, type Theme, type ThemeSpan, type Typography } from '@universe/core'
import { useMemo, useState } from 'react'
import { updater, useUi, useWorld } from '../store'
import { spanDates } from '../timeline/labels'
import { themeSpanCommand } from '../timeline/themeCommands'
import { playheadOf, usePlayhead } from '../timeline/timelineStore'
import { useCalendar } from '../world/useSky'
import { useThemeLook, useWorldThemes } from '../world/useThemeLook'
import { ColorField, CommitSlider, DeleteButton, NotesField, NumberInput, PanelHeader, SelectField, Swatch, SwatchList, TagsField, TextField, TimeField } from './fields'
import { FONT_STACKS } from './ThemedWorkspace'

/**
 * Themes in the inspector (PLAN.md §4.5): the editor for a theme (its look,
 * lighting, air, type and tone), the editor for a span of one on a world's
 * timeline, and the world's themes section: what's in force at the
 * playhead, its spans, and the library.
 */

const LIGHTING_LABELS: Record<LightingPreset, string> = { day: 'Clear day', golden: 'Golden hour', overcast: 'Overcast', dusk: 'Dusk', night: 'Night', storm: 'Storm' }
const TYPE_LABELS: Record<Typography, string> = { serif: 'Serif (book)', sans: 'Sans (modern)', mono: 'Monospace (records)' }

const execute = (command: Command | undefined) => void (command && useUi.getState().execute(command))

const closePanel = () => useUi.getState().selectTimeline(null)

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
  const update = updater('theme', theme.id)
  const setColour = (key: keyof Theme['palette']) => (colour: string) => update({ palette: { ...theme.palette, [key]: colour } })
  return (
    <section className="inspector-section" aria-label="Theme">
      <PanelHeader icon="🎨" label="Theme" onClose={closePanel} />
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
      <SelectField label="Lighting" value={theme.lighting} options={LIGHTING_LABELS} onCommit={(lighting) => update({ lighting })} />
      <CommitSlider label="Haze" min={0} max={1} step={0.05} value={theme.atmosphere} onCommit={(atmosphere) => update({ atmosphere })} />
      <SelectField label="Type" value={theme.typography} options={TYPE_LABELS} onCommit={(typography) => update({ typography })} />
      <TagsField label="Mood" tags={theme.mood} onCommit={(mood) => update({ mood })} />
      <TextAreaField
        label="Prose style guide"
        value={theme.style}
        placeholder="How to write about this time: voice, tense, words to use and avoid…"
        onCommit={(style) => update({ style })}
      />
      <TagsField label="Music and ambience" tags={theme.ambience} onCommit={(ambience) => update({ ambience })} />
      <NotesField label="Theme notes" value={theme.notes} onCommit={(notes) => update({ notes })} />
      <div className="field">
        <span>Used on</span>
        {uses.length ? (
          <SwatchList
            rows={uses.map((s) => ({ id: s.id, name: nodes.find((n) => n.id === s.ownerId)?.name ?? 'A world', color: theme.palette.accent }))}
            onPick={(id) => useUi.getState().selectTimeline({ kind: 'themeSpan', ids: [id] })}
          />
        ) : (
          <span className="muted small">No world yet: add a span on a world's timeline.</span>
        )}
      </div>
      <DeleteButton kind="theme" ids={[theme.id]}>
        Delete theme{uses.length ? ` and its ${uses.length} span${uses.length > 1 ? 's' : ''}` : ''}
      </DeleteButton>
    </section>
  )
}

export function ThemeSpanPanel({ span }: { span: ThemeSpan }) {
  const themes = useUi((s) => s.timeline.themes)
  const { regions } = useWorld(span.ownerId)
  const cal = useCalendar(span.ownerId)
  const theme = themes.find((t) => t.id === span.themeId)
  const year = secondsPerYear(cal)
  const length = (span.end - span.start) / year
  const update = updater('themeSpan', span.id)
  return (
    <section className="inspector-section" aria-label="Theme span">
      <PanelHeader icon="▬" label="Theme span" onClose={closePanel} />
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
        <select aria-label="Where" value={span.regionId ?? ''} onChange={(e) => update({ regionId: e.target.value || null })}>
          <option value="">The whole world</option>
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
          {span.regionId && !regions.some((r) => r.id === span.regionId) && <option value={span.regionId}>A deleted region</option>}
        </select>
      </label>
      <label className="field">
        <span>Priority (higher shows on top where spans overlap)</span>
        <NumberInput value={span.priority} min={-100} max={100} integer onCommit={(priority) => update({ priority })} />
      </label>
      <SpanShowing span={span} />
      <DeleteButton kind="themeSpan" ids={[span.id]}>
        Delete theme span
      </DeleteButton>
    </section>
  )
}

const round = (v: number) => Math.round(v * 100) / 100

/** How much of a span shows at the playhead. On its own, as it follows the playhead. */
function SpanShowing({ span }: { span: ThemeSpan }) {
  const playhead = usePlayhead(span.ownerId)
  const cal = useCalendar(span.ownerId)
  const shown = Math.round(spanWeight(span, playhead) * 100)
  const at = formatTime(playhead, 'year', cal)
  return (
    <p className="muted small" aria-label="Theme span at the playhead">
      {shown > 0 ? `${shown}% showing at the playhead (${at}).` : `Not showing at the playhead (${at}).`}
    </p>
  )
}

/** What's in force on a world at the playhead: its themes and how much each shows, the mood, and how to write it. */
function ThemeNow({ worldId }: { worldId: string }) {
  const look = useThemeLook(worldId)
  if (!look) return <span className="muted small">No theme at the playhead.</span>
  return (
    <div className="theme-now" style={{ ['--c' as string]: rgb01ToHex(look.accent) }}>
      <b>{look.layers.map((l) => `${l.theme.name}${l.weight < 0.98 ? ` ${Math.round(l.weight * 100)}%` : ''}`).join(' + ')}</b>
      {look.dominant.mood.length > 0 && <span className="muted small">{look.dominant.mood.join(' · ')}</span>}
      {look.dominant.style && <p className="small" style={{ fontFamily: FONT_STACKS[look.dominant.typography] }}>{look.dominant.style}</p>}
    </div>
  )
}

/**
 * The world's themes in its inspector: what's in force at the playhead and
 * how to write it, its spans in time order, and the library to pick from or
 * start new themes in (from a preset).
 */
export function WorldThemes({ world }: { world: SpatialNode }) {
  const { spans, themes } = useWorldThemes(world.id)
  const cal = useCalendar(world.id)
  const [preset, setPreset] = useState(Object.keys(THEME_PRESETS)[0]!)
  const select = useUi.getState().selectTimeline
  const rows = useMemo(() => {
    const themeById = new Map(themes.map((t) => [t.id, t]))
    return [...spans]
      .sort((a, b) => a.start - b.start)
      .map((s) => {
        const t = themeById.get(s.themeId)
        return { id: s.id, name: `${t?.name ?? 'Theme'} · ${spanDates(s, cal)}`, color: t?.palette.accent }
      })
  }, [spans, themes, cal])

  // From the playhead for a century.
  const putOn = (theme: { themeId: string } | { preset: string }) => {
    const start = playheadOf(world.id)
    execute(themeSpanCommand(world.id, start, start + 100 * secondsPerYear(cal), theme))
  }

  return (
    <section className="inspector-section world-themes" aria-label="Themes">
      <h3>Themes</h3>
      <ThemeNow worldId={world.id} />
      {rows.length > 0 && <SwatchList rows={rows} onPick={(id) => select({ kind: 'themeSpan', ids: [id] })} />}
      {themes.length > 0 && (
        <div className="theme-library" aria-label="Theme library">
          {themes.map((t) => (
            <span key={t.id} className="theme-chip">
              <button className="link" onClick={() => select({ kind: 'theme', ids: [t.id] })} title={`Edit ${t.name}`}>
                <Swatch color={t.palette.accent} />
                {t.name}
              </button>
              <button className="link small" onClick={() => putOn({ themeId: t.id })} title={`Use ${t.name} on this world from the playhead`} aria-label={`Use ${t.name} from the playhead`}>
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
        <button onClick={() => putOn({ preset })}>New theme from the playhead</button>
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
