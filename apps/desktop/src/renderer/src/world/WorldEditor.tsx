import type { SpatialNode } from '@universe/core'
import { BIOMES } from '@universe/procgen'
import { useMemo } from 'react'
import { useUi } from '../store'
import { isBrushTool, useEditor, type EditorTool } from './editorStore'
import { GlobeView } from './GlobeView'
import { MapView } from './MapView'
import { useSurfaceTools } from './useSurfaceTools'
import { useTerrain } from './useTerrain'

const TOOLS: { tool: EditorTool; label: string; icon: string; hint: string }[] = [
  { tool: 'navigate', label: 'Navigate', icon: '✋', hint: 'Drag to rotate or pan, scroll to zoom. Click a region to select it.' },
  { tool: 'raise', label: 'Raise', icon: '⛰', hint: 'Drag to raise land. Right-drag rotates.' },
  { tool: 'lower', label: 'Lower', icon: '🕳', hint: 'Drag to lower land or carve seas.' },
  { tool: 'smooth', label: 'Smooth', icon: '〰', hint: 'Drag to soften slopes.' },
  { tool: 'flatten', label: 'Flatten', icon: '▭', hint: 'Drag to level terrain to the height where the stroke started.' },
  { tool: 'paint', label: 'Paint biome', icon: '🖌', hint: 'Drag to paint the selected biome.' },
  { tool: 'erase', label: 'Erase biome', icon: '⌫', hint: 'Drag to return painted cells to the automatic biome.' },
  { tool: 'region', label: 'Draw region', icon: '⬠', hint: 'Click to add points. Enter or double-click saves, Backspace removes a point, Esc cancels.' }
]

/** WebGL can be missing (old GPUs, remote desktops); the map still works without it. */
const hasWebGL = (() => {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
})()

export function WorldEditor({ world }: { world: SpatialNode }) {
  const info = useUi((s) => s.worlds.find((w) => w.id === world.id))
  const allRegions = useUi((s) => s.regions)
  const regions = useMemo(() => allRegions.filter((r) => r.worldId === world.id), [allRegions, world.id])
  const { view, tool, radiusKm, strength, biome, exaggeration, set } = useEditor()
  const { model, change, error, bump, commit } = useTerrain(world.id, world.seed, info)
  const { pointerDown, pointerMove, finishRegion } = useSurfaceTools(world.id, model, bump, commit)
  const activeView = hasWebGL ? view : 'map'
  const hint = TOOLS.find((t) => t.tool === tool)?.hint

  const viewProps = model && {
    model,
    change,
    regions,
    onPointerDown: pointerDown,
    onPointerMove: pointerMove,
    onDoubleClick: () => void finishRegion()
  }

  return (
    <div className="world-editor">
      <div className="world-toolbar" role="toolbar" aria-label="World tools">
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={activeView === 'globe'} disabled={!hasWebGL} onClick={() => set({ view: 'globe' })} title={hasWebGL ? '' : 'WebGL is not available on this computer'}>
            🌐 Globe
          </button>
          <button aria-pressed={activeView === 'map'} onClick={() => set({ view: 'map' })}>
            🗺 Map
          </button>
        </div>
        <div className="segmented" role="group" aria-label="Tool">
          {TOOLS.map((t) => (
            <button key={t.tool} aria-pressed={tool === t.tool} title={t.label} aria-label={t.label} onClick={() => set({ tool: t.tool, draft: [] })}>
              {t.icon}
            </button>
          ))}
        </div>
        {isBrushTool(tool) && (
          <>
            <Slider label="Size" value={radiusKm} min={30} max={2500} step={10} unit="km" onChange={(v) => set({ radiusKm: v })} />
            {tool !== 'paint' && tool !== 'erase' && (
              <Slider label="Strength" value={Math.round(strength * 100)} min={5} max={100} step={5} unit="%" onChange={(v) => set({ strength: v / 100 })} />
            )}
          </>
        )}
        {activeView === 'globe' && <Slider label="Relief" value={exaggeration} min={1} max={80} step={1} unit="×" onChange={(v) => set({ exaggeration: v })} />}
      </div>

      {tool === 'paint' && (
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
        {viewProps ? activeView === 'globe' ? <GlobeView {...viewProps} /> : <MapView {...viewProps} /> : null}
        {!model && <div className="world-loading">{error ? `Couldn't load terrain: ${error}` : 'Generating terrain…'}</div>}
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
