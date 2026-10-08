import { formatTime, parseTime, type Precision } from '@universe/core'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { deleteCommand, useTimelineOwner, useUi, type DeleteKind } from '../store'
import { useCalendar } from '../world/useSky'
import { NotesEditor } from './NotesEditor'
import { menuRef, type ElementKind } from '../contextMenu'

/**
 * Inputs that save once when editing finishes (blur, Enter, slider release),
 * not on every keystroke: each save is one undo step.
 */
/** Text being edited, replaced by each new stored value (a save, undo, an edit elsewhere). */
function useDraft(value: string): [string, (text: string) => void] {
  const [text, setText] = useState(value)
  const [stored, setStored] = useState(value)
  if (stored !== value) {
    setStored(value)
    setText(value)
  }
  return [text, setText]
}

export function TextField(props: { label: string; value: string; placeholder?: string; required?: boolean; onCommit(v: string): void }) {
  const [text, setText] = useDraft(props.value)
  const commit = () => {
    const v = text.trim()
    if (props.required && !v) setText(props.value)
    else if (v !== props.value) props.onCommit(v)
  }
  return (
    <label className="field">
      <span>{props.label}</span>
      <input value={text} placeholder={props.placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
    </label>
  )
}

/**
 * A color picker that saves once, when the picker closes, rather than for
 * every color passed over while dragging (each save is an undo step).
 */
export function ColorField(props: { label: string; value: string; onCommit(color: string): void }) {
  const ref = useRef<HTMLInputElement>(null)
  const { value, onCommit } = props
  useEffect(() => {
    const el = ref.current!
    const onChange = () => el.value.toLowerCase() !== value.toLowerCase() && onCommit(el.value)
    el.addEventListener('change', onChange)
    return () => el.removeEventListener('change', onChange)
  }, [value, onCommit])
  return (
    <label className="field">
      <span>{props.label}</span>
      {/* Uncontrolled, re-created when the stored color changes (e.g. undo). */}
      <input key={value} ref={ref} type="color" aria-label={props.label} defaultValue={value} />
    </label>
  )
}

/** Comma-separated tags; saves only if the list actually changed. */
export function TagsField(props: { label: string; tags: string[]; onCommit(tags: string[]): void }) {
  return (
    <TextField
      label={props.label}
      placeholder="comma, separated"
      value={props.tags.join(', ')}
      onCommit={(text) => {
        const tags = parseTags(text)
        if (tags.join('\u0000') !== props.tags.join('\u0000')) props.onCommit(tags)
      }}
    />
  )
}

/** "a, b ,, c" → ['a', 'b', 'c']. */
export const parseTags = (text: string): string[] =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

/** A new random seed: any 32-bit unsigned integer. */
export const randomSeed = () => Math.floor(Math.random() * 0x100000000)

/** Rich-text notes under their label. A new stored value (undo, an edit elsewhere) is shown in a fresh editor. */
export function NotesField({ label, value, grow, onCommit }: { label: string; value: string; grow?: boolean; onCommit(html: string): void }) {
  return (
    <div className={grow ? 'field grow' : 'field'}>
      <span>{label}</span>
      <NotesEditor key={value} label={label} value={value} onCommit={onCommit} />
    </div>
  )
}

/** Copies `text` to the clipboard; says "Copied" for a moment. */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button className={className} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** A small colour square. */
export const Swatch = ({ color }: { color: string | undefined }) => <span className="swatch" style={{ background: color }} />

/** The top line of an inspector panel: what it shows, and a button that closes it. */
export function PanelHeader({ icon, label, onClose }: { icon: ReactNode; label: string; onClose(): void }) {
  return (
    <div className="inspector-kind">
      {icon} {label}
      <button className="link close" aria-label={`Close ${label.toLowerCase()}`} onClick={onClose}>
        ✕
      </button>
    </div>
  )
}

/** The button at the bottom of a panel that deletes what it shows, in one undo step. */
export function DeleteButton({ kind, ids, children }: { kind: DeleteKind; ids: string[]; children: ReactNode }) {
  const remove = () => {
    const command = deleteCommand(kind, ids)
    if (command) void useUi.getState().execute(command)
  }
  return (
    <button className="danger" onClick={remove}>
      {children}
    </button>
  )
}

export interface SwatchRow {
  id: string
  name: string
  color: string | undefined
  selected?: boolean
  /** Why it's dimmed (it isn't there at the playhead); shown as its tooltip. */
  absent?: string
}

/** A list of named colour swatches (regions, characters, structures, events); clicking one picks it, right-clicking it (as `menu`) gives its options. */
export function SwatchList({ rows, onPick, menu }: { rows: SwatchRow[]; onPick(id: string): void; menu?: ElementKind }) {
  return (
    <ul className="region-list">
      {rows.map((r) => (
        <li key={r.id}>
          <button className={`link region-row${r.selected ? ' selected' : ''}${r.absent ? ' absent' : ''}`} title={r.absent} data-menu={menu && menuRef(menu, r.id)} onClick={() => onPick(r.id)}>
            <Swatch color={r.color} />
            {r.name}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A choice from a fixed list (its values and their labels), saved as it's picked. */
export function SelectField<T extends string>({ label, value, options, onCommit }: { label: string; value: T; options: Record<T, string>; onCommit(v: T): void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onCommit(e.target.value as T)}>
        {(Object.keys(options) as T[]).map((o) => (
          <option key={o} value={o}>
            {options[o]}
          </option>
        ))}
      </select>
    </label>
  )
}

/** A range slider that saves once on release, not on every pixel of a drag (each save is an undo step). */
export function CommitSlider(props: { label: string; unit?: string; min: number; max: number; step: number; value: number; onCommit(v: number): void }) {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? props.value
  const commit = () => {
    if (draft !== null && draft !== props.value) props.onCommit(draft)
    setDraft(null)
  }
  return (
    <label className="field">
      <span className="field-label-row">
        {props.label}
        <span className="muted">
          {shown}
          {props.unit}
        </span>
      </span>
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  )
}

export function NumberInput(props: { value: number; min: number; max: number; integer?: boolean; onCommit(v: number): void }) {
  const [text, setText] = useDraft(String(props.value))
  const commit = () => {
    const v = Number(text)
    const valid = Number.isFinite(v) && v >= props.min && v <= props.max && (!props.integer || Number.isInteger(v))
    if (valid && v !== props.value) props.onCommit(v)
    else if (!valid) setText(String(props.value))
  }
  return <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={blurOnEnter} />
}

function blurOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === 'Enter') e.currentTarget.blur()
}

/**
 * A date on the timeline, typed the way people write them ("1204",
 * "15 Mar 1204", "c. 1200", "4.5 billion years ago"). Saves on blur or Enter;
 * text that isn't a date is flagged and put back. With `allowEmpty`, clearing it saves null.
 * Dates are in the calendar of the timeline in view.
 */
export function TimeField(props: {
  label: string
  value: number | null
  precision: Precision
  allowEmpty?: boolean
  placeholder?: string
  onCommit(value: { t: number; precision: Precision } | null): void
}) {
  const cal = useCalendar(useTimelineOwner()?.id)
  const shown = props.value === null ? '' : formatTime(props.value, props.precision, cal)
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const cancelled = useRef(false)
  const commit = () => {
    const text = cancelled.current ? null : draft
    cancelled.current = false
    setDraft(null)
    if (text === null || text.trim() === shown) return
    if (!text.trim() && props.allowEmpty) return props.onCommit(null)
    const parsed = parseTime(text, cal)
    setInvalid(!parsed)
    if (parsed) props.onCommit(parsed)
  }
  return (
    <input
      aria-label={props.label}
      aria-invalid={invalid}
      className={invalid ? 'invalid' : undefined}
      value={draft ?? shown}
      placeholder={props.placeholder}
      title={invalid ? 'Not a date. Try 1204, 15 Mar 1204, c. 1200 or 4.5 billion years ago' : undefined}
      onChange={(e) => (setDraft(e.target.value), setInvalid(false))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}
