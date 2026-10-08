import { regionAt, type Region, type SpatialNode } from '@universe/core'
import { useState } from 'react'
import { updater, useOwnRecords, useUi, useWorld } from '../store'
import { ColorField, CommitSlider, DeleteButton, NotesField, PanelHeader, Swatch, SwatchList, TextField } from './fields'
import { RegionHistory } from './RegionHistory'
import { BlueprintLibrary } from './BlueprintLibrary'
import { StructurePanel } from './StructurePanel'
import { CharacterPanel } from './CharacterPanel'
import { CalendarPanel, ClimatePanel } from './SkyPanels'
import { WorldGenPanel } from './WorldGenPanel'
import { RegionTheme, WorldThemes } from './ThemePanels'
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
  if (!info) return null
  const { settings } = info
  const update = updater('world', world.id)

  return (
    <>
      {selectedRegion && <RegionForm key={selectedRegion.id} region={selectedRegion} />}
      {selectedStructure && <StructurePanel key={selectedStructure.id} structure={selectedStructure} />}
      {selectedCharacter && <CharacterPanel key={selectedCharacter.id} character={selectedCharacter} />}

      <WorldGenPanel world={world} settings={settings} />
      <ClimatePanel world={world} settings={settings} />
      <CalendarPanel world={world} />
      <WorldThemes world={world} />

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

      <RegionList worldId={world.id} regions={regions} selectedId={selectedRegion?.id} onPick={selectRegion} />
      <ExportBible worldId={world.id} />
    </>
  )
}

/** Writes the whole world up as one Markdown document (a "world bible"), where the user picks. */
function ExportBible({ worldId }: { worldId: string }) {
  const [saved, setSaved] = useState<string>()
  const exportIt = async () => {
    const path = await useUi.getState().run(window.universe.exportBible(worldId))
    if (path) setSaved(path)
  }
  return (
    <section className="inspector-section" aria-label="World bible">
      <h3>World bible</h3>
      <p className="muted small">The whole world as one document: its calendar, regions, history in order, structures, characters, life and the tone of each age.</p>
      <button onClick={() => void exportIt()}>Export world bible…</button>
      {saved && <p className="small muted" aria-label="Exported to">Saved to {saved}</p>}
    </section>
  )
}

/** The world's regions, dimmed where they don't exist at the playhead (which only this list follows). */
function RegionList({ worldId, regions, selectedId, onPick }: { worldId: string; regions: Region[]; selectedId: string | undefined; onPick(id: string): void }) {
  const changes = useUi((s) => s.timeline.changes)
  const playhead = usePlayhead(worldId)
  return (
    <section className="inspector-section">
      <h3>Regions</h3>
      {regions.length === 0 ? (
        <p className="muted small">None yet. Pick the ⬠ tool and click points on the world to draw one.</p>
      ) : (
        <SwatchList
          rows={regions.map((r) => ({ id: r.id, name: r.name, color: r.color, selected: r.id === selectedId, absent: regionAt(r, changes, playhead) ? undefined : 'Doesn’t exist at the playhead' }))}
          onPick={onPick}
        />
      )}
    </section>
  )
}

function RegionForm({ region }: { region: Region }) {
  const selectRegion = useUi((s) => s.selectRegion)
  const update = updater('region', region.id)

  return (
    <section className="inspector-section region-form" aria-label="Region">
      <PanelHeader icon={<Swatch color={region.color} />} label="Region" onClose={() => selectRegion(null)} />
      <TextField label="Region name" value={region.name} required onCommit={(name) => update({ name })} />
      <ColorField label="Region color" value={region.color} onCommit={(color) => update({ color })} />
      <RegionTheme worldId={region.worldId} regionId={region.id} />
      <RegionHistory region={region} />
      <NotesField label="Region notes" value={region.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="region" ids={[region.id]}>
        Delete region
      </DeleteButton>
    </section>
  )
}

/** The world's characters, dimmed when they aren't alive at the playhead. */
function CharacterList({ worldId }: { worldId: string }) {
  const characters = useOwnRecords('characters', worldId)
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
        <SwatchList
          rows={characters.map((c) => ({ id: c.id, name: c.name, color: c.color, selected: c.id === selectedId, absent: isAlive(c, playhead) ? undefined : 'Not alive at the playhead' }))}
          onPick={useUi.getState().selectCharacter}
        />
      )}
      <div className="add-buttons">
        <button onClick={() => void add()}>+ Character</button>
      </div>
    </section>
  )
}

/** The world's structures, coloured by condition at the playhead, and how fast things weather here. */
function StructureList({ worldId, erosionSpeed, onErosionSpeed }: { worldId: string; erosionSpeed: number; onErosionSpeed(v: number): void }) {
  const structures = useOwnRecords('structures', worldId)
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
        <SwatchList
          rows={structures.map((x) => {
            const state = stateAt(curves.get(x.id)!, playhead)
            return { id: x.id, name: state.name, color: STAGE_COLORS[state.stage], selected: x.id === selectedId, absent: state.exists ? undefined : 'Not standing at the playhead' }
          })}
          onPick={selectStructure}
        />
      )}
      <CommitSlider label="Erosion speed" unit="×" min={EROSION_SPEED.min} max={EROSION_SPEED.max} step={EROSION_SPEED.step} value={erosionSpeed} onCommit={onErosionSpeed} />
    </section>
  )
}
