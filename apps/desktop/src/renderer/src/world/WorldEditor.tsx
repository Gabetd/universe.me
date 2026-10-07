import type { SpatialNode } from '@universe/core'
import { BIOMES } from '@universe/procgen'
import { useUi, useWorld } from '../store'
import { isBrushTool, useEditor, type EditorTool } from './editorStore'
import { EventCanvas } from './EventCanvas'
import { GlobeView } from './GlobeView'
import { MapView } from './MapView'
import { useSurfaceTools } from './useSurfaceTools'
import { useTerrain, type SurfaceViewProps } from './useTerrain'
import { useStructuresAt } from './useStructures'
import { useWorldAtTime } from './useWorldAtTime'
import { BUILTIN_BLUEPRINTS } from '@universe/core'

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
  { tool: 'move', label: 'Move structure', icon: '✥', hint: 'Click the structure’s new spot. Esc cancels.' }
]

/** Tools started from the inspector rather than the toolbar. */
const PICK_TOOLS: EditorTool[] = ['locate', 'move']

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
  const { view, tool, radiusKm, strength, biome, exaggeration, placeBlueprintId, set } = useEditor()
  const structures = useStructuresAt(world.id)
  const library = useUi((s) => s.timeline.blueprints)
  const { model, change, error, bump, commit } = useTerrain(world.id, world.seed, info)
  const { pointerDown, pointerMove, finishRegion } = useSurfaceTools(world.id, model, bump, commit)
  const activeView = hasWebGL || view === 'canvas' ? view : 'map'
  const onSurface = activeView !== 'canvas'
  const hint = onSurface ? TOOLS.find((t) => t.tool === tool)?.hint : undefined

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
          <button aria-pressed={activeView === 'canvas'} onClick={() => set({ view: 'canvas' })} title="This world's events as cards">
            🗂 Canvas
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
        {onSurface && tool === 'place' && (
          <select aria-label="Blueprint to place" value={placeBlueprintId} onChange={(e) => set({ placeBlueprintId: e.target.value })}>
            {[...BUILTIN_BLUEPRINTS, ...library].map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
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
        {activeView === 'globe' && <Slider label="Relief" value={exaggeration} min={1} max={80} step={1} unit="×" onChange={(v) => set({ exaggeration: v })} />}
      </div>

      {onSurface && tool === 'paint' && (
        <div className="biome-palette" role="radiogroup" aria-label="Biome">
          {BIOMES.slice(1).map((b) => (
            <button key={b.id} role="radio" aria-checked={biome === b.id} title={b.name} onClick={() => set({ biome: b.id })}>
              <span className="swatch" style={{ background: b.color }} />
              {b.name}
            </button>
          ))}
        </div>
      )}

      <div className="world-canvas">
        {activeView === 'canvas' ? (
          <EventCanvas worldId={world.id} regions={allRegions} />
        ) : viewProps ? (
          activeView === 'globe' ? (
            <GlobeView {...viewProps} />
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
