import { ARROWS, CANVAS_COLORS, canvasColor, type Arrows, type CanvasColor } from '@universe/core'
import { useState } from 'react'
import { ALIGNS, type Align, type Point } from './board'
import { useCanvasSettings } from './canvasSettings'

/** The canvas's colours by name, as Obsidian offers them. */
const COLOR_NAMES: Record<keyof typeof CANVAS_COLORS, string> = { '1': 'Red', '2': 'Orange', '3': 'Yellow', '4': 'Green', '5': 'Cyan', '6': 'Purple' }
const ALIGN_LABELS: Record<Align, string> = { left: 'Align left', center: 'Align centres', right: 'Align right', top: 'Align tops', middle: 'Align middles', bottom: 'Align bottoms' }
export const ARROW_LABELS: Record<Arrows, string> = { end: 'Arrow at the end', start: 'Arrow at the start', both: 'Arrows at both ends', none: 'No arrows' }

/** What the bar over the selection offers for it; each is there only if it applies. */
export interface SelectionActions {
  onDelete?(): void
  /** Colours it; `allowNone` offers taking the colour off. */
  onColor?(color: CanvasColor): void
  allowNone?: boolean
  onZoom?(): void
  onEdit?(): void
  onOpen?(): void
  onBrowser?(): void
  onToEvent?(): void
  onGoTo?(): void
  onDuplicate?(): void
  onGroup?(): void
  onAlign?(how: Align): void
  arrows?: Arrows
  onArrows?(arrows: Arrows): void
}

/** The bar over what's selected (Obsidian's): colour, delete, zoom to it, and what else it can do. */
export function SelectionBar({ at, actions }: { at: Point; actions: SelectionActions }) {
  const [open, setOpen] = useState<'color' | 'align' | 'arrows' | null>(null)
  const a = actions
  const toggle = (menu: typeof open) => setOpen(open === menu ? null : menu)
  /** Picking from one of its menus closes it. */
  const pick = <T,>(run: (value: T) => void) => (value: T) => (setOpen(null), run(value))
  return (
    <div className="canvas-selection-bar view-control" role="toolbar" aria-label="Selection" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      {a.onEdit && <button title="Edit (or double-click)" aria-label="Edit" onClick={a.onEdit}>✏️</button>}
      {a.onOpen && <button title="Open it" aria-label="Open" onClick={a.onOpen}>↗</button>}
      {a.onBrowser && <button title="Open in your browser" aria-label="Open in browser" onClick={a.onBrowser}>🌐</button>}
      {a.onGoTo && <button title="Go to when and where it happened (or double-click)" aria-label="Go to" onClick={a.onGoTo}>📍</button>}
      {a.onColor && (
        <button title="Colour" aria-label="Colour" aria-expanded={open === 'color'} onClick={() => toggle('color')}>
          🎨
        </button>
      )}
      {a.onArrows && (
        <button title="Arrows" aria-label="Arrows" aria-expanded={open === 'arrows'} onClick={() => toggle('arrows')}>
          ⇄
        </button>
      )}
      {a.onAlign && (
        <button title="Align" aria-label="Align" aria-expanded={open === 'align'} onClick={() => toggle('align')}>
          ⫷
        </button>
      )}
      {a.onGroup && <button title="Put in a group" aria-label="Group" onClick={a.onGroup}>▭</button>}
      {a.onToEvent && <button title="Turn into an event at the playhead" aria-label="Turn into event" onClick={a.onToEvent}>📅</button>}
      {a.onDuplicate && <button title="Duplicate (Ctrl+D)" aria-label="Duplicate" onClick={a.onDuplicate}>⧉</button>}
      {a.onZoom && <button title="Zoom to selection (Shift+2)" aria-label="Zoom to selection" onClick={a.onZoom}>🔍</button>}
      {a.onDelete && <button title="Delete (Delete key)" aria-label="Delete" className="danger" onClick={a.onDelete}>🗑</button>}

      {open === 'color' && a.onColor && (
        <div className="canvas-popover" role="group" aria-label="Colours">
          {(Object.keys(CANVAS_COLORS) as (keyof typeof CANVAS_COLORS)[]).map((c) => (
            <button key={c} aria-label={COLOR_NAMES[c]} title={COLOR_NAMES[c]} onClick={() => pick(a.onColor!)(c)}>
              <span className="swatch" style={{ background: canvasColor(c)! }} />
            </button>
          ))}
          <label title="Any colour" className="canvas-any-color">
            <input type="color" aria-label="Any colour" onChange={(e) => pick(a.onColor!)(e.target.value)} />
          </label>
          {a.allowNone && (
            <button aria-label="No colour" title="No colour" onClick={() => pick(a.onColor!)(null)}>
              ⊘
            </button>
          )}
        </div>
      )}
      {open === 'align' && a.onAlign && (
        <div className="canvas-popover" role="group" aria-label="Align">
          {ALIGNS.map((how) => (
            <button key={how} onClick={() => pick(a.onAlign!)(how)}>
              {ALIGN_LABELS[how]}
            </button>
          ))}
        </div>
      )}
      {open === 'arrows' && a.onArrows && (
        <div className="canvas-popover" role="radiogroup" aria-label="Arrows">
          {ARROWS.map((arrows) => (
            <button key={arrows} role="radio" aria-checked={a.arrows === arrows} onClick={() => pick(a.onArrows!)(arrows)}>
              {ARROW_LABELS[arrows]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The board's own controls (Obsidian's, in the toolbar here, to leave the board clear): zoom, snapping, read-only, export. */
export function BoardControls({ zoom, onZoom, onReset, onFit, onSelection, onExport }: { zoom: number; onZoom(factor: number): void; onReset(): void; onFit(): void; onSelection?: () => void; onExport(): void }) {
  const { snapGrid, snapObjects, readOnly, toggle } = useCanvasSettings()
  return (
    <div className="canvas-controls" role="group" aria-label="Board">
      <button aria-label="Zoom in" title="Zoom in" onClick={() => onZoom(1.25)}>＋</button>
      <button aria-label="Zoom to 100%" title="Zoom to 100% (Shift+0)" onClick={onReset} className="small">
        {Math.round(zoom * 100)}%
      </button>
      <button aria-label="Zoom out" title="Zoom out" onClick={() => onZoom(0.8)}>－</button>
      <button aria-label="Zoom to fit" title="Zoom to fit (Shift+1)" onClick={onFit}>⤢</button>
      <button aria-label="Zoom to selection" title="Zoom to selection (Shift+2)" onClick={onSelection} disabled={!onSelection}>⬚</button>
      <button aria-label="Snap to grid" title="Snap to grid" aria-pressed={snapGrid} onClick={() => toggle('snapGrid')}>#</button>
      <button aria-label="Snap to cards" title="Snap to other cards’ edges" aria-pressed={snapObjects} onClick={() => toggle('snapObjects')}>⫶</button>
      <button aria-label="Read-only" title="Read-only: look, don’t change" aria-pressed={readOnly} onClick={() => toggle('readOnly')}>🔒</button>
      <button aria-label="Export as image" title="Export as image (PNG)" onClick={onExport}>⤓</button>
    </div>
  )
}

const ADDS = [
  { kind: 'text', icon: '📝', label: 'Card', title: 'A card of text (or double-click the board)' },
  { kind: 'element', icon: '🔖', label: 'Element', title: 'Something of the project: a character, a place, an event…' },
  { kind: 'image', icon: '🖼', label: 'Picture', title: 'A picture from a file (or drop one on the board)' },
  { kind: 'link', icon: '🔗', label: 'Link', title: 'A web page, opened in your browser' },
  { kind: 'group', icon: '▭', label: 'Group', title: 'A group (round what’s selected)' }
] as const

/** Adding cards, in the middle of the view (a right-click or a double-click adds one where it's asked). */
export function AddPalette({ onAdd }: { onAdd(kind: 'text' | 'element' | 'image' | 'link' | 'group'): void }) {
  return (
    <div className="canvas-palette" role="group" aria-label="Add to the canvas">
      {ADDS.map(({ kind, icon, label, title }) => (
        <button key={kind} aria-label={label} title={title} onClick={() => onAdd(kind)}>
          {icon} <span className="palette-label">{label}</span>
        </button>
      ))}
    </div>
  )
}
