import { useEffect, useRef, useState } from 'react'
import { useUi } from '../store'
import { isBrushTool, useEditor } from './editorStore'

/** The terrain brush's sizes, in km (as its Size slider has them). */
const BRUSH = { min: 30, max: 2500, step: 10 }
/** A structure's sizes (as its Size slider has them). */
const STRUCTURE = { min: 0.25, max: 4, step: 0.25 }
/** How much a pixel of dragging changes the size: up a hundred pixels, about 1.8 times as big. */
const PER_PX = 0.006

const sized = (start: number, dy: number, { min, max, step }: { min: number; max: number; step: number }) =>
  Math.min(max, Math.max(min, Math.round((start * Math.exp(dy * PER_PX)) / step) * step))

/** What a middle-button drag resizes: the brush while a terrain tool is out, else the selected structure on this world. */
function target(worldId: string): { kind: 'brush'; start: number } | { kind: 'structure'; id: string; name: string; start: number } | null {
  const { tool, radiusKm } = useEditor.getState()
  if (isBrushTool(tool)) return { kind: 'brush', start: radiusKm }
  const { selectedStructureId, timeline } = useUi.getState()
  const s = selectedStructureId ? timeline.structures.find((x) => x.id === selectedStructureId && x.ownerId === worldId) : undefined
  return s ? { kind: 'structure', id: s.id, name: s.name, start: s.scale } : null
}

/**
 * Holding the middle button on the globe, the map or the ground and dragging
 * up or down makes the terrain brush bigger or smaller while a terrain tool is
 * out, or else the selected structure (one step of undo, on letting go). It
 * says the size as it goes. Put in the views' box; with nothing to resize,
 * the middle button does what the view does with it.
 */
export function MiddleSize({ worldId }: { worldId: string }) {
  const hud = useRef<HTMLDivElement>(null)
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    const box = hud.current?.parentElement
    if (!box) return
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return
      const t = target(worldId)
      if (!t) return
      // Before the view's own middle button (zooming, panning) and the browser's scrolling.
      e.preventDefault()
      e.stopPropagation()
      const y0 = e.clientY
      let size = t.start
      const show = () => setLabel(t.kind === 'brush' ? `Brush size ${size} km` : `${t.name}: ${size}×`)
      show()
      const move = (m: PointerEvent) => {
        size = sized(t.start, y0 - m.clientY, t.kind === 'brush' ? BRUSH : STRUCTURE)
        if (t.kind === 'brush') useEditor.getState().set({ radiusKm: size })
        show()
      }
      const up = () => {
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', up, true)
        setLabel(null)
        if (t.kind === 'structure' && size !== t.start) void useUi.getState().execute({ type: 'structure.update', payload: { id: t.id, patch: { scale: size } } })
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', up, true)
    }
    // No autoscroll, nor a paste on Linux, from the middle button over the views.
    const quiet = (e: MouseEvent) => e.button === 1 && target(worldId) && e.preventDefault()
    box.addEventListener('pointerdown', onDown, true)
    box.addEventListener('mousedown', quiet, true)
    box.addEventListener('auxclick', quiet, true)
    return () => {
      box.removeEventListener('pointerdown', onDown, true)
      box.removeEventListener('mousedown', quiet, true)
      box.removeEventListener('auxclick', quiet, true)
    }
  }, [worldId])
  return (
    <div ref={hud} className="middle-size" role="status" aria-label="Resizing" hidden={label === null}>
      {label}
    </div>
  )
}
