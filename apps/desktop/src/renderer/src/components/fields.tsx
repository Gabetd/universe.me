import { useState } from 'react'

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
