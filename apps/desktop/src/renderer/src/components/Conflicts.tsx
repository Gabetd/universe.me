import { parseRefKey, pathWords, stampTime, type Conflict, type RecordKind } from '@universe/core'
import { useMemo } from 'react'
import { menuRef, nameOf, openElement, type ElementKind, type ElementRef } from '../contextMenu'
import { useUi } from '../store'

/**
 * Conflict notes (PLAN.md §6.7, M20): a change made on another device at
 * the same time as one here, to the same field, that lost to the later one.
 * Each says what it was about and what the version that lost had, and can be
 * put back (undoable) or dismissed; both go for every copy.
 */

/** The elements the app can open, by record kind. */
const ELEMENT_OF: Partial<Record<RecordKind, ElementKind>> = {
  structure: 'structure',
  character: 'character',
  event: 'event',
  era: 'era',
  group: 'group',
  link: 'link',
  theme: 'theme',
  themeSpan: 'themeSpan',
  lifeform: 'species',
  lane: 'lane',
  power: 'power',
  faction: 'faction',
  relationship: 'relationship',
  waterway: 'waterway',
  member: 'member'
}

/** What a conflict note is about, if the app can open it. */
function elementOf(conflict: Conflict): ElementRef | undefined {
  const ref = parseRefKey(conflict.key)
  if (ref.t === 'node' || ref.t === 'world') return { kind: 'node', id: ref.id }
  if (ref.t === 'region') return { kind: 'region', id: ref.id }
  const kind = ref.t === 'record' ? ELEMENT_OF[ref.kind] : undefined
  return kind && { kind, id: ref.id }
}

/** What a field held, in a line: text without its markup, anything else as it's written. */
export function valueLine(value: unknown, removed: boolean): string {
  if (removed) return '(taken out)'
  const text = typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : JSON.stringify(value)
  if (!text) return '(empty)'
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

/** The open conflict notes, newest first: all of them, or those about what belongs to a node (`ownerId`, such as a world). */
export function useConflicts(ownerId?: string): Conflict[] {
  const all = useUi((s) => s.timeline.conflicts)
  return useMemo(() => all.filter((c) => !c.deletedAt && (!ownerId || c.ownerId === ownerId)).sort((a, b) => b.lostStamp.localeCompare(a.lostStamp)), [all, ownerId])
}

/** Conflict notes, each with what it's about, what was lost and when, and its two buttons. */
export function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <>
      {conflicts.map((c) => (
        <ConflictCard key={c.id} conflict={c} />
      ))}
    </>
  )
}

function ConflictCard({ conflict: c }: { conflict: Conflict }) {
  const execute = useUi((s) => s.execute)
  // Subscribed for the name of what it's about: a rename shows here at once.
  useUi((s) => s.timeline)
  const element = elementOf(c)
  const name = element && nameOf(element)
  const ref = parseRefKey(c.key)
  const field = ref.t === 'world' ? `the world’s ${pathWords(c.path)}` : pathWords(c.path)
  const when = new Date(stampTime(c.lostStamp)).toLocaleString()
  return (
    <article className="finding conflict" aria-label={`Changed at once: ${name ?? 'something'}, ${field}`}>
      <header>
        <span className="finding-severity">Changed at once</span>
        <b>
          {name ?? 'Something deleted'} · {field}
        </b>
      </header>
      <p className="muted small">Two changes to this were made at the same time on different devices. The later one was kept; this one ({when}) wasn’t:</p>
      <blockquote className="conflict-value">{valueLine(c.value, c.removed)}</blockquote>
      <footer className="field-row">
        <button onClick={() => void execute({ type: 'conflict.use', payload: { id: c.id } })}>Use this instead</button>
        <button onClick={() => void execute({ type: 'record.remove', payload: { refs: [{ kind: 'conflict', id: c.id }] } })} title="Keep what’s there now">
          Dismiss
        </button>
        {element && name && (
          <button className="link accent" data-menu={menuRef(element.kind, element.id)} onClick={() => openElement(element)}>
            Open
          </button>
        )}
      </footer>
    </article>
  )
}
