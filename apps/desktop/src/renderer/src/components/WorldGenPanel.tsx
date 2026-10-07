import { LANDFORMS, WORLD_RANGES, type Landform, type SpatialNode, type TerrainParams, type WorldSettings, type WorldSettingsPatch } from '@universe/core'
import { WORLD_PRESETS, encodeWorldCode, randomSeedName, readSeed } from '@universe/procgen'
import { useState } from 'react'
import { useUi } from '../store'
import { ColorField, CommitSlider, NumberInput, TextField } from './fields'

const LANDFORM_LABELS: Record<Landform, string> = { continents: 'Continents', supercontinent: 'Supercontinent', archipelago: 'Archipelago' }

/**
 * A world's seed and generation options. With a seed, the seed decides every
 * option and they're locked; "Customize" unlocks them, starting from what the
 * seed made. Either way the world code recreates exactly this planet.
 */
export function WorldGenPanel({ world, settings }: { world: SpatialNode; settings: WorldSettings }) {
  const { execute } = useUi.getState()
  const [copied, setCopied] = useState(false)
  const t = settings.terrain
  const locked = settings.seedText !== null
  const code = encodeWorldCode({ seed: world.seed, radiusKm: settings.radiusKm, terrain: t })
  const update = (patch: WorldSettingsPatch) => void execute({ type: 'world.update', payload: { id: world.id, patch } })
  const setTerrain = (terrain: Partial<TerrainParams>) => update({ terrain })

  const applySeed = (text: string) => {
    const w = readSeed(text)
    void execute({
      type: 'batch',
      payload: {
        commands: [
          { type: 'node.update', payload: { id: world.id, patch: { seed: w.seed } } },
          { type: 'world.update', payload: { id: world.id, patch: { seedText: text.trim(), radiusKm: w.radiusKm, terrain: w.terrain } } }
        ]
      }
    })
  }

  /** A slider for a 0–1 option, shown as a percentage. */
  const percent = (label: string, key: 'water' | 'islands' | 'mountains' | 'roughness' | 'aridity' | 'beaches') => (
    <CommitSlider
      label={label}
      unit="%"
      min={Math.round(WORLD_RANGES[key].min * 100)}
      max={Math.round(WORLD_RANGES[key].max * 100)}
      step={Math.round(WORLD_RANGES[key].step * 100)}
      value={Math.round(t[key] * 100)}
      onCommit={(v) => setTerrain({ [key]: v / 100 })}
    />
  )

  return (
    <section className="inspector-section" aria-label="World generation">
      <h3>World</h3>
      <TextField label="Seed" value={settings.seedText ?? ''} required placeholder="A word, a number, or a world code" onCommit={applySeed} />
      <div className="add-buttons">
        <button onClick={() => applySeed(randomSeedName())}>🎲 Random seed</button>
        {!locked && (
          <select aria-label="Start from preset" value="" onChange={(e) => e.target.value && setTerrain(WORLD_PRESETS.find((p) => p.name === e.target.value)!.terrain)}>
            <option value="">Start from preset…</option>
            {WORLD_PRESETS.map((p) => (
              <option key={p.name}>{p.name}</option>
            ))}
          </select>
        )}
      </div>
      {locked ? (
        <p className="seed-lock" role="status">
          🔒 Generated from <b>“{settings.seedText}”</b>: the seed decides everything below.{' '}
          <button className="link" onClick={() => update({ seedText: null })}>
            Customize
          </button>
        </p>
      ) : (
        <p className="muted small">Custom world: set the options below, or type a seed to generate one.</p>
      )}

      <div className="field">
        <span>World code</span>
        <div className="field-row">
          <code className="world-code" data-testid="world-code" title="Enter this as a seed to recreate exactly this planet">
            {code}
          </code>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => setCopied(true))
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <fieldset className="gen-options" disabled={locked}>
        <div className="field">
          <span>Land</span>
          <div className="segmented" role="group" aria-label="Land type">
            {LANDFORMS.map((l) => (
              <button key={l} aria-pressed={t.landform === l} onClick={() => setTerrain({ landform: l })}>
                {LANDFORM_LABELS[l]}
              </button>
            ))}
          </div>
        </div>
        {percent('Water', 'water')}
        <CommitSlider
          label="Continent size"
          min={0.4}
          max={4}
          step={0.1}
          // Shown inverted: bigger number = bigger continents, which is how people think about it.
          value={Number((4.4 - t.continentScale).toFixed(1))}
          onCommit={(v) => setTerrain({ continentScale: Number((4.4 - v).toFixed(1)) })}
        />
        {percent('Islands', 'islands')}
        {percent('Mountains', 'mountains')}
        <CommitSlider label="Mountain height" unit=" m" min={0} max={WORLD_RANGES.mountainHeight.max} step={WORLD_RANGES.mountainHeight.step} value={t.mountainHeight} onCommit={(v) => setTerrain({ mountainHeight: v })} />
        {percent('Roughness', 'roughness')}
        <CommitSlider
          label="Temperature"
          unit=" °C"
          min={WORLD_RANGES.temperature.min}
          max={WORLD_RANGES.temperature.max}
          step={WORLD_RANGES.temperature.step}
          value={t.temperature}
          onCommit={(v) => setTerrain({ temperature: v })}
        />
        {percent('Deserts', 'aridity')}
        {percent('Beaches', 'beaches')}
        <div className="field-pair three">
          <ColorField label="Vegetation" value={t.vegetationColor} onCommit={(vegetationColor) => setTerrain({ vegetationColor })} />
          <ColorField label="Sand" value={t.sandColor} onCommit={(sandColor) => setTerrain({ sandColor })} />
          <ColorField label="Water color" value={t.waterColor} onCommit={(waterColor) => setTerrain({ waterColor })} />
        </div>
        <label className="field">
          <span>Planet radius (km)</span>
          <NumberInput value={settings.radiusKm} min={WORLD_RANGES.radiusKm.min} max={WORLD_RANGES.radiusKm.max} integer onCommit={(v) => update({ radiusKm: v })} />
        </label>
        <button title="Same options, different continents" onClick={() => void execute({ type: 'node.update', payload: { id: world.id, patch: { seed: Math.floor(Math.random() * 0x100000000) } } })}>
          🎲 New shape
        </button>
      </fieldset>
    </section>
  )
}
