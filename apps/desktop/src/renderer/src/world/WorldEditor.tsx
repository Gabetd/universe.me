import { characterAt, eventPlace, findBlueprint, type LatLon, type SpatialNode } from '@universe/core'
import { viewingDistance } from './structureLook'
import { playheadOf } from '../timeline/timelineStore'
import { BIOMES } from '@universe/procgen'
import { useUi, useWorld } from '../store'
import { isBrushTool, showsSurface, useEditor, type EditorTool } from './editorStore'
import { EcosystemView } from './EcosystemView'
import { EventCanvas } from './EventCanvas'
import { GlobeView } from './GlobeView'
import { GroundView } from './GroundView'
import { MapView } from './MapView'
import { useSurfaceTools } from './useSurfaceTools'
import { useTerrain, type SurfaceViewProps } from './useTerrain'
import { useStructuresAt } from './useStructures'
import { useCharactersAt } from './useCharacters'
import { useWorldAtTime } from './useWorldAtTime'
import { BlueprintOptions } from '../components/BlueprintOptions'

const TOOLS: { tool: EditorTool; label: string; icon: string; hint: string }[] = [
  { tool: 'navigate', label: 'Navigate', icon: '✋', hint: 'Drag to rotate or pan, scroll to zoom. Click a region to select it.' },
  { tool: 'raise', label: 'Raise', icon: '⛰', hint: 'Drag to raise land. Right-drag rotates.' },
  { tool: 'lower', label: 'Lower', icon: '🕳', hint: 'Drag to lower land or carve seas.' },
  { tool: 'smooth', label: 'Smooth', icon: '〰', hint: 'Drag to soften slopes.' },
  { tool: 'flatten', label: 'Flatten', icon: '▭', hint: 'Drag to level terrain to the height where the stroke started.' },
  { tool: 'paint', label: 'Paint biome', icon: '🖌', hint: 'Drag to paint the selected biome.' },
  { tool: 'erase', label: 'Erase biome', icon: '⌫', hint: 'Drag to return painted cells to the automatic biome.' },
  { tool: 'region', label: 'Draw region', icon: '⬠', hint: 'Click to add points. Enter or double-click saves, Backspace removes a point, Esc cancels.' },
  { tool: 'place', label: 'Place structure', icon: '🏰', hint: 'Click to place the chosen blueprint, built at the playhead. Esc stops placing.' },
  { tool: 'locate', label: 'Place event', icon: '📍', hint: 'Click where the selected event happens. Esc cancels.' },
  { tool: 'move', label: 'Move structure', icon: '✥', hint: 'Click the structure’s new spot. Esc cancels.' },
  { tool: 'travel', label: 'Send character', icon: '🧭', hint: 'Click where the character goes; they arrive at the playhead. Esc cancels.' }
]

/** Tools started from the inspector rather than the toolbar. */
const PICK_TOOLS: EditorTool[] = ['locate', 'move', 'travel']

const GROUND_HINT = 'Drag to move over the ground, right-drag to look around, scroll to zoom. Scroll all the way out to go back up.'

/** WebGL can be missing (old GPUs, remote desktops); the map still works without it. */
const hasWebGL = (() => {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
})()

export function WorldEditor({ world }: { world: SpatialNode }) {
  const { info, regions: allRegions } = useWorld(world.id)
  const { regions, pins, highlightRegionIds, focus } = useWorldAtTime(world.id, allRegions)
  const { view, tool, radiusKm, strength, biome, exaggeration, placeBlueprintId, ground, set } = useEditor()
  const structures = useStructuresAt(world.id)
  const characters = useCharactersAt(world.id)
  const { model, change, error, bump, commit } = useTerrain(world.id, world.seed, info)
  const { pointerDown, pointerMove, finishRegion } = useSurfaceTools(world.id, model, bump, commit)
  // Without WebGL the 3D views fall back to the map.
  const activeView = hasWebGL || !showsSurface(view) ? view : 'map'
  const onSurface = showsSurface(activeView)
  const hint = onSurface ? (activeView === 'ground' && tool === 'navigate' ? GROUND_HINT : TOOLS.find((t) => t.tool === tool)?.hint) : undefined

  const viewProps: SurfaceViewProps | undefined = model && {
    model,
    change,
    regions,
    pins,
    highlightRegionIds,
    focus,
    onPinClick: (eventId) => useUi.getState().selectTimeline({ kind: 'event', ids: [eventId] }),
    structures,
    onStructureClick: (id) => useUi.getState().selectStructure(id),
    characters,
    onCharacterClick: (id) => useUi.getState().selectCharacter(id),
    onPointerDown: pointerDown,
    onPointerMove: pointerMove,
    onDoubleClick: () => void finishRegion()
  }

  return (
    <div className="world-editor">
      <div className="world-toolbar" role="toolbar" aria-label="World tools">
        <div className="segmented" role="group" aria-label="View">
          <button
            aria-pressed={activeView === 'globe'}
            disabled={!hasWebGL}
            onClick={() => set({ view: 'globe', surfaceView: 'globe' })}
            title={hasWebGL ? '' : 'WebGL is not available on this computer'}
          >
            🌐 Globe
          </button>
          <button aria-pressed={activeView === 'map'} onClick={() => set({ view: 'map', surfaceView: 'map' })}>
            🗺 Map
          </button>
          <button
            aria-pressed={activeView === 'ground'}
            disabled={!hasWebGL}
            onClick={() => useEditor.getState().enterGround(...groundTarget(world.id))}
            title="The ground up close: buildings, trees and people at their real size (or scroll all the way in)"
          >
            🔍 Ground
          </button>
          <button aria-pressed={activeView === 'canvas'} onClick={() => set({ view: 'canvas' })} title="This world's events as cards">
            🗂 Canvas
          </button>
          <button aria-pressed={activeView === 'species'} onClick={() => set({ view: 'species' })} title="What lives here, and who eats whom">
            🦌 Species
          </button>
        </div>
        {onSurface && (
          <div className="segmented" role="group" aria-label="Tool">
            {TOOLS.filter((t) => !PICK_TOOLS.includes(t.tool)).map((t) => (
              <button key={t.tool} aria-pressed={tool === t.tool} title={t.label} aria-label={t.label} onClick={() => set({ tool: t.tool, draft: [] })}>
                {t.icon}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="world-canvas">
        {(onSurface && (tool === 'place' || isBrushTool(tool))) || activeView === 'globe' ? (
          // Over the view rather than in the toolbar, so picking a tool never moves the map.
          <aside className="tool-options" aria-label="Tool options">
            {onSurface && tool === 'place' && (
              <select aria-label="Blueprint to place" value={placeBlueprintId} onChange={(e) => set({ placeBlueprintId: e.target.value })}>
                <BlueprintOptions />
              </select>
            )}
            {onSurface && isBrushTool(tool) && (
              <>
                <Slider label="Size" value={radiusKm} min={30} max={2500} step={10} unit="km" onChange={(v) => set({ radiusKm: v })} />
                {tool !== 'paint' && tool !== 'erase' && (
                  <Slider
                    label="Strength"
                    value={Math.round(strength * 100)}
                    min={5}
                    max={100}
                    step={5}
                    unit="%"
                    onChange={(v) => set({ strength: v / 100 })}
                  />
                )}
              </>
            )}
            {activeView === 'globe' && (
              <Slider label="Relief" value={exaggeration} min={1} max={80} step={1} unit="×" onChange={(v) => set({ exaggeration: v })} />
            )}
            {onSurface && tool === 'paint' && (
            <span className="small muted">{BIOMES.find((b) => b.id === biome)?.name}</span>
          )}
          {onSurface && tool === 'paint' && (
              <div className="biome-palette" role="radiogroup" aria-label="Biome">
                {BIOMES.slice(1).map((b) => (
                  // Swatches only, named on hover, so the palette stays one slim row over the view.
                  <button key={b.id} role="radio" aria-checked={biome === b.id} aria-label={b.name} title={b.name} onClick={() => set({ biome: b.id })}>
                    <span className="swatch" style={{ background: b.color }} />
                  </button>
                ))}
              </div>
            )}
          </aside>
        ) : null}
        {activeView === 'species' ? (
          <EcosystemView worldId={world.id} model={model} change={change} />
        ) : activeView === 'canvas' ? (
          <EventCanvas worldId={world.id} regions={allRegions} />
        ) : viewProps ? (
          activeView === 'globe' ? (
            <GlobeView {...viewProps} />
          ) : activeView === 'ground' ? (
            // A new spot to go down to opens a fresh view there.
            <GroundView key={ground ? `${ground.lat},${ground.lon}` : ''} {...viewProps} seed={world.seed} worldId={world.id} />
          ) : (
            <MapView {...viewProps} />
          )
        ) : null}
        {!model && onSurface && <div className="world-loading">{error ? `Couldn't load terrain: ${error}` : 'Generating terrain…'}</div>}
      </div>
      <div className="viewport-overlay bottom muted small">{hint}</div>
    </div>
  )
}

/**
 * Where the Ground button goes down, and how close: the selected character
 * or structure, the selected event's place, or where the globe looks.
 */
function groundTarget(worldId: string): [LatLon, number?] {
  const { selectedCharacterId, selectedStructureId, timeline, timelineSelection, regions } = useUi.getState()
  const character = timeline.characters.find((c) => c.id === selectedCharacterId)
  const at = character && characterAt(character, playheadOf(worldId))
  if (at) return [at, 14]
  const structure = timeline.structures.find((s) => s.id === selectedStructureId)
  const blueprint = structure && findBlueprint(timeline.blueprints, structure.blueprintId)
  if (structure) return [structure, blueprint && viewingDistance(blueprint, structure.scale)]
  const event = timelineSelection?.kind === 'event' ? timeline.events.find((e) => e.id === timelineSelection.ids[0]) : undefined
  const place = event && eventPlace(event, regions)
  return [place ?? useEditor.getState().lookingAt ?? { lat: 0, lon: 0 }]
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange(v: number): void }) {
  return (
    <label className="toolbar-slider">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <span className="toolbar-value">
        {props.value}
        {props.unit}
      </span>
    </label>
  )
}
