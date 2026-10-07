import { regionAt, type Region, type RegionPatch, type SpatialNode, type WorldSettingsPatch } from '@universe/core'
import { useUi, useWorld } from '../store'
import { ColorField, CommitSlider, TextField } from './fields'
import { NotesEditor } from './NotesEditor'
import { RegionHistory } from './RegionHistory'
import { WorldGenPanel } from './WorldGenPanel'
import { usePlayhead } from '../timeline/timelineStore'

/** Inspector section for a world: generation settings, terrain resets, and regions. */
export function WorldPanel({ world }: { world: SpatialNode }) {
  const { info, regions } = useWorld(world.id)
  const selectedRegion = useUi((s) => s.regions.find((r) => r.id === s.selectedRegionId))
  const selectRegion = useUi((s) => s.selectRegion)
  const execute = useUi((s) => s.execute)
  const changes = useUi((s) => s.timeline.changes)
  const playhead = usePlayhead(world.id)
  if (!info) return null
  const { settings } = info
  const update = (patch: WorldSettingsPatch) => void execute({ type: 'world.update', payload: { id: world.id, patch } })

  return (
    <>
      {selectedRegion && <RegionForm key={`${selectedRegion.id}:${selectedRegion.updatedAt}`} region={selectedRegion} />}

      <WorldGenPanel world={world} settings={settings} />

      <section className="inspector-section" aria-label="Edits">
        <h3>Edits</h3>
        <p className="muted small">Sculpting, painting and sea level changes sit on top of the generated world and are kept when its seed or options change.</p>
        <CommitSlider label="Sea level change" unit=" m" min={-4000} max={4000} step={50} value={settings.seaLevel} onCommit={(v) => update({ seaLevel: v })} />
        <div className="add-buttons">
          <button onClick={() => void execute({ type: 'terrain.reset', payload: { worldId: world.id, layer: 'height' } })}>Reset sculpting</button>
          <button onClick={() => void execute({ type: 'terrain.reset', payload: { worldId: world.id, layer: 'biome' } })}>Reset painting</button>
        </div>
      </section>

      <section className="inspector-section">
        <h3>Regions</h3>
        {regions.length === 0 ? (
          <p className="muted small">None yet. Pick the ⬠ tool and click points on the world to draw one.</p>
        ) : (
          <ul className="region-list">
            {regions.map((r) => (
              <li key={r.id}>
                <button
                  className={`link region-row${r.id === selectedRegion?.id ? ' selected' : ''}${regionAt(r, changes, playhead) ? '' : ' absent'}`}
                  title={regionAt(r, changes, playhead) ? undefined : 'Doesn’t exist at the playhead'}
                  onClick={() => selectRegion(r.id)}
                >
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
      <ColorField label="Region color" value={region.color} onCommit={(color) => update({ color })} />
      <RegionHistory region={region} />
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
