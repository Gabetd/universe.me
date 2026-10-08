import { useMemo } from 'react'
import { regionAt, type Region, type RegionPatch, type SpatialNode, type WorldSettingsPatch } from '@universe/core'
import { useUi, useWorld } from '../store'
import { ColorField, CommitSlider, TextField } from './fields'
import { NotesEditor } from './NotesEditor'
import { RegionHistory } from './RegionHistory'
import { BlueprintLibrary } from './BlueprintLibrary'
import { StructurePanel } from './StructurePanel'
import { CharacterPanel } from './CharacterPanel'
import { WorldGenPanel } from './WorldGenPanel'
import { EROSION_SPEED, isAlive, stateAt } from '@universe/core'
import { STAGE_COLORS } from '../world/structureLook'
import { useConditionCurves } from '../world/useStructures'
import { useEditor } from '../world/editorStore'
import { usePlayhead } from '../timeline/timelineStore'

/** Inspector section for a world: generation settings, terrain resets, and regions. */
export function WorldPanel({ world }: { world: SpatialNode }) {
  const { info, regions } = useWorld(world.id)
  const selectedRegion = useUi((s) => s.regions.find((r) => r.id === s.selectedRegionId))
  const selectRegion = useUi((s) => s.selectRegion)
  const selectedStructure = useUi((s) => s.timeline.structures.find((x) => x.id === s.selectedStructureId))
  const selectedCharacter = useUi((s) => s.timeline.characters.find((x) => x.id === s.selectedCharacterId))
  const execute = useUi((s) => s.execute)
  const changes = useUi((s) => s.timeline.changes)
  const playhead = usePlayhead(world.id)
  if (!info) return null
  const { settings } = info
  const update = (patch: WorldSettingsPatch) => void execute({ type: 'world.update', payload: { id: world.id, patch } })

  return (
    <>
      {selectedRegion && <RegionForm key={`${selectedRegion.id}:${selectedRegion.updatedAt}`} region={selectedRegion} />}
      {selectedStructure && <StructurePanel key={`${selectedStructure.id}:${selectedStructure.updatedAt}`} structure={selectedStructure} />}
      {selectedCharacter && <CharacterPanel key={`${selectedCharacter.id}:${selectedCharacter.updatedAt}`} character={selectedCharacter} />}

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

      <CharacterList worldId={world.id} />
      <StructureList worldId={world.id} erosionSpeed={settings.erosionSpeed} onErosionSpeed={(erosionSpeed) => update({ erosionSpeed })} />
      <BlueprintLibrary />

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

/** The world's structures, coloured by condition at the playhead, and how fast things weather here. */
function CharacterList({ worldId }: { worldId: string }) {
  const all = useUi((s) => s.timeline.characters)
  const characters = useMemo(() => all.filter((x) => x.ownerId === worldId), [all, worldId])
  const selectedId = useUi((s) => s.selectedCharacterId)
  const playhead = usePlayhead(worldId)
  const add = async () => {
    const state = await useUi.getState().execute({ type: 'character.create', payload: { ownerId: worldId, born: playhead } })
    // Then pick where they're born.
    const id = state?.focus?.id
    if (id) useEditor.getState().startTool({ tool: 'travel', travelCharacterId: id })
  }
  return (
    <section className="inspector-section" aria-label="Characters">
      <h3>Characters</h3>
      {characters.length > 0 && (
        <ul className="region-list">
          {characters.map((c) => (
            <li key={c.id}>
              <button
                className={`link region-row${c.id === selectedId ? ' selected' : ''}${isAlive(c, playhead) ? '' : ' absent'}`}
                title={isAlive(c, playhead) ? undefined : 'Not alive at the playhead'}
                onClick={() => useUi.getState().selectCharacter(c.id)}
              >
                <span className="swatch" style={{ background: c.color }} />
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="add-buttons">
        <button onClick={() => void add()}>+ Character</button>
      </div>
    </section>
  )
}

function StructureList({ worldId, erosionSpeed, onErosionSpeed }: { worldId: string; erosionSpeed: number; onErosionSpeed(v: number): void }) {
  const all = useUi((s) => s.timeline.structures)
  const structures = useMemo(() => all.filter((x) => x.ownerId === worldId), [all, worldId])
  const selectedId = useUi((s) => s.selectedStructureId)
  const selectStructure = useUi((s) => s.selectStructure)
  const { curves } = useConditionCurves(worldId)
  const playhead = usePlayhead(worldId)
  return (
    <section className="inspector-section" aria-label="Structures">
      <h3>Structures</h3>
      {structures.length === 0 ? (
        <p className="muted small">
          None yet.{' '}
          <button className="link" onClick={() => useEditor.getState().startTool({ tool: 'place' })}>
            Pick 🏰
          </button>{' '}
          and click on the world to place one.
        </p>
      ) : (
        <ul className="region-list">
          {structures.map((x) => {
            const state = stateAt(curves.get(x.id)!, playhead)
            return (
              <li key={x.id}>
                <button
                  className={`link region-row${x.id === selectedId ? ' selected' : ''}${state.exists ? '' : ' absent'}`}
                  title={state.exists ? undefined : 'Not standing at the playhead'}
                  onClick={() => selectStructure(x.id)}
                >
                  <span className="swatch" style={{ background: STAGE_COLORS[state.stage] }} />
                  {state.name}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <CommitSlider label="Erosion speed" unit="×" min={EROSION_SPEED.min} max={EROSION_SPEED.max} step={EROSION_SPEED.step} value={erosionSpeed} onCommit={onErosionSpeed} />
    </section>
  )
}
