import { formatTime, parseTime, type Precision } from '@universe/core'
import { useEffect, useRef, useState } from 'react'

/**
 * Inputs that save once when editing finishes (blur, Enter, slider release),
 * not on every keystroke: each save is one undo step.
 */
export function TextField(props: { label: string; value: string; placeholder?: string; required?: boolean; onCommit(v: string): void }) {
  const [text, setText] = useState(props.value)
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
        const tags = text
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        if (tags.join('\u0000') !== props.tags.join('\u0000')) props.onCommit(tags)
      }}
    />
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
  const [text, setText] = useState(String(props.value))
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
 */
export function TimeField(props: {
  label: string
  value: number | null
  precision: Precision
  allowEmpty?: boolean
  placeholder?: string
  onCommit(value: { t: number; precision: Precision } | null): void
}) {
  const shown = props.value === null ? '' : formatTime(props.value, props.precision)
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const cancelled = useRef(false)
  const commit = () => {
    const text = cancelled.current ? null : draft
    cancelled.current = false
    setDraft(null)
    if (text === null || text.trim() === shown) return
    if (!text.trim() && props.allowEmpty) return props.onCommit(null)
    const parsed = parseTime(text)
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
