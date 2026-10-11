import { canvasColor, type CanvasCard } from '@universe/core'
import { memo, useEffect, useMemo, useRef } from 'react'
import { updater, useUi } from '../../store'
import { elementSummary, openTarget } from './elements'
import { markdownToHtml } from './markdown'

/**
 * What a card on the canvas shows: a text card its Markdown (or, being
 * edited, the Markdown itself), an element card what it is with a little of
 * its notes, a picture card its picture, a link card its address, a group
 * its label above it. Where it is and how big is the board's to say.
 */
// Memoized: the board re-renders as it's panned and things are dragged, and a card only when it changes (`onDone` is stable).
export const CardBody = memo(function CardBody({ card, editing, onDone }: { card: CanvasCard; editing: boolean; onDone(): void }) {
  switch (card.kind) {
    case 'text':
      return editing ? <InlineEditor label="Card text" value={card.text} multiline onDone={(text) => saveText(card, text, onDone)} /> : <Markdown text={card.text} />
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
})

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => markdownToHtml(text) || '<p class="muted">Double-click to write</p>', [text])
  return <div className="canvas-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

/** Keeps a card's text (or a group's label) as it was left, one step to undo, if it changed. */
const saveText = (card: CanvasCard, text: string, done: () => void) => {
  if (text !== card.text) updater('card', card.id)({ text })
  done()
}

/** A group's label, over its top-left corner (edited in place). */
export const GroupLabel = memo(function GroupLabel({ card, editing, onDone }: { card: CanvasCard; editing: boolean; onDone(): void }) {
  const color = canvasColor(card.color)
  return (
    <div className="canvas-group-label" style={color ? { background: color } : undefined}>
      {editing ? <InlineEditor label="Group label" value={card.text} onDone={(text) => saveText(card, text, onDone)} /> : card.text || 'Group'}
    </div>
  )
})

function ElementBody({ card }: { card: CanvasCard }) {
  // Worked out again when the project changes (a rename shows), not as the board moves.
  const timeline = useUi((s) => s.timeline)
  const nodes = useUi((s) => s.nodes)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `timeline` and `nodes` stand for what it reads from the store
  const summary = useMemo(() => elementSummary(card.target!), [card.target, timeline, nodes])
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

/** Text edited in place (a card's, a group's label, a connection's label): kept as it's left (Escape, a click elsewhere, Enter or, written on several lines, Ctrl+Enter). */
export function InlineEditor({ label, value, multiline, className = 'canvas-text-editor', style, onDone }: { label: string; value: string; multiline?: boolean; className?: string; style?: React.CSSProperties; onDone(value: string): void }) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const props = {
    ref,
    'aria-label': label,
    defaultValue: value,
    className,
    style,
    onBlur: () => onDone(ref.current!.value),
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
