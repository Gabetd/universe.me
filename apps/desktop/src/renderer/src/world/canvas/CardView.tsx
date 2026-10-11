import { canvasColor, type CanvasCard } from '@universe/core'
import { useEffect, useRef } from 'react'
import { useUi } from '../../store'
import { elementSummary, openTarget } from './elements'
import { markdownToHtml } from './markdown'

/**
 * What a card on the canvas shows: a text card its Markdown (or, being
 * edited, the Markdown itself), an element card what it is with a little of
 * its notes, a picture card its picture, a link card its address, a group
 * its label above it. Where it is and how big is the board's to say.
 */
export function CardBody({ card, editing, onDone }: { card: CanvasCard; editing: boolean; onDone(): void }) {
  switch (card.kind) {
    case 'text':
      return editing ? <TextEditor card={card} field="text" label="Card text" multiline onDone={onDone} /> : <div className="canvas-markdown" dangerouslySetInnerHTML={{ __html: markdownToHtml(card.text) || '<p class="muted">Double-click to write</p>' }} />
    case 'element':
      return <ElementBody card={card} />
    case 'image':
      return <img className="canvas-picture" src={card.image ?? undefined} alt="" draggable={false} />
    case 'link':
      return (
        <div className="canvas-link-card">
          <span aria-hidden>🔗</span>
          <a href={card.url ?? undefined} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()}>
            {card.url}
          </a>
          <span className="muted small">Opens in your browser</span>
        </div>
      )
    case 'group':
      return null
  }
}

/** A group's label, over its top-left corner (edited in place). */
export function GroupLabel({ card, editing, onDone }: { card: CanvasCard; editing: boolean; onDone(): void }) {
  const color = canvasColor(card.color)
  return (
    <div className="canvas-group-label" style={color ? { background: color } : undefined}>
      {editing ? <TextEditor card={card} field="text" label="Group label" onDone={onDone} /> : card.text || 'Group'}
    </div>
  )
}

function ElementBody({ card }: { card: CanvasCard }) {
  // Read anew when the project changes, so a rename shows.
  useUi((s) => s.timeline)
  const summary = elementSummary(card.target!)
  return (
    <div className={`canvas-element${summary.missing ? ' missing' : ''}`}>
      <span className="small muted">{summary.kind}</span>
      <button className="link canvas-element-name" onPointerDown={(e) => e.stopPropagation()} onClick={() => openTarget(card.target!)} disabled={summary.missing} title="Open it">
        {summary.name}
      </button>
      {summary.notes && <p className="small canvas-element-notes">{summary.notes}</p>}
    </div>
  )
}

/** Edits a card's text in place: kept as it's left (Escape, a click elsewhere, Ctrl+Enter), one step to undo. */
function TextEditor({ card, field, label, multiline, onDone }: { card: CanvasCard; field: 'text'; label: string; multiline?: boolean; onDone(): void }) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const save = () => {
    const value = ref.current!.value
    if (value !== card[field]) void useUi.getState().execute({ type: 'card.update', payload: { id: card.id, patch: { [field]: value } } })
    onDone()
  }
  const props = {
    ref,
    'aria-label': label,
    defaultValue: card[field],
    className: 'canvas-text-editor',
    onBlur: save,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !multiline))) {
        e.preventDefault()
        ref.current!.blur()
      }
    }
  }
  return multiline ? <textarea {...props} spellCheck /> : <input {...props} spellCheck />
}
