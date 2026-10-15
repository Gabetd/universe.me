import { LAW_KIND_LABELS, formatTime, lawOf, lawOwner, lawSpan, lawStatus, lawsOver, scopeId, type Character, type Law, type LawScope, type TimelineEvent } from '@universe/core'
import { useMemo } from 'react'
import { addLaw, openElement } from '../contextMenu'
import { updater, useOwnRecords, useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'
import { useCalendar } from '../world/useSky'
import { CauseFields, SpanFields } from './FactionParts'
import { DeleteButton, NotesField, PanelHeader, SelectField, TagsField, TextField } from './fields'
import { hinted } from './Hint'

/**
 * Laws (core laws.ts) in the inspector: an era's or a faction's list of them,
 * a law's own panel, the laws a character lives under, and the laws an event
 * enacts or repeals.
 */

/** What each of a law's values changes, said when the pointer rests on it. */
const LAW_HINTS = {
  kind: 'What it’s about: rule and succession, crime, trade, land, faith, magic, war or custom. Laws are listed by it.',
  says: 'What it asks of people, in a line: shown beside it wherever it’s listed.',
  penalty: 'What breaking it costs: a fine, exile, death, a curse…',
  inForce:
    'When it holds. Empty, it holds from when its era or faction begins and until it ends; dates outside that are kept but it isn’t in force there. The events say what enacted and repealed it; picking one moves the date to it.',
  list: 'The laws it holds people to. Dimmed ones aren’t in force at the playhead.',
  over: 'The laws they live under at the playhead: the era’s, and those of each faction they belong to then (and of what those factions are part of).'
}

/** A world's eras and factions: what bounds its laws' times. */
function useLawContext(worldId: string) {
  const eras = useOwnRecords('eras', worldId)
  const factions = useOwnRecords('factions', worldId)
  return useMemo(() => ({ eras, factions }), [eras, factions])
}

const open = (law: Law) => openElement({ kind: 'law', id: law.id })

/** An era's or a faction's laws, dimmed when not in force at the playhead, and a button to make another. */
export function LawList({ worldId, scope }: { worldId: string; scope: LawScope }) {
  const all = useOwnRecords('laws', worldId)
  const ofId = scopeId(scope)
  const laws = useMemo(() => all.filter((l) => lawOf(l, { kind: scope.kind, id: ofId })), [all, scope.kind, ofId])
  const context = useLawContext(worldId)
  const playhead = usePlayhead(worldId)
  return (
    <div className="field" role="group" aria-label="Laws" {...hinted(LAW_HINTS.list)}>
      <span>Laws</span>
      {laws.length > 0 ? (
        <ul className="plain-list faction-rows law-rows">
          {laws.map((law) => {
            const status = lawStatus(law, playhead, context)
            return (
              <li key={law.id} className={`faction-row${status === 'in force' ? '' : ' absent'}`}>
                <button className="link" onClick={() => open(law)}>
                  {law.name}
                </button>
                <span className="muted small">
                  {LAW_KIND_LABELS[law.kind]} · {status}
                  {law.summary && ` · ${law.summary}`}
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted small">No laws yet.</p>
      )}
      <div className="add-buttons">
        <button onClick={() => void addLaw(scope)}>⚖ Add a law</button>
      </div>
    </div>
  )
}

/** Where a law stands at the playhead, and the time it's in force, in words. */
function useLawNow(law: Law): string {
  const context = useLawContext(law.ownerId)
  const playhead = usePlayhead(law.ownerId)
  const cal = useCalendar(law.ownerId)
  const year = (t: number) => formatTime(t, 'year', cal)
  const { start, end } = lawSpan(law, context)
  const when = `${start === null ? 'from the beginning' : `from ${year(start)}`} ${end === null ? 'on' : `until ${year(end)}`}`
  const status = lawStatus(law, playhead, context)
  return `${status === 'in force' ? 'In force' : status === 'not yet' ? 'Not yet in force' : 'No longer in force'} at ${year(playhead)}; it holds ${when}.`
}

export function LawPanel({ law }: { law: Law }) {
  const update = updater('law', law.id)
  const owner = lawOwner(law, useLawContext(law.ownerId))
  const now = useLawNow(law)
  return (
    <section className="inspector-section" aria-label="Law">
      <PanelHeader icon="⚖" label="Law" onClose={() => useUi.getState().selectTimeline(null)} />
      <TextField label="Law name" value={law.name} required onCommit={(name) => update({ name })} />
      {owner && (
        <p className="small">
          {law.scope.kind === 'era' ? 'A law of the era ' : 'A law of '}
          <button className="link" onClick={() => openElement({ kind: law.scope.kind, id: owner.id })}>
            {owner.name}
          </button>
        </p>
      )}
      <SelectField label="Kind of law" value={law.kind} options={LAW_KIND_LABELS} hint={LAW_HINTS.kind} onCommit={(kind) => update({ kind })} />
      <TextField label="What it says" value={law.summary} placeholder="In a line: what it asks of people" hint={LAW_HINTS.says} onCommit={(summary) => update({ summary })} />
      <TextField label="Penalty" value={law.penalty} placeholder="What breaking it costs" hint={LAW_HINTS.penalty} onCommit={(penalty) => update({ penalty })} />
      <div className="field" {...hinted(LAW_HINTS.inForce)}>
        <span>In force</span>
        <SpanFields span={law} label="Law" from="Enacted" until="Repealed" onCommit={update} />
        <CauseFields worldId={law.ownerId} span={law} start="Enacted by" end="Repealed by" onCommit={update} />
        <p className="muted small" data-testid="law-status">
          {now}
        </p>
      </div>
      <TagsField label="Law tags" tags={law.tags} onCommit={(tags) => update({ tags })} />
      <NotesField label="Law notes" value={law.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="law" ids={[law.id]}>
        Delete law
      </DeleteButton>
    </section>
  )
}

/** The laws a character lives under at the playhead, and whose each is. */
export function LawsOver({ character }: { character: Character }) {
  const laws = useOwnRecords('laws', character.ownerId)
  const memberships = useOwnRecords('memberships', character.ownerId)
  const context = useLawContext(character.ownerId)
  const playhead = usePlayhead(character.ownerId)
  const over = useMemo(() => lawsOver(character, playhead, laws, { ...context, memberships }), [character, playhead, laws, context, memberships])
  if (!laws.length) return null
  return (
    <div className="field" role="group" aria-label="Laws over them" {...hinted(LAW_HINTS.over)}>
      <span>Laws over them</span>
      {over.length ? (
        <ul className="plain-list small law-rows">
          {over.map(({ law, from }) => (
            <li key={law.id}>
              <button className="link" onClick={() => open(law)}>
                {law.name}
              </button>{' '}
              <span className="muted">· {from.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">None at the playhead.</p>
      )}
    </div>
  )
}

/** The laws an event enacted or repealed (as their cause). */
export function EventLaws({ event }: { event: TimelineEvent }) {
  const all = useOwnRecords('laws', event.ownerId)
  const laws = useMemo(() => all.flatMap((law) => [...(law.startEventId === event.id ? [{ law, did: 'Enacts' }] : []), ...(law.endEventId === event.id ? [{ law, did: 'Repeals' }] : [])]), [all, event.id])
  if (!laws.length) return null
  return (
    <div className="field" role="group" aria-label="Its laws">
      <span>Laws</span>
      <ul className="plain-list small law-rows">
        {laws.map(({ law, did }) => (
          <li key={`${did}:${law.id}`}>
            {did}{' '}
            <button className="link" onClick={() => open(law)}>
              {law.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
