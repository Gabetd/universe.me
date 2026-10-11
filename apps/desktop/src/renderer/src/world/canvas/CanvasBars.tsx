import { ARROWS, CANVAS_COLORS, canvasColor, type Arrows, type CanvasColor, type CardKind } from '@universe/core'
import { useState } from 'react'
import { ColorField } from '../../components/fields'
import type { MenuItem } from '../../contextMenu'
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

/** The actions that are one button (and one menu item) each, in the bar's order. */
type ButtonAction = 'onEdit' | 'onOpen' | 'onBrowser' | 'onGoTo' | 'onGroup' | 'onToEvent' | 'onDuplicate' | 'onZoom'
const ACTIONS: { key: ButtonAction; icon: string; label: string; title: string }[] = [
  { key: 'onEdit', icon: '✏️', label: 'Edit', title: 'Edit (or double-click)' },
  { key: 'onOpen', icon: '↗', label: 'Open', title: 'Open it' },
  { key: 'onBrowser', icon: '🌐', label: 'Open in browser', title: 'Open in your browser' },
  { key: 'onGoTo', icon: '📍', label: 'Go to', title: 'Go to when and where it happened (or double-click)' },
  { key: 'onGroup', icon: '▭', label: 'Group', title: 'Put in a group' },
  { key: 'onToEvent', icon: '📅', label: 'Turn into event', title: 'Turn into an event at the playhead' },
  { key: 'onDuplicate', icon: '⧉', label: 'Duplicate', title: 'Duplicate (Ctrl+D)' },
  { key: 'onZoom', icon: '🔍', label: 'Zoom to selection', title: 'Zoom to it (Shift+2)' }
]

/** A selection's actions as a right-click menu: the bar's buttons, the arrows of a connection, and Delete. */
export function menuItems(a: SelectionActions): MenuItem[] {
  return [
    ...ACTIONS.flatMap(({ key, label }) => (a[key] ? [{ label, run: a[key] }] : [])),
    ...(a.onArrows ? ARROWS.map((arrows) => ({ label: ARROW_LABELS[arrows], run: () => a.onArrows!(arrows) })) : []),
    ...(a.onDelete ? ['separator' as const, { label: 'Delete', run: a.onDelete, danger: true }] : [])
  ]
}

/** The bar over what's selected (Obsidian's): its actions, colour, arrows and aligning, and delete. */
export function SelectionBar({ at, actions }: { at: Point; actions: SelectionActions }) {
  const [open, setOpen] = useState<'color' | 'align' | 'arrows' | null>(null)
  const a = actions
  const toggle = (menu: typeof open) => setOpen(open === menu ? null : menu)
  /** Picking from one of its menus closes it. */
  const pick = <T,>(run: (value: T) => void) => (value: T) => (setOpen(null), run(value))
  return (
    <div className="canvas-selection-bar" role="toolbar" aria-label="Selection" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      {ACTIONS.map(({ key, icon, label, title }) =>
        a[key] ? (
          <button key={key} title={title} aria-label={label} onClick={a[key]}>
            {icon}
          </button>
        ) : null
      )}
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
      {a.onDelete && (
        <button title="Delete (Delete key)" aria-label="Delete" className="danger" onClick={a.onDelete}>
          🗑
        </button>
      )}

      {open === 'color' && a.onColor && (
        <div className="canvas-popover" role="group" aria-label="Colours">
          {(Object.keys(CANVAS_COLORS) as (keyof typeof CANVAS_COLORS)[]).map((c) => (
            <button key={c} aria-label={COLOR_NAMES[c]} title={COLOR_NAMES[c]} onClick={() => pick(a.onColor!)(c)}>
              <span className="swatch" style={{ background: canvasColor(c)! }} />
            </button>
          ))}
          <ColorField label="Any colour" value="#888888" onCommit={pick(a.onColor)} />
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
export function AddPalette({ onAdd }: { onAdd(kind: CardKind): void }) {
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
