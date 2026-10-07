import type { Region, RegionPatch, SpatialNode, WorldSettingsPatch } from '@universe/core'
import { useMemo } from 'react'
import { useUi } from '../store'
import { CommitSlider, NumberInput, TextField } from './fields'
import { NotesEditor } from './NotesEditor'

/** Inspector section for a world: generation settings, terrain resets, and regions. */
export function WorldPanel({ world }: { world: SpatialNode }) {
  const info = useUi((s) => s.worlds.find((w) => w.id === world.id))
  const allRegions = useUi((s) => s.regions)
  const regions = useMemo(() => allRegions.filter((r) => r.worldId === world.id), [allRegions, world.id])
  const selectedRegion = useUi((s) => s.regions.find((r) => r.id === s.selectedRegionId))
  const selectRegion = useUi((s) => s.selectRegion)
  const execute = useUi((s) => s.execute)
  if (!info) return null
  const { settings } = info
  const update = (patch: WorldSettingsPatch) => void execute({ type: 'world.update', payload: { id: world.id, patch } })

  return (
    <>
      {selectedRegion && <RegionForm key={`${selectedRegion.id}:${selectedRegion.updatedAt}`} region={selectedRegion} />}

      <section className="inspector-section">
        <h3>Surface</h3>
        <CommitSlider label="Sea level" unit=" m" min={-4000} max={4000} step={50} value={settings.seaLevel} onCommit={(v) => update({ seaLevel: v })} />
        <CommitSlider
          label="Continent size"
          unit=""
          min={0.4}
          max={4}
          step={0.1}
          // Shown inverted: bigger number = bigger continents, which is how people think about it.
          value={Number((4.4 - settings.terrain.continentScale).toFixed(1))}
          onCommit={(v) => update({ terrain: { continentScale: Number((4.4 - v).toFixed(1)) } })}
        />
        <CommitSlider label="Roughness" unit="%" min={0} max={100} step={5} value={Math.round(settings.terrain.roughness * 100)} onCommit={(v) => update({ terrain: { roughness: v / 100 } })} />
        <CommitSlider label="Mountain height" unit=" m" min={0} max={12000} step={250} value={settings.terrain.mountainHeight} onCommit={(v) => update({ terrain: { mountainHeight: v } })} />
        <label className="field">
          <span>Planet radius (km)</span>
          <NumberInput value={settings.radiusKm} min={50} max={200000} onCommit={(v) => update({ radiusKm: v })} />
        </label>
        <div className="add-buttons">
          <button onClick={() => void execute({ type: 'terrain.reset', payload: { worldId: world.id, layer: 'height' } })}>Reset sculpting</button>
          <button onClick={() => void execute({ type: 'terrain.reset', payload: { worldId: world.id, layer: 'biome' } })}>Reset painting</button>
        </div>
        <p className="muted small">Change the seed above for a different planet. Sculpting and painting are kept on top of it.</p>
      </section>

      <section className="inspector-section">
        <h3>Regions</h3>
        {regions.length === 0 ? (
          <p className="muted small">None yet. Pick the ⬠ tool and click points on the world to draw one.</p>
        ) : (
          <ul className="region-list">
            {regions.map((r) => (
              <li key={r.id}>
                <button className={`link region-row${r.id === selectedRegion?.id ? ' selected' : ''}`} onClick={() => selectRegion(r.id)}>
                  <span className="swatch" style={{ background: r.color }} />
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function RegionForm({ region }: { region: Region }) {
  const execute = useUi((s) => s.execute)
  const selectRegion = useUi((s) => s.selectRegion)
  const update = (patch: RegionPatch) => void execute({ type: 'region.update', payload: { id: region.id, patch } })

  return (
    <section className="inspector-section region-form" aria-label="Region">
      <div className="inspector-kind">
        <span className="swatch" style={{ background: region.color }} /> Region
        <button className="link close" aria-label="Close region" onClick={() => selectRegion(null)}>
          ✕
        </button>
      </div>
      <TextField label="Region name" value={region.name} required onCommit={(name) => update({ name })} />
      <label className="field">
        <span>Color</span>
        <input type="color" value={region.color} onChange={(e) => update({ color: e.target.value })} />
      </label>
      <div className="field">
        <span>Region notes</span>
        <NotesEditor label="Region notes" value={region.notes} onCommit={(notes) => update({ notes })} />
      </div>
      <button className="danger" onClick={() => void execute({ type: 'region.delete', payload: { id: region.id } })}>
        Delete region
      </button>
    </section>
  )
}
