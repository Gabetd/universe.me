import { LANDFORMS, WORLD_RANGES, type Landform, type SpatialNode, type TerrainParams, type WorldSettings } from '@universe/core'
import { WORLD_PRESETS, encodeWorldCode, randomSeedName, readSeed } from '@universe/procgen'
import { updater, useUi } from '../store'
import { ColorField, CommitSlider, CopyButton, NumberInput, TextField, randomSeed } from './fields'

const LANDFORM_LABELS: Record<Landform, string> = { continents: 'Continents', supercontinent: 'Supercontinent', archipelago: 'Archipelago' }

/** What each option does, shown when the pointer rests on it. */
export const WORLD_HINTS = {
  seed: 'Any word, number or world code. The same seed always grows the same planet; a world code recreates this one exactly, options and all.',
  preset: 'Sets every option below to a kind of world (an ocean world, a desert planet…) to start from.',
  code: 'This planet in a few letters: enter it as a seed (here or anywhere) to recreate exactly this world.',
  land: 'How the land is gathered: several continents, one great landmass, or many scattered islands.',
  water: 'How much of the surface is sea. More water, less land.',
  continentSize: 'How big each landmass is: bigger means fewer, larger continents; smaller, more of them.',
  islands: 'How many small islands rise from the sea between the continents.',
  mountains: 'How much of the land is mountainous: ranges, high plateaus and rugged country.',
  mountainHeight: 'How high the tallest peaks reach above sea level.',
  roughness: 'How broken the land is: smooth plains and rolling hills, or jagged, craggy ground.',
  temperature: 'The world’s average temperature. Colder worlds have ice caps and tundra reaching further from the poles; warmer ones, more desert and jungle.',
  deserts: 'How dry the land is: more deserts and steppe, fewer forests.',
  beaches: 'How much sandy shore lines the coasts.',
  vegetation: 'The colour of plants and forests, on the globe, the map and the ground.',
  sand: 'The colour of beaches and deserts.',
  waterColor: 'The colour of the sea and lakes.',
  radius: 'How big the planet is. Earth’s is 6,371 km. It sets distances on the ground and the scale of the map.',
  newShape: 'Keeps every option but grows different continents: a new seed for the same kind of world.',
  seaLevel: 'Raises or lowers the sea over the whole world, flooding coasts or uncovering land, on top of what was generated.',
  erosionSpeed: 'How fast structures weather and crumble over time when nobody maintains them.'
} as const

/**
 * A world's seed and generation options. With a seed, the seed decides every
 * option and they're locked; "Customize" unlocks them, starting from what the
 * seed made. Either way the world code recreates exactly this planet.
 */
export function WorldGenPanel({ world, settings }: { world: SpatialNode; settings: WorldSettings }) {
  const { execute } = useUi.getState()
  const t = settings.terrain
  const locked = settings.seedText !== null
  const code = encodeWorldCode({ seed: world.seed, radiusKm: settings.radiusKm, terrain: t })
  const update = updater('world', world.id)
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
  const percent = (label: string, key: 'water' | 'islands' | 'mountains' | 'roughness' | 'aridity' | 'beaches', hint: string) => (
    <CommitSlider
      label={label}
      hint={hint}
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
      <TextField label="Seed" value={settings.seedText ?? ''} required placeholder="A word, a number, or a world code" hint={WORLD_HINTS.seed} onCommit={applySeed} />
      <div className="add-buttons">
        <button onClick={() => applySeed(randomSeedName())}>🎲 Random seed</button>
        {!locked && (
          <select aria-label="Start from preset" title={WORLD_HINTS.preset} value="" onChange={(e) => e.target.value && setTerrain(WORLD_PRESETS.find((p) => p.name === e.target.value)!.terrain)}>
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

      <div className="field" title={WORLD_HINTS.code}>
        <span>World code</span>
        <div className="field-row">
          <code className="world-code" data-testid="world-code">
            {code}
          </code>
          <CopyButton text={code} />
        </div>
      </div>

      <fieldset className="gen-options" disabled={locked}>
        <div className="field" title={WORLD_HINTS.land}>
          <span>Land</span>
          <div className="segmented" role="group" aria-label="Land type">
            {LANDFORMS.map((l) => (
              <button key={l} aria-pressed={t.landform === l} onClick={() => setTerrain({ landform: l })}>
                {LANDFORM_LABELS[l]}
              </button>
            ))}
          </div>
        </div>
        {percent('Water', 'water', WORLD_HINTS.water)}
        <CommitSlider
          label="Continent size"
          hint={WORLD_HINTS.continentSize}
          min={0.4}
          max={4}
          step={0.1}
          // Shown inverted: bigger number = bigger continents, which is how people think about it.
          value={Number((4.4 - t.continentScale).toFixed(1))}
          onCommit={(v) => setTerrain({ continentScale: Number((4.4 - v).toFixed(1)) })}
        />
        {percent('Islands', 'islands', WORLD_HINTS.islands)}
        {percent('Mountains', 'mountains', WORLD_HINTS.mountains)}
        <CommitSlider label="Mountain height" hint={WORLD_HINTS.mountainHeight} unit=" m" min={0} max={WORLD_RANGES.mountainHeight.max} step={WORLD_RANGES.mountainHeight.step} value={t.mountainHeight} onCommit={(v) => setTerrain({ mountainHeight: v })} />
        {percent('Roughness', 'roughness', WORLD_HINTS.roughness)}
        <CommitSlider
          label="Temperature"
          hint={WORLD_HINTS.temperature}
          unit=" °C"
          min={WORLD_RANGES.temperature.min}
          max={WORLD_RANGES.temperature.max}
          step={WORLD_RANGES.temperature.step}
          value={t.temperature}
          onCommit={(v) => setTerrain({ temperature: v })}
        />
        {percent('Deserts', 'aridity', WORLD_HINTS.deserts)}
        {percent('Beaches', 'beaches', WORLD_HINTS.beaches)}
        <div className="field-pair three">
          <ColorField label="Vegetation" hint={WORLD_HINTS.vegetation} value={t.vegetationColor} onCommit={(vegetationColor) => setTerrain({ vegetationColor })} />
          <ColorField label="Sand" hint={WORLD_HINTS.sand} value={t.sandColor} onCommit={(sandColor) => setTerrain({ sandColor })} />
          <ColorField label="Water color" hint={WORLD_HINTS.waterColor} value={t.waterColor} onCommit={(waterColor) => setTerrain({ waterColor })} />
        </div>
        <label className="field" title={WORLD_HINTS.radius}>
          <span>Planet radius (km)</span>
          <NumberInput value={settings.radiusKm} min={WORLD_RANGES.radiusKm.min} max={WORLD_RANGES.radiusKm.max} integer onCommit={(v) => update({ radiusKm: v })} />
        </label>
        <button title={WORLD_HINTS.newShape} onClick={() => updater('node', world.id)({ seed: randomSeed() })}>
          🎲 New shape
        </button>
      </fieldset>
    </section>
  )
}
