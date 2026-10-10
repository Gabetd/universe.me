import { characterAt, eventPlace, findBlueprint, type Faction, type LatLon, type SpatialNode } from '@universe/core'
import { viewingDistance } from './structureLook'
import { playheadOf } from '../timeline/timelineStore'
import { BIOMES } from '@universe/procgen'
import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUi, useWorld } from '../store'
import { isBrushTool, showsSurface, useEditor, type EditorTool, type EditorView } from './editorStore'
import { EcosystemView } from './EcosystemView'
import { EventCanvas } from './EventCanvas'
import { FactionsView } from './FactionsView'
import { PowersView } from './PowersView'
import { WarningsView, useWarningCount } from './WarningsView'
import { GlobeView } from './GlobeView'
import { GroundView } from './GroundView'
import { MapView } from './MapView'
import { useSurfaceTools } from './useSurfaceTools'
import { useTerrain, type SurfaceViewProps } from './useTerrain'
import { firstLook } from './firstLook'
import { useShortcuts, withKey } from '../shortcuts'
import { showFaction } from '../contextMenu'
import { useStructuresAt } from './useStructures'
import { useCharactersAt } from './useCharacters'
import { useWorldAtTime } from './useWorldAtTime'
import { WEBGL } from './webgl'
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
/** The rest are in the toolbar, each with a shortcut (`tool-<tool>`). */
const TOOLBAR_TOOLS = TOOLS.filter((t) => !PICK_TOOLS.includes(t.tool))

const GROUND_HINT = 'Drag to move over the ground, right-drag to look around, scroll to zoom. Scroll all the way out to go back up.'

/** WebGL can be missing (old GPUs, remote desktops); the map still works without it. */
const hasWebGL = WEBGL.available

/** The world's views, in toolbar order; each has a shortcut (`view-<view>`). */
const VIEWS: { view: EditorView; icon: string; label: string; title: string; webgl?: true }[] = [
  { view: 'globe', icon: '🌐', label: 'Globe', title: 'The world as a globe', webgl: true },
  { view: 'map', icon: '🗺', label: 'Map', title: 'The world as a flat map' },
  { view: 'ground', icon: '🔍', label: 'Ground', title: 'The ground up close: buildings, trees and people at their real size (or scroll all the way in)', webgl: true },
  { view: 'canvas', icon: '🗂', label: 'Canvas', title: "This world's events as cards" },
  { view: 'species', icon: '🦌', label: 'Species', title: 'What lives here, and who eats whom' },
  { view: 'powers', icon: '✨', label: 'Powers', title: 'How magic, faith, technology or politics work here, age by age' },
  { view: 'factions', icon: '⚑', label: 'Factions', title: 'Kingdoms, houses, guilds and faiths: who belongs, what they hold, and who’s related to whom' },
  { view: 'warnings', icon: '⚠', label: 'Warnings', title: 'What doesn’t fit: what Claude found, and the app’s own checks' }
]
const OPEN_VIEWS = VIEWS.filter((v) => !v.webgl || hasWebGL)

/** Shows one of a world's views; the globe and the map are also where the canvas and the rest come back to. */
function openView(view: EditorView, worldId: string): void {
  const { set, enterGround } = useEditor.getState()
  if (view === 'ground') enterGround(...groundTarget(worldId))
  else set(view === 'globe' || view === 'map' ? { view, surfaceView: view } : { view })
}

/** Picking something in a view selects it. */
const selectEvent = (eventId: string) => useUi.getState().selectTimeline({ kind: 'event', ids: [eventId] })
const selectStructure = (id: string) => useUi.getState().selectStructure(id)
const selectCharacter = (id: string) => useUi.getState().selectCharacter(id)

export function WorldEditor({ world }: { world: SpatialNode }) {
  const { info, regions: allRegions } = useWorld(world.id)
  const { regions, holders, pins, highlightRegionIds, focus } = useWorldAtTime(world.id, allRegions)
  const hasFactions = useUi((s) => s.timeline.factions.some((f) => f.ownerId === world.id))
  // Just what's drawn here: the views and the tool options follow the rest of the editor themselves.
  const { view, tool, ground, territory, set } = useEditor(useShallow((s) => ({ view: s.view, tool: s.tool, ground: s.ground, territory: s.territory, set: s.set })))
  const structures = useStructuresAt(world.id)
  const characters = useCharactersAt(world.id)
  const warnings = useWarningCount(world.id)
  const { model, change, error, bump, commit } = useTerrain(world.id, world.seed, info)
  const { pointerDown, pointerMove, finishRegion } = useSurfaceTools(world.id, model, bump, commit)
  // Without WebGL the 3D views fall back to the map.
  const activeView = hasWebGL || !showsSurface(view) ? view : 'map'
  const onSurface = showsSurface(activeView)
  const hint = onSurface ? (activeView === 'ground' && tool === 'navigate' ? GROUND_HINT : TOOLS.find((t) => t.tool === tool)?.hint) : undefined

  const onDoubleClick = useCallback(() => void finishRegion(), [finishRegion])
  useShortcuts({
    ...Object.fromEntries(OPEN_VIEWS.map((v) => [`view-${v.view}`, () => openView(v.view, world.id)])),
    ...(onSurface && Object.fromEntries(TOOLBAR_TOOLS.map((t) => [`tool-${t.tool}`, () => set({ tool: t.tool, draft: [] })])))
  })
  // The same object until something in it changes, so the views don't redraw for nothing.
  const viewProps = useMemo<SurfaceViewProps | undefined>(
    () =>
      model && {
        worldId: world.id,
        model,
        change,
        regions,
        pins,
        highlightRegionIds,
        focus,
        onPinClick: selectEvent,
        structures,
        onStructureClick: selectStructure,
        characters,
        onCharacterClick: selectCharacter,
        onPointerDown: pointerDown,
        onPointerMove: pointerMove,
        onDoubleClick
      },
    [world.id, model, change, regions, pins, highlightRegionIds, focus, structures, characters, pointerDown, pointerMove, onDoubleClick]
  )

  return (
    <div className="world-editor">
      <div className="world-toolbar" role="toolbar" aria-label="World tools">
        <div className="segmented" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button
              key={v.view}
              aria-pressed={activeView === v.view}
              disabled={v.webgl && !hasWebGL}
              onClick={() => openView(v.view, world.id)}
              title={v.webgl && !hasWebGL ? 'WebGL is not available on this computer' : withKey(v.title, `view-${v.view}`)}
            >
              {v.icon} <span className="view-label">{v.label}</span>
              {v.view === 'warnings' && warnings > 0 && <span className="badge warn">{warnings}</span>}
            </button>
          ))}
        </div>
        {onSurface && activeView !== 'ground' && hasFactions && (
          <button className="territory-toggle" aria-pressed={territory} title="Colour the regions by the faction holding them at the playhead" onClick={() => set({ territory: !territory })}>
            ⚑ <span className="view-label">Territory</span>
          </button>
        )}
        {onSurface && (
          <div className="segmented" role="group" aria-label="Tool">
            {TOOLBAR_TOOLS.map((t) => (
              <button key={t.tool} aria-pressed={tool === t.tool} title={withKey(t.label, `tool-${t.tool}`)} aria-label={t.label} onClick={() => set({ tool: t.tool, draft: [] })}>
                {t.icon}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="world-canvas">
        <ToolOptions view={activeView} />
        {territory && onSurface && activeView !== 'ground' && <TerritoryLegend holders={holders} />}
        {activeView === 'species' ? (
          <EcosystemView worldId={world.id} model={model} change={change} error={error} />
        ) : activeView === 'powers' ? (
          <PowersView worldId={world.id} />
        ) : activeView === 'factions' ? (
          <FactionsView worldId={world.id} />
        ) : activeView === 'warnings' ? (
          <WarningsView worldId={world.id} />
        ) : activeView === 'canvas' ? (
          <EventCanvas worldId={world.id} regions={allRegions} />
        ) : viewProps ? (
          activeView === 'globe' ? (
            <GlobeView {...viewProps} />
          ) : activeView === 'ground' ? (
            // A new spot to go down to opens a fresh view there.
            <GroundView key={ground ? `${ground.lat},${ground.lon}` : ''} {...viewProps} seed={world.seed} />
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
  return [place ?? firstLook(worldId) ?? { lat: 0, lon: 0 }]
}

/** Who holds the regions coloured on the view, at the playhead. */
function TerritoryLegend({ holders }: { holders: Map<string, Faction> }) {
  const factions = [...new Map([...holders.values()].map((f) => [f.id, f])).values()]
  return (
    <aside className="territory-legend" aria-label="Territory">
      {factions.length ? (
        factions.map((f) => (
          <button key={f.id} className="link" onClick={() => showFaction(f.id)}>
            <span className="swatch" style={{ background: f.color }} /> {f.emblem} {f.name}
          </button>
        ))
      ) : (
        <span className="muted small">No faction holds land at the playhead.</span>
      )}
    </aside>
  )
}

/** Over the view rather than in the toolbar, so picking a tool never moves the map. */
function ToolOptions({ view }: { view: EditorView }) {
  const { tool, radiusKm, strength, biome, exaggeration, placeBlueprintId, set } = useEditor(
    useShallow((s) => ({ tool: s.tool, radiusKm: s.radiusKm, strength: s.strength, biome: s.biome, exaggeration: s.exaggeration, placeBlueprintId: s.placeBlueprintId, set: s.set }))
  )
  const onSurface = showsSurface(view)
  if (!((onSurface && (tool === 'place' || isBrushTool(tool))) || view === 'globe')) return null
  return (
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
            <Slider label="Strength" value={Math.round(strength * 100)} min={5} max={100} step={5} unit="%" onChange={(v) => set({ strength: v / 100 })} />
          )}
        </>
      )}
      {view === 'globe' && <Slider label="Relief" value={exaggeration} min={1} max={80} step={1} unit="×" onChange={(v) => set({ exaggeration: v })} />}
      {onSurface && tool === 'paint' && <span className="small muted">{BIOMES.find((b) => b.id === biome)?.name}</span>}
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
  )
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
